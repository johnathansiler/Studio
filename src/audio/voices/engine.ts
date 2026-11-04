/** Beat Machine pad voices. The same rules run in `core/dsp/src/voice.rs`. */

import { wasmDspRequested } from '../wasm/flag'

export const MAX_PADS = 16
export const SP1200 = { bitDepth: 12, sampleRate: 26040 }
export const MPC60 = { bitDepth: 12, sampleRate: 40000 }

const GRAIN = 1024
const HOP = 512
const TAU = Math.PI * 2

export interface VintageStage {
  bitDepth?: number
  sampleRate?: number
  wow?: number
  flutter?: number
  noise?: number
  crackle?: number
  lowpass?: number
}

export type PitchMode = 'vinyl' | 'stretch'

interface Region {
  sampleId: number
  start: number
  end: number
  fadeIn: number
  fadeOut: number
  reverse: boolean
  hold: boolean
  semis: number
  cents: number
  stretch: boolean
  highpass: number
  lowpass: number
  choke: number
  swing: number
  level: number
  pan: number
  vintage: Required<VintageStage>
}

interface Slot {
  samples: Float32Array
  fileRate: number
}

interface Playing {
  active: boolean
  released: boolean
  pad: number
  cursor: number
  wait: number
  env: number
  rateTime: number
  ratePitch: number
  stretch: boolean
  hp: number
  hpX: number
  lp: number
  vintLp: number
  hpA: number
  lpA: number
  vintA: number
  held: number
  holdLeft: number
  holdN: number
  bits: number
  wow: number
  flutter: number
  noise: number
  crackle: number
  seed: number
  time: number
  velocity: number
  releaseSamples: number
}

function emptyRegion(): Region {
  return {
    sampleId: 0, start: 0, end: 0, fadeIn: 32, fadeOut: 32, reverse: false, hold: false,
    semis: 0, cents: 0, stretch: false, highpass: 0, lowpass: 0, choke: 0, swing: 0,
    level: 1, pan: 0, vintage: { bitDepth: 0, sampleRate: 0, wow: 0, flutter: 0, noise: 0, crackle: 0, lowpass: 0 },
  }
}

function idle(): Playing {
  return {
    active: false, released: false, pad: 0, cursor: 0, wait: 0, env: 1, rateTime: 1, ratePitch: 1, stretch: false,
    hp: 0, hpX: 0, lp: 0, vintLp: 0, hpA: 0, lpA: 0, vintA: 0, held: 0, holdLeft: 0, holdN: 1,
    bits: 0, wow: 0, flutter: 0, noise: 0, crackle: 0, seed: 1, time: 0, velocity: 1, releaseSamples: 1,
  }
}

function sane(rate: number) {
  return Number.isFinite(rate) && rate > 0 ? rate : 48000
}

function pole(freq: number, sampleRate: number) {
  if (!(freq > 1)) return 0
  const limited = Math.min(freq, sampleRate * 0.45)
  return 1 - Math.exp(-TAU * limited / sampleRate)
}

function wobbleOf(wow: number, flutter: number, time: number) {
  return 1 + wow * 0.015 * Math.sin(TAU * 0.55 * time) + flutter * 0.004 * Math.sin(TAU * 7.1 * time)
}

function readLinear(buffer: Float32Array, at: number) {
  if (buffer.length < 2 || !Number.isFinite(at)) return 0
  if (at <= 0) return buffer[0] || 0
  const last = buffer.length - 1
  if (at >= last) return buffer[last] || 0
  const index = Math.floor(at)
  const frac = at - index
  return (buffer[index] || 0) + ((buffer[index + 1] || 0) - (buffer[index] || 0)) * frac
}

function hann(phase: number) {
  if (phase <= 0 || phase >= 1) return 0
  return 0.5 - 0.5 * Math.cos(TAU * phase)
}

