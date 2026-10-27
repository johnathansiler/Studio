/** Knock — a trap bass instrument. Original sound, not a sample-pack clone. */

export const KNOCK_NAME = 'Knock'

export const SCALE_NAMES = ['Major', 'Minor', 'Dorian', 'Mixolydian', 'Harmonic minor'] as const
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const
export const DRIVE_NAMES = ['Soft', 'Hard', 'Tube', 'Tape', 'Fuzz', 'Crush', 'Fold', 'Rectify'] as const
export const CLICK_NAMES = ['Off', 'Click', 'Top', 'Sample'] as const

const SCALES: number[][] = [
  [0, 2, 4, 5, 7, 9, 11],
  [0, 2, 3, 5, 7, 8, 10],
  [0, 2, 3, 5, 7, 9, 10],
  [0, 2, 4, 5, 7, 9, 10],
  [0, 2, 3, 5, 7, 8, 11],
]

/** Butterworth Q for an 8th-order lowpass, one value per biquad. */
const BUTTER_Q = [0, 1, 2, 3].map((k) => 1 / (2 * Math.sin(((2 * k + 1) * Math.PI) / 16)))

export interface KnockEvent {
  sample: number
  pitch: number
  vel: number
  slide?: boolean
}

export interface KnockBuffers {
  samples?: Float32Array | null
  samplesR?: Float32Array | null
  sampleRate?: number
  sidechain?: Float32Array | null
  quality?: 'full' | 'eco'
}

interface Crush {
  hold: number
  n: number
}

interface OsState {
  os: number
  sr: number
  coeffs: number[][]
  mem: Float64Array
  xover: number
  pre: number
  post: number
  low: number
  band: number
  crush: Crush
}

export interface KnockVoice {
  gen: number
  live: boolean
  stage: 'a' | 'h' | 'd' | 's' | 'r'
  envPos: number
  amp: number
  phase: number
  subPhase: number
  glideFrom: number
  glideTo: number
  glidePos: number
  glideLen: number
  pitchAge: number
  midiNow: number
  clickAge: number
  clickPhase: number
  samplePos: number
  vel: number
  bound: number
  boundSr: number
  detected: number
  dcX: number
  dcY: number
  lim: number
  duck: number
  monoL: number
  monoR: number
  os: OsState
}

export function createKnockVoice(): KnockVoice {
  return {
    gen: -1,
    live: false,
    stage: 'a',
    envPos: 0,
    amp: 0,
    phase: 0,
    subPhase: 0,
    glideFrom: 36,
    glideTo: 36,
    glidePos: 0,
    glideLen: 0,
    pitchAge: 0,
    midiNow: 36,
    clickAge: 0,
    clickPhase: 0,
    samplePos: 0,
    vel: 0.8,
    bound: -1,
    boundSr: 0,
    detected: 36,
    dcX: 0,
    dcY: 0,
    lim: 1,
    duck: 0,
    monoL: 0,
    monoR: 0,
    os: {
      os: 0,
      sr: 0,
      coeffs: [],
      mem: new Float64Array(8),
      xover: 0,
      pre: 0,
      post: 0,
      low: 0,
      band: 0,
      crush: { hold: 0, n: 0 },
    },
  }
}

const voices = new WeakMap<object, KnockVoice>()

export function knockVoice(key: object) {
  let state = voices.get(key)
  if (!state) {
    state = createKnockVoice()
    voices.set(key, state)
  }
  return state
}

export function midiHz(note: number) {
  return 440 * 2 ** ((note - 69) / 12)
}

export function glideCurve(t: number, curve: number) {
  const x = Math.min(1, Math.max(0, t))
  if (curve >= 1.5) return x * x * (3 - 2 * x)
  if (curve >= 0.5) return 1 - (1 - x) ** 2
  return x
}

export function glideSamples(params: Record<string, number>, sampleRate: number, beatSamples: number) {
  if ((params.gsync || 0) >= 0.5) return Math.max(1, Math.round((params.gbeats || 0.25) * beatSamples))
  return Math.max(0, Math.round(((params.glide || 0) / 1000) * sampleRate))
}

