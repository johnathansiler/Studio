/** Last explicit arrange selection. A loaded project has a current track and still counts as nothing selected. */

export type PhoneFocus = 'none' | 'track'

let focus: PhoneFocus = 'none'
const listeners = new Set<() => void>()

export function phoneFocus() {
  return focus
}

export function setPhoneFocus(next: PhoneFocus) {
  if (focus === next) return
  focus = next
  for (const listener of listeners) listener()
}

export function subscribePhoneFocus(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