function stretchRead(buffer: Float32Array, start: number, end: number, playhead: number, pitch: number, reverse: boolean) {
  const local = playhead % HOP
  const base = playhead - local
  const posA = reverse ? (end - 1 - base) - local * pitch : start + base + local * pitch
  const posB = reverse ? (end - 1 - (base - HOP)) - (local + HOP) * pitch : start + (base - HOP) + (local + HOP) * pitch
  const winA = hann(local / GRAIN)
  const winB = hann((local + HOP) / GRAIN)
  const norm = winA + winB
  if (norm <= 1e-9) return readLinear(buffer, reverse ? end - 1 - playhead : start + playhead)
  return (readLinear(buffer, posA) * winA + readLinear(buffer, posB) * winB) / norm
}

function edgeGain(cursor: number, span: number, fadeIn: number, fadeOut: number) {
  let gain = 1
  if (fadeIn > 0 && cursor < fadeIn) gain *= Math.max(0, cursor / fadeIn)
  const remain = span - cursor
  if (fadeOut > 0 && remain < fadeOut) gain *= Math.max(0, remain / fadeOut)
  return gain
}

function clip(sample: number) {
  if (!Number.isFinite(sample)) return 0
  return Math.max(-1, Math.min(1, sample))
}

/** One pool. `pad(n)` is stable for pads 0..15, the two banks of eight. */
export class SamplePool {
  private readonly rate: number
  private readonly slots: (Slot | null)[] = Array.from({ length: 32 }, () => null)
  private readonly pads: Region[] = Array.from({ length: MAX_PADS }, emptyRegion)
  private readonly voices: Playing[] = Array.from({ length: 16 }, idle)
  private readonly hits: { offset: number; pad: number; velocity: number }[] = []

  constructor(sampleRate: number) {
    this.rate = sane(sampleRate)
  }

  load(id: number, data: Float32Array, fileRate = this.rate) {
    if (id < 1 || id > 32) return
    const rate = Number.isFinite(fileRate) && fileRate > 0 ? fileRate : this.rate
    this.slots[id - 1] = { samples: data, fileRate: rate }
  }

  pad(index: number): Pad {
    return new Pad(this, index)
  }

  note(offset: number, pad: number, velocity: number) {
    if (pad < 0 || pad >= MAX_PADS || this.hits.length >= 64) return
    const hit = { offset, pad, velocity }
    let at = this.hits.length
    this.hits.push(hit)
    while (at > 0 && this.hits[at - 1].offset > hit.offset) {
      this.hits[at] = this.hits[at - 1]
      at -= 1
    }
    this.hits[at] = hit
  }

  process(left: Float32Array, right: Float32Array) {
    const frames = Math.min(left.length, right.length)
    let hit = 0
    for (let index = 0; index < frames; index++) {
      while (hit < this.hits.length && this.hits[hit].offset <= index) {
        this.fire(this.hits[hit].pad, this.hits[hit].velocity)
        hit += 1
      }
      let mixL = 0
      let mixR = 0
      for (let voice = 0; voice < this.voices.length; voice++) {
        const pair = this.tick(voice)
        if (!pair) continue
        mixL += pair[0]
        mixR += pair[1]
      }
      left[index] = clip(mixL)
      right[index] = clip(mixR)
    }
    this.hits.length = 0
  }

  reset() {
    this.hits.length = 0
    for (let i = 0; i < this.voices.length; i++) this.voices[i] = idle()
  }

  /** @internal */
  region(index: number) {
    return this.pads[index]
  }