export function snapMidi(note: number, root: number, scaleIndex: number, enabled: boolean) {
  if (!enabled) return note
  const scale = SCALES[Math.max(0, Math.min(SCALES.length - 1, Math.round(scaleIndex)))] || SCALES[0]
  const rounded = Math.round(note)
  const pc = ((rounded % 12) + 12) % 12
  const rel = (pc - (((Math.round(root) % 12) + 12) % 12) + 12) % 12
  let best = scale[0]
  let dist = 99
  for (const deg of scale) {
    const d = Math.min((deg - rel + 12) % 12, (rel - deg + 12) % 12)
    if (d < dist) {
      dist = d
      best = deg
    }
  }
  const snappedPc = (((Math.round(root) % 12) + 12) % 12 + best) % 12
  let snapped = rounded - pc + snappedPc
  if (snapped - note > 6) snapped -= 12
  if (note - snapped > 6) snapped += 12
  return snapped
}

export function knockPadPitch(index: number, root: number, scaleIndex: number, base = 24) {
  const scale = SCALES[Math.max(0, Math.min(SCALES.length - 1, Math.round(scaleIndex)))] || SCALES[0]
  const oct = Math.floor(index / scale.length)
  const deg = ((index % scale.length) + scale.length) % scale.length
  return base + (((Math.round(root) % 12) + 12) % 12) + scale[deg] + oct * 12
}

export function noteLabel(midi: number) {
  const rounded = Math.round(midi)
  const cents = Math.round((midi - rounded) * 100)
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12]
  const oct = Math.floor(rounded / 12) - 1
  const sign = cents > 0 ? `+${cents}` : `${cents}`
  return `${name}${oct} ${sign}c`
}

export function detectPitch(samples: Float32Array, sampleRate: number) {
  if (samples.length < 64 || sampleRate < 1000) return { hz: 0, midi: 0 }
  const step = Math.max(1, Math.floor(sampleRate / 12000))
  const n = Math.min(16000, Math.floor(samples.length / step))
  const buf = new Float32Array(n)
  let mean = 0
  for (let i = 0; i < n; i++) mean += samples[i * step] || 0
  mean /= n
  for (let i = 0; i < n; i++) buf[i] = (samples[i * step] || 0) - mean
  const sr = sampleRate / step
  const minLag = Math.max(2, Math.floor(sr / 500))
  const maxLag = Math.min(n - 2, Math.floor(sr / 28))
  if (maxLag <= minLag) return { hz: 0, midi: 0 }
  const corr = new Float32Array(maxLag + 1)
  let best = -Infinity
  let bestLag = minLag
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    const end = n - lag
    for (let i = 0; i < end; i += 2) sum += buf[i] * buf[i + lag]
    corr[lag] = sum
    if (sum > best) {
      best = sum
      bestLag = lag
    }
  }
  const gate = best * 0.9
  let chosen = bestLag
  for (let lag = minLag + 1; lag <= bestLag; lag++) {
    if (corr[lag] >= gate && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      chosen = lag
      break
    }
  }
  const c0 = corr[Math.max(minLag, chosen - 1)] || 0
  const c1 = corr[chosen] || 0
  const c2 = corr[Math.min(maxLag, chosen + 1)] || 0
  const denom = c0 - 2 * c1 + c2
  const shift = Math.abs(denom) < 1e-12 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (c0 - c2)) / denom))
  const hz = sr / (chosen + shift)
  if (!Number.isFinite(hz) || hz < 20) return { hz: 0, midi: 0 }
  return { hz, midi: 69 + 12 * Math.log2(hz / 440) }
}

function designLP(fc: number, q: number, fs: number) {
  const w0 = (2 * Math.PI * fc) / fs
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const alpha = sin / (2 * q)
  const b0 = (1 - cos) / 2
  const b1 = 1 - cos
  const b2 = (1 - cos) / 2
  const a0 = 1 + alpha
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0]
}

function ensureOs(os: OsState, sampleRate: number, factor: number) {
  if (os.os === factor && os.sr === sampleRate && os.coeffs.length === 4) return
  os.os = factor
  os.sr = sampleRate
  const fs = sampleRate * factor
  const fc = Math.min(9000, sampleRate * 0.42)
  os.coeffs = BUTTER_Q.map((q) => designLP(fc, q, fs))
  os.mem.fill(0)
}

