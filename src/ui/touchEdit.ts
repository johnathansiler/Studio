/** Where a trim-tool tap lands on a clip, as a fraction from the left edge. */
export function trimZone(ratio: number, coarse: boolean): 'start' | 'end' | null {
  if (!Number.isFinite(ratio)) return null
  const t = Math.min(1, Math.max(0, ratio))
  if (coarse) return t < 0.5 ? 'start' : 'end'
  if (t <= 0.22) return 'start'
  if (t >= 0.78) return 'end'
  return null
}

/** Resize grip in pixels. Touch gets a wider edge, but a middle band stays for moving. */
export function noteGrip(width: number, coarse: boolean) {
  const size = Math.max(0, width)
  if (!coarse) return Math.min(8, size * 0.25)
  const wanted = Math.min(22, Math.max(12, size * 0.28))
  return Math.min(wanted, size * 0.34)
}

export function coarsePointer(pointerType: string) {
  return pointerType === 'touch' || pointerType === 'pen'
}

/** How long a phone press waits before the pattern-clip menu opens. */
export const PATTERN_HOLD_MS = 480
/** Movement past this many pixels is a drag, so the menu stays closed. */
export const PATTERN_HOLD_SLOP = 8

/** A still phone press opens Duplicate / Delete. A drag moves the clip instead. */
export function patternHoldOpensMenu(phone: boolean, heldMs: number, movedPx: number): boolean {
  return phone && heldMs >= PATTERN_HOLD_MS && movedPx <= PATTERN_HOLD_SLOP
}
