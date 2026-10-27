/** Guitar and bass amp, cabinet, pedal, and tuner DSP. Shared by the live insert and the offline bounce. */

import { copyCoeffs, designBiquad, sanitize, tickBiquad, type Biquad } from './dsp'

export const SLOT_COUNT = 8

export const AMPS = [
  'Clear American',
  'British Crunch',
  'Modern Gain',
  'Tweed Box',
  'Edge Break',
  'Acoustic Box',
  'Tube Bass',
  'Clean Bass',
  'Driven Bass',
] as const

export const CABS = [
  'Open 1×12',
  'Closed 2×12',
  'Wide 4×12',
  'Small Combo',
  'Dark 4×12',
  'Wood Body',
  'Bass 1×15',
  'Bass 4×10',
  'Bass 8×10',
] as const

export const MICS = ['Dynamic', 'Condenser', 'Ribbon'] as const

export const PEDALS = [
  'Empty',
  'Tuner',
  'Gate',
  'Comp',
  'Overdrive',
  'Distortion',
  'Fuzz',
  'Boost',
  'Wah',
  'EQ',
  'Chorus',
  'Flange',
  'Phase',
  'Tremolo',
  'Vibrato',
  'Swirl',
  'Delay',
  'Reverb',
  'Octaver',
  'Bend',
  'Loop',
  'Bass Drive',
  'Sub',
  'Filter',
] as const

export const TUNE_PRESETS = [
  { name: 'Chromatic', strings: [] as number[] },
  { name: 'Guitar', strings: [40, 45, 50, 55, 59, 64] },
  { name: 'Bass', strings: [28, 33, 38, 43] },
  { name: 'Drop D', strings: [38, 45, 50, 55, 59, 64] },
  { name: 'Open G', strings: [38, 43, 50, 55, 59, 62] },
  { name: 'Open D', strings: [38, 45, 50, 54, 57, 62] },
  { name: 'Drop C', strings: [36, 43, 48, 53, 57, 62] },
] as const

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export interface PitchRead {
  hz: number
  midi: number
  note: number
  cents: number
  name: string
}

export interface FirState {
  hist: Float32Array
  pos: number
}

export function slotOrder(params: Record<string, number>) {
  return Array.from({ length: SLOT_COUNT }, (_, index) => Math.round(params[`s${index}`] ?? 0))
}

export function reorderSlots(params: Record<string, number>, from: number, to: number) {
  const next = { ...params }
  const start = clamp(Math.round(from), 0, SLOT_COUNT - 1)
  const end = clamp(Math.round(to), 0, SLOT_COUNT - 1)
  if (start === end) return next
  const row = ['s', 'a', 'b', 'z'].map((key) => next[`${key}${start}`] ?? 0)
  if (start < end) {
    for (let index = start; index < end; index++) copySlot(next, index + 1, index)
  } else {
    for (let index = start; index > end; index--) copySlot(next, index - 1, index)
  }
  ;['s', 'a', 'b', 'z'].forEach((key, index) => {
    next[`${key}${end}`] = row[index]
  })
  return next
}

export function addPedal(params: Record<string, number>, pedal: number) {
  const next = { ...params }
  const index = slotOrder(next).findIndex((id) => id <= 0)
  if (index < 0) return next
  next[`s${index}`] = clamp(Math.round(pedal), 1, PEDALS.length - 1)
  return next
}

export function removePedal(params: Record<string, number>, index: number) {
  const cleared = { ...params, [`s${index}`]: 0 }
  return reorderSlots(cleared, index, SLOT_COUNT - 1)
}

function copySlot(params: Record<string, number>, from: number, to: number) {
  for (const key of ['s', 'a', 'b', 'z']) params[`${key}${to}`] = params[`${key}${from}`] ?? 0
}

export function noteName(midi: number) {
  const wrapped = ((Math.round(midi) % 12) + 12) % 12
  const octave = Math.floor(Math.round(midi) / 12) - 1
  return `${NOTE_NAMES[wrapped]}${octave}`
}

export function midiHz(midi: number, a4 = 440) {
  return a4 * 2 ** ((midi - 69) / 12)
}

/** Chromatic readout. `cents` is the signed distance to the nearest semitone at this A4. */
export function describePitch(hz: number, a4 = 440): PitchRead | null {
  if (!(hz > 1) || !Number.isFinite(hz)) return null
  const ref = clamp(a4, 430, 450)
  const midi = 69 + 12 * Math.log2(hz / ref)
  const note = Math.round(midi)
  return { hz, midi, note, cents: (midi - note) * 100, name: noteName(note) }
}

/** Nearest guitar or bass string, or the nearest semitone when the preset is chromatic. */
export function targetNote(midi: number, preset: number) {
  const strings = TUNE_PRESETS[clamp(Math.round(preset), 0, TUNE_PRESETS.length - 1)]?.strings ?? []
  if (!strings.length) return Math.round(midi)
  let best = strings[0]
  let distance = Math.abs(midi - best)
  for (const string of strings) {
    const next = Math.abs(midi - string)
    if (next < distance) {
      best = string
      distance = next
    }
  }
  return best
}

