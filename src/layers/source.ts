import { defaults } from '../model/rack'
import { renderTone, type FxBus, type PlayVoice, type ToneCtx } from '../audio/rack/synth'
import { hermite, clamp, flush } from './dsp'
import {
  ANALOG_PARAMS,
  FM_PARAMS,
  GRAIN_PARAMS,
  SAMPLE_PARAMS,
  WAVE_PARAMS,
  registerParamList,
  sourceKey,
  type LayerParam,
  type LayerSourceSpec,
} from './types'

/**
 * One generator inside a layer voice.
 * The multi-sample engine can register its own factory later. This module
 * does not import that work. Synth layers call the existing analog, wavetable,
 * and FM engines. Sample layers follow the current sampler's root / loop / tune
 * model (rate = 2^((tune + note - root) / 12), loop modes 0 loop, 1 ping-pong, 2 one-shot).
 */
export interface LayerNote {
  pitch: number
  velocity: number
  released: boolean
}

export interface SourceContext {
  sampleRate: number
  time: number
  quality: 'full' | 'eco'
  buffer: Float32Array | null
  bufferRate: number
}

export interface LayerSourceVoice {
  start(note: LayerNote, params: Record<string, number>, ctx: SourceContext): void
  render(note: LayerNote, params: Record<string, number>, ctx: SourceContext): number
  release(): void
}

export interface LayerSourceFactory {
  kind: string
  params: LayerParam[]
  create(sampleRate: number): LayerSourceVoice
}

const factories = new Map<string, LayerSourceFactory>()

export function registerLayerSource(factory: LayerSourceFactory) {
  factories.set(factory.kind, factory)
  registerParamList(factory.kind, factory.params)
}

export function createLayerVoice(spec: LayerSourceSpec, sampleRate: number): LayerSourceVoice {
  const factory = factories.get(sourceKey(spec))
  return factory ? factory.create(sampleRate) : silentVoice()
}

function silentVoice(): LayerSourceVoice {
  return { start() {}, render() { return 0 }, release() {} }
}

function emptyFx(): FxBus {
  return { phase: 0, delay: new Float32Array(8), delayPos: 0, combs: [], combPos: [], low: 0, band: 0 }
}

const ANALOG_BASE = defaults('sub')
const WAVE_BASE = defaults('wave')
const FM_BASE = defaults('fm')

function createSynth(engine: 'analog' | 'wavetable' | 'fm', sampleRate: number): LayerSourceVoice {
  const play: PlayVoice = {
    note: 60,
    vel: 1,
    bend: 0,
    pressure: 0,
    glideFrom: 60,
    released: false,
    active: true,
    synth: {},
  }
  const voices = [play]
  const fx = emptyFx()
  const kind = engine === 'fm' ? 'fm' : engine === 'wavetable' ? 'wave' : 'sub'
  const base = engine === 'fm' ? FM_BASE : engine === 'wavetable' ? WAVE_BASE : ANALOG_BASE
  const params = { ...base }
  const ctx: ToneCtx = {
    sr: sampleRate,
    time: 0,
    quality: 'full',
    params,
    voices,
    played: (voice) => voice.note,
    table: null,
    fx,
    publish: () => {},
    deviceId: `layer-${engine}`,
  }
  const open = () => {
    params.attack = 0
    params.decay = 1
    params.sustain = 1
    params.release = 8000
    params.cutoff = 18000
    params.res = 0
    params.famt = 0
    params.fattack = 0
    params.fdecay = 1
    params.fsustain = 1
    params.frelease = 8000
    params.mattack = 0
    params.mdecay = 1
    params.msustain = 1
    params.mrelease = 8000
    params.fxChor = 0
    params.fxDel = 0
    params.fxRev = 0
    params.fxDrv = 0
    params.glide = 0
    params.m1d = 0
    params.m2d = 0
    params.m3d = 0
    params.m4d = 0
    params.mod1amt = 0
    params.mod2amt = 0
    params.mod3amt = 0
    params.mod4amt = 0
  }
  return {
    start(note) {
      play.note = note.pitch
      play.glideFrom = note.pitch
      play.vel = 1
      play.bend = 0
      play.pressure = 0
      play.released = false
      play.active = true
      play.synth = {}
      ctx.time = 0
    },
    render(note, src, renderCtx) {
      Object.assign(params, base)
      open()
      play.note = note.pitch
      play.active = true
      play.released = false
      play.vel = 1
      ctx.quality = renderCtx.quality
      ctx.time += 1
      if (engine === 'fm') {
        params.ratio = src.ratio ?? 2
        params.index = src.index ?? 1.2
        params.algo = src.algo ?? 0
        params.feedback = src.feedback ?? 0
        params.lv3 = 0
        params.lv4 = 0
        params.lv5 = 0
        params.lv6 = 0
      } else if (engine === 'wavetable') {
        params.table = src.table ?? 0
        params.position = src.position ?? 0
        params.warp = src.warp ?? 0
        params.warpAmt = src.warpAmt ?? 0
        params.uni = src.uni ?? 1
        params.uniDet = 8
      } else {
        params.wave1 = src.wave ?? 0
        params.wave2 = 1
        params.mix1 = 0.75
        params.mix2 = src.mix2 ?? 0
        params.mix3 = 0
        params.detune = src.detune ?? 0
        params.pw = src.pw ?? 0.5
        params.uni = src.uni ?? 1
        params.uniDet = 8
        params.sync = 0
        params.ring = 0
        params.drive = 0
      }
      const raw = renderTone(kind, ctx)
      const scale = kind === 'fm' ? 0.2 : 0.22
      return flush(raw / scale)
    },
    release() {
      play.released = true
    },
  }
}

