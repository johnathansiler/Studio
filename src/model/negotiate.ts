/** The higher id yields on glare. The lower id keeps the offer it already sent. */
export function politePeer(selfId: string, remoteId: string) {
  return selfId > remoteId
}

export function iceUfrag(sdp: string) {
  return sdp.match(/a=ice-ufrag:(\S+)/)?.[1] || ''
}

export type RemotePlan = 'apply-answer' | 'queue-answer' | 'ignore-answer' | 'apply-offer' | 'rollback-offer' | 'ignore-offer'

/**
 * Perfect negotiation.
 * An answer that arrives before setLocalDescription finishes is queued, not dropped.
 * An offer that never started ICE, or whose ICE already failed, is abandoned so the
 * other side can recover. A fresh offer still in flight is kept by the impolite peer.
 */
export function remoteDescriptionPlan(input: {
  polite: boolean
  signaling: string
  kind: 'offer' | 'answer'
  makingOffer: boolean
  ice: string
  offerAgeMs: number
  localUfrag: string
  remoteUfrag: string
}): RemotePlan {
  if (input.kind === 'answer') {
    // Each side has its own ice-ufrag, so an answer must not be matched on that.
    if (input.signaling === 'have-local-offer') return 'apply-answer'
    if (input.makingOffer) return 'queue-answer'
    return 'ignore-answer'
  }
  const collision = input.makingOffer || (input.signaling !== 'stable' && input.signaling !== '')
  if (!collision) return 'apply-offer'
  if (input.polite) return 'rollback-offer'
  // The impolite peer keeps its offer through a disconnect flicker.
  // A failed path, or an offer that never reached ICE, can be replaced.
  const abandoned =
    input.ice === 'failed' ||
    (input.offerAgeMs >= 4000 && (input.ice === 'new' || input.ice === 'checking'))
  if (abandoned) return 'rollback-offer'
  return 'ignore-offer'
}

/**
 * A live room this browser already hosts wins over Create.
 * A dropped socket must rejoin that code. Minting is only the first Create
 * when this browser does not already have a room.
 */
/**
 * A second WebSocket may be opened only after the previous one has closed.
 * CONNECTING and OPEN stay as they are. CLOSING waits for the close event.
 */
export function socketMayOpen(readyState: number | null | undefined) {
  if (readyState == null) return true
  return readyState === 3
}

/**
 * A second hello takes the seat only when the previous socket is gone.
 * Protocol pongs do not count: a proxy can answer those while the page
 * has stopped reading. `probeAnswered` is an application message.
 */
export function replaceSocketPlan(input: { readyState: number | null | undefined; probeAnswered: boolean }): 'keep' | 'replace' {
  if (input.readyState !== 1) return 'replace'
  return input.probeAnswered ? 'keep' : 'replace'
}

/**
 * The polite peer never offers. An outstanding local offer is resent, not
 * replaced, until ICE has actually failed.
 */
export function offerAgainPlan(input: { polite: boolean; signaling: string; ice: string; connection: string }): 'offer' | 'resend' | 'ask' {
  const failed = input.ice === 'failed' || input.connection === 'failed'
  if (input.polite) return 'ask'
  if (input.signaling === 'have-local-offer' && !failed) return 'resend'
  return 'offer'
}

/**
 * A signaling reconnect keeps a peer connection that is already up.
 * Renegotiate only when that connection has failed, or the other browser
 * reloaded and minted a new page instance.
 */
export function signalingReconnectPlan(input: {
  connection: string
  ice: string
  remoteInstance: string
  previousInstance: string
}): 'keep' | 'renegotiate' {
  const failed = input.connection === 'failed' || input.ice === 'failed'
  const replaced = Boolean(input.previousInstance && input.remoteInstance && input.remoteInstance !== input.previousInstance)
  if (replaced || failed) return 'renegotiate'
  return 'keep'
}

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
  if (requested) return { action: 'join', code: requested, reason: `joined ${requested}` }
  return { action: 'join', reason: 'no session code was available' }
}
