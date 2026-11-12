/** How mixer secondary controls fit as the strip gets narrower. */

export const TARGET_PX = 40
export const GAP_PX = 2

/**
 * Kept so a caller can still rank controls.
 * The mixer no longer hides any of them: every control stays on the strip.
 */

/**
 * Full-word button widths at the mixer face (12px, semibold, horizontal padding).
 * A little wider than the measured glyphs so a word is not clipped on a narrow strip.
 */
export const CONTROL_WIDTH: Record<string, number> = {
  Off: 46,
  Read: 50,
  Touch: 58,
  Latch: 58,
  Mute: 54,
  Solo: 48,
  Inserts: 64,
  Arm: 48,
  Safe: 48,
  Tune: 54,
  Level: 58,
  Pan: 40,
  More: 58,
  Master: 66,
  Cue: 50,
}

export interface SecondarySlot {
  id: string
  width: number
  keep?: number
}

export interface SecondaryFit {
  shown: string[]
  drawer: string[]
  rows: number
}

export function controlWidth(label: string) {
  const known = CONTROL_WIDTH[label]
  if (known) return known
  const letters = [...label.trim()].length
  return Math.max(TARGET_PX, Math.ceil(letters * 8 + 22))
}

/** Rows a list of control widths occupies, wrapping at `width`. */
export function rowsFor(width: number, itemWidths: number[], gap = GAP_PX) {
  const room = Math.max(TARGET_PX, width)
  if (!itemWidths.length) return 0
  let rows = 1
  let used = 0
  for (const item of itemWidths) {
    const need = Math.max(TARGET_PX, item)
    if (used === 0) {
      used = need
      continue
    }
    if (used + gap + need <= room + 0.5) used += gap + need
    else {
      rows += 1
      used = need
    }
  }
  return rows
}

/** Every control stays on the strip, in the order it was given. A tall band scrolls. */
export function fitSecondary(width: number, items: SecondarySlot[]): SecondaryFit {
  const ordered = items.map((item) => ({
    id: item.id,
    width: Math.max(TARGET_PX, item.width),
  }))
  if (!ordered.length) return { shown: [], drawer: [], rows: 0 }
  return {
    shown: ordered.map((item) => item.id),
    drawer: [],
    rows: rowsFor(width, ordered.map((item) => item.width)),
  }
}

/**
 * How many rows a closed band used to spend before the fader stopped being the main control.
 * The mixer ignores this budget now and scrolls the secondary band instead.
 */

/** Content box the secondary band can use. */
export function secondaryContentWidth(flow: 'columns' | 'rows', strip: number, viewport: number) {
  if (flow === 'rows') return Math.max(TARGET_PX, viewport - 16)
  const pad = strip < 72 ? 2 : 12
  return Math.max(TARGET_PX, strip - pad)
}
