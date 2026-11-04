import { glideValue, PARAM_SMOOTH_SEC } from '../paramCurve'

/**
 * Integer choices. Gliding these passes a fraction into Math.round and the
 * processor stays on the old mode until the glide crosses halfway.
 */
const STEPPED_PARAMS = new Set([
  'kind', 'mode', 'sync', 'pingpong', 'releaseMode', 'ir', 'shape', 'bands',
  'loopMode', 'clipMode', 'hq', 'cab', 'mono', 'keys', 'record', 'linear',
  'ms', 'scaleIndex', 'root', 'holdMidi', 'mask', 'bypassMask', 'custom',
  'phase', 'transport', 'model', 'lfF', 'lmfF', 'hmfF', 'hfF',
  'pLow', 'pHigh', 'preHp', 'preLow', 'preMid', 'preHigh', 'pCutF',
  'busRatio', 'busAtk', 'busRel', 'fetRatio', 'variTime', 'bits',
])

/** Linear gains and pans. These can move every sample without retuning a filter. */
const CHEAP_PARAMS = new Set([
  'gain', 'pan', 'mix', 'drive', 'output', 'makeup', 'wet', 'master', 'volume',
])

export function isSteppedParam(key: string) {
  return STEPPED_PARAMS.has(key)
}

export function isCheapParam(key: string) {
  return CHEAP_PARAMS.has(key)
}

/** Look-ahead and pitch processors keep one parameter value for the whole block. */
export function usesBlockValue(pluginId: string, latencySamples: number, params?: Record<string, number>) {
  if (latencySamples > 0) return true
  if (pluginId === 'tune' || pluginId === 'limiter') return true
  if (pluginId === 'mod' && Math.round(params?.kind ?? 0) === 5) return true
  return false
}

/** One-pole coefficient for a single sample. The block glide uses the same time constant. */
export function sampleAlpha(sampleRate: number, seconds = PARAM_SMOOTH_SEC) {
  const tau = Math.min(0.015, Math.max(0.005, seconds))
  const rate = sampleRate > 0 ? sampleRate : 48000
  return 1 - Math.exp(-1 / (tau * rate))
}

/**
 * Per-sample gain or pan. The first target snaps, so a settled knob matches
 * a processor that read the value once. Later targets move one sample at a time.
 */
export class SampleGlide {
  private value = 0
  private ready = false
  private alpha = 0
  private rate = 0

  prepare(sampleRate: number) {
    const rate = sampleRate > 0 ? sampleRate : 48000
    if (rate === this.rate && this.alpha > 0) return
    this.rate = rate
    this.alpha = sampleAlpha(rate)
  }

  /** True once a target has been seen. A constant target stays bit-exact after that. */
  get settled() {
    return this.ready
  }

  peek() {
    return this.value
  }

  snap(target: number) {
    this.value = Number.isFinite(target) ? target : 0
    this.ready = true
    return this.value
  }

  next(target: number) {
    const goal = Number.isFinite(target) ? target : 0
    if (!this.ready) return this.snap(goal)
    if (Math.abs(this.value - goal) < 1e-6) {
      this.value = goal
      return goal
    }
    this.value += (goal - this.value) * this.alpha
    return this.value
  }

  reset() {
    this.ready = false
    this.value = 0
  }
}

/**
 * Per-sample smoother. `nextBlock` matches `glideValue`, which is what the
 * insert worklet already applies, so a steady knob stays bit-for-bit.
 */
export class ParamSmoother {
  private current = new Float64Array(0)
  private target = new Float64Array(0)
  private stepped = new Uint8Array(0)
  private alpha = 0
  private rate = 48000

  prepare(count: number, sampleRate: number) {
    const n = Math.max(0, count | 0)
    this.current = new Float64Array(n)
    this.target = new Float64Array(n)
    this.stepped = new Uint8Array(n)
    this.rate = sampleRate > 0 ? sampleRate : 48000
    this.alpha = sampleAlpha(this.rate)
  }

  /** Stepped and enum parameters jump. They are not glided. */
  markStepped(index: number, stepped = true) {
    if (index < 0 || index >= this.stepped.length) return
    this.stepped[index] = stepped ? 1 : 0
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

  /** Advance one sample toward the target. Stepped parameters land on the target. */
  nextSample(index: number) {
    const goal = this.target[index] || 0
    if (this.stepped[index]) {
      this.current[index] = goal
      return goal
    }
    const from = this.current[index] || 0
    if (Math.abs(from - goal) < 1e-6) {
      this.current[index] = goal
      return goal
    }
    const next = from + (goal - from) * this.alpha
    this.current[index] = next
    return next
  }

  /** One exponential step for a whole block. Same curve as `glideValue`. Stepped parameters jump. */
  nextBlock(index: number, frames: number) {
    const goal = this.target[index] || 0
    if (this.stepped[index]) {
      this.current[index] = goal
      return goal
    }
    const next = glideValue(this.current[index] || 0, goal, frames, this.rate)
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
      prev[key] = isSteppedParam(key) ? (target ?? from) : glideValue(from, target ?? from, frames, sampleRate)
    }
    if (!keys) {
      for (const key of Object.keys(prev)) if (!(key in params)) delete prev[key]
    }
    return prev
  }
}