/**
 * Chromatic pitch for a clean periodic tone.
 * Coarse YIN runs on a 2× downsample, then a full-rate parabolic fit lands within a cent.
 */
export function tunePitch(frame: Float32Array, sampleRate: number, a4 = 440): PitchRead | null {
  const n = frame.length
  if (n < 512 || sampleRate < 8000) return null
  let mean = 0
  for (let i = 0; i < n; i++) mean += frame[i]
  mean /= n
  let energy = 0
  const centered = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const sample = frame[i] - mean
    centered[i] = sample
    energy += sample * sample
  }
  if (energy / n < 1e-7) return null
  const halfN = Math.floor(n / 2)
  const half = new Float32Array(halfN)
  for (let i = 0; i < halfN; i++) half[i] = (centered[i * 2] + centered[i * 2 + 1]) * 0.5
  const halfRate = sampleRate / 2
  const coarse = yinTau(half, halfRate, 32, 1600)
  if (coarse == null) return null
  const guess = coarse * 2
  const tau = refineTau(centered, guess)
  const hz = sampleRate / tau
  return describePitch(hz, a4)
}

function yinTau(frame: Float32Array, sampleRate: number, minHz: number, maxHz: number) {
  const n = frame.length
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz))
  const tauMax = Math.min(n - 3, Math.floor(sampleRate / minHz))
  if (tauMax <= tauMin + 2) return null
  const diff = new Float32Array(tauMax + 1)
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0
    const limit = n - tau
    for (let i = 0; i < limit; i++) {
      const delta = frame[i] - frame[i + tau]
      sum += delta * delta
    }
    diff[tau] = sum
  }
  const cmnd = new Float32Array(tauMax + 1)
  let running = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau]
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1
  }
  let tau = -1
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < 0.12) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t += 1
      tau = t
      break
    }
  }
  if (tau < 0) {
    let best = tauMin
    for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t
    if (cmnd[best] > 0.5) return null
    tau = best
  }
  return tau + parabola(cmnd[tau - 1], cmnd[tau], cmnd[tau + 1])
}

function refineTau(frame: Float32Array, guess: number) {
  const n = frame.length
  const center = Math.max(2, Math.round(guess))
  const from = Math.max(2, center - 5)
  const to = Math.min(n - 3, center + 5)
  const diff = new Float32Array(to + 1)
  let best = center
  let bestDiff = Number.POSITIVE_INFINITY
  for (let tau = from; tau <= to; tau++) {
    let sum = 0
    const limit = n - tau
    for (let i = 0; i < limit; i += 1) {
      const delta = frame[i] - frame[i + tau]
      sum += delta * delta
    }
    diff[tau] = sum
    if (sum < bestDiff) {
      best = tau
      bestDiff = sum
    }
  }
  const shift = parabola(diff[best - 1] ?? bestDiff, diff[best], diff[best + 1] ?? bestDiff)
  return Math.max(1, best + shift)
}

function parabola(prev: number, mid: number, next: number) {
  const denom = prev + next - 2 * mid
  if (!denom) return 0
  return clamp((prev - next) / (2 * denom), -1, 1)
}

const CAB_MODES: { hz: number; decay: number; amp: number }[][] = [
  [
    { hz: 98, decay: 18, amp: 0.7 },
    { hz: 240, decay: 28, amp: 0.45 },
    { hz: 980, decay: 40, amp: 0.28 },
    { hz: 2800, decay: 70, amp: 0.16 },
  ],
  [
    { hz: 110, decay: 16, amp: 0.75 },
    { hz: 360, decay: 30, amp: 0.4 },
    { hz: 1400, decay: 48, amp: 0.22 },
    { hz: 3200, decay: 80, amp: 0.12 },
  ],
  [
    { hz: 90, decay: 14, amp: 0.8 },
    { hz: 420, decay: 26, amp: 0.5 },
    { hz: 1800, decay: 50, amp: 0.2 },
    { hz: 3500, decay: 90, amp: 0.14 },
  ],
  [
    { hz: 140, decay: 22, amp: 0.6 },
    { hz: 700, decay: 36, amp: 0.35 },
    { hz: 2200, decay: 60, amp: 0.22 },
    { hz: 4100, decay: 95, amp: 0.1 },
  ],
  [
    { hz: 85, decay: 12, amp: 0.85 },
    { hz: 300, decay: 24, amp: 0.4 },
    { hz: 900, decay: 40, amp: 0.18 },
    { hz: 2400, decay: 70, amp: 0.08 },
  ],
  [
    { hz: 180, decay: 20, amp: 0.55 },
    { hz: 420, decay: 28, amp: 0.4 },
    { hz: 1600, decay: 46, amp: 0.25 },
    { hz: 3600, decay: 72, amp: 0.18 },
  ],
  [
    { hz: 60, decay: 12, amp: 0.9 },
    { hz: 140, decay: 18, amp: 0.5 },
    { hz: 480, decay: 34, amp: 0.22 },
    { hz: 1400, decay: 60, amp: 0.08 },
  ],
  [
    { hz: 70, decay: 14, amp: 0.85 },
    { hz: 180, decay: 22, amp: 0.45 },
    { hz: 620, decay: 38, amp: 0.2 },
    { hz: 1800, decay: 66, amp: 0.1 },
  ],
  [
    { hz: 48, decay: 10, amp: 0.95 },
    { hz: 120, decay: 16, amp: 0.5 },
    { hz: 360, decay: 30, amp: 0.22 },
    { hz: 1100, decay: 55, amp: 0.08 },
  ],
]

