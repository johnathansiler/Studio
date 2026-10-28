/** Side session panel. Missing or anything other than "open" stays closed, including saved projects from before this choice existed. */
export const SESSION_DOCK_KEY = 'cueharbor-session-dock'

export function sessionDockOpen(stored: string | null | undefined): boolean {
  return stored === 'open'
}

export function readSessionDock(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): boolean {
  try {
    return sessionDockOpen(storage?.getItem(SESSION_DOCK_KEY))
  } catch {
    return false
  }
}

export function writeSessionDock(open: boolean, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
  try {
    storage?.setItem(SESSION_DOCK_KEY, open ? 'open' : 'closed')
  } catch {
    /* private mode keeps the choice for this visit */
  }
}

/**
 * Old saves used the room pane for the always-visible dock.
 * That is not an explicit choice to keep the panel open.
 */
export function paneAfterRestore(phonePane: 'edit' | 'room', dockOpen: boolean): 'edit' | 'room' {
  if (phonePane === 'room' && !dockOpen) return 'edit'
  return phonePane
}

export function nextSessionDock(input: {
  dockOpen: boolean
  phonePane: 'edit' | 'room'
  action: 'session' | 'hide'
}): { dockOpen: boolean; phonePane: 'edit' | 'room' } {
  if (input.action === 'hide') return { dockOpen: false, phonePane: 'edit' }
  if (!input.dockOpen) return { dockOpen: true, phonePane: 'room' }
  if (input.phonePane === 'room') return { dockOpen: false, phonePane: 'edit' }
  return { dockOpen: true, phonePane: 'room' }
}

/** Piano and rack still use the dock. The call panel does not, until the user opens it. Artist view is the call itself. */
export function dockVisible(input: { surface: 'studio' | 'artist'; panel: 'room' | 'piano' | 'rack'; dockOpen: boolean }): boolean {
  if (input.surface === 'artist') return true
  if (input.panel === 'piano' || input.panel === 'rack') return true
  return input.dockOpen
}