interface SamplePlay {
  pos: number
  dir: number
  ended: boolean
}

function createSample(sampleRate: number): LayerSourceVoice {
  const play: SamplePlay = { pos: 0, dir: 1, ended: false }
  const place = (params: Record<string, number>, ctx: SourceContext) => {
    const data = ctx.buffer
    if (!data || data.length < 2) return null
    const start = clamp(params.start ?? 0, 0, 0.98) * (data.length - 1)
    const end = Math.max(start + 2, clamp(params.end ?? 1, 0, 1) * (data.length - 1))
    return { data, start, end }
  }
  return {
    start(_note, params, ctx) {
      const region = place(params, ctx)
      play.pos = region?.start ?? 0
      play.dir = 1
      play.ended = !region
    },
    render(note, params, ctx) {
      const region = place(params, ctx)
      if (!region || play.ended) return 0
      const { data, start, end } = region
      const semis = (params.tune ?? 0) + (note.pitch - (params.root ?? 60))
      const rate = 2 ** (semis / 12) * ((ctx.bufferRate || sampleRate) / sampleRate)
      const mode = Math.max(0, Math.min(2, Math.round(params.loop ?? 0)))
      const fade = Math.max(0, (params.crossfade ?? 0) * (end - start))
      let sample = hermite(data, play.pos)
      if (mode === 0 && fade > 2 && play.pos > end - fade) {
        const t = (play.pos - (end - fade)) / fade
        const looped = hermite(data, start + (play.pos - (end - fade)))
        sample = sample * (1 - t) + looped * t
      }
      if (mode === 2) {
        play.pos += Math.abs(rate)
        if (play.pos >= end) play.ended = true
      } else if (mode === 1) {
        play.pos += play.dir * Math.abs(rate)
        if (play.pos >= end) {
          play.pos = end
          play.dir = -1
        } else if (play.pos <= start) {
          play.pos = start
          play.dir = 1
        }
      } else {
        play.pos += Math.abs(rate)
        const span = Math.max(1, end - start)
        if (play.pos >= end) play.pos = start + ((play.pos - start) % span)
      }
      return flush(sample)
    },
    release() {
      play.ended = true
    },
  }
}

interface Grain {
  active: boolean
  pos: number
  step: number
  phase: number
  window: number
}

function createGranular(sampleRate: number): LayerSourceVoice {
  const grains: Grain[] = Array.from({ length: 8 }, () => ({ active: false, pos: 0, step: 1, phase: 0, window: 1 }))
  let spawn = 0
  let rng = 1
  const next = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
    return rng / 4294967296
  }
  return {
    start(note) {
      for (const grain of grains) grain.active = false
      spawn = 0
      rng = Math.max(1, Math.round(note.pitch) + 1)
    },
    render(note, params, ctx) {
      const data = ctx.buffer
      if (!data || data.length < 8) return 0
      const sizeMs = clamp(params.size ?? 80, 8, 500)
      const size = Math.max(8, Math.round((sizeMs / 1000) * sampleRate))
      const density = clamp(params.density ?? 12, 0.2, 48)
      const cap = ctx.quality === 'eco' ? 4 : 8
      spawn += density / sampleRate
      let active = grains.reduce((sum, grain) => sum + (grain.active ? 1 : 0), 0)
      while (spawn >= 1 && active < cap) {
        spawn -= 1
        const slot = grains.find((grain) => !grain.active)
        if (!slot) break
        const position = clamp(params.position ?? 0.25, 0, 1)
        const spray = clamp(params.spray ?? 0, 0, 1)
        const center = position * Math.max(0, data.length - size)
        const jitter = (next() * 2 - 1) * spray * data.length * 0.45
        slot.pos = clamp(center + jitter, 0, data.length - 2)
        const semis = (params.pitch ?? 0) + (note.pitch - (params.root ?? 60))
        const spread = (next() * 2 - 1) * clamp(params.spread ?? 0, 0, 1) * 8
        const reverse = (params.reverse ?? 0) >= 0.5 ? -1 : 1
        slot.step = reverse * 2 ** ((semis + spread) / 12) * ((ctx.bufferRate || sampleRate) / sampleRate)
        slot.phase = 0
        slot.window = 1 / size
        slot.active = true
        active += 1
      }
      if (spawn > 2) spawn = 2
      let sum = 0
      for (const grain of grains) {
        if (!grain.active) continue
        const window = 0.5 * (1 - Math.cos(2 * Math.PI * Math.min(0.999, grain.phase)))
        sum += hermite(data, grain.pos) * window
        grain.pos += grain.step
        grain.phase += grain.window
        if (grain.phase >= 1 || grain.pos < 1 || grain.pos >= data.length - 2) grain.active = false
      }
      const overlap = Math.max(1, density * (sizeMs / 1000))
      return flush(sum / Math.sqrt(overlap))
    },
    release() {
      for (const grain of grains) grain.active = false
    },
  }
}

registerLayerSource({ kind: 'synth:analog', params: ANALOG_PARAMS, create: (sampleRate) => createSynth('analog', sampleRate) })
registerLayerSource({ kind: 'synth:wavetable', params: WAVE_PARAMS, create: (sampleRate) => createSynth('wavetable', sampleRate) })
registerLayerSource({ kind: 'synth:fm', params: FM_PARAMS, create: (sampleRate) => createSynth('fm', sampleRate) })
registerLayerSource({ kind: 'sample', params: SAMPLE_PARAMS, create: (sampleRate) => createSample(sampleRate) })
registerLayerSource({ kind: 'granular', params: GRAIN_PARAMS, create: (sampleRate) => createGranular(sampleRate) })
