import { descriptor, FACTORY } from './catalog'
import { clamp, sanitize } from './dsp'
import { renderStretch } from '../stretch/engine'
import {
  emptySampler,
  sampleUsesStretch,
  sampleVoiceLimit,
  zoneFor,
  type SamplerState,
} from '../sample/engine'
import { playbackChannel, readSlotPoints } from '../sample/slot'
import { gainStep, playbackRateFor, readPlayed, softClip } from '../sample/pitch'
import type { PluginInstance } from '../../model/types'
import type { PluginModule, Processor } from './types'

interface Voice {
  note: number
  age: number
  active: boolean
  released: boolean
  vel: number
  env: number
  choke: number
  pos: number
  dir: number
  rate: number
  buffer: Float32Array
  /** Loop points inside `buffer`. One-shot plays the whole buffer. */
  loopFrom: number
  loopTo: number
  mode: number
  fade: number
  low: number
  stretch: boolean
  /** Samples to wait before this voice contributes. Used when a note is scheduled ahead. */
  delay: number
  stage: 'attack' | 'decay' | 'sustain'
  root: number
}

interface Tail {
  buffer: Float32Array
  pos: number
  dir: number
  rate: number
  env: number
  vel: number
  loopFrom: number
  loopTo: number
  mode: number
  fade: number
  low: number
}

interface ScheduledNote {
  time: number
  pitch: number
  vel: number
}

interface PlayRegion {
  audio: Float32Array
  loopFrom: number
  loopTo: number
}

export interface SamplerProcessor extends Processor {
  bind(plugin: PluginInstance, channel: (id: string) => Float32Array | null): void
  note(pitch: number, vel: number): void
  /** `time` is an AudioContext time. The voice starts on the sample that contains it. */
  schedule(pitch: number, vel: number, time: number): void
  capture(): Float32Array | null
  sounding(): number
}

export interface SamplerEvent {
  time: number
  pitch: number
  vel: number
}

/** Offline render of one sampler insert. Notes are timed in seconds from the start of the span. */
export function renderSamplerSpan(
  plugin: PluginInstance,
  channel: Float32Array,
  events: SamplerEvent[],
  sampleRate: number,
  length: number,
): [Float32Array, Float32Array] {
  const proc = createSampler(sampleRate)
  proc.bind(plugin, () => channel)
  const left = new Float32Array(Math.max(0, length))
  const right = new Float32Array(Math.max(0, length))
  const ordered = events.slice().sort((a, b) => a.time - b.time)
  let cursor = 0
  let offset = 0
  while (offset < left.length) {
    const n = Math.min(128, left.length - offset)
    const start = offset / sampleRate
    while (cursor < ordered.length && ordered[cursor].time <= start + n / sampleRate + 1e-9) {
      proc.schedule(ordered[cursor].pitch, ordered[cursor].vel, ordered[cursor].time)
      cursor += 1
    }
    const input = [new Float32Array(n), new Float32Array(n)]
    const output = [new Float32Array(n), new Float32Array(n)]
    proc.process(input, output, plugin.params, {
      sampleRate,
      tempo: 120,
      sampleTime: offset,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [],
      quality: 'full',
      offline: true,
      playTime: start,
    })
    left.set(output[0], offset)
    right.set(output[1], offset)
    offset += n
  }
  return [left, right]
}

