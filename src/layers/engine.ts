import { resampleSinc } from '../audio/quality/resample'
import {
  chorusStep,
  clamp,
  delayStep,
  envStep,
  filterStep,
  freshChorus,
  freshDelay,
  freshEnv,
  freshFilter,
  soft,
  type ChorusState,
  type DelayState,
  type EnvState,
  type FilterState,
} from './dsp'
import { applyRoutesInto, flattenPatch, morphValues, rangeMap } from './matrix'
import { createLayerVoice, type LayerNote, type LayerSourceVoice, type SourceContext } from './source'
import { freeWaveform } from './wave'
import { sourceKey, sourceParamList, type LayerPatch, type LayerState } from './types'

export interface LayerBuffer {
  sampleRate: number
  channel: Float32Array
}

export interface LayerNoteEvent {
  sample: number
  pitch: number
  vel: number
}

interface Times {
  attack: number
  decay: number
  sustain: number
  release: number
  fAttack: number
  fDecay: number
  fSustain: number
  fRelease: number
  mAttack: number
  mDecay: number
  mSustain: number
  mRelease: number
}

interface Slot {
  key: string
  source: LayerSourceVoice
  amp: EnvState
  filterEnv: EnvState
  modEnv: EnvState
  filter: FilterState
  chorus: ChorusState
  delay: DelayState
  times: Times
  started: boolean
}

interface Voice {
  pitch: number
  vel: number
  released: boolean
  active: boolean
  age: number
  retrigger: boolean
  tail: number
  tailArmed: boolean
  slots: Map<string, Slot>
}

