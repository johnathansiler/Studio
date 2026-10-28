/** True while the user is typing, so Delete edits the text instead of a clip. */
export function editingText(target: EventTarget | null) {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

/** Delete and Backspace remove the selected clip when focus is on the timeline. */
export function deletesSelection(key: string, target: EventTarget | null) {
  if (editingText(target)) return false
  return key === 'Delete' || key === 'Backspace'
}