export function createSampler(sampleRate: number): SamplerProcessor {
  const voices: Voice[] = []
  let state: SamplerState = emptySampler()
  let source: Float32Array | null = null
  let lookup: (id: string) => Float32Array | null = () => null
  let quality: 'full' | 'eco' = 'full'
  const captured: number[] = []
  const played = new Map<string, Float32Array>()
  const tails: Tail[] = []
  const pending: ScheduledNote[] = []
  const hear = (id: string, channel: Float32Array | null) => {
    if (!channel?.length) return null
    const fileRate = state.sourceRate && state.sourceRate > 0 ? state.sourceRate : sampleRate
    if (fileRate === sampleRate) return channel
    const key = `${id}:${channel.length}:${fileRate}:${sampleRate}`
    let hit = played.get(key)
    if (!hit) {
      hit = playbackChannel(channel, fileRate, sampleRate)
      played.set(key, hit)
    }
    return hit
  }
  const park = (voice: Voice) => {
    if (!voice.active || voice.buffer.length < 2 || voice.env < 0.001) return
    tails.push({
      buffer: voice.buffer,
      pos: voice.pos,
      dir: voice.dir,
      rate: voice.rate > 0 ? voice.rate : 1,
      env: voice.env,
      vel: voice.vel,
      loopFrom: voice.loopFrom,
      loopTo: voice.loopTo,
      mode: voice.mode,
      fade: voice.fade,
      low: voice.low,
    })
  }
  const startNote = (pitch: number, vel: number, delay: number) => {
    const midi = Math.round(pitch)
    if (vel <= 0.0001) {
      for (const voice of voices) if (voice.note === midi && voice.active) voice.released = true
      return
    }
    const region = regionFor(state, source, (id) => hear(id, lookup(id)), midi)
    if (!region) return
    const slice = state.slices.length ? zoneFor(state.slices, midi) : null
    const limit = sampleVoiceLimit(quality)
    const slot = steal(voices, midi, limit, park)
    slot.vel = vel
    slot.env = 0
    slot.stage = 'attack'
    slot.delay = Math.max(0, delay | 0)
    slot.choke = slice?.choke ?? 0
    slot.buffer = region.audio
    slot.loopFrom = region.loopFrom
    slot.loopTo = region.loopTo
    slot.pos = 0
    slot.dir = 1
    slot.rate = 1
    slot.mode = state.loopMode
    slot.fade = Math.round((state.crossfade || 0) * region.audio.length)
    slot.low = 0
    slot.stretch = true
    slot.root = slice ? slice.root + (slice.tune || 0) : state.root
    if (slot.choke > 0) {
      for (const voice of voices) {
        if (voice !== slot && voice.active && voice.choke === slot.choke) voice.released = true
      }
    }
  }
  return {
    latencySamples: 0,
    reset() {
      voices.length = 0
      tails.length = 0
      pending.length = 0
      captured.length = 0
    },
    bind(plugin, channel) {
      state = plugin.sampler ?? emptySampler()
      lookup = channel
      source = hear(state.bufferId, state.bufferId ? channel(state.bufferId) : null)
    },
    note(pitch, vel) {
      startNote(pitch, vel, 0)
    },
    schedule(pitch, vel, time) {
      if (!Number.isFinite(time)) {
        startNote(pitch, vel, 0)
        return
      }
      pending.push({ time, pitch, vel })
      pending.sort((a, b) => a.time - b.time)
    },
    capture() {
      if (!captured.length) return null
      const out = Float32Array.from(captured)
      captured.length = 0
      return out
    },
    sounding() {
      return voices.filter((voice) => voice.active).length
    },
    process(input, output, params, ctx) {
      quality = ctx.quality
      const n = input[0]?.length ?? 0
      const play = ctx.playTime
      if (play != null && Number.isFinite(play) && pending.length) {
        const end = play + n / sampleRate
        while (pending.length && pending[0].time <= end + 1e-6) {
          const event = pending.shift()!
          const offset = Math.max(0, Math.min(Math.max(0, n - 1), Math.round((event.time - play) * sampleRate)))
          startNote(event.pitch, event.vel, offset)
        }
      }
      const limit = (params.mono ?? 0) >= 0.5 ? 1 : sampleVoiceLimit(quality)
      while (voices.filter((voice) => voice.active).length > limit) {
        const extra = voices.filter((voice) => voice.active).sort((a, b) => b.age - a.age)[0]
        if (!extra) break
        park(extra)
        extra.active = false
      }
      const cap = quality === 'eco' ? sampleRate * 4 : sampleRate * 30
      if ((params.record ?? 0) >= 0.5 && captured.length < cap) {
        const src = ctx.sidechain ?? input[0]
        if (src) for (let i = 0; i < n && captured.length < cap; i++) captured.push(sanitize(src[i] || 0))
      }
      const attack = Math.max(8, ((params.attack ?? 4) / 1000) * sampleRate)
      const decay = Math.max(8, ((params.decay ?? 200) / 1000) * sampleRate)
      const sustain = clamp(params.sustain ?? 0.8, 0, 1)
      const release = Math.max(8, ((params.release ?? 120) / 1000) * sampleRate)
      const tailRelease = Math.max(32, Math.round(sampleRate * 0.008))
      const cutoff = params.cutoff ?? 16000
      const coeff = 1 - Math.exp((-2 * Math.PI * clamp(cutoff, 40, sampleRate * 0.45)) / sampleRate)
      const gain = clamp(params.gain ?? 0.8, 0, 1)
      const playRate = state.speed && state.speed > 0 ? state.speed : 1
      const beat = Math.max(2, Math.round((sampleRate * 60) / Math.max(1, ctx.tempo)))
      for (const voice of voices) {
        if (!voice.active || !voice.stretch) continue
        voice.stretch = false
        const chromatic = (params.keys ?? 0) >= 0.5
        const loopAt = clamp(voice.loopFrom, 0, Math.max(0, voice.buffer.length - 2))
        const loopStop = clamp(voice.loopTo || voice.buffer.length, loopAt + 2, voice.buffer.length)
        const pieceLength = loopStop - loopAt
        if (!chromatic && sampleUsesStretch(params.stretch ?? 1, quality) && pieceLength <= sampleRate * 2) {
          const piece = voice.buffer.subarray(loopAt, loopStop)
          const rendered = renderStretch([piece], sampleRate, {
            ratio: beat / piece.length,
            semitones: 0,
            mode: 'tonal',
            quality: ctx.offline ? 'hq' : 'preview',
          })
          if (rendered[0]?.length) {
            voice.buffer = rendered[0]
            voice.loopFrom = 0
            voice.loopTo = voice.buffer.length
            voice.pos = 0
          }
          voice.rate = playRate
        } else voice.rate = playbackRateFor(voice.note + (params.pitch ?? 0), voice.root || state.root) * playRate
      }
      for (let i = 0; i < n; i++) {
        let left = 0
        let right = 0
        for (const voice of voices) {
          if (!voice.active) continue
          voice.age += 1
          if (voice.delay > 0) {
            voice.delay -= 1
            continue
          }
          if (voice.released) voice.env = gainStep(voice.env, 0, release)
          else if (voice.stage === 'attack') {
            voice.env = gainStep(voice.env, 1, attack)
            if (voice.env > 0.98) voice.stage = 'decay'
          } else if (voice.stage === 'decay') {
            voice.env = gainStep(voice.env, sustain, decay)
            if (Math.abs(voice.env - sustain) < 0.015) voice.stage = 'sustain'
          } else voice.env = gainStep(voice.env, sustain, decay)
          if (voice.released && voice.env < 0.0008) {
            voice.active = false
            continue
          }
          const sample = readVoice(voice, coeff) * voice.env * voice.vel * gain
          const pan = clamp(params.pan ?? 0, -1, 1)
          left += sample * (pan <= 0 ? 1 : 1 - pan)
          right += sample * (pan >= 0 ? 1 : 1 + pan)
        }
        for (let t = tails.length - 1; t >= 0; t--) {
          const tail = tails[t]
          tail.env = gainStep(tail.env, 0, tailRelease)
          if (tail.env < 0.0008) {
            tails.splice(t, 1)
            continue
          }
          const sample = readTail(tail, coeff) * tail.env * tail.vel * gain
          left += sample
          right += sample
        }
        const mixedL = softClip(left)
        const mixedR = softClip(right)
        if (output[0]) output[0][i] = sanitize(mixedL)
        if (output[1]) output[1][i] = sanitize(mixedR)
      }
    },
  }
}