  private fire(pad: number, velocity: number) {
    const region = this.pads[pad]
    if (!region) return
    if (velocity <= 0.0001) {
      if (!region.hold) return
      for (const voice of this.voices) if (voice.active && voice.pad === pad) voice.released = true
      return
    }
    if (region.choke > 0) {
      for (const voice of this.voices) {
        if (voice.active && this.pads[voice.pad]?.choke === region.choke) voice.released = true
      }
    }
    const fileRate = this.slots[region.sampleId - 1]?.fileRate ?? this.rate
    const slot = this.claim(pad)
    const timeRate = fileRate / this.rate
    const semis = region.semis + region.cents / 100
    const pitch = 2 ** (semis / 12)
    const voice = idle()
    voice.active = true
    voice.pad = pad
    voice.wait = region.swing
    voice.rateTime = Number.isFinite(timeRate) && timeRate > 0 ? timeRate : 1
    voice.ratePitch = Number.isFinite(pitch) && pitch > 0 ? pitch : 1
    voice.stretch = region.stretch
    voice.velocity = Math.max(0, Math.min(1, velocity))
    voice.releaseSamples = Math.max(1, this.rate * 0.05)
    voice.hpA = pole(region.highpass, this.rate)
    voice.lpA = pole(region.lowpass, this.rate)
    voice.vintA = pole(region.vintage.lowpass, this.rate)
    voice.holdN = region.vintage.sampleRate > 100 ? Math.max(1, Math.min(64, Math.round(this.rate / region.vintage.sampleRate))) : 1
    voice.bits = region.vintage.bitDepth
    voice.wow = Math.max(0, Math.min(1, region.vintage.wow))
    voice.flutter = Math.max(0, Math.min(1, region.vintage.flutter))
    voice.noise = Math.max(0, Math.min(1, region.vintage.noise))
    voice.crackle = Math.max(0, Math.min(1, region.vintage.crackle))
    voice.seed = (0x12345678 ^ Math.imul(pad, 0x9E3779B9)) >>> 0
    this.voices[slot] = voice
  }

  private claim(pad: number) {
    for (let i = 0; i < this.voices.length; i++) if (this.voices[i].active && this.voices[i].pad === pad) return i
    for (let i = 0; i < this.voices.length; i++) if (!this.voices[i].active) return i
    let oldest = 0
    for (let i = 1; i < this.voices.length; i++) if (this.voices[i].cursor > this.voices[oldest].cursor) oldest = i
    return oldest
  }

  private tick(index: number): [number, number] | null {
    const voice = this.voices[index]
    if (!voice.active) return null
    if (voice.wait > 0) {
      voice.wait -= 1
      return null
    }
    const region = this.pads[voice.pad]
    const buffer = this.slots[region.sampleId - 1]?.samples
    if (!buffer) {
      voice.active = false
      return null
    }
    const length = buffer.length
    const start = region.start
    const end = Math.min(region.end, length)
    const span = end - start
    if (span < 2 || voice.cursor >= span - 1) {
      voice.active = false
      return null
    }
    if (voice.released) {
      voice.env -= 1 / voice.releaseSamples
      if (voice.env <= 0) {
        voice.active = false
        return null
      }
    }
    const wobble = wobbleOf(voice.wow, voice.flutter, voice.time)
    const raw = voice.stretch
      ? stretchRead(buffer, start, end, voice.cursor, voice.ratePitch * wobble, region.reverse)
      : region.reverse
        ? readLinear(buffer, end - 1 - voice.cursor)
        : readLinear(buffer, start + voice.cursor)
    let sample = raw * edgeGain(voice.cursor, span, region.fadeIn, region.fadeOut)
    if (voice.holdLeft <= 0) {
      voice.held = sample
      voice.holdLeft = voice.holdN
    }
    voice.holdLeft -= 1
    sample = voice.held
    if (voice.bits >= 2 && voice.bits <= 16) {
      const steps = 2 ** (voice.bits - 1)
      sample = Math.floor(sample * steps + 0.5) / steps
      sample = Math.max(-1, Math.min(1, sample))
    }
    if (voice.hpA > 0) {
      const next = voice.hpA * (voice.hp + sample - voice.hpX)
      voice.hpX = sample
      voice.hp = next
      sample = next
    }
    if (voice.lpA > 0) {
      voice.lp += voice.lpA * (sample - voice.lp)
      sample = voice.lp
    }
    if (voice.vintA > 0) {
      voice.vintLp += voice.vintA * (sample - voice.vintLp)
      sample = voice.vintLp
    }
    voice.seed = (Math.imul(voice.seed, 1664525) + 1013904223) >>> 0
    if (voice.noise > 0) {
      const unit = ((voice.seed >>> 8) & 65535) / 32768 - 1
      sample += unit * voice.noise * 0.15
    }
    if (voice.crackle > 0 && (voice.seed % 4096) < voice.crackle * 80) {
      sample += (voice.seed & 1) === 0 ? 0.45 : -0.45
    }
    const step = voice.stretch ? voice.rateTime : voice.rateTime * voice.ratePitch * wobble
    voice.time += 1 / this.rate
    voice.cursor += step
    const gain = sample * voice.env * voice.velocity * Math.max(0, Math.min(1, region.level))
    const angle = (Math.max(-1, Math.min(1, region.pan)) + 1) * Math.PI / 4
    return [gain * Math.cos(angle), gain * Math.sin(angle)]
  }
}

