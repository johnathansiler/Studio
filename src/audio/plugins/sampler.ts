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
}

interface PlayRegion {
  audio: Float32Array
  loopFrom: number
  loopTo: number
}

export interface SamplerProcessor extends Processor {
  bind(plugin: PluginInstance, channel: (id: string) => Float32Array | null): void
  note(pitch: number, vel: number): void
  capture(): Float32Array | null
  sounding(): number
}

export function createSampler(sampleRate: number): SamplerProcessor {
  const voices: Voice[] = []
  let state: SamplerState = emptySampler()
  let source: Float32Array | null = null
  let lookup: (id: string) => Float32Array | null = () => null
  let quality: 'full' | 'eco' = 'full'
  const captured: number[] = []
  const played = new Map<string, Float32Array>()
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
  return {
    latencySamples: 0,
    reset() {
      voices.length = 0
      captured.length = 0
    },
    bind(plugin, channel) {
      state = plugin.sampler ?? emptySampler()
      lookup = channel
      source = hear(state.bufferId, state.bufferId ? channel(state.bufferId) : null)
    },
    note(pitch, vel) {
      const midi = Math.round(pitch)
      if (vel <= 0.0001) {
        for (const voice of voices) if (voice.note === midi) voice.released = true
        return
      }
      const region = regionFor(state, source, (id) => hear(id, lookup(id)), midi)
      if (!region) return
      const slice = state.slices.length ? zoneFor(state.slices, midi) : null
      const limit = sampleVoiceLimit(quality)
      const slot = steal(voices, midi, limit)
      slot.vel = vel
      slot.env = 0
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
      if (slot.choke > 0) {
        for (const voice of voices) {
          if (voice !== slot && voice.active && voice.choke === slot.choke) voice.released = true
        }
      }
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
      const limit = (params.mono ?? 0) >= 0.5 ? 1 : sampleVoiceLimit(quality)
      while (voices.filter((voice) => voice.active).length > limit) {
        const extra = voices.filter((voice) => voice.active).sort((a, b) => b.age - a.age)[0]
        if (!extra) break
        extra.active = false
      }
      const cap = quality === 'eco' ? sampleRate * 4 : sampleRate * 30
      if ((params.record ?? 0) >= 0.5 && captured.length < cap) {
        const src = ctx.sidechain ?? input[0]
        if (src) for (let i = 0; i < n && captured.length < cap; i++) captured.push(sanitize(src[i] || 0))
      }
      const attack = Math.max(1, ((params.attack ?? 4) / 1000) * sampleRate)
      const release = Math.max(1, ((params.release ?? 120) / 1000) * sampleRate)
      const cutoff = params.cutoff ?? 16000
      const coeff = 1 - Math.exp((-2 * Math.PI * clamp(cutoff, 40, sampleRate * 0.45)) / sampleRate)
      const gain = clamp(params.gain ?? 0.8, 0, 1)
      const beat = Math.max(2, Math.round((sampleRate * 60) / Math.max(1, ctx.tempo)))
      for (const voice of voices) {
        if (!voice.active || !voice.stretch) continue
        voice.stretch = false
        const semis = (params.pitch ?? 0) + (voice.note - state.root)
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
          voice.rate = 1
        } else voice.rate = 2 ** (semis / 12)
      }
      for (let i = 0; i < n; i++) {
        let left = 0
        let right = 0
        for (const voice of voices) {
          if (!voice.active) continue
          voice.age += 1
          voice.env = voice.released ? voice.env * Math.exp(-1 / release) : Math.min(1, voice.env + 1 / attack)
          if (voice.released && voice.env < 0.0008) {
            voice.active = false
            continue
          }
          const sample = readVoice(voice, coeff) * voice.env * voice.vel * gain
          const pan = clamp(params.pan ?? 0, -1, 1)
          left += sample * (pan <= 0 ? 1 : 1 - pan)
          right += sample * (pan >= 0 ? 1 : 1 + pan)
        }
        if (output[0]) output[0][i] = sanitize(left)
        if (output[1]) output[1][i] = sanitize(right)
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
  let sample = readSample(voice.buffer, pos)
  const fade = Math.max(0, Math.min(loopTo - loopFrom - 2, voice.fade))
  if (fade > 1 && voice.mode === 0 && pos >= loopTo - fade && pos < loopTo) {
    const t = (pos - (loopTo - fade)) / fade
    sample = sample * (1 - t) + readSample(voice.buffer, loopFrom + (pos - (loopTo - fade))) * t
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

function readSample(buffer: Float32Array, at: number) {
  const pos = clamp(at, 0, Math.max(0, buffer.length - 1.001))
  const index = Math.floor(pos)
  const frac = pos - index
  return (buffer[index] || 0) * (1 - frac) + (buffer[Math.min(buffer.length - 1, index + 1)] || 0) * frac
}

function steal(voices: Voice[], note: number, limit: number) {
  const cap = Math.max(1, Math.round(Number.isFinite(limit) ? limit : 16))
  for (const voice of voices) if (voice.active) voice.age += 1
  const same = voices.find((voice) => voice.active && voice.note === note)
  if (same) {
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
  }
}

const plugin: PluginModule = {
  descriptor: descriptor('sampler')!,
  presets: FACTORY.sampler,
  create: createSampler,
}

export default plugin
