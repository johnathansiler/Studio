import { clamp, dbToGain, designBiquad, gainToDb, sanitize, tickBiquad, type Biquad } from '../dsp'

/** 0 VU is -18 dBFS, the usual studio lineup. */
export const VU_DBFS = -18

export function coeff(ms: number, sampleRate: number) {
  const samples = Math.max(1, (ms / 1000) * sampleRate)
  return 1 - Math.exp(-1 / samples)
}

export function stepPick<T>(index: number, values: readonly T[]): T {
  const at = clamp(Math.round(index), 0, values.length - 1)
  return values[at]
}

export function responseDb(filter: Biquad, freq: number, sampleRate: number) {
  const w = (2 * Math.PI * freq) / sampleRate
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const numRe = filter.b0 + filter.b1 * c1 + filter.b2 * c2
  const numIm = -(filter.b1 * s1 + filter.b2 * s2)
  const denRe = 1 + filter.a1 * c1 + filter.a2 * c2
  const denIm = -(filter.a1 * s1 + filter.a2 * s2)
  return 20 * Math.log10(Math.hypot(numRe, numIm) / Math.max(1e-12, Math.hypot(denRe, denIm)))
}

export function cascadeDb(filters: Biquad[], freq: number, sampleRate: number) {
  return filters.reduce((sum, filter) => sum + responseDb(filter, freq, sampleRate), 0)
}

/** FET 1176-style fixed ratios, including the all-buttons crush as the last entry. */
export const FET_RATIOS = [4, 8, 12, 20, 20] as const

/** Static gain reduction for a level `overDb` above the fixed -18 dBFS threshold. */
export function fetReduction(overDb: number, ratioIndex: number) {
  const ratio = FET_RATIOS[clamp(Math.round(ratioIndex), 0, FET_RATIOS.length - 1)]
  const knee = 1.5
  let over = overDb
  if (over <= -knee) return 0
  if (over < knee) {
    const soft = over + knee
    over = (soft * soft) / (4 * knee)
  }
  let reduction = Math.max(0, over) * (1 - 1 / ratio)
  if (Math.round(ratioIndex) >= 4 && overDb > 2) reduction += Math.min(4, (overDb - 2) * 0.35)
  return reduction
}

/** VCA bus ratios 2, 4, and 10. The curve is the published static law, within a tight tolerance. */
export const BUS_RATIOS = [2, 4, 10] as const
export const BUS_ATTACKS = [0.1, 0.3, 1, 3, 10, 30] as const
export const BUS_RELEASES = [100, 300, 600, 1200, 0] as const

export function vcaReduction(overDb: number, ratioIndex: number) {
  const ratio = BUS_RATIOS[clamp(Math.round(ratioIndex), 0, BUS_RATIOS.length - 1)]
  if (overDb <= 0) return 0
  return overDb * (1 - 1 / ratio)
}

/**
 * Vari-mu time constants.
 * Positions 1–4 match the published Fairchild 670 chart.
 * Positions 5 and 6 are the dual-release settings: a fast part plus a slow tail.
 */
export const VARI_TIMES: { attack: number; release: number; slow: number }[] = [
  { attack: 0.2, release: 300, slow: 300 },
  { attack: 0.2, release: 800, slow: 800 },
  { attack: 0.4, release: 2000, slow: 2000 },
  { attack: 0.8, release: 5000, slow: 5000 },
  { attack: 0.2, release: 300, slow: 2000 },
  { attack: 0.4, release: 800, slow: 5000 },
]

export function variReduction(overDb: number) {
  const knee = 8
  if (overDb <= -knee / 2) return 0
  const soft = overDb + knee / 2
  const bent = soft < knee ? (soft * soft) / (2 * knee) : overDb
  const ratio = 4
  return Math.max(0, bent) * (1 - 1 / ratio)
}

export function propQ(gainDb: number) {
  return clamp(0.35 + Math.abs(gainDb) / 7, 0.35, 2.4)
}

export function channelQ(curve: number) {
  return curve >= 0.5 ? 1.5 : 0.65
}

const LOW_FREQS = [20, 30, 60, 100]
const HIGH_FREQS = [3000, 4000, 5000, 8000, 10000, 12000, 16000]
const HIGH_ATTEN = [5000, 10000, 20000]