/** License-safe cabinet impulse: decaying body modes, a short deterministic air burst, then mic and distance. */
export function cabinetIr(opts: {
  cab: number
  mic: number
  axis: number
  distance: number
  length: number
  sampleRate: number
}) {
  const length = Math.max(8, opts.length)
  const ir = new Float32Array(length)
  const cab = clamp(Math.round(opts.cab), 0, CABS.length - 1)
  const mic = clamp(Math.round(opts.mic), 0, 2)
  const axis = clamp(opts.axis, 0, 1)
  const distance = clamp(opts.distance, 0, 1)
  const modes = CAB_MODES[cab]
  for (const mode of modes) {
    const high = mode.hz > 2000
    const axisGain = high ? 1 - axis * 0.72 : 1 - axis * 0.08
    const distanceGain = high ? 1 - distance * 0.55 : 1
    const micGain = mic === 1 ? (mode.hz > 3000 ? 1.35 : 1) : mic === 2 ? (mode.hz > 2500 ? 0.55 : 1.2) : 1
    const amp = mode.amp * axisGain * distanceGain * micGain
    const decay = mode.decay * (1 + distance * 0.25)
    for (let i = 0; i < length; i++) {
      const t = i / opts.sampleRate
      ir[i] += amp * Math.exp(-t * decay) * Math.sin(2 * Math.PI * mode.hz * t)
    }
  }
  let seed = 1009 + cab * 17 + mic * 3
  const air = Math.min(length, 360)
  for (let i = 0; i < air; i++) {
    seed = (seed * 16807) % 2147483647
    const noise = (seed / 2147483647) * 2 - 1
    ir[i] += noise * 0.015 * Math.exp(-i / (36 + distance * 70)) * (1 - axis * 0.45)
  }
  const delay = Math.round(distance * 12)
  if (delay > 0) {
    for (let i = length - 1; i >= delay; i--) ir[i] = ir[i - delay]
    for (let i = 0; i < delay; i++) ir[i] = 0
  }
  let peak = 0
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(ir[i]))
  if (peak > 0) {
    const norm = 0.9 / peak
    for (let i = 0; i < length; i++) ir[i] *= norm
  }
  return ir
}

export function createFir(length: number): FirState {
  return { hist: new Float32Array(Math.max(1, length)), pos: 0 }
}

/** One sample of direct convolution. An impulse reproduces the impulse response. */
export function firSample(state: FirState, ir: Float32Array, x: number) {
  const m = ir.length
  if (state.hist.length !== m) {
    state.hist = new Float32Array(m)
    state.pos = 0
  }
  state.hist[state.pos] = x
  let y = 0
  let k = state.pos
  for (let i = 0; i < m; i++) {
    y += ir[i] * state.hist[k]
    k = k === 0 ? m - 1 : k - 1
  }
  state.pos += 1
  if (state.pos >= m) state.pos = 0
  return y
}

export function convolve(input: Float32Array, ir: Float32Array) {
  const state = createFir(ir.length)
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) out[i] = firSample(state, ir, input[i])
  return out
}

const HPF = [80, 90, 120, 70, 85, 140, 32, 40, 48]
const DRIVE = [2.4, 7, 16, 6, 4.2, 1.2, 5, 1.6, 12]
const BUTTER_Q = [2.5629154477, 0.8999762231, 0.6013448869, 0.5097955791]

export function osFactor(quality: 'full' | 'eco') {
  return quality === 'eco' ? 2 : 4
}

export function irLength(quality: 'full' | 'eco') {
  return quality === 'eco' ? 256 : 512
}

interface OsChannel {
  up: Biquad[]
  down: Biquad[]
  dcX: number
  dcY: number
  factor: number
  rate: number
}

interface Tone {
  bass: Biquad
  mid: Biquad
  treble: Biquad
  presence: Biquad
  hpf: Biquad
  bright: Biquad
  key: string
}

interface PedalState {
  id: number
  env: number
  gain: number
  hold: number
  phase: number
  svfLow: number
  svfBand: number
  delay: Float32Array
  write: number
  comb: Float32Array[]
  combPos: number[]
  pitch: Float32Array
  pitchWrite: number
  pitchPhase: number
  sub: number
  subHold: number
  loopL: Float32Array
  loopR: Float32Array
  loopWrite: number
  loopLen: number
  loopRead: number
  os: OsChannel[]
}

export interface AmpState {
  os: OsChannel[]
  tone: Tone[]
  fir: FirState[]
  firB: FirState[]
  irA: Float32Array
  irB: Float32Array
  irKey: string
  pedals: PedalState[]
  tune: Float32Array
  tuneWrite: number
  tuneCount: number
  readout: PitchRead | null
  sampleRate: number
}