function aa(os: OsState, x: number) {
  let y = x
  const z = os.mem
  for (let i = 0; i < 4; i++) {
    const c = os.coeffs[i]
    const o = i * 2
    const out = c[0] * y + z[o]
    z[o] = c[1] * y - c[3] * out + z[o + 1]
    z[o + 1] = c[2] * y - c[4] * out
    y = out
  }
  return y
}

function shape(x: number, type: number, drive: number, crush: Crush) {
  // Gain stays moderate so the harmonics die before the 8× Nyquist and cannot fold back.
  const g = 1 + Math.max(0, drive) * 6
  const y = x * g
  const kind = Math.max(0, Math.min(7, Math.round(type)))
  if (kind === 0) return Math.tanh(y)
  if (kind === 1) {
    const s = Math.tanh(y)
    const s2 = s * s
    return s * (1.4 - 0.4 * s2)
  }
  if (kind === 2) return Math.tanh(y + 0.2 * y * Math.abs(y))
  if (kind === 3) {
    const sat = Math.tanh(y * 0.8)
    return sat - 0.12 * sat * sat * sat
  }
  if (kind === 4) {
    const s = Math.tanh(y)
    return Math.tanh(s * 3 + s * s * s * 6)
  }
  if (kind === 5) {
    const bits = Math.max(2, Math.round(12 - drive * 9))
    const steps = 2 ** bits
    const crushed = Math.round(Math.max(-1, Math.min(1, Math.tanh(y))) * steps) / steps
    const holdFor = Math.max(1, Math.round(1 + drive * 20))
    crush.n += 1
    if (crush.n >= holdFor) {
      crush.n = 0
      crush.hold = crushed
    }
    return crush.hold
  }
  if (kind === 6) {
    let v = y
    for (let i = 0; i < 8; i++) {
      if (v > 1) v = 2 - v
      else if (v < -1) v = -2 - v
      else break
    }
    return Math.max(-1, Math.min(1, v))
  }
  return Math.max(-1, Math.min(1, Math.abs(y) * 2 - 0.65))
}

function lpCoeff(hz: number, sr: number) {
  return 1 - Math.exp((-2 * Math.PI * Math.max(20, hz)) / sr)
}

/** Low band stays clean. High band takes the nonlinearity, then the 8× (or 4×) lowpass. */
export function driveAtOs(os: OsState, x: number, params: Record<string, number>, osRate: number) {
  const drive = params.drive || 0
  const mix = params.dmix ?? 1
  if (drive <= 0.0001 || mix <= 0.0001) return x
  const band = params.band ?? 1
  if (band < 0.5) {
    const wet = shape(x, params.dtype || 0, drive, os.crush)
    return x * (1 - mix) + wet * mix
  }
  const c = lpCoeff(params.xover || 90, osRate)
  os.xover += c * (x - os.xover)
  const low = os.xover
  const high = x - low
  const pre = lpCoeff(params.pre || 8000, osRate)
  os.pre += pre * (high - os.pre)
  const wet = shape(os.pre, params.dtype || 0, drive, os.crush)
  const post = lpCoeff(params.post || 12000, osRate)
  os.post += post * (wet - os.post)
  return low + high * (1 - mix) + os.post * mix
}

function bodyWave(phase: number, morph: number) {
  const p = phase - Math.floor(phase)
  const sine = Math.sin(2 * Math.PI * p)
  if (morph <= 0.001) return sine
  const tri = 4 * Math.abs(p - 0.5) - 1
  const rounded = Math.tanh(sine * (1.1 + morph * 5))
  if (morph < 0.5) {
    const t = morph / 0.5
    return sine * (1 - t) + tri * t
  }
  const t = (morph - 0.5) / 0.5
  return tri * (1 - t) + rounded * t
}

function svf(os: OsState, x: number, cutoff: number, res: number, osRate: number, highpass: boolean) {
  const f = 2 * Math.sin(Math.min(Math.PI * 0.22, (Math.PI * cutoff) / osRate))
  const q = Math.max(0.08, 1 - Math.max(0, Math.min(0.95, res)) * 0.9)
  os.low += f * os.band
  const high = x - os.low - q * os.band
  os.band += f * high
  if (Math.abs(os.low) < 1e-15) os.low = 0
  if (Math.abs(os.band) < 1e-15) os.band = 0
  return highpass ? high : os.low
}

