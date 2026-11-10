/** Columns for a two-row tray. Extra rows are only used when two rows cannot keep a 40px chip. */
export function trayColumns(count: number, width: number, min = 40, gap = 6): number {
  const safe = Math.max(0, Math.floor(count))
  if (safe <= 1) return 1
  const twoRows = Math.ceil(safe / 2)
  const fit = Math.max(1, Math.floor((Math.max(0, width) + gap) / (min + gap)))
  return Math.max(1, Math.min(twoRows, fit))
}

export function trayRows(count: number, columns: number): number {
  const safe = Math.max(0, Math.floor(count))
  if (safe === 0) return 0
  return Math.ceil(safe / Math.max(1, columns))
}