export function createAmpState(sampleRate: number): AmpState {
  return {
    os: [createOs(sampleRate, 4), createOs(sampleRate, 4)],
    tone: [createTone(sampleRate), createTone(sampleRate)],
    fir: [createFir(8), createFir(8)],
    firB: [createFir(8), createFir(8)],
    irA: new Float32Array(8),
    irB: new Float32Array(8),
    irKey: '',
    pedals: Array.from({ length: SLOT_COUNT }, () => createPedal(sampleRate)),
    tune: new Float32Array(8192),
    tuneWrite: 0,
    tuneCount: 0,
    readout: null,
    sampleRate,
  }
}

export function resetAmpState(state: AmpState) {
  const next = createAmpState(state.sampleRate)
  state.os = next.os
  state.tone = next.tone
  state.fir = next.fir
  state.firB = next.firB
  state.irA = next.irA
  state.irB = next.irB
  state.irKey = ''
  state.pedals = next.pedals
  state.tune.fill(0)
  state.tuneWrite = 0
  state.tuneCount = 0
  state.readout = null
}

function createOs(sampleRate: number, factor: number): OsChannel {
  const osRate = sampleRate * factor
  const cutoff = Math.min(10000, sampleRate * 0.42)
  return {
    up: BUTTER_Q.map((q) => designBiquad('lowpass', osRate, cutoff, q)),
    down: BUTTER_Q.map((q) => designBiquad('lowpass', osRate, cutoff, q)),
    dcX: 0,
    dcY: 0,
    factor,
    rate: sampleRate,
  }
}

function createTone(sampleRate: number): Tone {
  const flat = designBiquad('lowshelf', sampleRate, 120, 0.7, 0)
  return {
    bass: flat,
    mid: designBiquad('peaking', sampleRate, 750, 0.8, 0),
    treble: designBiquad('highshelf', sampleRate, 3200, 0.7, 0),
    presence: designBiquad('highshelf', sampleRate, 5500, 0.7, 0),
    hpf: designBiquad('highpass', sampleRate, 80, 0.7),
    bright: designBiquad('highshelf', sampleRate, 2200, 0.7, 0),
    key: '',
  }
}

function createPedal(sampleRate: number): PedalState {
  const delay = new Float32Array(Math.max(8, Math.floor(sampleRate * 1.5)))
  const combLen = [29, 43, 61, 79].map((ms) => Math.max(8, Math.floor((sampleRate * ms) / 1000)))
  return {
    id: -1,
    env: 0,
    gain: 1,
    hold: 0,
    phase: 0,
    svfLow: 0,
    svfBand: 0,
    delay,
    write: 0,
    comb: combLen.map((length) => new Float32Array(length)),
    combPos: combLen.map(() => 0),
    pitch: new Float32Array(Math.max(32, Math.floor(sampleRate * 0.05))),
    pitchWrite: 0,
    pitchPhase: 0,
    sub: 1,
    subHold: 0,
    loopL: new Float32Array(Math.max(8, Math.floor(sampleRate * 4))),
    loopR: new Float32Array(Math.max(8, Math.floor(sampleRate * 4))),
    loopWrite: 0,
    loopLen: 0,
    loopRead: 0,
    os: [createOs(sampleRate, 4), createOs(sampleRate, 4)],
  }
}

function ensureOs(channel: OsChannel, sampleRate: number, factor: number) {
  if (channel.factor === factor && channel.rate === sampleRate) return
  const next = createOs(sampleRate, factor)
  channel.up = next.up
  channel.down = next.down
  channel.factor = factor
  channel.rate = sampleRate
  channel.dcX = 0
  channel.dcY = 0
}

function syncTone(tone: Tone, sampleRate: number, model: number, params: Record<string, number>) {
  const bass = (clamp(params.bass ?? 0.5, 0, 1) - 0.5) * 24
  const mid = (clamp(params.mid ?? 0.5, 0, 1) - 0.5) * 20
  const treble = (clamp(params.treble ?? 0.5, 0, 1) - 0.5) * 18
  const presence = (clamp(params.presence ?? 0.5, 0, 1) - 0.5) * 12
  const bright = (params.bright ?? 0) >= 0.5 ? 4.5 : 0
  const key = `${model}:${bass}:${mid}:${treble}:${presence}:${bright}`
  if (tone.key === key) return
  copyCoeffs(tone.bass, designBiquad('lowshelf', sampleRate, model >= 6 ? 80 : 140, 0.7, bass))
  copyCoeffs(tone.mid, designBiquad('peaking', sampleRate, model >= 6 ? 420 : 800, model === 2 ? 0.9 : 0.75, mid))
  copyCoeffs(tone.treble, designBiquad('highshelf', sampleRate, 2800, 0.7, treble))
  copyCoeffs(tone.presence, designBiquad('highshelf', sampleRate, model === 5 ? 4500 : 6200, 0.7, presence))
  copyCoeffs(tone.hpf, designBiquad('highpass', sampleRate, HPF[model] ?? 80, 0.707))
  copyCoeffs(tone.bright, designBiquad('highshelf', sampleRate, 2400, 0.7, bright))
  tone.key = key
}