function regionFor(state: SamplerState, source: Float32Array | null, lookup: (id: string) => Float32Array | null, midi: number): PlayRegion | null {
  const slice = state.slices.length ? zoneFor(state.slices, midi) : null
  const channel = (slice && lookup(slice.bufferId)) || source
  if (!channel || channel.length < 2) return null
  const points = readSlotPoints(state)
  const from = slice ? slice.loopStart : points.start
  const to = slice ? slice.loopEnd : points.end
  const start = clamp(Math.floor(from * channel.length), 0, channel.length - 2)
  const end = clamp(Math.floor(to * channel.length), start + 2, channel.length)
  const audio = channel.slice(start, end)
  if (slice?.reverse) reverseInPlace(audio)
  if (slice || state.loopMode === 2) return { audio, loopFrom: 0, loopTo: audio.length }
  const loopStart = clamp(Math.floor(points.loopStart * channel.length), start, end - 2)
  const loopEnd = clamp(Math.floor(points.loopEnd * channel.length), loopStart + 2, end)
  return { audio, loopFrom: loopStart - start, loopTo: loopEnd - start }
}

function reverseInPlace(region: Float32Array) {
  for (let i = 0; i < region.length / 2; i++) {
    const swap = region[i]
    region[i] = region[region.length - 1 - i]
    region[region.length - 1 - i] = swap
  }
}

