/**
 * Windowed-sinc resampler. Sample-rate conversion stays band-limited.
 * The kernel is a polyphase table: one build per cutoff, then a multiply per tap.
 * A direct sinc on every output sample stalls the main thread on a phone when a
 * 96 kHz file is fitted to 44.1 or 48 kHz. The table matches that filter.
 */

const BESSEL_TERMS = 12
const PHASES = 256

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

function sinc(x: number) {
  if (Math.abs(x) < 1e-8) return 1
  const p = Math.PI * x
  return Math.sin(p) / p
}

export interface PolyphaseKernel {
  half: number
  taps: number
  phases: number
  rows: Float32Array
}

const kernels = new Map<string, PolyphaseKernel>()

/** Kaiser-windowed lowpass, normalized per phase. `fc` is cycles per source sample. */
export function polyphaseKernel(fc: number, half: number): PolyphaseKernel {
  const radius = Math.max(8, Math.min(128, half | 0))
  const cutoff = Math.min(0.49, Math.max(0.02, Math.round(fc * 10000) / 10000))
  const key = `${radius}|${cutoff}`
  const cached = kernels.get(key)
  if (cached) return cached
  const taps = radius * 2 + 1
  const rows = new Float32Array(PHASES * taps)
  const beta = 8.6
  const i0 = bessel0(beta)
  for (let phase = 0; phase < PHASES; phase++) {
    const frac = phase / PHASES
    let sum = 0
    const base = phase * taps
    for (let tap = 0; tap < taps; tap++) {
      const k = tap - radius
      const x = k - frac
      const ratio = k / radius
      const inside = 1 - ratio * ratio
      const win = inside > 0 ? bessel0(beta * Math.sqrt(inside)) / i0 : 0
      const weight = 2 * cutoff * sinc(2 * cutoff * x) * win
      rows[base + tap] = weight
      sum += weight
    }
    if (sum !== 0) for (let tap = 0; tap < taps; tap++) rows[base + tap] /= sum
  }
  const kernel = { half: radius, taps, phases: PHASES, rows }
  kernels.set(key, kernel)
  return kernel
}

/** One source-position read. Out-of-range samples are zero, so the edges do not jump. */
export function sampleKernel(kernel: PolyphaseKernel, channel: Float32Array, pos: number) {
  const length = channel.length
  if (length < 1 || !Number.isFinite(pos)) return 0
  const origin = Math.floor(pos)
  const row = Math.min(kernel.phases - 1, Math.max(0, Math.floor((pos - origin) * kernel.phases)))
  const base = row * kernel.taps
  const start = origin - kernel.half
  const rows = kernel.rows
  let acc = 0
  const from = start < 0 ? -start : 0
  const to = start + kernel.taps > length ? length - start : kernel.taps
  for (let tap = from; tap < to; tap++) acc += channel[start + tap] * rows[base + tap]
  return acc
}

/** Same kernel for a sample that is not one contiguous buffer. */
export function sampleKernelAt(kernel: PolyphaseKernel, sampleAt: (index: number) => number, pos: number) {
  if (!Number.isFinite(pos)) return 0
  const origin = Math.floor(pos)
  const row = Math.min(kernel.phases - 1, Math.max(0, Math.floor((pos - origin) * kernel.phases)))
  const base = row * kernel.taps
  const start = origin - kernel.half
  const rows = kernel.rows
  let acc = 0
  for (let tap = 0; tap < kernel.taps; tap++) acc += (sampleAt(start + tap) || 0) * rows[base + tap]
  return acc
}

/**
 * Resample `input` to exactly `outLen` samples.
 * `taps` is the kernel half-width. 96 is the offline setting; 24 is the live preview.
 */
export function resampleSinc(input: Float32Array, outLen: number, taps = 96): Float32Array {
  const output = new Float32Array(Math.max(1, outLen | 0))
  if (input.length < 1) return output
  if (input.length === 1 || output.length === 1) {
    output.fill(input[0] || 0)
    return output
  }
  if (input.length === output.length) {
    output.set(input)
    return output
  }
  const half = Math.max(8, Math.min(128, taps | 0))
  const scale = input.length / output.length
  const fc = Math.min(0.45, 0.45 / Math.max(1, scale))
  const kernel = polyphaseKernel(fc, half)
  for (let i = 0; i < output.length; i++) {
    const center = (i + 0.5) * scale - 0.5
    output[i] = sampleKernel(kernel, input, center)
  }
  return output
}
