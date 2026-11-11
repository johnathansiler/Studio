/**
 * 4x oversampled waveshaper.
 * A windowed-sinc polyphase raises the rate, ADAA shapes tanh, then a lowpass drops back.
 */

const FACTOR = 4
const PHASE_TAPS = 8
const DOWN_TAPS = 32

function sinc(x: number) {
  if (Math.abs(x) < 1e-8) return 1
  const p = Math.PI * x
  return Math.sin(p) / p
}

function bessel0(x: number) {
  let sum = 1
  let term = 1
  const half = x * 0.5
  for (let k = 1; k <= 10; k++) {
    term *= (half * half) / (k * k)
    sum += term
  }
  return sum
}

function kaiser(amount: number, beta: number) {
  const inside = 1 - amount * amount
  return inside > 0 ? bessel0(beta * Math.sqrt(inside)) / bessel0(beta) : 0
}

function lowpass(length: number, cutoff: number, gain: number) {
  const kernel = new Float64Array(length)
  const mid = (length - 1) / 2
  const beta = 8
  let sum = 0
  for (let i = 0; i < length; i++) {
    const x = i - mid
    kernel[i] = 2 * cutoff * sinc(2 * cutoff * x) * kaiser(mid === 0 ? 0 : x / mid, beta)
    sum += kernel[i]
  }
  const scale = sum !== 0 ? gain / sum : 1
  for (let i = 0; i < length; i++) kernel[i] *= scale
  return kernel
}

export interface ShaperState {
  ring: Float64Array
  write: number
  high: Float64Array
  highWrite: number
  prevU: number
  prevF: number
  filled: number
}

export function resetShaperState(state: ShaperState) {
  state.ring.fill(0)
  state.high.fill(0)
  state.write = 0
  state.highWrite = 0
  state.prevU = 0
  state.prevF = 0
  state.filled = 0
}

export function createShaperState(): ShaperState {
  return {
    ring: new Float64Array(PHASE_TAPS),
    write: 0,
    high: new Float64Array(DOWN_TAPS),
    highWrite: 0,
    prevU: 0,
    prevF: 0,
    filled: 0,
  }
}

export function shaperLatencySamples() {
  return Math.round((PHASE_TAPS + DOWN_TAPS / FACTOR) / 2)
}

const PHASES = (() => {
  const kernel = lowpass(FACTOR * PHASE_TAPS, 0.45 / FACTOR, FACTOR)
  return Array.from({ length: FACTOR }, (_, phase) => {
    const taps = new Float64Array(PHASE_TAPS)
    for (let tap = 0; tap < PHASE_TAPS; tap++) taps[tap] = kernel[tap * FACTOR + phase] || 0
    return taps
  })
})()

/** Just under the original Nyquist. 0.9/factor sat above it and folded the new harmonics. */
const DOWN = lowpass(DOWN_TAPS, 0.4 / FACTOR, 1)

/**
 * Odd rational stand-in for tanh. Max abs error vs tanh is 0.024 on the real line
 * (at about 1.57), and it saturates at ±1. No log or cosh.
 */
export function padeTanh(u: number) {
  const a = u < 0 ? -u : u
  const y = (a * (27 + a * a)) / (27 + 9 * a * a)
  const clamped = y > 1 ? 1 : y
  return u < 0 ? -clamped : clamped
}

export function oversampleShape(state: ShaperState, sample: number, drive: number, shape: number) {
  state.ring[state.write] = sample
  const norm = padeTanh(shape) || 1
  for (let phase = 0; phase < FACTOR; phase++) {
    const taps = PHASES[phase]
    let acc = 0
    for (let tap = 0; tap < PHASE_TAPS; tap++) {
      const index = (state.write - tap + PHASE_TAPS) % PHASE_TAPS
      acc += state.ring[index] * taps[tap]
    }
    const curved = (acc + drive * acc * acc * 0.2) * shape
    state.high[state.highWrite] = padeTanh(curved) / norm
    state.highWrite = (state.highWrite + 1) % DOWN_TAPS
  }
  state.write = (state.write + 1) % PHASE_TAPS
  state.filled += 1
  let mixed = 0
  for (let tap = 0; tap < DOWN_TAPS; tap++) {
    const index = (state.highWrite - 1 - tap + DOWN_TAPS) % DOWN_TAPS
    mixed += state.high[index] * DOWN[tap]
  }
  return mixed
}