function advanceAmp(state: KnockVoice, params: Record<string, number>, sampleRate: number, beatSamples: number, released: boolean) {
  if (released) {
    state.stage = 'r'
    const rel = Math.max(1, ((params.release || 180) / 1000) * sampleRate)
    state.amp *= Math.exp(-1 / rel)
    if (state.amp < 1e-5) state.amp = 0
    return state.amp
  }
  const attack = Math.max(0, ((params.attack || 0) / 1000) * sampleRate)
  const hold = Math.max(0, ((params.hold || 0) / 1000) * sampleRate)
  const decay = (params.tail || 0) >= 0.5
    ? Math.max(1, (params.tailBeats || 1) * beatSamples)
    : Math.max(1, ((params.decay || 400) / 1000) * sampleRate)
  const sustain = Math.max(0, Math.min(1, params.sustain ?? 0.6))
  if (state.stage === 'a') {
    if (attack < 1) {
      state.amp = 1
      state.stage = hold > 0 ? 'h' : 'd'
      state.envPos = 0
    } else {
      state.amp = Math.min(1, state.amp + 1 / attack)
      if (state.amp >= 1) {
        state.stage = hold > 0 ? 'h' : 'd'
        state.envPos = 0
      }
    }
  } else if (state.stage === 'h') {
    state.amp = 1
    state.envPos += 1
    if (state.envPos >= hold) {
      state.stage = 'd'
      state.envPos = 0
    }
  } else {
    state.amp += (sustain - state.amp) * (1 - Math.exp(-1 / decay))
    if (Math.abs(state.amp - sustain) < 1e-4) {
      state.amp = sustain
      state.stage = 's'
    }
  }
  return state.amp
}

export function knockNoteOn(state: KnockVoice, note: number, vel: number, slide: boolean, params: Record<string, number>, sampleRate: number, beatSamples: number) {
  const target = snapMidi(note, params.root || 0, params.scale || 0, (params.snap || 0) >= 0.5)
  const gliding = slide && state.live
  state.glideFrom = gliding ? state.midiNow : target
  state.glideTo = target
  state.glidePos = 0
  state.glideLen = gliding ? glideSamples(params, sampleRate, beatSamples) : 0
  state.pitchAge = 0
  state.vel = vel
  state.clickAge = 0
  state.clickPhase = 0
  if (!gliding) state.samplePos = 0
  if (!state.live || (params.attack || 0) > 2) {
    state.stage = 'a'
    state.envPos = 0
    if (!state.live) state.amp = (params.attack || 0) <= 0 ? 1 : 0
  } else if (!gliding) {
    state.stage = (params.hold || 0) > 0 ? 'h' : 'd'
    state.envPos = 0
  }
  state.live = true
  state.midiNow = state.glideFrom
}

function readMidi(state: KnockVoice, params: Record<string, number>, bend: number, sampleRate: number) {
  const len = state.glideLen
  const t = len <= 0 ? 1 : Math.min(1, state.glidePos / len)
  const base = state.glideFrom + (state.glideTo - state.glideFrom) * glideCurve(t, params.gcurve || 0)
  const pdec = Math.max(1, ((params.pdec || 40) / 1000) * sampleRate)
  const punch = (params.punch || 0) * (1 - glideCurve(Math.min(1, state.pitchAge / pdec), params.pcurve || 0))
  const range = Math.max(1, params.bend || 2)
  const bent = Math.max(-range, Math.min(range, bend))
  state.midiNow = base + punch + bent + (params.fine || 0) / 100
  if (state.glidePos < len) state.glidePos += 1
  else state.glidePos = len
  state.pitchAge += 1
  return state.midiNow
}

