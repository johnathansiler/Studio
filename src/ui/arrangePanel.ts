export type UtilitySheet = 'setup' | 'tools' | 'snap'

export const ARRANGE_SHEET_EVENT = 'cueharbor-arrange-sheet'

const MARK = 'arrange-sheet'

let current: UtilitySheet | null = null
const listeners = new Set<() => void>()

export function currentArrangeSheet() {
  return current
}

export function subscribeArrangeSheet(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function publishArrangeSheet(id: UtilitySheet | null) {
  if (current === id) return
  current = id
  for (const listener of listeners) listener()
}

export function toggleArrangeSheet(id: UtilitySheet) {
  document.dispatchEvent(new CustomEvent(ARRANGE_SHEET_EVENT, { detail: id }))
}

export function sheetHistoryKey(trackId: string | null, utility: UtilitySheet | null) {
  if (trackId) return `track:${trackId}`
  return utility
}

/** Drop the sheet history entry when a control closes it. A browser Back press is already popping. */
export function popSheetHistory() {
  if (typeof history === 'undefined') return
  const state = history.state as { cueharbor?: string } | null
  if (state?.cueharbor === MARK) history.back()
}

export function rememberSheetHistory(key: string) {
  if (typeof history === 'undefined') return
  const state = history.state as { cueharbor?: string } | null
  if (state?.cueharbor === MARK) history.replaceState({ cueharbor: MARK, id: key }, '')
  else history.pushState({ cueharbor: MARK, id: key }, '')
}
