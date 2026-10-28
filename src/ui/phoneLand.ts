/**
 * Phone landscape chrome. Heights match src/ui/remoteFixes.css.
 * At 844×390 and 915×412 the timeline row keeps most of the screen.
 */

export const PHONE_LAND_TOP = 32
export const PHONE_LAND_TRANSPORT = 32
export const PHONE_LAND_TOOLS = 28
/** Open sheets stay under this share of the viewport so the timeline is still visible. */
export const PHONE_LAND_SHEET = 0.26

export const PHONE_LAND_VIEWPORTS = [
  { width: 844, height: 390, name: '844x390' },
  { width: 915, height: 412, name: '915x412' },
] as const

export function phoneLandscape(width: number, height: number) {
  return width > height && height <= 520
}

export function landscapeChrome() {
  return PHONE_LAND_TOP + PHONE_LAND_TRANSPORT + PHONE_LAND_TOOLS
}

/** Share of the viewport left for the timeline or mixer when the three chrome rows are open. */
export function landscapeWorkShare(height: number) {
  if (height <= 0) return 0
  return (height - landscapeChrome()) / height
}