function hash(n: number) {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

function clickSample(state: KnockVoice, params: Record<string, number>, sampleRate: number, buffer: Float32Array | null) {
  const kind = Math.round(params.click || 0)
  const level = params.clevel ?? 0.3
  if (kind <= 0 || level <= 0) {
    state.clickAge += 1
    return 0
  }
  const dec = Math.max(1, ((params.cdec || 12) / 1000) * sampleRate)
  const env = Math.exp(-state.clickAge / dec)
  if (env < 1e-4) {
    state.clickAge += 1
    return 0
  }
  const tone = 900 + (params.ctone || 0.5) * 4200
  let sample = 0
  if (kind === 1) {
    sample = Math.sin(2 * Math.PI * state.clickPhase)
    state.clickPhase += tone / sampleRate
  } else if (kind === 2) {
    const n = hash(state.clickAge + 3) * 2 - 1
    const fade = Math.min(1, state.clickAge / 4)
    sample = n * fade
  } else if (buffer && buffer.length) {
    const index = state.clickAge
    const raw = buffer[index] || 0
    sample = index < 4 ? raw * (index / 4) : raw
  }
  state.clickAge += 1
  return sample * env * level
}

function dcBlock(state: KnockVoice, x: number) {
  const y = x - state.dcX + 0.995 * state.dcY
  state.dcX = x
  state.dcY = y
  return y
}

export function applyDuck(signal: number, kick: number, amount: number, state: { duck: number }, releaseSamples: number) {
  const rect = Math.abs(kick)
  if (rect > state.duck) state.duck = rect
  else state.duck += (rect - state.duck) * (1 - Math.exp(-1 / Math.max(1, releaseSamples)))
  const gain = 1 - Math.max(0, Math.min(1, amount)) * Math.min(1, state.duck * 3)
  return signal * gain
}

export function splitMonoBelow(left: number, right: number, state: { monoL: number; monoR: number }, hz: number, sampleRate: number) {
  const c = lpCoeff(hz, sampleRate)
  state.monoL += c * (left - state.monoL)
  state.monoR += c * (right - state.monoR)
  const low = 0.5 * (state.monoL + state.monoR)
  return [low + (left - state.monoL), low + (right - state.monoR)] as const
}

export function limitSample(state: KnockVoice, x: number, ceiling: number) {
  const cap = Math.max(0.05, Math.min(1, ceiling))
  const mag = Math.abs(x)
  if (mag > cap) state.lim = cap / mag
  else state.lim += (1 - state.lim) * 0.002
  if (state.lim > 1) state.lim = 1
  const y = x * state.lim
  return Math.max(-cap, Math.min(cap, y))
}

function flush(x: number) {
  if (!Number.isFinite(x) || Math.abs(x) < 1e-15) return 0
  return x
}

export interface KnockStep {
  mono: number
  delta: number
  midi: number
  done: boolean
}

export function knockStep(
  state: KnockVoice,
  params: Record<string, number>,
  sampleRate: number,
  beatSamples: number,
  released: boolean,
  bend: number,
  side: number,
  buffer: Float32Array | null,
  bufferR: Float32Array | null,
  bufferRate: number,
  quality: 'full' | 'eco',
): KnockStep {
  const factor = quality === 'eco' ? 4 : 8
  ensureOs(state.os, sampleRate, factor)
  const midi = readMidi(state, params, bend, sampleRate)
  const hz = midiHz(midi)
  const osRate = sampleRate * factor
  const useSample = (params.smode || 0) >= 0.5 && !!buffer && buffer.length > 8
  if (useSample && buffer && (state.bound !== buffer.length || state.boundSr !== bufferRate)) {
    state.bound = buffer.length
    state.boundSr = bufferRate
    state.detected = detectPitch(buffer, bufferRate).midi || 36
  }
  const root = (params.sroot || 0) > 1 ? params.sroot : state.detected
  const cutoff = Math.max(40, Math.min(18000, params.cutoff || 2400))
  const opened = cutoff * (1 + Math.max(0, params.fenv || 0) * 4 * Math.exp(-state.pitchAge / Math.max(1, ((params.decay || 300) / 1000) * sampleRate)))
  const phone = Math.max(0, Math.min(1, params.phone || 0))
  const subMix = Math.max(0, Math.min(1, params.sub || 0))
  const morph = Math.max(0, Math.min(1, params.morph || 0))
  let last = 0
  let high = 0
  for (let k = 0; k < factor; k++) {
    let raw = 0
    if (useSample && buffer) {
      const rate = 2 ** ((midi - root) / 12) * (bufferRate / sampleRate)
      const pos = state.samplePos
      const index = Math.floor(pos)
      const frac = pos - index
      const a = buffer[index] || 0
      const b = buffer[index + 1] || 0
      const left = index < 8 ? (a + (b - a) * frac) * (index / 8) : a + (b - a) * frac
      let right = left
      if (bufferR && bufferR.length) {
        const ar = bufferR[index] || 0
        const br = bufferR[index + 1] || 0
        right = ar + (br - ar) * frac
      }
      const [ml, mr] = splitMonoBelow(left, right, state, params.mono || 120, osRate)
      raw = (ml + mr) * 0.5
      high = mr - ml
      state.samplePos += rate / factor
      state.phase += hz / osRate
    } else {
      raw = bodyWave(state.phase, morph)
      if (subMix > 0) raw = raw * (1 - subMix * 0.4) + Math.sin(2 * Math.PI * state.subPhase) * subMix
      state.phase += hz / osRate
      state.subPhase += (hz * 0.5) / osRate
    }
    const filtered = svf(state.os, raw, Math.min(18000, opened), params.res || 0, osRate, (params.fmode || 0) >= 0.5)
    const harm = phone > 0 ? (Math.sin(2 * Math.PI * state.phase * 3) * 0.55 + Math.sin(2 * Math.PI * state.phase * 5) * 0.3) * phone : 0
    const driven = driveAtOs(state.os, filtered + harm, params, osRate)
    last = aa(state.os, driven)
  }
  const amp = advanceAmp(state, params, sampleRate, beatSamples, released)
  let y = last * amp * Math.max(0, Math.min(1.2, state.vel || 0.8))
  y += clickSample(state, params, sampleRate, buffer)
  y *= Math.max(0, params.level ?? 0.8) * (params.dout ?? 1)
  y = dcBlock(state, y)
  if ((params.duck || 0) > 0) y = applyDuck(y, side, params.duck || 0, state, ((params.duckRel || 80) / 1000) * sampleRate)
  y = limitSample(state, y, params.ceiling ?? 0.95)
  y = flush(y)
  const done = released && state.amp <= 0 && state.clickAge > 8
  return { mono: y, delta: flush(high * amp * 0.35), midi, done }
}

export function renderKnockBuffer(
  params: Record<string, number>,
  events: KnockEvent[],
  sampleRate: number,
  tempo: number,
  length: number,
  buffers: KnockBuffers = {},
) {
  const state = createKnockVoice()
  state.vel = 0.8
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  const midi = new Float32Array(length)
  const ordered = events.slice().sort((a, b) => a.sample - b.sample || b.vel - a.vel)
  const beatSamples = Math.max(1, (60 / Math.max(1, tempo)) * sampleRate)
  let cursor = 0
  let released = false
  let gen = 0
  for (let i = 0; i < length; i++) {
    while (cursor < ordered.length && ordered[cursor].sample <= i) {
      const event = ordered[cursor]
      cursor += 1
      if (event.vel <= 0.0001) {
        released = true
        continue
      }
      released = false
      gen += 1
      state.gen = gen
      knockNoteOn(state, event.pitch, event.vel, !!event.slide && state.live, params, sampleRate, beatSamples)
    }
    const step = knockStep(
      state,
      params,
      sampleRate,
      beatSamples,
      released,
      0,
      buffers.sidechain?.[i] || 0,
      buffers.samples || null,
      buffers.samplesR || null,
      buffers.sampleRate || sampleRate,
      buffers.quality || 'full',
    )
    left[i] = step.mono
    right[i] = flush(step.mono + step.delta)
    midi[i] = step.midi
  }
  return { left, right, midi }
}

/** Hard-clipped sine through the same oversampled drive the voice uses. */
export function renderDriveProbe(freq: number, sampleRate: number, length: number, params: Record<string, number>) {
  const state = createKnockVoice()
  const factor = 8
  ensureOs(state.os, sampleRate, factor)
  const out = new Float32Array(length)
  const osRate = sampleRate * factor
  let phase = 0
  for (let i = 0; i < length; i++) {
    let last = 0
    for (let k = 0; k < factor; k++) {
      const x = Math.sin(2 * Math.PI * phase)
      phase += freq / osRate
      last = aa(state.os, driveAtOs(state.os, x, params, osRate))
    }
    out[i] = flush(dcBlock(state, last))
  }
  return out
}
