import { landedOnInteger, LONG_PRESS_MS } from '../model/dragNumeric'

/** Light flash plus a 5ms haptic when a drag lands on a whole number. */
export function markIntegerLand(el: { classList?: DOMTokenList } | null | undefined, before: number, after: number) {
  if (!landedOnInteger(before, after)) return
  try {
    navigator.vibrate?.(5)
  } catch {
    /* this device has no haptic */
  }
  const list = el?.classList
  if (!list) return
  list.remove('integer-tick')
  void (el as HTMLElement).offsetWidth
  list.add('integer-tick')
}

/** Touch long-press turns the rest of the drag into fine mode. Returns a cancel. */
export function armFinePress(pointerType: string | undefined, onFine: () => void): () => void {
  if (pointerType !== 'touch') return () => undefined
  const id = window.setTimeout(onFine, LONG_PRESS_MS)
  return () => window.clearTimeout(id)
}
