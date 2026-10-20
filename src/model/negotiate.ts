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
  const abandoned =
    input.ice === 'failed' ||
    input.ice === 'disconnected' ||
    (input.offerAgeMs >= 4000 && (input.ice === 'new' || input.ice === 'checking'))
  if (abandoned) return 'rollback-offer'
  return 'ignore-offer'
}

/**
 * A live room this browser already hosts wins over Create.
 * A dropped socket must rejoin that code. Minting is only the first Create
 * when this browser does not already have a room.
 */
export function sessionHello(input: { create: boolean; requestedCode?: string; hostedCode?: string }): {
  action: 'create' | 'join'
  code?: string
  reason: string
} {
  const requested = (input.requestedCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
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
