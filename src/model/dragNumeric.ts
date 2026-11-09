/** Shared finger math for every numeric control. One whole number is about 10px. */

export const INTEGER_PX = 10
export const FINE_INTEGER_PX = 40
/** How close a value must be before it sticks on the nearest integer. */
export const DETENT_RADIUS = 0.3
export const LONG_PRESS_MS = 450

export function applyIntegerDetent(value: number, radius = DETENT_RADIUS) {
  if (!Number.isFinite(value)) return value
  const nearest = Math.round(value)
  if (Math.abs(value - nearest) <= radius + 1e-9) return nearest
  return value
}

/** Pixels of finger travel for a change of 1. Never faster than the control's own full-range drag. */
export function pixelsPerUnit(span: number, spanPx: number | undefined, fine: boolean) {
  const floor = fine ? FINE_INTEGER_PX : INTEGER_PX
  if (!(spanPx && spanPx > 0) || !(span > 0) || !Number.isFinite(span)) return floor
  return Math.max(spanPx / span, floor)
}

export function dragNumeric(input: {
  origin: number
  deltaPx: number
  min?: number
  max?: number
  fine?: boolean
  /** Pixels that cover max-min on this control. Omit for a pure 10px-per-integer drag. */
  spanPx?: number
}) {
  const fine = !!input.fine
  const min = input.min ?? Number.NEGATIVE_INFINITY
  const max = input.max ?? Number.POSITIVE_INFINITY
  const span = Number.isFinite(max) && Number.isFinite(min) ? max - min : 1
  const px = pixelsPerUnit(span, input.spanPx, fine)
  const raw = input.origin + input.deltaPx / (px || 1)
  const next = fine ? raw : applyIntegerDetent(raw)
  if (!Number.isFinite(next)) return Number.isFinite(input.origin) ? input.origin : 0
  return Math.min(max, Math.max(min, next))
}

/** True the moment a drag lands on a whole number it was not already on. */
export function landedOnInteger(before: number, after: number) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false
  if (Math.abs(after - Math.round(after)) > 1e-6) return false
  return Math.abs(before - after) > 1e-6
}