function readVoice(voice: Voice, coeff: number) {
  const span = voice.buffer.length
  if (span < 2) return 0
  const loopTo = voice.mode === 2 ? span : clamp(voice.loopTo || span, 2, span)
  const loopFrom = voice.mode === 2 ? 0 : clamp(voice.loopFrom || 0, 0, loopTo - 2)
  const pos = clamp(voice.pos, 0, span - 1.001)
  const wrap = voice.mode === 0 && pos >= loopFrom
  let sample = readPlayed(voice.buffer, pos, voice.rate, wrap ? loopFrom : null, wrap ? loopTo : null)
  const fade = Math.max(0, Math.min(loopTo - loopFrom - 2, voice.fade))
  if (fade > 1 && voice.mode === 0 && pos >= loopTo - fade && pos < loopTo) {
    const t = (pos - (loopTo - fade)) / fade
    const head = readPlayed(voice.buffer, loopFrom, 1, null, null)
    sample = sample * (1 - t) + head * t
  }
  voice.low += (sample - voice.low) * coeff
  const step = voice.rate > 0 ? voice.rate : 1
  if (voice.mode === 2) {
    voice.pos += step
    if (voice.pos >= span - 1) voice.released = true
  } else if (voice.mode === 1) {
    if (voice.pos < loopFrom) voice.pos += step
    else {
      voice.pos += voice.dir * step
      if (voice.pos >= loopTo - 1) {
        voice.pos = loopTo - 2
        voice.dir = -1
      } else if (voice.pos <= loopFrom) {
        voice.pos = loopFrom + 1
        voice.dir = 1
      }
    }
  } else {
    voice.pos += step
    if (voice.pos >= loopTo) {
      const cycle = Math.max(1, loopTo - loopFrom)
      voice.pos = loopFrom + ((voice.pos - loopTo) % cycle)
    }
  }
  return sanitize(voice.low)
}

function readTail(tail: Tail, coeff: number) {
  const span = tail.buffer.length
  if (span < 2) return 0
  const loopTo = tail.mode === 2 ? span : clamp(tail.loopTo || span, 2, span)
  const loopFrom = tail.mode === 2 ? 0 : clamp(tail.loopFrom || 0, 0, loopTo - 2)
  const wrap = tail.mode === 0
  const sample = readPlayed(tail.buffer, clamp(tail.pos, 0, span - 1.001), tail.rate, wrap ? loopFrom : null, wrap ? loopTo : null)
  tail.low += (sample - tail.low) * coeff
  tail.pos += tail.rate > 0 ? tail.rate : 1
  return sanitize(tail.low)
}

function steal(voices: Voice[], note: number, limit: number, park: (voice: Voice) => void) {
  const cap = Math.max(1, Math.round(Number.isFinite(limit) ? limit : 16))
  for (const voice of voices) if (voice.active) voice.age += 1
  const same = voices.find((voice) => voice.active && voice.note === note)
  if (same) {
    park(same)
    same.age = 0
    same.released = false
    same.active = true
    return same
  }
  let slot = voices.find((voice) => !voice.active)
  if (!slot && voices.length < cap) {
    slot = fresh(note)
    voices.push(slot)
    return slot
  }
  if (!slot) {
    const releasing = voices.filter((voice) => voice.released)
    const pool = releasing.length ? releasing : voices
    slot = pool.slice().sort((a, b) => b.age - a.age)[0]
    park(slot)
  }
  Object.assign(slot, fresh(note))
  return slot
}

function fresh(note: number): Voice {
  return {
    note,
    age: 0,
    active: true,
    released: false,
    vel: 1,
    env: 0,
    choke: 0,
    pos: 0,
    dir: 1,
    rate: 1,
    buffer: new Float32Array(2),
    loopFrom: 0,
    loopTo: 2,
    mode: 0,
    fade: 0,
    low: 0,
    stretch: false,
    delay: 0,
    stage: 'attack',
    root: 60,
  }
}

const plugin: PluginModule = {
  descriptor: descriptor('sampler')!,
  presets: FACTORY.sampler,
  create: createSampler,
}

export default plugin
