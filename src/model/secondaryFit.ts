/** How mixer secondary controls fit as the strip gets narrower. */

export const TARGET_PX = 40
export const GAP_PX = 2

/**
 * Higher stays on the strip longer.
 * Mute and Solo are the controls under a finger.
 * Tune, Safe, and Arm are the first to step behind More.
 */
export const SECONDARY_KEEP: Record<string, number> = {
  mute: 100,
  solo: 90,
  automation: 80,
  routing: 70,
  master: 68,
  inserts: 60,
  pan: 50,
  arm: 40,
  level: 32,
  safe: 20,
  tune: 10,
}

/**
 * Full-word button widths at the mixer face (12px, semibold, horizontal padding).
 * A little wider than the measured glyphs so a control moves behind More
 * before its word is clipped.
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

/**
 * Keep every control on the strip while they fit in `maxRows`.
 * When they do not, move the least-used into the drawer and reserve one More button.
 * Shown order is the keep order, so the row fills with the controls people reach for.
 */
export function fitSecondary(width: number, items: SecondarySlot[], maxRows: number, moreWidth = controlWidth('More')): SecondaryFit {
  const normalized = items.map((item) => ({
    id: item.id,
    width: Math.max(TARGET_PX, item.width),
    keep: item.keep ?? SECONDARY_KEEP[item.id] ?? 0,
  }))
  const ordered = [...normalized].sort((a, b) => b.keep - a.keep || a.id.localeCompare(b.id))
  if (!ordered.length) return { shown: [], drawer: [], rows: 0 }
  const budget = Math.max(1, maxRows)
  const widths = (list: { width: number }[], more: boolean) => {
    const values = list.map((item) => item.width)
    if (more) values.push(Math.max(TARGET_PX, moreWidth))
    return values
  }
  if (rowsFor(width, widths(ordered, false)) <= budget) {
    return { shown: ordered.map((item) => item.id), drawer: [], rows: rowsFor(width, widths(ordered, false)) }
  }
  const kept = [...ordered]
  const drawer: typeof ordered = []
  while (kept.length > 1 && rowsFor(width, widths(kept, true)) > budget) drawer.push(kept.pop()!)
  drawer.sort((a, b) => b.keep - a.keep || a.id.localeCompare(b.id))
  return {
    shown: kept.map((item) => item.id),
    drawer: drawer.map((item) => item.id),
    rows: rowsFor(width, widths(kept, drawer.length > 0)),
  }
}

/**
 * How many closed rows this band can spend before the volume fader stops being the main control.
 * Rows stay on one line so several tracks still fit on a phone.
 * Columns stack, then More, because a 40px strip can hold one word per line.
 */
export function secondaryRowBudget(flow: 'columns' | 'rows', zone: 'tools' | 'hear' | 'top', width: number) {
  if (zone === 'hear' || zone === 'top') return width < 112 ? 2 : 1
  if (flow === 'rows') return 1
  if (width >= 160) return 3
  return 4
}

/** Content box the secondary band can use. */
export function secondaryContentWidth(flow: 'columns' | 'rows', strip: number, viewport: number) {
  if (flow === 'rows') return Math.max(TARGET_PX, viewport - 16)
  const pad = strip < 72 ? 2 : 12
  return Math.max(TARGET_PX, strip - pad)
}
