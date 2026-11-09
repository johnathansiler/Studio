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

/**
 * A single tap only selects. A second tap soon after opens the editor.
 * A clip on a Step Sequencer track, including the MIDI clip To Arrange writes, opens that sequencer on the first tap.
 */
export const CLIP_DOUBLE_MS = 350

export function clipTapAction(input: {
  moved: boolean
  sinceLastMs: number
  kind: 'audio' | 'midi' | 'pattern'
  /** Clips on a Step Sequencer track open that editor on the first tap. */
  sequencer?: boolean
}): 'drag' | 'select' | 'edit' {
  if (input.moved) return 'drag'
  if (input.sequencer && (input.kind === 'pattern' || input.kind === 'midi')) return 'edit'
  if (input.kind !== 'pattern' && input.sinceLastMs >= 0 && input.sinceLastMs < CLIP_DOUBLE_MS) return 'edit'
  return 'select'
}

/** Double-click on an empty lane can add a clip. A click on a clip does not. */
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
