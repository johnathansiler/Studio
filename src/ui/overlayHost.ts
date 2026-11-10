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

/** The phone shell, whether `root` is that element or a parent that contains it. */
function phoneShell(root?: ParentNode | null): Element | null {
  if (typeof document === 'undefined') return null
  if (root instanceof Element && root.classList.contains('shell') && root.classList.contains('phone')) return root
  const scope = root ?? document
  return scope.querySelector('.shell.phone')
}

/** Room between the transport (or the tabs) and the phone bottom bar. Sheets use this height. */
export function syncPhoneSheetFrame(root?: ParentNode | null) {
  if (typeof document === 'undefined') return
  const target = document.documentElement
  const shell = phoneShell(root)
  if (!shell) {
    target.style.removeProperty('--phone-chrome-top')
    target.style.removeProperty('--phone-chrome-bottom')
    target.style.removeProperty('--phone-sheet-room')
    target.style.removeProperty('--phone-sheet-h')
    return
  }
  const tabs = shell.querySelector('.views')?.getBoundingClientRect()
  const transport = shell.querySelector('.transport')?.getBoundingClientRect()
  const bar = shell.querySelector('.tool-slot')?.getBoundingClientRect()
  const top = Math.max(tabs?.bottom ?? 0, transport && transport.height > 8 ? transport.bottom : 0)
  const bottomInset = bar && bar.height > 8 && bar.top < window.innerHeight - 4
    ? Math.max(0, window.innerHeight - bar.top)
    : 0
  const room = Math.max(0, window.innerHeight - top - bottomInset)
  const reserve = 48
  const cap = Math.max(96, room - reserve)
  const height = room > 0 && room < 320 ? cap : Math.round(Math.min(cap, Math.max(200, room * 0.7)))
  target.style.setProperty('--phone-chrome-top', `${Math.round(top)}px`)
  target.style.setProperty('--phone-chrome-bottom', `${Math.round(bottomInset)}px`)
  target.style.setProperty('--phone-sheet-room', `${Math.round(room)}px`)
  target.style.setProperty('--phone-sheet-h', `${Math.round(Math.max(96, height))}px`)
}
