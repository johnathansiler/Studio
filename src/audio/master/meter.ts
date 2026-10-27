/** EBU R128 / ITU-R BS.1770 loudness and a 4x true-peak reading. */

import { createOversample, truePeakDb, type Oversample } from './fir'
import { clamp, type Biquad } from '../plugins/dsp'

const ABSOLUTE_GATE = -70
const RELATIVE_LU = 10

export interface LoudnessReading {
  integrated: number
  shortTerm: number
  momentary: number
  lra: number
  truePeak: number
  rms: number
  crest: number
  correlation: number
}

export function designKWeight(sampleRate: number): [Biquad, Biquad] {
  return [designPreFilter(sampleRate), designHighPass(sampleRate)]
}

function designPreFilter(sampleRate: number): Biquad {
  const f0 = 1681.974450955533
  const gain = 3.999843853973347
  const q = 0.7071752369554196
  const k = Math.tan(Math.PI * f0 / sampleRate)
  const vh = 10 ** (gain / 20)
  const vb = vh ** 0.4996667741545416
  const a0 = 1 + k / q + k * k
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
    x1: 0, x2: 0, y1: 0, y2: 0,
  }
}

function designHighPass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444
  const q = 0.5003270373238773
  const k = Math.tan(Math.PI * f0 / sampleRate)
  const a0 = 1 + k / q + k * k
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
    x1: 0, x2: 0, y1: 0, y2: 0,
  }
}

function tick(filter: Biquad, x: number) {
  const y = filter.b0 * x + filter.b1 * filter.x1 + filter.b2 * filter.x2 - filter.a1 * filter.y1 - filter.a2 * filter.y2
  filter.x2 = filter.x1
  filter.x1 = x
  filter.y2 = filter.y1
  filter.y1 = y
  return y
}

function weight(sample: number, shelf: Biquad, highpass: Biquad) {
  return tick(highpass, tick(shelf, sample))
}

function toLufs(meanSquare: number) {
  if (meanSquare <= 1e-12) return -70
  return -0.691 + 10 * Math.log10(meanSquare)
}

function gatedMean(blocks: number[], relativeLu: number) {
  const passed = blocks.filter((block) => toLufs(block) > ABSOLUTE_GATE)
  if (!passed.length) return 0
  const absolute = passed.reduce((sum, block) => sum + block, 0) / passed.length
  const relative = toLufs(absolute) - relativeLu
  const kept = passed.filter((block) => toLufs(block) >= relative)
  if (!kept.length) return absolute
  return kept.reduce((sum, block) => sum + block, 0) / kept.length
}

function percentile(values: number[], p: number) {
  if (!values.length) return -70
  const sorted = [...values].sort((a, b) => a - b)
  const index = clamp((p / 100) * (sorted.length - 1), 0, sorted.length - 1)
  const low = Math.floor(index)
  const high = Math.min(sorted.length - 1, low + 1)
  const frac = index - low
  return sorted[low] * (1 - frac) + sorted[high] * frac
}

function energyOf(left: Float32Array, right: Float32Array, start: number, length: number) {
  const end = Math.min(left.length, start + length)
  let sum = 0
  let count = 0
  for (let i = start; i < end; i++) {
    sum += (left[i] || 0) ** 2 + (right[i] || 0) ** 2
    count += 1
  }
  return count ? sum / count : 0
}

/** Integrated, short-term, momentary, LRA, true peak, RMS, crest, and correlation. */
export function measureProgram(leftIn: Float32Array, rightIn: Float32Array | null, sampleRate: number): LoudnessReading {
  const left = leftIn
  const right = rightIn ?? leftIn
  const n = Math.min(left.length, right.length)
  const rate = Math.max(8000, sampleRate)
  const weightedL = new Float32Array(n)
  const weightedR = new Float32Array(n)
  const [ls, lh] = designKWeight(rate)
  const [rs, rh] = designKWeight(rate)
  for (let i = 0; i < n; i++) {
    weightedL[i] = weight(left[i] || 0, ls, lh)
    weightedR[i] = weight(right[i] || 0, rs, rh)
  }
  const momentaryLen = Math.max(1, Math.round(0.4 * rate))
  const hop = Math.max(1, Math.round(0.1 * rate))
  const blocks: number[] = []
  if (n < momentaryLen) blocks.push(energyOf(weightedL, weightedR, 0, n))
  else for (let start = 0; start + momentaryLen <= n; start += hop) blocks.push(energyOf(weightedL, weightedR, start, momentaryLen))
  const integrated = toLufs(gatedMean(blocks, RELATIVE_LU))
  const momentary = toLufs(blocks[blocks.length - 1] ?? 0)
  const shortBlocks = Math.max(1, Math.round(3 / 0.1))
  const shortValues: number[] = []
  for (let i = 0; i < blocks.length; i += 10) {
    const slice = blocks.slice(Math.max(0, i - shortBlocks + 1), i + 1)
    const mean = slice.reduce((sum, block) => sum + block, 0) / slice.length
    shortValues.push(toLufs(mean))
  }
  const shortTerm = shortValues[shortValues.length - 1] ?? momentary
  const shortEnergy = shortValues.map((value) => (value <= -69 ? 0 : 10 ** ((value + 0.691) / 10)))
  const lraGate = toLufs(gatedMean(shortEnergy.filter((value) => value > 0), 20))
  const lraValues = shortValues.filter((value) => value >= lraGate && value > ABSOLUTE_GATE)
  const lra = lraValues.length >= 2 ? Math.max(0, percentile(lraValues, 95) - percentile(lraValues, 10)) : 0

  let sum = 0
  let peak = 0
  let lr = 0
  let ll = 0
  let rr = 0
  for (let i = 0; i < n; i++) {
    const l = left[i] || 0
    const r = right[i] || 0
    sum += l * l + r * r
    peak = Math.max(peak, Math.abs(l), Math.abs(r))
    lr += l * r
    ll += l * l
    rr += r * r
  }
  const mean = n ? sum / n : 0
  const rms = mean > 1e-12 ? 10 * Math.log10(mean) : -70
  const peakDb = peak > 1e-8 ? 20 * Math.log10(peak) : -70
  const correlation = ll > 1e-12 && rr > 1e-12 ? clamp(lr / Math.sqrt(ll * rr), -1, 1) : 1
  return {
    integrated,
    shortTerm,
    momentary,
    lra,
    truePeak: truePeakDb([left.subarray(0, n), right.subarray(0, n)]),
    rms,
    crest: peakDb - rms,
    correlation,
  }
}