/** Pultec-style passive shelves. Boost and atten sit at different corners, which makes the low-end trick. */
export function passiveFilters(sampleRate: number, params: Record<string, number>): Biquad[] {
  const low = stepPick(params.lowF ?? 2, LOW_FREQS)
  const high = stepPick(params.highF ?? 4, HIGH_FREQS)
  const attenF = stepPick(params.highAttenF ?? 1, HIGH_ATTEN)
  const boost = clamp(params.lowBoost ?? 0, 0, 1) * 12
  const atten = -clamp(params.lowAtten ?? 0, 0, 1) * 12
  const highBoost = clamp(params.highBoost ?? 0, 0, 1) * 14
  const bandwidth = clamp(params.highBw ?? 0.5, 0, 1)
  const q = 0.4 + bandwidth * 1.6
  const highCut = -clamp(params.highAtten ?? 0, 0, 1) * 12
  return [
    designBiquad('peaking', sampleRate, low, 0.9, boost),
    designBiquad('lowshelf', sampleRate, low * 3.2, 0.7, atten * 0.7),
    designBiquad('peaking', sampleRate, high, q, highBoost),
    designBiquad('highshelf', sampleRate, attenF, 0.7, highCut),
  ]
}

const PRE_HP = [0, 50, 80, 160, 300]
const PRE_LOW = [35, 60, 110, 220]
const PRE_MID = [360, 700, 1600, 3200, 4800, 7200]

/** Stepped preamp/EQ. The high band is an inductor-like shelf, and drive is separate. */
export function preFilters(sampleRate: number, params: Record<string, number>): Biquad[] {
  const hp = stepPick(params.hp ?? 0, PRE_HP)
  const lowF = stepPick(params.lowF ?? 2, PRE_LOW)
  const midF = stepPick(params.midF ?? 2, PRE_MID)
  const highF = (params.highF ?? 0) >= 0.5 ? 12000 : 10000
  const filters = [
    designBiquad('lowshelf', sampleRate, lowF, 0.7, clamp(params.lowG ?? 0, -16, 16)),
    designBiquad('peaking', sampleRate, midF, 1.1, clamp(params.midG ?? 0, -18, 18)),
    designBiquad('highshelf', sampleRate, highF, 0.6, clamp(params.highG ?? 0, -16, 16)),
  ]
  if (hp > 0) filters.unshift(designBiquad('highpass', sampleRate, hp, 0.7))
  return filters
}

export function tapeBumpHz(speedIndex: number) {
  const speed = stepPick(speedIndex, [7.5, 15, 30])
  return 55 * (speed / 15)
}

export interface Meter {
  vu: number
  gr: number
}

export function createMeter(): Meter {
  return { vu: -20, gr: 0 }
}

const powerOf = new WeakMap<Meter, number>()

/** A sine peaking at -18 dBFS reads 0 VU. */
export function trackVu(meter: Meter, sample: number, sampleRate: number) {
  const follow = coeff(300, sampleRate)
  const prev = powerOf.get(meter) ?? 0
  const next = prev + (sample * sample - prev) * follow
  powerOf.set(meter, next)
  const reference = (10 ** (VU_DBFS / 20)) / Math.SQRT2
  const rms = Math.sqrt(Math.max(next, 1e-12))
  meter.vu = 20 * Math.log10(rms / reference)
}

export interface Shaper {
  factor: number
  hist: Float64Array
  high: Float64Array
  phases: Float64Array[]
  downTaps: Float64Array
  write: number
  highWrite: number
  memory: { u: number; f: number }
}

function kernel(length: number, cutoff: number, gain: number) {
  const taps = new Float64Array(length)
  const mid = (length - 1) / 2
  let sum = 0
  for (let i = 0; i < length; i++) {
    const x = i - mid
    const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1))
    taps[i] = 2 * cutoff * sinc * window
    sum += taps[i]
  }
  const scale = gain / (sum || 1)
  for (let i = 0; i < length; i++) taps[i] *= scale
  return taps
}

const PHASE_TAPS = 16
const DOWN_TAPS = 31

function polyphase(factor: number, cutoff: number, gain: number) {
  const full = kernel(factor * PHASE_TAPS, cutoff, gain)
  return Array.from({ length: factor }, (_, phase) => {
    const branch = new Float64Array(PHASE_TAPS)
    for (let tap = 0; tap < PHASE_TAPS; tap++) branch[tap] = full[tap * factor + phase] || 0
    return branch
  })
}

export function createShaper(factor: number): Shaper {
  const rate = factor <= 2 ? 2 : 4
  return {
    factor: rate,
    hist: new Float64Array(PHASE_TAPS),
    high: new Float64Array(DOWN_TAPS),
    phases: polyphase(rate, 0.45 / rate, rate),
    downTaps: kernel(DOWN_TAPS, 0.9 / rate, 1),
    write: 0,
    highWrite: 0,
    memory: { u: 0, f: 0 },
  }
}

