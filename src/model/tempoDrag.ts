import { applyIntegerDetent, dragNumeric } from './dragNumeric'
import { roundTempo } from './tap'

/** Pixels of movement before a press becomes a tempo drag. A shorter move stays a tap. */
export const TEMPO_DRAG_SLOP = 10

/** BPM added for each pixel the finger moves up. One whole BPM is 10px. */
export const TEMPO_DRAG_PER_PX = 0.1

export type TempoDragIntent = 'pending' | 'drag' | 'scroll'

/**
 * A press is still a tap until it moves past the slop.
 * Vertical movement edits tempo. A larger horizontal move is left to the page.
 * `dy` is up-positive (start Y minus current Y).
 */
export function tempoDragIntent(dx: number, dy: number, slop = TEMPO_DRAG_SLOP): TempoDragIntent {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < slop && ay < slop) return 'pending'
  if (ax > ay) return 'scroll'
  return 'drag'
}

/** Song tempo for an upward drag of `dy` pixels, on the same 30–300 scale as typing. */
export function tempoFromDrag(origin: number, dy: number, perPx = TEMPO_DRAG_PER_PX, fine = false) {
  if (perPx === TEMPO_DRAG_PER_PX) return roundTempo(dragNumeric({ origin, deltaPx: dy, min: 30, max: 300, fine }), false)
  const raw = origin + dy * perPx
  return roundTempo(fine ? raw : applyIntegerDetent(raw), false)
}
