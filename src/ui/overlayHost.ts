/** Shared close list for menus, sheets, drawers, and full-size views. */

const closers = new Set<() => void>()

/** Register a closer. The returned function removes it. New overlays should register so a view tab closes them too. */
export function registerOverlay(close: () => void) {
  closers.add(close)
  return () => { closers.delete(close) }
}

/** Close every registered overlay. Safe to call when nothing is open. */
export function closeAllOverlays() {
  for (const close of [...closers]) {
    try { close() } catch { /* one closer must not block the rest */ }
  }
}

export function overlayCount() {
  return closers.size
}

/** Test helper. Production code should unregister with the function registerOverlay returns. */
export function resetOverlayRegistry() {
  closers.clear()
}

/**
 * A view tab always closes overlays, then leaves the keyboard.
 * A locked phone orientation is released with the existing helper.
 */
export function onViewTab(input: {
  keyboardOpen: boolean
  orientationLocked: boolean
  releaseOrientation: () => void
  hideKeyboard: () => void
}) {
  closeAllOverlays()
  if (input.keyboardOpen) input.hideKeyboard()
  if (input.orientationLocked) input.releaseOrientation()
}

export interface ViewTabFrame {
  top: number
  left: number
  right: number
  bottom: number
  height: number
}

/** Measure the Arrange / Mix / Collab bar and publish it as shared layout tokens. */
export function syncViewTabFrame(root?: ParentNode | null): ViewTabFrame | null {
  if (typeof document === 'undefined') return null
  const bar = (root ?? document).querySelector('.views')
  if (!bar) return null
  const box = bar.getBoundingClientRect()
  const frame = {
    top: box.top,
    left: box.left,
    right: box.right,
    bottom: box.bottom,
    height: box.height,
  }
  const target = document.documentElement
  target.style.setProperty('--view-tabs-top', `${frame.top}px`)
  target.style.setProperty('--view-tabs-height', `${frame.height}px`)
  target.style.setProperty('--view-tabs-bottom', `${frame.bottom}px`)
  target.style.setProperty('--view-tabs-left', `${frame.left}px`)
  target.style.setProperty('--view-tabs-right', `${frame.right}px`)
  return frame
}
