/** A second WebSocket may be opened only after the previous one has closed. */
export function socketMayOpen(readyState: number | null | undefined) {
  if (readyState == null) return true
  return readyState === 3
}

/**
 * MDN perfect negotiation. The impolite peer ignores an offer that collides
 * with the one it is already setting. The polite peer applies it and the
 * browser rolls the local offer back.
 */
export function ignoreIncomingOffer(input: {
  polite: boolean
  makingOffer: boolean
  signalingState: string
  settingRemoteAnswer: boolean
}) {
  const readyForOffer = !input.makingOffer && (input.signalingState === 'stable' || input.settingRemoteAnswer)
  return !input.polite && !readyForOffer
}

/** An invite link wins. The stored code is used only when the URL has none. */
export function inviteWins(urlCode: string, storedCode: string) {
  const url = (urlCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const stored = (storedCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (url) return { code: url, dropStored: Boolean(stored && stored !== url) }
  return { code: stored, dropStored: false }
}

/**
 * A signaling reconnect keeps the peer connection.
 * Close it when that peer leaves, or when their page instance changes.
 */
export function keepPeerConnection(input: { left: boolean; remoteInstance: string; previousInstance: string }) {
  if (input.left) return false
  if (input.previousInstance && input.remoteInstance && input.remoteInstance !== input.previousInstance) return false
  return true
}

/**
 * A live room this browser already hosts wins over Create.
 * Minting is only New session, or the first Create when this browser has no room.
 * A requested code is a request to join that room, not proof the join worked.
 */
export function sessionHello(input: { create: boolean; fresh?: boolean; requestedCode?: string; hostedCode?: string }): {
  action: 'create' | 'join'
  code?: string
  reason: string
} {
  const requested = (input.requestedCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (input.fresh) return { action: 'create', reason: 'host tapped New session' }
  if (input.hostedCode && (input.create || !requested || requested === input.hostedCode)) {
    const reason = input.create
      ? `new session was not created because this browser already hosts ${input.hostedCode}`
      : `rejoined ${input.hostedCode} because the socket dropped or the page reloaded`
    return { action: 'join', code: input.hostedCode, reason }
  }
  if (input.create && !requested) return { action: 'create', reason: 'host tapped Create' }
  if (requested) return { action: 'join', code: requested, reason: `request ${requested}` }
  return { action: 'join', reason: 'no session code was available' }
}
