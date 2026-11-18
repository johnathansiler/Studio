import { TEMPO_MAX, TEMPO_MIN } from './tap'

/** A still press this long opens the BPM field and must not count as a tap. */
export const TEMPO_HOLD_MS = 450

const RANGE = `Use a tempo from ${TEMPO_MIN} to ${TEMPO_MAX}`

/** Inline message for empty, junk, or out-of-range text. A number still applies, clamped. */
export function tempoEntryIssue(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed === '.' || trimmed === '-' || trimmed === '-.') return RANGE
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return RANGE
  if (value < TEMPO_MIN || value > TEMPO_MAX) return RANGE
  return null
}

/**
 * One decimal inside 20–300. Out-of-range numbers clamp. Empty or junk returns null
 * so the field can show an error instead of applying.
 */
export function tempoEntryBpm(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed === '.' || trimmed === '-' || trimmed === '-.') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return null
  const clamped = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, value))
  return Math.round(clamped * 10) / 10
}

export interface TempoEntryBox {
  left: number
  top: number
  width: number
  height: number
}

/** Compact popover under the Tap button, kept on screen. Flips above only when it would not fit below. */
export function placeTempoEntry(
  trigger: TempoEntryBox,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
  margin = 8,
): { top: number; left: number; side: 'down' | 'up' } {
  const width = Math.min(menu.width, Math.max(0, viewport.width - margin * 2))
  let left = trigger.left
  if (left + width > viewport.width - margin) left = viewport.width - margin - width
  if (left < margin) left = margin
  const below = trigger.top + trigger.height + gap
  if (below + menu.height <= viewport.height - margin) return { top: below, left, side: 'down' }
  const above = trigger.top - gap - menu.height
  if (above >= margin) return { top: above, left, side: 'up' }
  return { top: Math.max(margin, viewport.height - margin - menu.height), left, side: 'down' }
}
