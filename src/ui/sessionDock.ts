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

export const EDITOR_DOCK_DEFAULT = 380
export const EDITOR_DOCK_MIN = 280
export const EDITOR_DOCK_MAX = 760
/** Arrange or Session keeps at least this much beside a side editor. */
export const EDITOR_WORK_MIN = 320

/** Side editor width that stays inside the viewport and leaves the work visible. */
export function fittedDockWidth(viewport: number, requested: number, edge: 'right' | 'bottom' = 'right'): number {
  const view = Number.isFinite(viewport) && viewport > 0 ? viewport : 1280
  const want = Number.isFinite(requested) ? requested : EDITOR_DOCK_DEFAULT
  if (edge === 'bottom') {
    const max = Math.min(520, Math.max(200, Math.floor(view * 0.45)))
    return Math.round(Math.min(max, Math.max(200, want)))
  }
  const cap = Math.max(EDITOR_DOCK_MIN, Math.min(EDITOR_DOCK_MAX, Math.floor(view * 0.5), view - EDITOR_WORK_MIN))
  return Math.round(Math.min(cap, Math.max(EDITOR_DOCK_MIN, want)))
}

/** Piano, rack, and Scaler use the side dock. The call panel is the Collab tab and never this dock. */
export function dockVisible(input: { surface: 'studio' | 'artist'; panel: 'room' | 'piano' | 'rack' | 'scaler' | 'pads'; dockOpen: boolean }): boolean {
  if (input.surface !== 'studio') return false
  return input.panel === 'piano' || input.panel === 'rack' || input.panel === 'scaler' || input.panel === 'pads'
}
