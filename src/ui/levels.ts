/** Mixer strip and arrange header share this scale of the post-fader reading. */
export function meterFill(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0
  return Math.min(1, level * 3.2)
}
