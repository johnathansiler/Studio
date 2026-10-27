/** Shared sample tools. Plugin processors and the offline renderer both use these. */

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
  x1: number
  x2: number
  y1: number
  y2: number
}

export type BiquadKind = 'peaking' | 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf' | 'bandpass'

export function designBiquad(kind: BiquadKind, sampleRate: number, freq: number, q: number, gainDb = 0): Biquad {
  const fs = Math.max(1, sampleRate)
  const f = clamp(freq, 1, fs * 0.49)
  const qq = clamp(q, 0.05, 24)
  const A = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * f) / fs
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const octave = (2 / Math.LN2) * Math.asinh(1 / (2 * qq))
  const warp = Math.min(2.2, w0 / Math.max(1e-4, sin))
  const alpha = kind === 'peaking' ? sin * Math.sinh((Math.LN2 / 2) * octave * warp) : sin / (2 * qq)
  let b0 = 1
  let b1 = 0
  let b2 = 0
  let a0 = 1
  let a1 = 0
  let a2 = 0
  if (kind === 'lowpass') {
    b0 = (1 - cos) / 2
    b1 = 1 - cos
    b2 = (1 - cos) / 2
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else if (kind === 'highpass') {
    b0 = (1 + cos) / 2
    b1 = -(1 + cos)
    b2 = (1 + cos) / 2
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else if (kind === 'bandpass') {
    b0 = alpha
    b1 = 0
    b2 = -alpha
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else if (kind === 'peaking') {
    b0 = 1 + alpha * A
    b1 = -2 * cos
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cos
    a2 = 1 - alpha / A
  } else if (kind === 'lowshelf') {
    const beta = Math.sqrt(A) / qq
    b0 = A * (A + 1 - (A - 1) * cos + beta * sin)
    b1 = 2 * A * (A - 1 - (A + 1) * cos)
    b2 = A * (A + 1 - (A - 1) * cos - beta * sin)
    a0 = A + 1 + (A - 1) * cos + beta * sin
    a1 = -2 * (A - 1 + (A + 1) * cos)
    a2 = A + 1 + (A - 1) * cos - beta * sin
  } else {
    const beta = Math.sqrt(A) / qq
    b0 = A * (A + 1 + (A - 1) * cos + beta * sin)
    b1 = -2 * A * (A - 1 + (A + 1) * cos)
    b2 = A * (A + 1 + (A - 1) * cos - beta * sin)
    a0 = A + 1 - (A - 1) * cos + beta * sin
    a1 = 2 * (A - 1 - (A + 1) * cos)
    a2 = A + 1 - (A - 1) * cos - beta * sin
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 }
}

export function tickBiquad(filter: Biquad, x: number) {
  const y = filter.b0 * x + filter.b1 * filter.x1 + filter.b2 * filter.x2 - filter.a1 * filter.y1 - filter.a2 * filter.y2
  filter.x2 = filter.x1
  filter.x1 = x
  filter.y2 = filter.y1
  filter.y1 = y
  return y
}

export function copyCoeffs(target: Biquad, next: Biquad) {
  target.b0 = next.b0
  target.b1 = next.b1
  target.b2 = next.b2
  target.a1 = next.a1
  target.a2 = next.a2
}

/** Replace non-finite samples and flush denormals. */
export function sanitize(sample: number) {
  if (!Number.isFinite(sample) || Math.abs(sample) < 1e-15) return 0
  return sample
}

export function sanitizeBuffer(buffer: Float32Array) {
  for (let i = 0; i < buffer.length; i++) buffer[i] = sanitize(buffer[i])
}

export function dbToGain(db: number) {
  return 10 ** (db / 20)
}

export function gainToDb(gain: number) {
  const abs = Math.abs(gain)
  if (abs < 1e-8) return -160
  return 20 * Math.log10(abs)
}

export function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export interface LoudnessState {
  shelf: Biquad
  highpass: Biquad
  mean: number
  peak: number
  samples: number
}

export function createLoudness(sampleRate: number): LoudnessState {
  return {
    shelf: designBiquad('highshelf', sampleRate, 1500, 0.707, 4),
    highpass: designBiquad('highpass', sampleRate, 38, 0.5, 0),
    mean: 0,
    peak: 0,
    samples: 0,
  }
}

/** K-weighted momentary loudness and a 4x true-peak estimate. */
export function measureLoudness(state: LoudnessState, left: Float32Array, right: Float32Array | null, sampleRate: number) {
  let sum = 0
  let peak = 0
  const n = left.length
  for (let i = 0; i < n; i++) {
    const l = tickBiquad(state.highpass, tickBiquad(state.shelf, left[i] || 0))
    const rIn = right ? right[i] || 0 : left[i] || 0
    const r = right ? tickBiquad(state.highpass, tickBiquad(state.shelf, rIn)) : l
    sum += l * l + r * r
    peak = Math.max(peak, truePeakSample(left[i] || 0, i + 1 < n ? left[i + 1] || 0 : left[i] || 0))
    if (right) peak = Math.max(peak, truePeakSample(right[i] || 0, i + 1 < n ? right[i + 1] || 0 : right[i] || 0))
  }
  const blockMean = n ? sum / n : 0
  const total = state.samples + n
  state.mean = total ? (state.mean * state.samples + blockMean * n) / total : 0
  state.samples = total
  state.peak = Math.max(state.peak, peak)
  const lufs = state.mean > 1e-12 ? -0.691 + 10 * Math.log10(state.mean) : -70
  const truePeak = state.peak > 1e-8 ? 20 * Math.log10(state.peak) : -70
  void sampleRate
  return { lufs, truePeak }
}

function truePeakSample(a: number, b: number) {
  let peak = Math.max(Math.abs(a), Math.abs(b))
  for (let k = 1; k < 4; k++) {
    const t = k / 4
    const v = a + (b - a) * t
    peak = Math.max(peak, Math.abs(v))
  }
  return peak
}

export function hann(index: number, length: number) {
  if (length <= 1) return 1
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1))
}