function syncIr(state: AmpState, params: Record<string, number>, quality: 'full' | 'eco') {
  const length = irLength(quality)
  const key = `${Math.round(params.cabA ?? 0)}:${Math.round(params.cabB ?? 0)}:${Math.round(params.mic ?? 0)}:${(params.axis ?? 0).toFixed(3)}:${(params.distance ?? 0).toFixed(3)}:${length}:${state.sampleRate}`
  if (key === state.irKey) return
  const shared = {
    mic: params.mic ?? 0,
    axis: params.axis ?? 0,
    distance: params.distance ?? 0,
    length,
    sampleRate: state.sampleRate,
  }
  state.irA = cabinetIr({ ...shared, cab: params.cabA ?? 0 })
  state.irB = cabinetIr({ ...shared, cab: params.cabB ?? 2 })
  state.fir = [createFir(length), createFir(length)]
  state.firB = [createFir(length), createFir(length)]
  state.irKey = key
}

/** Smooth odd shaper. No hard corner, so the oversampled images fall under the reconstruction filter. */
function shapeSample(model: number, x: number, gain: number) {
  const drive = DRIVE[model] ?? 3
  const y = x * (1 + gain * drive)
  if (model === 5) return Math.tanh(y)
  if (model === 2 || model === 8) return odd(odd(y) * (1 + gain * 0.8))
  if (model === 3 || model === 6) {
    const s = Math.tanh(y)
    return s + 0.06 * s * s
  }
  return odd(y)
}

function odd(y: number) {
  const s = Math.tanh(y)
  return s * (1.25 - 0.25 * s * s)
}

function oversample(channel: OsChannel, x: number, model: number, gain: number) {
  return oversampleShape(channel, x, (sample) => shapeSample(model, sample, gain))
}

/** Upsample, run a nonlinearity, then lowpass. Used by the amp and the dirt pedals. */
function oversampleShape(channel: OsChannel, x: number, shape: (sample: number) => number) {
  let y = 0
  const factor = channel.factor
  for (let k = 0; k < factor; k++) {
    let s = k === 0 ? x * factor : 0
    for (const filter of channel.up) s = tickBiquad(filter, s)
    s = shape(s)
    for (const filter of channel.down) s = tickBiquad(filter, s)
    y = s
  }
  const dc = y - channel.dcX + 0.995 * channel.dcY
  channel.dcX = y
  channel.dcY = dc
  return dc
}

function prepare(tone: Tone, x: number, bright: boolean) {
  const highpassed = tickBiquad(tone.hpf, x)
  return bright ? tickBiquad(tone.bright, highpassed) : highpassed
}

function stack(tone: Tone, x: number, neutral: boolean) {
  if (neutral) return x
  return tickBiquad(tone.presence, tickBiquad(tone.treble, tickBiquad(tone.mid, tickBiquad(tone.bass, x))))
}

function cabinet(state: AmpState, channel: number, x: number, blend: number, enabled: boolean) {
  if (!enabled) return x
  const a = firSample(state.fir[channel], state.irA, x)
  if (blend <= 0.001) return a
  const b = firSample(state.firB[channel], state.irB, x)
  if (blend >= 0.999) return b
  return a * (1 - blend) + b * blend
}

function pedal(state: PedalState, left: number, right: number, id: number, a: number, b: number, ctx: AmpRun) {
  if (state.id !== id) {
    const fresh = createPedal(ctx.sampleRate)
    Object.assign(state, fresh)
    state.id = id
  }
  const amount = clamp(a, 0, 1)
  const tone = clamp(b, 0, 1)
  if (id === 2) return gate(state, left, right, amount, tone, ctx.sampleRate)
  if (id === 3) return compress(state, left, right, amount, ctx.sampleRate)
  if (id === 4 || id === 5 || id === 6 || id === 7 || id === 21) return dirt(state, id, left, right, amount, tone, ctx.sampleRate, ctx.factor)
  if (id === 8) return wah(state, left, right, amount, tone, ctx)
  if (id === 9) return eqPedal(state, left, right, amount, tone, ctx.sampleRate)
  if (id === 10 || id === 11 || id === 14) return modulate(state, left, right, id, amount, tone, ctx.sampleRate)
  if (id === 12 || id === 15) return phase(state, left, right, amount, tone, ctx.sampleRate, id === 15)
  if (id === 13) return tremolo(state, left, right, amount, tone, ctx.sampleRate)
  if (id === 16) return delay(state, left, right, amount, tone, ctx)
  if (id === 17) return reverb(state, left, right, amount, tone)
  if (id === 18 || id === 19) return pitch(state, left, right, id === 18 ? 0.5 : 0.5 + tone, amount)
  if (id === 20) return loop(state, left, right, amount, ctx.loop)
  if (id === 22) return sub(state, left, right, amount, ctx.sampleRate)
  if (id === 23) return envelope(state, left, right, amount, tone, ctx.sampleRate)
  return [left, right] as const
}

interface AmpRun {
  sampleRate: number
  expr: number
  loop: number
  tempo: number
  factor: number
}

