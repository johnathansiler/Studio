/**
 * Zero-crossing search for editors. This walks a buffer on the UI thread
 * when a handle moves. It never runs on the audio thread.
 */

export interface ZeroHit {
  /** Sample to land on: the later sample of the pair that crosses zero. */
  index: number
  /** Fractional sample where the line between neighbors crosses zero. */
  at: number
  locked: boolean
}

const NEAR = 1e-5

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** True when sample `index` is on the far side of a zero from the previous sample. */
export function crossesAt(channel: ArrayLike<number>, index: number) {
  if (index <= 0 || index >= channel.length) return false
  const prev = channel[index - 1] || 0
  const value = channel[index] || 0
  return prev === 0 || prev * value < 0 || Math.abs(value) < NEAR
}

/** Fractional offset from `index - 1` to `index` where the pair crosses zero. */
export function crossingPosition(channel: ArrayLike<number>, index: number) {
  if (index <= 0) return 0
  const prev = channel[index - 1] || 0
  const value = channel[index] || 0
  if (Math.abs(value) < NEAR) return index
  if (prev === 0) return index - 1
  const span = value - prev
  if (span === 0) return index
  const t = -prev / span
  if (t < 0 || t > 1) return index
  return index - 1 + t
}

/**
 * Nearest zero-crossing sample to `index`, searching outward.
 * Ties keep the earlier sample. With no crossing inside `radius`, returns `index`.
 */
export function nearestZeroIndex(channel: ArrayLike<number>, index: number, radius = 256) {
  const last = Math.max(0, channel.length - 1)
  const at = clamp(Math.round(index), 0, last)
  if (channel.length < 2 || radius < 1) return at
  const from = Math.max(1, at - radius)
  const to = Math.min(last, at + radius)
  const maxDist = Math.max(at - from, to - at)
  for (let dist = 0; dist <= maxDist; dist++) {
    const left = at - dist
    const right = at + dist
    if (left >= from && crossesAt(channel, left)) return left
    if (dist > 0 && right <= to && crossesAt(channel, right)) return right
  }
  return at
}

/** Snap to the nearest crossing when `enabled`. Otherwise keep the sample where it is. */
export function lockToZero(channel: ArrayLike<number> | null | undefined, index: number, enabled: boolean, radius?: number): ZeroHit {
  const length = channel?.length ?? 0
  const clamped = clamp(Math.round(index), 0, Math.max(0, length - 1))
  if (!enabled || !channel || length < 2) return { index: clamped, at: clamped, locked: false }
  const reach = radius == null ? length : radius
  const found = nearestZeroIndex(channel, clamped, reach)
  if (!crossesAt(channel, found)) return { index: clamped, at: clamped, locked: false }
  return { index: found, at: crossingPosition(channel, found), locked: true }
}

/** Crossings whose later sample lies in `[start, end]`, capped so a wide view stays light. */
export function crossingsInRange(channel: ArrayLike<number>, start: number, end: number, limit = 8000): { index: number; at: number }[] {
  const from = Math.max(1, Math.floor(start))
  const to = Math.min(channel.length - 1, Math.ceil(end))
  if (to < from || to - from > limit) return []
  const hits: { index: number; at: number }[] = []
  for (let i = from; i <= to; i++) {
    if (!crossesAt(channel, i)) continue
    hits.push({ index: i, at: crossingPosition(channel, i) })
  }
  return hits
}

export interface FractionSnap {
  fraction: number
  index: number
  at: number
  locked: boolean
}

/** Snap a 0..1 buffer fraction. `1` is the end of the buffer, past the last sample. */
export function snapFraction(channel: ArrayLike<number> | null | undefined, fraction: number, enabled: boolean): FractionSnap {
  const length = channel?.length ?? 0
  const clamped = clamp(fraction, 0, 1)
  if (!enabled || !channel || length < 2) {
    const sample = clamped * Math.max(0, length)
    return { fraction: clamped, index: Math.round(sample), at: sample, locked: false }
  }
  const sample = clamped * length
  const hit = lockToZero(channel, sample, true, length)
  if (!hit.locked) return { fraction: clamped, index: Math.round(sample), at: sample, locked: false }
  return { fraction: hit.index / length, index: hit.index, at: hit.at, locked: true }
}
