import { connectionWord, type ConnectionGrade } from '../model/callVideo'

export type StudioTab = 'arrange' | 'mix' | 'beats' | 'session' | 'collab'

/** The call panel is a tab. It is not a dock, overlay, or side effect of another view. */
export function collabPanelVisible(tab: StudioTab): boolean {
  return tab === 'collab'
}

/** Idle, failed, and ended calls show Host and Join. A live call does not. */
export function collabChoosing(status: string): boolean {
  return status === 'idle' || status === 'error' || status === 'rejected' || status === 'removed'
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

/** The sentence next to the colored dot. The word is the whole grade, not an abbreviation. */
export function connectionLine(grade: ConnectionGrade): string {
  if (grade === 'Good') return 'Connection: Good. Audio and video are smooth.'
  if (grade === 'OK') return 'Connection: OK. Audio and video may hesitate.'
  return 'Connection: Poor. Audio and video may cut out.'
}

export function worstConnection(grades: readonly ConnectionGrade[]): ConnectionGrade {
  if (grades.includes('Poor')) return 'Poor'
  if (grades.includes('OK')) return 'OK'
  return 'Good'
}

function linkUp(link: { connection: string; ice: string } | undefined): boolean {
  if (!link) return false
  return link.connection === 'connected' || link.ice === 'connected' || link.ice === 'completed'
}

export function linkLooksFailed(link: { connection: string; ice: string } | undefined): boolean {
  if (!link) return false
  return link.connection === 'failed' || link.connection === 'disconnected' || link.ice === 'failed' || link.ice === 'disconnected'
}

/**
 * Your own grade follows the room once someone else is here.
 * A default round-trip must not read as smooth before any path is up.
 */
export function selfConnection(input: {
  status: string
  oneWayMs: number | null
  peers: number
  linksUp: number
  linksFailed: number
}): ConnectionGrade {
  if (input.linksFailed > 0 && input.linksUp === 0) {
    return connectionWord({ status: input.status, failed: true, oneWayMs: input.oneWayMs })
  }
  if (input.peers > 0 && input.linksUp === 0) {
    return connectionWord({
      status: input.status === 'reconnecting' ? 'reconnecting' : 'connecting',
      failed: false,
      oneWayMs: null,
    })
  }
  return connectionWord({ status: input.status, failed: false, oneWayMs: input.oneWayMs })
}

/** One grade per person. A remote path that is not up yet stays OK instead of Good. */
export function personConnection(input: {
  self: boolean
  status: string
  link: { connection: string; ice: string } | undefined
  oneWayMs: number | null
}): ConnectionGrade {
  if (input.self) return connectionWord({ status: input.status, failed: false, oneWayMs: input.oneWayMs })
  if (linkLooksFailed(input.link)) return connectionWord({ status: input.status, failed: true, oneWayMs: input.oneWayMs })
  if (!linkUp(input.link)) {
    if (input.status === 'error' || input.status === 'rejected' || input.status === 'removed') {
      return connectionWord({ status: input.status, failed: false, oneWayMs: null })
    }
    return connectionWord({
      status: input.status === 'reconnecting' ? 'reconnecting' : 'connecting',
      failed: false,
      oneWayMs: null,
    })
  }
  return connectionWord({ status: input.status, failed: false, oneWayMs: input.oneWayMs })
}