export interface MeterState {
  left: [Biquad, Biquad]
  right: [Biquad, Biquad]
  samples: number
  block: number
  blockSamples: number
  energies: number[]
  short: number[]
  scope: Float32Array
  scopeWrite: number
  momentary: number
  shortTerm: number
  integrated: number
  lra: number
  truePeak: number
  rms: number
  crest: number
  correlation: number
  held: number
  peakLeft: Oversample
  peakRight: Oversample
}

export function createMeter(sampleRate: number): MeterState {
  return {
    left: designKWeight(sampleRate),
    right: designKWeight(sampleRate),
    samples: 0,
    block: 0,
    blockSamples: 0,
    energies: [],
    short: [],
    scope: new Float32Array(256),
    scopeWrite: 0,
    momentary: -70,
    shortTerm: -70,
    integrated: -70,
    lra: 0,
    truePeak: -70,
    rms: -70,
    crest: 0,
    correlation: 1,
    held: 0,
    peakLeft: createOversample(4, 32),
    peakRight: createOversample(4, 32),
  }
}

/** Update a running master meter from one audio block. `heavy` enables 4x true peak. */
export function feedMeter(state: MeterState, left: Float32Array, right: Float32Array, sampleRate: number, heavy: boolean) {
  const hop = Math.max(1, Math.round(0.1 * sampleRate))
  let sum = 0
  let peak = 0
  let lr = 0
  let ll = 0
  let rr = 0
  const n = left.length
  for (let i = 0; i < n; i++) {
    const l = left[i] || 0
    const r = right[i] || 0
    const wl = weight(l, state.left[0], state.left[1])
    const wr = weight(r, state.right[0], state.right[1])
    state.block += wl * wl + wr * wr
    state.blockSamples += 1
    sum += l * l + r * r
    peak = Math.max(peak, Math.abs(l), Math.abs(r))
    lr += l * r
    ll += l * l
    rr += r * r
    if ((state.samples + i) % 8 === 0) {
      state.scope[state.scopeWrite] = l
      state.scope[state.scopeWrite + 1] = r
      state.scopeWrite = (state.scopeWrite + 2) % state.scope.length
    }
    if (state.blockSamples >= hop) {
      state.energies.push(state.block / state.blockSamples)
      if (state.energies.length > 18000) state.energies.shift()
      state.block = 0
      state.blockSamples = 0
    }
  }
  state.samples += n
  const momentaryBlocks = 4
  const recent = state.energies.slice(-momentaryBlocks)
  const momentaryMean = recent.length ? recent.reduce((total, value) => total + value, 0) / recent.length : 0
  state.momentary = toLufs(momentaryMean)
  const shortBlocks = 30
  const shortSlice = state.energies.slice(-shortBlocks)
  state.shortTerm = toLufs(shortSlice.length ? shortSlice.reduce((total, value) => total + value, 0) / shortSlice.length : 0)
  if (state.energies.length % 10 === 0) state.short.push(state.shortTerm)
  if (state.short.length > 4000) state.short.shift()
  state.integrated = toLufs(gatedMean(state.energies, RELATIVE_LU))
  const lraValues = state.short.filter((value) => value > ABSOLUTE_GATE)
  state.lra = lraValues.length >= 2 ? Math.max(0, percentile(lraValues, 95) - percentile(lraValues, 10)) : 0
  const mean = n ? sum / n : 0
  state.rms = mean > 1e-12 ? 10 * Math.log10(mean) : -70
  const samplePeak = peak > 1e-8 ? 20 * Math.log10(peak) : -70
  let inter = samplePeak
  if (heavy) {
    const scratch = new Float32Array(n)
    let linear = 0
    const watch = (sample: number) => {
      linear = Math.max(linear, Math.abs(sample))
      return sample
    }
    state.peakLeft.process(left, scratch, watch)
    state.peakRight.process(right, scratch, watch)
    inter = linear > 1e-8 ? 20 * Math.log10(linear) : -70
  }
  const linearPeak = inter <= -70 ? 0 : 10 ** (inter / 20)
  state.held = Math.max(linearPeak, state.held * Math.exp(-n / sampleRate))
  state.truePeak = state.held > 1e-8 ? 20 * Math.log10(state.held) : -70
  state.crest = state.truePeak - state.rms
  state.correlation = ll > 1e-12 && rr > 1e-12 ? clamp(lr / Math.sqrt(ll * rr), -1, 1) : state.correlation
  return state
}
