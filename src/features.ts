/**
 * Product switches. Session is the Ableton-style clip launcher.
 * The view, menus, and launch transport stay in the tree.
 * Set session to true to bring that UI back.
 */
/** Build flag `__CUEHARBOR_SESSION__` is this value. Both have to move together. */
export const sessionOn = false

export const FEATURES: { readonly session: boolean } = {
  session: sessionOn,
}

export function preferArrangeView<T extends string>(view: T): T | 'arrange' {
  if (view === 'beats') return 'arrange'
  if (!FEATURES.session && view === 'session') return 'arrange'
  return view
}

export function preferArrangeTransport(mode: 'arrangement' | 'session'): 'arrangement' | 'session' {
  if (!FEATURES.session && mode === 'session') return 'arrangement'
  return mode
}