function gate(state: PedalState, left: number, right: number, amount: number, release: number, sampleRate: number) {
  const threshold = -80 + amount * 80
  const peak = Math.max(Math.abs(left), Math.abs(right))
  const openCoeff = Math.exp(-1 / (sampleRate * 0.003))
  const closeCoeff = Math.exp(-1 / (sampleRate * 0.04))
  const coeff = peak > state.env ? openCoeff : closeCoeff
  state.env = peak + coeff * (state.env - peak)
  const db = state.env > 1e-8 ? 20 * Math.log10(state.env) : -120
  const open = db >= threshold
  if (open) state.hold = Math.floor(sampleRate * 0.03)
  else if (state.hold > 0) state.hold -= 1
  const target = open || state.hold > 0 ? 1 : 0
  const glide = target > state.gain ? Math.exp(-1 / (sampleRate * 0.002)) : Math.exp(-1 / (sampleRate * (0.02 + release * 0.2)))
  state.gain = target + glide * (state.gain - target)
  return [left * state.gain, right * state.gain] as const
}

function compress(state: PedalState, left: number, right: number, amount: number, sampleRate: number) {
  const peak = Math.max(Math.abs(left), Math.abs(right))
  const coeff = Math.exp(-1 / (sampleRate * 0.02))
  state.env = peak + coeff * (state.env - peak)
  const over = state.env / 0.12
  const reduce = over > 1 ? 1 / (1 + (over - 1) * amount * 3) : 1
  const target = reduce * (1 + amount * 0.8)
  state.gain += (target - state.gain) * 0.02
  return [left * state.gain, right * state.gain] as const
}

function dirt(state: PedalState, id: number, left: number, right: number, amount: number, tone: number, sampleRate: number, factor: number) {
  ensureOs(state.os[0], sampleRate, factor)
  ensureOs(state.os[1], sampleRate, factor)
  const drive = 1 + amount * (id === 7 ? 4 : id === 6 ? 14 : id === 5 ? 10 : id === 21 ? 8 : 6)
  const color = 0.4 + tone * 0.6
  const shape = (x: number) => {
    const y = x * drive
    if (id === 6) return Math.tanh(y * y * Math.sign(y) * 0.8) * color + Math.tanh(y) * (1 - color) * 0.3
    return odd(y) * (0.55 + tone * 0.45)
  }
  return [oversampleShape(state.os[0], left, shape), oversampleShape(state.os[1], right, shape)] as const
}

function wah(state: PedalState, left: number, right: number, manual: number, auto: number, ctx: AmpRun) {
  const peak = Math.max(Math.abs(left), Math.abs(right))
  state.env = peak + Math.exp(-1 / (ctx.sampleRate * 0.03)) * (state.env - peak)
  const env = clamp(state.env * 4, 0, 1)
  const hand = clamp(manual + (ctx.expr - 0.3), 0, 1)
  const pos = hand * (1 - auto) + env * auto
  const cutoff = 280 + pos * 2200
  return [svf(state, left, cutoff, 3.2, ctx.sampleRate), svf(state, right, cutoff, 3.2, ctx.sampleRate)] as const
}

function svf(state: PedalState, x: number, cutoff: number, q: number, sampleRate: number) {
  const f = 2 * Math.sin(Math.min(Math.PI * 0.3, (Math.PI * cutoff) / sampleRate))
  const damp = 1 / Math.max(0.3, q)
  state.svfLow += f * state.svfBand
  const high = x - state.svfLow - damp * state.svfBand
  state.svfBand += f * high
  return state.svfBand
}

function eqPedal(state: PedalState, left: number, right: number, low: number, high: number, sampleRate: number) {
  const coeff = Math.exp((-2 * Math.PI * 200) / sampleRate)
  state.svfLow = left + coeff * (state.svfLow - left)
  state.env = right + coeff * (state.env - right)
  const bass = (low - 0.5) * 1.4
  const air = (high - 0.5) * 1.1
  return [left + state.svfLow * bass + (left - state.svfLow) * air, right + state.env * bass + (right - state.env) * air] as const
}

function modulate(state: PedalState, left: number, right: number, id: number, amount: number, tone: number, sampleRate: number) {
  const rate = 0.2 + tone * 3
  state.phase += (2 * Math.PI * rate) / sampleRate
  const lfo = Math.sin(state.phase)
  const base = id === 11 ? 0.003 : id === 14 ? 0.004 : 0.012
  const depth = base * (0.3 + amount)
  const delayL = (base + lfo * depth) * sampleRate
  const delayR = (base + Math.sin(state.phase + 0.8) * depth) * sampleRate
  state.delay[state.write] = left
  const wetL = readDelay(state.delay, state.write - delayL)
  const wetR = readDelay(state.delay, state.write - delayR)
  state.write = (state.write + 1) % state.delay.length
  const mix = 0.15 + amount * 0.55
  const feedback = id === 11 ? wetL * 0.35 : 0
  state.delay[state.write] += feedback
  return [left * (1 - mix) + wetL * mix, right * (1 - mix) + wetR * mix] as const
}