function read(flat: Record<string, number>, key: string, fallback: number) {
  const value = flat[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function timesFrom(params: Record<string, number>): Times {
  const pick = (id: string, fallback: number) => {
    const value = params[id]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  return {
    attack: pick('attack', 8),
    decay: pick('decay', 240),
    sustain: pick('sustain', 0.75),
    release: pick('release', 320),
    fAttack: pick('fAttack', 12),
    fDecay: pick('fDecay', 280),
    fSustain: pick('fSustain', 0.3),
    fRelease: pick('fRelease', 360),
    mAttack: pick('mAttack', 10),
    mDecay: pick('mDecay', 200),
    mSustain: pick('mSustain', 0.5),
    mRelease: pick('mRelease', 280),
  }
}

export class LayerRuntime {
  private readonly voices: Voice[] = []
  private readonly scratch: Record<string, number> = {}
  private readonly sources: Record<string, number> = {}
  private readonly prepared = new Map<string, Float32Array>()
  private readonly lfoPhase = [0, 0, 0, 0]
  private readonly lfoHold = [-1, -1, -1, -1]
  private readonly lfoOut = [0, 0, 0, 0]
  private readonly lfoRate = [Number.NaN, Number.NaN, Number.NaN, Number.NaN]
  private readonly lfoShape = [Number.NaN, Number.NaN, Number.NaN, Number.NaN]
  private readonly paramCache: Record<string, number> = {}
  private time = 0

  constructor(private readonly sampleRate: number) {}

  note(pitch: number, vel: number, polyphony = 8) {
    const midi = Math.max(0, Math.min(127, Math.round(pitch)))
    const level = vel > 1 ? vel / 127 : vel
    if (!(level > 0.0001)) {
      for (const voice of this.voices) {
        if (voice.active && voice.pitch === midi && !voice.released) voice.released = true
      }
      return
    }
    const cap = Math.max(1, Math.round(polyphony) || 8)
    for (const voice of this.voices) if (voice.active) voice.age += 1
    let slot = this.voices.find((voice) => voice.active && voice.pitch === midi)
    if (!slot) slot = this.voices.find((voice) => !voice.active)
    if (!slot && this.voices.length < cap) {
      slot = this.fresh(midi)
      this.voices.push(slot)
    }
    if (!slot) {
      const releasing = this.voices.filter((voice) => voice.released)
      const pool = releasing.length ? releasing : this.voices
      slot = pool.slice().sort((a, b) => b.age - a.age)[0] ?? this.voices[0]
    }
    slot.pitch = midi
    slot.vel = clamp(level, 0, 1)
    slot.released = false
    slot.active = true
    slot.age = 0
    slot.retrigger = true
    slot.tail = 0
    slot.tailArmed = false
  }

  allOff() {
    for (const voice of this.voices) if (voice.active) voice.released = true
  }

  render(patch: LayerPatch, frames: number, quality: 'full' | 'eco', buffers: Map<string, LayerBuffer>) {
    const count = Math.max(0, frames | 0)
    const left = new Float32Array(count)
    const right = new Float32Array(count)
    if (!count || !patch.layers?.length) return [left, right] as [Float32Array, Float32Array]
    const fallback = flattenPatch(patch)
    const corners = (patch.corners ?? []).map((corner) => corner?.values ?? {})
    const base = morphValues(corners, patch.xy?.x ?? 0, patch.xy?.y ?? 0, fallback)
    const ranges = rangeMap(patch)
    const routes = patch.routes ?? []
    const cap = quality === 'eco' ? Math.min(patch.polyphony || 8, 4) : patch.polyphony || 8
    this.limit(cap)
    const audio = new Map<string, { data: Float32Array; rate: number }>()
    for (const layer of patch.layers) audio.set(layer.id, this.prepare(layer, buffers, quality))
    const ctx: SourceContext = { sampleRate: this.sampleRate, time: 0, quality, buffer: null, bufferRate: this.sampleRate }
    const note: LayerNote = { pitch: 60, velocity: 1, released: false }
    for (let i = 0; i < count; i++) {
      this.advanceLfo(base)
      let sumL = 0
      let sumR = 0
      for (const voice of this.voices) {
        if (!voice.active) continue
        voice.age += 1
        this.advanceVoice(voice, patch)
        const resolved = applyRoutesInto(base, routes, (destination) => this.fillSources(voice, patch, destination), ranges, this.scratch)
        this.lfoRate[0] = read(resolved, 'g:lfo1Rate', this.lfoRate[0])
        this.lfoRate[1] = read(resolved, 'g:lfo2Rate', this.lfoRate[1])
        this.lfoRate[2] = read(resolved, 'g:lfo3Rate', this.lfoRate[2])
        this.lfoRate[3] = read(resolved, 'g:lfo4Rate', this.lfoRate[3])
        this.lfoShape[0] = read(resolved, 'g:lfo1Shape', this.lfoShape[0])
        this.lfoShape[1] = read(resolved, 'g:lfo2Shape', this.lfoShape[1])
        this.lfoShape[2] = read(resolved, 'g:lfo3Shape', this.lfoShape[2])
        this.lfoShape[3] = read(resolved, 'g:lfo4Shape', this.lfoShape[3])
        const master = read(resolved, 'g:master', 0.75)
        note.velocity = voice.vel
        note.released = voice.released
        let heard = false
        for (const layer of patch.layers) {
          if (!layer.enabled) continue
          const slot = voice.slots.get(layer.id)
          if (!slot) continue
          this.storeTimes(slot, resolved, layer.id)
          const tuned = voice.pitch + read(resolved, `${layer.id}:tune`, 0) + read(resolved, `${layer.id}:fine`, 0) / 100
          note.pitch = tuned
          const heardBuffer = audio.get(layer.id)
          ctx.buffer = heardBuffer?.data ?? null
          ctx.bufferRate = heardBuffer?.rate ?? this.sampleRate
          ctx.time = this.time
          ctx.quality = quality
          if (!slot.started) {
            slot.source.start(note, this.sourceParams(layer, resolved), ctx)
            slot.started = true
          }
          let sample = slot.source.render(note, this.sourceParams(layer, resolved), ctx)
          const drive = read(resolved, `${layer.id}:drive`, 0)
          if (drive > 0.001) sample = Math.tanh(sample * (1 + drive * 6))
          const cutoff = clamp(
            read(resolved, `${layer.id}:cutoff`, 8000) + read(resolved, `${layer.id}:fAmt`, 0) * slot.filterEnv.value * 15960,
            40,
            16000,
          )
          sample = filterStep(slot.filter, sample, cutoff, read(resolved, `${layer.id}:res`, 0), read(resolved, `${layer.id}:filterMode`, 0), this.sampleRate)
          sample *= slot.amp.value * read(resolved, `${layer.id}:level`, 0.7) * (0.25 + 0.75 * voice.vel)
          sample = chorusStep(slot.chorus, sample, read(resolved, `${layer.id}:chorus`, 0), this.sampleRate)
          sample = delayStep(
            slot.delay,
            sample,
            read(resolved, `${layer.id}:delay`, 0),
            read(resolved, `${layer.id}:delayTime`, 0.28),
            read(resolved, `${layer.id}:feedback`, 0.3),
            this.sampleRate,
          )
          const pan = clamp(read(resolved, `${layer.id}:pan`, 0), -1, 1)
          const gainL = pan <= 0 ? 1 : 1 - pan
          const gainR = pan >= 0 ? 1 : 1 + pan
          sumL += sample * gainL * master
          sumR += sample * gainR * master
          if (slot.amp.value > 0.0008) heard = true
        }
        if (voice.released && !heard) {
          if (!voice.tailArmed) {
            voice.tail = this.tailSamples(patch, resolved)
            voice.tailArmed = true
          }
          if (voice.tail > 0) voice.tail -= 1
          else {
            voice.active = false
            for (const slot of voice.slots.values()) slot.source.release()
          }
        }
      }
      left[i] = soft(sumL)
      right[i] = soft(sumR)
      this.time += 1
    }
    return [left, right] as [Float32Array, Float32Array]
  }

  private fresh(pitch: number): Voice {
    return {
      pitch,
      vel: 1,
      released: false,
      active: true,
      age: 0,
      retrigger: true,
      tail: 0,
      tailArmed: false,
      slots: new Map(),
    }
  }

  private limit(cap: number) {
    const active = this.voices.filter((voice) => voice.active)
    if (active.length <= cap) return
    const extras = active.slice().sort((a, b) => b.age - a.age).slice(0, active.length - cap)
    for (const voice of extras) voice.released = true
  }

  private advanceVoice(voice: Voice, patch: LayerPatch) {
    for (const layer of patch.layers) {
      const key = sourceKey(layer.source)
      let slot = voice.slots.get(layer.id)
      if (!slot || slot.key !== key) {
        slot?.source.release()
        slot = {
          key,
          source: createLayerVoice(layer.source, this.sampleRate),
          amp: freshEnv(),
          filterEnv: freshEnv(),
          modEnv: freshEnv(),
          filter: freshFilter(),
          chorus: freshChorus(this.sampleRate),
          delay: freshDelay(),
          times: timesFrom(layer.params),
          started: false,
        }
        voice.slots.set(layer.id, slot)
      }
      if (voice.retrigger) {
        slot.started = false
        slot.amp = freshEnv()
        slot.filterEnv = freshEnv()
        slot.modEnv = freshEnv()
        slot.filter = freshFilter()
        slot.delay = freshDelay()
        slot.chorus.pos = 0
        slot.chorus.phase = 0
        slot.chorus.buf.fill(0)
        slot.times = timesFrom(layer.params)
      }
      const released = voice.released
      envStep(slot.amp, released, slot.times.attack, slot.times.decay, slot.times.sustain, slot.times.release, this.sampleRate)
      envStep(slot.filterEnv, released, slot.times.fAttack, slot.times.fDecay, slot.times.fSustain, slot.times.fRelease, this.sampleRate)
      envStep(slot.modEnv, released, slot.times.mAttack, slot.times.mDecay, slot.times.mSustain, slot.times.mRelease, this.sampleRate)
    }
    voice.retrigger = false
  }

  private fillSources(voice: Voice, patch: LayerPatch, destination: string) {
    const layerId = destination.startsWith('g:') ? patch.layers.find((layer) => layer.enabled)?.id : destination.split(':')[0]
    const slot = layerId ? voice.slots.get(layerId) : undefined
    this.sources.lfo1 = this.lfoOut[0]
    this.sources.lfo2 = this.lfoOut[1]
    this.sources.lfo3 = this.lfoOut[2]
    this.sources.lfo4 = this.lfoOut[3]
    this.sources.env1 = slot?.amp.value ?? 0
    this.sources.env2 = slot?.filterEnv.value ?? 0
    this.sources.env3 = slot?.modEnv.value ?? 0
    this.sources.velocity = voice.vel
    this.sources.modwheel = clamp(patch.modWheel ?? 0, 0, 1)
    this.sources.aftertouch = clamp(patch.aftertouch ?? 0, 0, 1)
    return this.sources
  }

  private advanceLfo(base: Record<string, number>) {
    for (let i = 0; i < 4; i++) {
      const n = i + 1
      const rate = Number.isFinite(this.lfoRate[i]) ? this.lfoRate[i] : read(base, `g:lfo${n}Rate`, 0.25)
      const shape = Number.isFinite(this.lfoShape[i]) ? this.lfoShape[i] : read(base, `g:lfo${n}Shape`, 0)
      this.lfoPhase[i] += Math.max(0, rate) / this.sampleRate
      const phase = this.lfoPhase[i]
      const wrapped = phase - Math.floor(phase)
      const choice = Math.max(0, Math.min(4, Math.round(shape)))
      if (choice === 1) this.lfoOut[i] = wrapped < 0.5 ? -1 + 4 * wrapped : 3 - 4 * wrapped
      else if (choice === 2) this.lfoOut[i] = 2 * wrapped - 1
      else if (choice === 3) this.lfoOut[i] = wrapped < 0.5 ? 1 : -1
      else if (choice === 4) {
        const step = Math.floor(phase)
        if (step !== this.lfoHold[i]) {
          this.lfoHold[i] = step
          let x = Math.imul(step + i * 17 + 1, 0x45d9f3b)
          x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
          this.lfoOut[i] = (((x ^ (x >>> 16)) >>> 0) / 4294967295) * 2 - 1
        }
      } else this.lfoOut[i] = Math.sin(2 * Math.PI * wrapped)
    }
  }

  private storeTimes(slot: Slot, flat: Record<string, number>, id: string) {
    slot.times.attack = read(flat, `${id}:attack`, slot.times.attack)
    slot.times.decay = read(flat, `${id}:decay`, slot.times.decay)
    slot.times.sustain = read(flat, `${id}:sustain`, slot.times.sustain)
    slot.times.release = read(flat, `${id}:release`, slot.times.release)
    slot.times.fAttack = read(flat, `${id}:fAttack`, slot.times.fAttack)
    slot.times.fDecay = read(flat, `${id}:fDecay`, slot.times.fDecay)
    slot.times.fSustain = read(flat, `${id}:fSustain`, slot.times.fSustain)
    slot.times.fRelease = read(flat, `${id}:fRelease`, slot.times.fRelease)
    slot.times.mAttack = read(flat, `${id}:mAttack`, slot.times.mAttack)
    slot.times.mDecay = read(flat, `${id}:mDecay`, slot.times.mDecay)
    slot.times.mSustain = read(flat, `${id}:mSustain`, slot.times.mSustain)
    slot.times.mRelease = read(flat, `${id}:mRelease`, slot.times.mRelease)
  }

  private sourceParams(layer: LayerState, flat: Record<string, number>) {
    const params = this.paramCache
    for (const key of Object.keys(params)) delete params[key]
    for (const item of sourceParamList(layer.source)) params[item.id] = read(flat, `${layer.id}:s:${item.id}`, item.default)
    return params
  }

  private tailSamples(patch: LayerPatch, flat: Record<string, number>) {
    let tail = 0
    for (const layer of patch.layers) {
      const mix = read(flat, `${layer.id}:delay`, 0)
      if (mix <= 0.02) continue
      const time = read(flat, `${layer.id}:delayTime`, 0.28)
      const feedback = read(flat, `${layer.id}:feedback`, 0.3)
      tail = Math.max(tail, Math.round(time * this.sampleRate * (0.5 + feedback)))
    }
    return tail
  }

  private prepare(layer: LayerState, buffers: Map<string, LayerBuffer>, quality: 'full' | 'eco') {
    const id = layer.source.bufferId || ''
    const asset = id ? buffers.get(id) : undefined
    if (!asset?.channel?.length) return { data: freeWaveform(this.sampleRate), rate: this.sampleRate }
    if (asset.sampleRate === this.sampleRate) return { data: asset.channel, rate: this.sampleRate }
    const key = `${id}:${asset.sampleRate}:${this.sampleRate}:${quality}`
    let data = this.prepared.get(key)
    if (!data) {
      const outLen = Math.max(2, Math.round(asset.channel.length * this.sampleRate / asset.sampleRate))
      data = resampleSinc(asset.channel, outLen, quality === 'full' ? 64 : 24)
      this.prepared.set(key, data)
    }
    return { data, rate: this.sampleRate }
  }
}

export function layerBuffers(
  patch: LayerPatch,
  assets: Map<string, { sampleRate: number; channels: Float32Array[] }>,
): Map<string, LayerBuffer> {
  const out = new Map<string, LayerBuffer>()
  for (const layer of patch.layers) {
    const id = layer.source.bufferId || ''
    if (!id || out.has(id)) continue
    const asset = assets.get(id)
    const channel = asset?.channels[0]
    if (asset && channel) out.set(id, { sampleRate: asset.sampleRate, channel })
  }
  return out
}

export function renderLayerNotes(
  patch: LayerPatch,
  events: LayerNoteEvent[],
  sampleRate: number,
  length: number,
  buffers = new Map<string, LayerBuffer>(),
  quality: 'full' | 'eco' = 'full',
) {
  const left = new Float32Array(Math.max(0, length | 0))
  const right = new Float32Array(left.length)
  if (!left.length) return [left, right] as [Float32Array, Float32Array]
  const runtime = new LayerRuntime(sampleRate)
  const sorted = events.slice().sort((a, b) => a.sample - b.sample || a.vel - b.vel)
  let cursor = 0
  let index = 0
  while (cursor < left.length) {
    while (index < sorted.length && sorted[index].sample <= cursor) {
      const event = sorted[index]
      index += 1
      runtime.note(event.pitch, event.vel, patch.polyphony || 8)
    }
    const next = index < sorted.length ? Math.min(left.length, Math.max(cursor + 1, sorted[index].sample)) : left.length
    const frames = Math.max(1, Math.min(4096, next - cursor))
    const block = runtime.render(patch, frames, quality, buffers)
    left.set(block[0], cursor)
    right.set(block[1], cursor)
    cursor += frames
  }
  return [left, right] as [Float32Array, Float32Array]
}
