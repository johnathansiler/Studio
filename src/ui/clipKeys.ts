/** A DOM node, or the small stand-in the tests use. */
type KeyHost = { tagName?: string; isContentEditable?: boolean }

/** True while the user is typing, so Delete edits the text instead of a clip. */
export function editingText(target: EventTarget | KeyHost | null) {
  const el = target as KeyHost | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

/** Delete and Backspace remove the selected clip when focus is on the timeline. */
export function deletesSelection(key: string, target: EventTarget | KeyHost | null) {
  if (editingText(target)) return false
  return key === 'Delete' || key === 'Backspace'
}

type ClipHost = { closest?: (selector: string) => unknown }

/** Double-click on an empty lane can add a clip. A click on a clip only opens its editor. */
export function laneDoubleClickAddsClip(target: EventTarget | ClipHost | null) {
  const el = target as ClipHost | null
  if (!el || typeof el.closest !== 'function') return true
  return !el.closest('[data-clip]')
}

/** A quick pointer drag is enough. The browser drag gesture waits longer and drops the flick. */
export const QUICK_DRAG_PX = 3

export function quickDragArmed(dx: number, dy: number, threshold = QUICK_DRAG_PX) {
  return Math.hypot(dx, dy) >= threshold
}