function phase(state: PedalState, left: number, right: number, amount: number, tone: number, sampleRate: number, swirl: boolean) {
  state.phase += (2 * Math.PI * (0.1 + tone * 1.4)) / sampleRate
  const lfo = Math.sin(state.phase)
  const cutoff = 400 + (0.5 + 0.5 * lfo) * 1600
  const wetL = svf(state, left, cutoff, 0.8, sampleRate)
  const trem = swirl ? 0.85 + 0.15 * Math.sin(state.phase * 0.5) : 1
  const mix = 0.2 + amount * 0.6
  return [(left * (1 - mix) + wetL * mix) * trem, (right * (1 - mix) + wetL * mix) * trem] as const
}

function tremolo(state: PedalState, left: number, right: number, amount: number, tone: number, sampleRate: number) {
  state.phase += (2 * Math.PI * (1 + tone * 7)) / sampleRate
  const lfo = 1 - amount * (0.5 + 0.5 * Math.sin(state.phase))
  return [left * lfo, right * lfo] as const
}

function delay(state: PedalState, left: number, right: number, amount: number, mode: number, ctx: AmpRun) {
  const kind = mode < 0.34 ? 0 : mode < 0.67 ? 1 : 2
  const beat = 60 / Math.max(40, ctx.tempo)
  const seconds = Math.min(1.2, beat * 0.75)
  const wow = kind === 1 ? Math.sin(state.phase) * 0.003 : 0
  state.phase += (2 * Math.PI * 0.4) / ctx.sampleRate
  const delaySamples = (seconds + wow) * ctx.sampleRate
  const feedback = kind === 2 ? 0.28 : 0.38
  const wet = readDelay(state.delay, state.write - delaySamples)
  const colored = kind === 0 ? wet * 0.72 + state.env * 0.28 : wet
  state.env = colored
  const input = (left + right) * 0.5 + colored * feedback
  state.delay[state.write] = input
  state.write = (state.write + 1) % state.delay.length
  const mix = amount * 0.6
  const ping = kind === 2 ? -wet : wet
  return [left * (1 - mix) + wet * mix, right * (1 - mix) + ping * mix] as const
}

function reverb(state: PedalState, left: number, right: number, amount: number, mode: number) {
  const kind = mode < 0.34 ? 0 : mode < 0.67 ? 1 : 2
  const feedback = kind === 0 ? 0.45 : kind === 1 ? 0.62 : 0.74
  const mono = (left + right) * 0.5
  let wet = 0
  for (let i = 0; i < state.comb.length; i++) {
    const line = state.comb[i]
    const pos = state.combPos[i] % line.length
    const delayed = line[pos]
    line[pos] = mono + delayed * feedback
    state.combPos[i] = pos + 1
    wet += delayed
  }
  wet /= state.comb.length
  const mix = amount * (kind === 2 ? 0.45 : 0.35)
  return [left * (1 - mix) + wet * mix, right * (1 - mix) + wet * 0.92 * mix] as const
}

function pitch(state: PedalState, left: number, right: number, ratio: number, amount: number) {
  const shifted = shift(state, (left + right) * 0.5, clamp(ratio, 0.25, 2))
  const mix = clamp(amount, 0, 1)
  return [left * (1 - mix) + shifted * mix, right * (1 - mix) + shifted * mix] as const
}

function shift(state: PedalState, x: number, ratio: number) {
  const line = state.pitch
  line[state.pitchWrite] = x
  const span = line.length / 2
  state.pitchPhase += 1 - ratio
  if (state.pitchPhase >= span) state.pitchPhase -= span
  if (state.pitchPhase < 0) state.pitchPhase += span
  const a = readDelay(line, state.pitchWrite - span + state.pitchPhase)
  const b = readDelay(line, state.pitchWrite - span + ((state.pitchPhase + span / 2) % span))
  const fade = 0.5 - 0.5 * Math.cos((2 * Math.PI * state.pitchPhase) / span)
  state.pitchWrite = (state.pitchWrite + 1) % line.length
  return a * (1 - fade) + b * fade
}

function loop(state: PedalState, left: number, right: number, amount: number, mode: number) {
  if (mode >= 0.5 && mode < 1.5) {
    state.loopL[state.loopWrite] = left
    state.loopR[state.loopWrite] = right
    state.loopWrite += 1
    state.loopLen = Math.max(state.loopLen, state.loopWrite)
    if (state.loopWrite >= state.loopL.length) state.loopWrite = 0
    return [left, right] as const
  }
  if (mode >= 1.5 && state.loopLen > 0) {
    const index = state.loopRead % state.loopLen
    const mix = 0.4 + amount * 0.6
    const outL = left + state.loopL[index] * mix
    const outR = right + state.loopR[index] * mix
    state.loopRead = index + 1
    return [outL, outR] as const
  }
  return [left, right] as const
}

function sub(state: PedalState, left: number, right: number, amount: number, sampleRate: number) {
  const mono = left + right
  if (mono >= 0 && state.subHold < 0) state.sub = -state.sub
  state.subHold = mono
  const coeff = Math.exp((-2 * Math.PI * 120) / sampleRate)
  state.env = state.sub * Math.abs(mono) + coeff * (state.env - state.sub * Math.abs(mono))
  const mix = amount * 0.7
  return [left + state.env * mix, right + state.env * mix] as const
}

