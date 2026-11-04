/** Mixer strip and arrange header share this scale of the post-fader reading. */
export function meterFill(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0
  return Math.min(1, level * 3.2)
}

export interface MeterHold {
  value: number
  at: number
}

/**
 * Painted meter height, 0–1. A short drum hit jumps up and stays readable,
 * then falls. `hold.value` stays at the peak until the fall finishes.
 */
export function holdMeter(hold: MeterHold, level: number, now: number, holdMs = 220, fallMs = 280): number {
  const next = meterFill(level)
  const peak = Number.isFinite(hold.value) && hold.value > 0 ? Math.min(1, hold.value) : 0
  if (!(peak > 0) || next >= peak) {
    hold.value = next
    hold.at = now
    return next
  }
  const age = Math.max(0, now - (Number.isFinite(hold.at) ? hold.at : now))
  if (age <= holdMs) return peak
  const fall = 1 - (age - holdMs) / Math.max(1, fallMs)
  if (fall <= 0) {
    hold.value = 0
    hold.at = now
    return 0
  }
  return peak * fall
}
