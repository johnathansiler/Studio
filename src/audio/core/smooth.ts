import { glideValue, PARAM_SMOOTH_SEC } from '../paramCurve'

/** One-pole coefficient for a single sample. The block glide uses the same time constant. */
export function sampleAlpha(sampleRate: number, seconds = PARAM_SMOOTH_SEC) {
  const tau = Math.min(0.015, Math.max(0.005, seconds))
  const rate = sampleRate > 0 ? sampleRate : 48000
  return 1 - Math.exp(-1 / (tau * rate))
}

/**
 * Per-sample smoother. `nextBlock` matches `glideValue`, which is what the
 * insert worklet already applies, so a steady knob stays bit-for-bit.
 */
export class ParamSmoother {
  private current = new Float64Array(0)
  private target = new Float64Array(0)
  private alpha = 0
  private rate = 48000

  prepare(count: number, sampleRate: number) {
    const n = Math.max(0, count | 0)
    this.current = new Float64Array(n)
    this.target = new Float64Array(n)
    this.rate = sampleRate > 0 ? sampleRate : 48000
    this.alpha = sampleAlpha(this.rate)
  }

  snap(index: number, value: number) {
    if (index < 0 || index >= this.target.length) return
    const next = Number.isFinite(value) ? value : 0
    this.target[index] = next
    this.current[index] = next
  }

  setTarget(index: number, value: number) {
    if (index < 0 || index >= this.target.length) return
    this.target[index] = Number.isFinite(value) ? value : 0
  }

  /** Advance one sample toward the target. */
  nextSample(index: number) {
    const goal = this.target[index] || 0
    const from = this.current[index] || 0
    if (Math.abs(from - goal) < 1e-6) {
      this.current[index] = goal
      return goal
    }
    const next = from + (goal - from) * this.alpha
    this.current[index] = next
    return next
  }

  /** One exponential step for a whole block. Same curve as `glideValue`. */
  nextBlock(index: number, frames: number) {
    const next = glideValue(this.current[index] || 0, this.target[index] || 0, frames, this.rate)
    this.current[index] = next
    return next
  }
}

/**
 * Block smoother keyed by plugin id. The worklet calls this instead of
 * allocating a parameter object every quantum.
 */
export class BlockSmoother {
  private held = new Map<string, Record<string, number>>()

  reset(id?: string) {
    if (id) this.held.delete(id)
    else this.held.clear()
  }

  /**
   * Write the smoothed parameters into `into` and return it.
   * The first block snaps, matching the previous worklet glide.
   * Pass `keys` from prepare so the audio thread does not allocate a key list.
   */
  apply(
    id: string,
    params: Record<string, number>,
    frames: number,
    sampleRate: number,
    into: Record<string, number>,
    keys?: readonly string[],
  ) {
    const list = keys ?? Object.keys(params)
    let prev = this.held.get(id)
    if (!prev) {
      for (const key of Object.keys(into)) delete into[key]
      for (let i = 0; i < list.length; i++) into[list[i]] = params[list[i]]
      this.held.set(id, into)
      return into
    }
    if (prev !== into) {
      for (const key of Object.keys(into)) delete into[key]
      for (const key of Object.keys(prev)) into[key] = prev[key]
      this.held.set(id, into)
      prev = into
    }
    for (let i = 0; i < list.length; i++) {
      const key = list[i]
      const target = params[key]
      const from = typeof prev[key] === 'number' ? prev[key] : target
      prev[key] = glideValue(from, target ?? from, frames, sampleRate)
    }
    if (!keys) {
      for (const key of Object.keys(prev)) if (!(key in params)) delete prev[key]
    }
    return prev
  }
}
