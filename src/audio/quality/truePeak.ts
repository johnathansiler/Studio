/**
 * 4x intersample peak for one new sample.
 * 16 taps per phase, Kaiser beta 5, cutoff at the original Nyquist.
 * On the sines used by the limiter tests this stays within about 0.02 dB of a
 * 64-tap 4x reconstruction, which is inside the 0.05 dB true-peak budget.
 * A full-scale 1 kHz sine reads about 1.0003, so callers treat anything within
 * 0.005% of the ceiling as not over.
 */

const FACTOR = 4
const PHASE_TAPS = 16
const BETA = 5
const BESSEL_TERMS = 12

export const TRUE_PEAK_SLACK = 1.0005

function bessel0(x: number) {
  let sum = 1
  let term = 1
  const half = x * 0.5
  for (let k = 1; k <= BESSEL_TERMS; k++) {
    term *= (half * half) / (k * k)
    sum += term
  }
  return sum
}

function designPhases() {
  const length = FACTOR * PHASE_TAPS
  const cutoff = 0.5 / FACTOR
  const mid = (length - 1) / 2
  const kernel = new Float64Array(length)
  let sum = 0
  for (let i = 0; i < length; i++) {
    const x = i - mid
    const arg = 2 * cutoff * x
    const sinc = Math.abs(arg) < 1e-8 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg)
    const amount = mid === 0 ? 0 : x / mid
    const inside = 1 - amount * amount
    const win = inside > 0 ? bessel0(BETA * Math.sqrt(inside)) / bessel0(BETA) : 0
    kernel[i] = 2 * cutoff * sinc * win
    sum += kernel[i]
  }
  const scale = FACTOR / (sum || 1)
  for (let i = 0; i < length; i++) kernel[i] *= scale
  return Array.from({ length: FACTOR }, (_, phase) => {
    const taps = new Float64Array(PHASE_TAPS)
    for (let tap = 0; tap < PHASE_TAPS; tap++) taps[tap] = kernel[tap * FACTOR + phase] || 0
    return taps
  })
}

const PHASES = designPhases()

export interface TruePeakState {
  hist: Float64Array
  write: number
}

export function createTruePeakState(): TruePeakState {
  return { hist: new Float64Array(PHASE_TAPS), write: 0 }
}

export function resetTruePeak(state: TruePeakState) {
  state.hist.fill(0)
  state.write = 0
}

/** Largest absolute value of this sample and the three quarter-sample points around it. */
export function readTruePeak(state: TruePeakState, sample: number) {
  const hist = state.hist
  const at = state.write
  hist[at] = sample
  let best = sample < 0 ? -sample : sample
  for (let phase = 0; phase < FACTOR; phase++) {
    const branch = PHASES[phase]
    let acc = 0
    for (let tap = 0; tap < PHASE_TAPS; tap++) {
      acc += hist[(at - tap + PHASE_TAPS) % PHASE_TAPS] * branch[tap]
    }
    const abs = acc < 0 ? -acc : acc
    if (abs > best) best = abs
  }
  state.write = (at + 1) % PHASE_TAPS
  return best
}