/** Even-rich tube/transformer curve. ADAA is the difference of log(cosh), the tanh antiderivative. */
export function colorSample(x: number, drive: number, prev: { u: number; f: number }) {
  const amount = clamp(drive, 0, 1)
  const shaped = x * (1 + amount * 3)
  const limited = Math.max(-12, Math.min(12, shaped))
  const next = Math.log(Math.cosh(limited))
  const delta = limited - prev.u
  const tanhAdaa = Math.abs(delta) < 1e-5 ? Math.tanh(limited) : (next - prev.f) / delta
  prev.u = limited
  prev.f = next
  const even = amount * 0.15 * limited * limited * Math.sign(limited) / (1 + limited * limited)
  return (tanhAdaa + even) / (1 + amount * 0.6)
}

export function oversample(shaper: Shaper, sample: number, drive: number) {
  if (drive <= 0.0001) return sample
  shaper.hist[shaper.write] = sample
  for (let phase = 0; phase < shaper.factor; phase++) {
    const branch = shaper.phases[phase]
    let acc = 0
    for (let tap = 0; tap < branch.length; tap++) {
      const index = (shaper.write - tap + shaper.hist.length) % shaper.hist.length
      acc += shaper.hist[index] * branch[tap]
    }
    shaper.high[shaper.highWrite] = colorSample(acc, drive, shaper.memory)
    shaper.highWrite = (shaper.highWrite + 1) % shaper.high.length
  }
  shaper.write = (shaper.write + 1) % shaper.hist.length
  let mixed = 0
  for (let tap = 0; tap < shaper.downTaps.length; tap++) {
    const index = (shaper.highWrite - 1 - tap + shaper.high.length) % shaper.high.length
    mixed += shaper.high[index] * shaper.downTaps[tap]
  }
  return mixed
}

/**
 * Block oversampler used by the aliasing test.
 * `factor` is 2 or 4. The kernels are windowed sincs at the new Nyquist.
 */
export function oversampleBlock(input: Float32Array, factor: number, shape: (sample: number) => number) {
  const upLen = input.length * factor
  const up = new Float32Array(upLen)
  const taps = 63
  const cutoff = 0.45 / factor
  const mid = (taps - 1) / 2
  const weights = new Float64Array(taps)
  let sum = 0
  for (let i = 0; i < taps; i++) {
    const x = (i - mid) / factor
    const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1))
    weights[i] = sinc * window
    sum += weights[i]
  }
  for (let i = 0; i < taps; i++) weights[i] /= sum || 1
  for (let i = 0; i < upLen; i++) {
    const center = i / factor
    let acc = 0
    for (let tap = 0; tap < taps; tap++) {
      const at = Math.round(center) - mid + tap
      if (at >= 0 && at < input.length) acc += input[at] * weights[tap]
    }
    up[i] = shape(acc)
  }
  const output = new Float32Array(input.length)
  const downCut = cutoff
  for (let i = 0; i < output.length; i++) {
    let acc = 0
    let norm = 0
    for (let tap = -mid; tap <= mid; tap++) {
      const at = i * factor + tap
      const x = tap
      const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(2 * downCut * Math.PI * x) / (Math.PI * x)
      const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * (tap + mid)) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * (tap + mid)) / (taps - 1))
      const weight = sinc * window
      if (at >= 0 && at < up.length) acc += up[at] * weight
      norm += weight
    }
    output[i] = norm !== 0 ? acc / norm : 0
  }
  return output
}

export function applyFilters(filters: Biquad[], sample: number) {
  let value = sample
  for (const filter of filters) value = tickBiquad(filter, value)
  return sanitize(value)
}

export function copyFilter(target: Biquad, next: Biquad) {
  target.b0 = next.b0
  target.b1 = next.b1
  target.b2 = next.b2
  target.a1 = next.a1
  target.a2 = next.a2
}

export function rmsDb(channel: Float32Array, start = 0, end = channel.length) {
  let sum = 0
  let count = 0
  for (let i = start; i < end; i++) {
    sum += channel[i] * channel[i]
    count += 1
  }
  const mean = count ? sum / count : 0
  return mean > 1e-12 ? 10 * Math.log10(mean) : -120
}

export { clamp, dbToGain, designBiquad, gainToDb, sanitize }
