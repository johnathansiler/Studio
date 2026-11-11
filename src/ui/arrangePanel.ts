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

/**
 * The sheet close calls history.back(), which fires popstate on a later turn.
 * An editor opened in the same click pushes its own entry before that pop,
 * and the late pop then removes the editor. Callers that push history wait for this.
 */
let pendingPop: Promise<void> | null = null

/** The in-flight sheet pop, or null when history.back() is not waiting. */
export function sheetHistoryPop(): Promise<void> | null {
  return pendingPop
}

/** Drop the sheet history entry when a control closes it. A browser Back press is already popping. */
export function popSheetHistory() {
  if (typeof history === 'undefined') return
  const state = history.state as { cueharbor?: string } | null
  if (state?.cueharbor !== MARK || pendingPop) return
  pendingPop = new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('popstate', done)
      pendingPop = null
      resolve()
    }
    window.addEventListener('popstate', done)
  })
  history.back()
}

export function rememberSheetHistory(key: string) {
  if (typeof history === 'undefined') return
  const state = history.state as { cueharbor?: string } | null
  if (state?.cueharbor === MARK) history.replaceState({ cueharbor: MARK, id: key }, '')
  else history.pushState({ cueharbor: MARK, id: key }, '')
}
