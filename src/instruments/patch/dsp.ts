import { continuousCeiling } from '../../audio/liveStage'

export function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Flush denormals. Full-scale and below stay linear; overs do not collapse. */
export function san(value: number) {
  return continuousCeiling(value)
}

export function hermite(buffer: Float32Array, pos: number) {
  const length = buffer.length
  if (length < 2) return buffer[0] || 0
  const x = clamp(pos, 0, length - 1.001)
  const i = Math.floor(x)
  const f = x - i
  const y0 = buffer[Math.max(0, i - 1)] || 0
  const y1 = buffer[i] || 0
  const y2 = buffer[Math.min(length - 1, i + 1)] || 0
  const y3 = buffer[Math.min(length - 1, i + 2)] || 0
  const c1 = 0.5 * (y2 - y0)
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
  return san(((c3 * f + c2) * f + c1) * f + y1)
}

interface Biq {
  x1: number
  x2: number
  y1: number
  y2: number
}

export function freshBiq(): Biq {
  return { x1: 0, x2: 0, y1: 0, y2: 0 }
}

/** RBJ biquad. Stable at high cutoffs, where a Chamberlin SVF starts to ring. */
export function biquadStep(state: Biq, input: number, cutoff: number, q: number, mode: number, sampleRate: number) {
  const w0 = (2 * Math.PI * clamp(cutoff, 20, sampleRate * 0.45)) / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const alpha = sin / (2 * clamp(q, 0.5, 12))
  const a0 = 1 + alpha
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  let b0 = 0
  let b1 = 0
  let b2 = 0
  if (mode === 1) {
    b0 = (1 + cos) / 2 / a0
    b1 = -(1 + cos) / a0
    b2 = b0
  } else if (mode === 2) {
    b0 = alpha / a0
    b1 = 0
    b2 = -b0
  } else {
    b0 = (1 - cos) / 2 / a0
    b1 = (1 - cos) / a0
    b2 = b0
  }
  const y = b0 * input + b1 * state.x1 + b2 * state.x2 - a1 * state.y1 - a2 * state.y2
  state.x2 = state.x1
  state.x1 = input
  state.y2 = state.y1
  state.y1 = san(y)
  return state.y1
}

/** Deterministic 0–1 value so spray stays repeatable. */
export function hashUnit(seed: number) {
  let x = Math.imul(seed | 0, 0x6d2b79f5)
  x = Math.imul(x ^ (x >>> 15), x | 1)
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}