function envelope(state: PedalState, left: number, right: number, amount: number, tone: number, sampleRate: number) {
  const peak = Math.max(Math.abs(left), Math.abs(right))
  const coeff = Math.exp(-1 / (sampleRate * (0.01 + (1 - tone) * 0.12)))
  state.env = peak + coeff * (state.env - peak)
  const cutoff = 180 + clamp(state.env * (2 + amount * 6), 0, 1) * (800 + amount * 2400)
  return [svf(state, left, cutoff, 2.4, sampleRate) * 0.8 + left * 0.2, svf(state, right, cutoff, 2.4, sampleRate) * 0.8 + right * 0.2] as const
}

function readDelay(line: Float32Array, at: number) {
  const length = line.length
  const wrapped = ((at % length) + length) % length
  const index = Math.floor(wrapped)
  const frac = wrapped - index
  const next = (index + 1) % length
  return line[index] * (1 - frac) + line[next] * frac
}

/**
 * Process one block. `block` size does not change the result: the same state machine runs per sample.
 * Mute zeros the output after the tuner has read the input.
 */
export function processAmp(
  state: AmpState,
  input: Float32Array[],
  output: Float32Array[],
  params: Record<string, number>,
  ctx: { sampleRate: number; tempo: number; quality: 'full' | 'eco'; loopLinked?: boolean },
) {
  const n = input[0]?.length ?? 0
  const model = clamp(Math.round(params.model ?? 0), 0, AMPS.length - 1)
  const gain = clamp(params.gain ?? 0, 0, 1)
  const factor = osFactor(ctx.quality)
  ensureOs(state.os[0], ctx.sampleRate, factor)
  ensureOs(state.os[1], ctx.sampleRate, factor)
  syncTone(state.tone[0], ctx.sampleRate, model, params)
  syncTone(state.tone[1], ctx.sampleRate, model, params)
  syncIr(state, params, ctx.quality)
  const cabOn = (params.cab ?? 1) >= 0.001
  const blend = clamp(params.blend ?? 0, 0, 1)
  const trim = clamp(params.master ?? 1, 0, 1)
  const neutral = Math.abs((params.bass ?? 0.5) - 0.5) < 0.001 && Math.abs((params.mid ?? 0.5) - 0.5) < 0.001 && Math.abs((params.treble ?? 0.5) - 0.5) < 0.001 && Math.abs((params.presence ?? 0.5) - 0.5) < 0.001
  const ampOn = gain >= 0.001
  const bright = (params.bright ?? 0) >= 0.5
  const mute = (params.mute ?? 0) >= 0.5
  const run: AmpRun = { sampleRate: ctx.sampleRate, expr: clamp(params.expr ?? 0, 0, 1), loop: params.loop ?? 0, tempo: ctx.tempo || 120, factor }
  const slots = Array.from({ length: SLOT_COUNT }, (_, index) => ({
    id: Math.round(params[`s${index}`] ?? 0),
    a: params[`a${index}`] ?? 0.5,
    b: params[`b${index}`] ?? 0.35,
    post: (params[`z${index}`] ?? 0) >= 0.5,
  }))
  const hearTuner = slots.some((slot) => slot.id === 1)
  for (let i = 0; i < n; i++) {
    let left = input[0]?.[i] ?? 0
    let right = input[1]?.[i] ?? left
    if (hearTuner) {
      state.tune[state.tuneWrite] = (left + right) * 0.5
      state.tuneWrite = (state.tuneWrite + 1) % state.tune.length
      state.tuneCount += 1
    }
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]
      if (slot.post || slot.id <= 1) continue
      ;[left, right] = pedal(state.pedals[s], left, right, slot.id, slot.a, slot.b, run)
    }
    if (ampOn) {
      left = oversample(state.os[0], prepare(state.tone[0], left, bright), model, gain)
      right = oversample(state.os[1], prepare(state.tone[1], right, bright), model, gain)
      left = stack(state.tone[0], left, neutral)
      right = stack(state.tone[1], right, neutral)
    }
    left = cabinet(state, 0, left, blend, cabOn)
    right = cabinet(state, 1, right, blend, cabOn)
    left *= trim
    right *= trim
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]
      if (!slot.post || slot.id <= 1) continue
      ;[left, right] = pedal(state.pedals[s], left, right, slot.id, slot.a, slot.b, run)
    }
    if (mute) {
      left = 0
      right = 0
    }
    const peak = Math.max(Math.abs(left), Math.abs(right))
    if (peak > 0.98) {
      const scale = 0.98 / peak
      left *= scale
      right *= scale
    }
    if (output[0]) output[0][i] = sanitize(left)
    if (output[1]) output[1][i] = sanitize(right)
  }
  if (hearTuner && state.tuneCount >= 4096) {
    const frame = new Float32Array(Math.min(8192, state.tuneCount))
    for (let i = 0; i < frame.length; i++) {
      const index = (state.tuneWrite - frame.length + i + state.tune.length) % state.tune.length
      frame[i] = state.tune[index]
    }
    state.readout = tunePitch(frame, ctx.sampleRate, params.cal ?? 440)
    state.tuneCount = 4096
  }
  void ctx.loopLinked
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function chainHasLoop(plugins: { pluginId: string }[]) {
  return plugins.some((plugin) => plugin.pluginId === 'loop')
}
