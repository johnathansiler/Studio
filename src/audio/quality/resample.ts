/** Windowed-sinc resampler. Sample-rate conversion stays band-limited. */

const BESSEL_TERMS = 12

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
  const beta = 8.6
  const i0 = bessel0(beta)
  for (let i = 0; i < output.length; i++) {
    const center = (i + 0.5) * scale - 0.5
    const iCenter = Math.floor(center)
    let acc = 0
    let norm = 0
    for (let k = -half; k <= half; k++) {
      const idx = iCenter + k
      const x = idx - center
      const ratio = half <= 0 ? 0 : k / half
      const inside = 1 - ratio * ratio
      const win = inside > 0 ? bessel0(beta * Math.sqrt(inside)) / i0 : 0
      const kernel = 2 * fc * sinc(2 * fc * x) * win
      if (idx >= 0 && idx < input.length) acc += (input[idx] || 0) * kernel
      norm += kernel
    }
    output[i] = norm !== 0 ? acc / norm : 0
  }
  return output
}