/** Stable names the chop UI calls. Pads 0..15 cover both banks. */
export class Pad {
  constructor(private readonly pool: SamplePool, private readonly index: number) {}

  setRegion(sampleId: number, start: number, end: number) {
    const region = this.pool.region(this.index)
    if (!region) return
    region.sampleId = sampleId
    region.start = start | 0
    region.end = end | 0
    if (region.fadeIn === 0 && region.fadeOut === 0) {
      region.fadeIn = 32
      region.fadeOut = 32
    }
  }

  setFade(fadeIn: number, fadeOut: number) {
    const region = this.pool.region(this.index)
    if (!region) return
    region.fadeIn = fadeIn | 0
    region.fadeOut = fadeOut | 0
  }

  setPitch(semis: number, cents: number, mode: PitchMode) {
    const region = this.pool.region(this.index)
    if (!region) return
    region.semis = semis
    region.cents = cents
    region.stretch = mode === 'stretch'
  }

  setVintage(stage: VintageStage) {
    const region = this.pool.region(this.index)
    if (!region) return
    region.vintage = {
      bitDepth: stage.bitDepth ?? 0,
      sampleRate: stage.sampleRate ?? 0,
      wow: stage.wow ?? 0,
      flutter: stage.flutter ?? 0,
      noise: stage.noise ?? 0,
      crackle: stage.crackle ?? 0,
      lowpass: stage.lowpass ?? 0,
    }
  }

  setFilter(highpass: number, lowpass: number) {
    const region = this.pool.region(this.index)
    if (!region) return
    region.highpass = highpass
    region.lowpass = lowpass
  }

  setChokeGroup(group: number) {
    const region = this.pool.region(this.index)
    if (region) region.choke = group | 0
  }

  setReverse(on: boolean) {
    const region = this.pool.region(this.index)
    if (region) region.reverse = on
  }

  /** Hold gates the sample. One shot plays the region through. */
  setHold(on: boolean) {
    const region = this.pool.region(this.index)
    if (region) region.hold = on
  }

  /** Extra delay, in samples, before this pad's hits speak. */
  setSwing(samples: number) {
    const region = this.pool.region(this.index)
    if (region) region.swing = Math.max(0, samples | 0)
  }

  setLevel(level: number, pan: number) {
    const region = this.pool.region(this.index)
    if (!region) return
    region.level = level
    region.pan = pan
  }
}

let wasmFactory: ((sampleRate: number) => SamplePool) | null = null

/** The WASM bridge registers this after the DSP chunk loads. A miss uses TypeScript. */
export function registerWasmPool(factory: (sampleRate: number) => SamplePool) {
  wasmFactory = factory
}

export function createSamplePool(sampleRate: number): SamplePool {
  if (wasmDspRequested() && wasmFactory) {
    try { return wasmFactory(sampleRate) } catch { /* TypeScript fallback */ }
  }
  return new SamplePool(sampleRate)
}
