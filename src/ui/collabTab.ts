export type StudioTab = 'arrange' | 'mix' | 'beats' | 'session' | 'collab'

/** The call panel is a tab. It is not a dock, overlay, or side effect of another view. */
export function collabPanelVisible(tab: StudioTab): boolean {
  return tab === 'collab'
}

export function collabBadgeOn(input: {
  tab: StudioTab
  status: 'idle' | 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'rejected' | 'removed' | 'error'
  pendingInvite: boolean
  waiting: number
}): boolean {
  if (collabPanelVisible(input.tab)) return false
  if (input.pendingInvite) return true
  if (input.waiting > 0) return true
  return input.status === 'connecting' || input.status === 'waiting' || input.status === 'live' || input.status === 'reconnecting'
}
