/** Trim, zoom, and zero-crossing math for the pad screen. No audio thread. */

export interface WaveView {
  /** Visible window as fractions of the buffer. */
  start: number
  end: number
}

export interface ZeroHit {
  index: number
  rising: boolean
}

const cache = new WeakMap<Float32Array, Map<string, Float32Array>>()

export function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function secondsLabel(fraction: number, frames: number, sampleRate: number) {
  const rate = sampleRate > 0 ? sampleRate : 48000
  const seconds = (clamp01(fraction) * Math.max(0, frames)) / rate
  return `${seconds.toFixed(2)} s`
}

/** Min and max in each pixel of the visible window. Cached per buffer and view. */
export function viewPeaks(samples: Float32Array, view: WaveView, width: number, reverse: boolean): Float32Array {
  const pixels = Math.max(1, Math.round(width))
  const key = `${pixels}|${view.start.toFixed(5)}|${view.end.toFixed(5)}|${reverse ? 1 : 0}`
  let bucket = cache.get(samples)
  if (!bucket) {
    bucket = new Map()
    cache.set(samples, bucket)
  }
  const hit = bucket.get(key)
  if (hit) return hit
  const peaks = new Float32Array(pixels * 2)
  const length = samples.length
  const from = Math.max(0, Math.min(length - 1, Math.floor(view.start * length)))
  const to = Math.max(from + 1, Math.min(length, Math.ceil(view.end * length)))
  const span = Math.max(1, to - from)
  for (let x = 0; x < pixels; x++) {
    const a = from + Math.floor((x * span) / pixels)
    const b = from + Math.floor(((x + 1) * span) / pixels)
    let lo = 0
    let hi = 0
    const last = Math.max(a + 1, b)
    for (let i = a; i < last && i < length; i++) {
      const at = reverse ? length - 1 - i : i
      const sample = samples[at] || 0
      if (sample < lo) lo = sample
      if (sample > hi) hi = sample
    }
    peaks[x * 2] = lo
    peaks[x * 2 + 1] = hi
  }
  if (bucket.size > 32) bucket.clear()
  bucket.set(key, peaks)
  return peaks
}

/** True when the visible window is only a few samples per pixel. */
export function showsSamples(view: WaveView, length: number, width: number) {
  const visible = Math.max(1, (view.end - view.start) * Math.max(1, length))
  return width > 0 && visible / width <= 4
}

export function sampleIndex(fraction: number, length: number) {
  if (length <= 1) return 0
  return Math.max(0, Math.min(length - 1, Math.round(clamp01(fraction) * (length - 1))))
}

export function fractionOf(index: number, length: number) {
  if (length <= 1) return 0
  return clamp01(index / (length - 1))
}

export function zeroCrossings(samples: Float32Array, from: number, to: number): ZeroHit[] {
  const hits: ZeroHit[] = []
  const start = Math.max(1, from)
  const end = Math.min(samples.length - 1, to)
  for (let i = start; i <= end; i++) {
    const prev = samples[i - 1] || 0
    const cur = samples[i] || 0
    if (prev < 0 && cur >= 0) hits.push({ index: i, rising: true })
    else if (prev > 0 && cur <= 0) hits.push({ index: i, rising: false })
    else if (cur === 0 && prev !== 0) hits.push({ index: i, rising: prev < 0 })
  }
  return hits
}

/** Nearest rising or falling zero crossing inside the radius, or the raw index. */
export function resolveTrimIndex(samples: Float32Array, rawIndex: number, snap: boolean, radius: number): { index: number; crossing: ZeroHit | null } {
  const length = samples.length
  const raw = Math.max(0, Math.min(Math.max(0, length - 1), Math.round(rawIndex)))
  if (!snap || length < 2) return { index: raw, crossing: null }
  const reach = Math.max(1, Math.round(radius))
  const hits = zeroCrossings(samples, raw - reach, raw + reach)
  if (!hits.length) return { index: raw, crossing: null }
  let best = hits[0]
  let dist = Math.abs(best.index - raw)
  for (const hit of hits) {
    const next = Math.abs(hit.index - raw)
    if (next < dist) {
      best = hit
      dist = next
    }
  }
  return { index: best.index, crossing: best }
}

export function snapRadius(sampleRate: number, zoomed: boolean) {
  const rate = sampleRate > 0 ? sampleRate : 48000
  return Math.max(2, Math.round(rate * (zoomed ? 0.004 : 0.012)))
}

export function zoomAround(view: WaveView, focus: number, factor: number, length: number): WaveView {
  const span = Math.max(1e-6, view.end - view.start)
  const minSpan = Math.min(1, 8 / Math.max(8, length))
  const next = Math.min(1, Math.max(minSpan, span / (factor > 0 ? factor : 1)))
  const place = clamp01(focus)
  const ratio = span > 0 ? (place - view.start) / span : 0.5
  let start = place - ratio * next
  let end = start + next
  if (start < 0) {
    end -= start
    start = 0
  }
  if (end > 1) {
    start -= end - 1
    end = 1
  }
  if (start < 0) start = 0
  return { start, end }
}

export function panView(view: WaveView, delta: number): WaveView {
  const span = Math.max(1e-6, view.end - view.start)
  let start = view.start + delta
  let end = start + span
  if (start < 0) {
    start = 0
    end = Math.min(1, span)
  }
  if (end > 1) {
    end = 1
    start = Math.max(0, 1 - span)
  }
  return { start, end }
}

/** A close-up of about `samples` points centered on a fraction. */
export function closeUp(fraction: number, length: number, samples = 64): WaveView {
  const span = Math.min(1, Math.max(8, samples) / Math.max(8, length))
  const place = clamp01(fraction)
  let start = place - span / 2
  let end = start + span
  if (start < 0) {
    start = 0
    end = span
  }
  if (end > 1) {
    end = 1
    start = Math.max(0, 1 - span)
  }
  return { start, end }
}

/** Horizontal drag. Pulling away from the wave shrinks the movement for fine placement. */
export function dragFraction(origin: number, dx: number, width: number, fine: boolean) {
  const scale = fine ? 0.2 : 1
  const span = width > 0 ? width : 1
  return clamp01(origin + (dx * scale) / span)
}

export function viewFraction(pointer: number, width: number, view: WaveView, reverse: boolean) {
  const local = width > 0 ? Math.min(1, Math.max(0, pointer / width)) : 0
  const shown = reverse ? 1 - local : local
  return view.start + shown * (view.end - view.start)
}

export function markerLeft(fraction: number, view: WaveView, reverse: boolean) {
  const span = view.end - view.start
  if (!(span > 0)) return 0
  const shown = reverse ? 1 - fraction : fraction
  return (shown - view.start) / span
}
