export type FormFactor = 'phone' | 'fold' | 'desk'

/** Narrow portrait and short landscape stay on the phone shell. Near-square inner screens use two panes. */
export function formFactor(width: number, height: number): FormFactor {
  const landscape = width > height
  if (landscape && height <= 520) return 'phone'
  if (width <= 520) return 'phone'
  if (width <= 1100) return 'fold'
  return 'desk'
}

export function isLandscape(width: number, height: number) {
  return width > height
}
