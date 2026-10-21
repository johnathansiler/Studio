/** A second WebSocket may be opened only after the previous one has closed. */
export function socketMayOpen(readyState: number | null | undefined) {
  if (readyState == null) return true
  return readyState === 3
}

/**
 * App-level signaling keepalive. Short enough that a cellular carrier does not
 * reap a quiet TCP flow, and it never closes a socket for a missed reply.
 */
export const SIGNAL_KEEPALIVE_MS = 5000

export interface OutboundSignal {
  t?: string
  to?: string
  data?: {
    description?: { type?: string }
    negotiationId?: number
    candidate?: unknown
  }
}

/**
 * Messages wait until this socket has been welcomed. Hello is not queued.
 * The latest offer or answer for a peer replaces an older one. Anything else
 * stays in order, and a long outage cannot grow the queue without bound.
 */
export function enqueueSignal(queue: OutboundSignal[], message: OutboundSignal, limit = 64): OutboundSignal[] {
  if (message.t === 'hello') return queue
  const next = queue.slice()
  const description = message.data?.description?.type
  if (message.t === 'signal' && description && message.to) {
    const index = next.findIndex((item) => item.t === 'signal' && item.to === message.to && item.data?.description?.type === description)
    if (index >= 0) next.splice(index, 1)
  }
  next.push(message)
  while (next.length > limit) {
    const drop = next.findIndex((item) => !(item.t === 'signal' && item.data?.description?.type))
    next.splice(drop >= 0 ? drop : 0, 1)
  }
  return next
}

/**
 * A disconnected ICE path often checks itself back to connected.
 * Restarting immediately throws away the congestion estimate. Waiting
 * several seconds is what froze the picture for 10s on a dead TCP relay.
 * Two seconds is long enough for a blip and short enough to ramp again.
 */
export const ICE_DISCONNECT_RESTART_MS = 2000

/**
 * The host recovers a failed peer connection, or one that has stayed
 * disconnected. An offer still in flight is sent again. A stable connection
 * restarts ICE. A short disconnect waits. Nothing rolls an offer back, and
 * nothing builds a second peer connection. The guest never does this.
 */
export function iceRecoveryAction(input: {
  polite: boolean
  connection: string
  ice: string
  signaling: string
  disconnectedForMs?: number
}): 'none' | 'restart' | 'resend' | 'wait' {
  if (input.polite) return 'none'
  const failed = input.connection === 'failed' || input.ice === 'failed'
  const disconnected = input.connection === 'disconnected' || input.ice === 'disconnected'
  if (!failed && !disconnected) return 'none'
  const stalled = failed || (input.disconnectedForMs ?? 0) >= ICE_DISCONNECT_RESTART_MS
  if (!stalled) return 'wait'
  if (input.signaling === 'have-local-offer') return 'resend'
  if (input.signaling === 'stable') return 'restart'
  return 'wait'
}

/** The same negotiation id is the same offer. Answer it again; do not apply it twice. */
export function repeatedOffer(answeredId: number | undefined, incomingId: number | undefined) {
  return incomingId != null && answeredId != null && incomingId === answeredId
}

/** An answer belongs to the offer still in flight. A missing id is from an older client and is kept. */
export function answerMatches(currentId: number | undefined, incomingId: number | undefined) {
  if (incomingId == null || currentId == null) return true
  return incomingId === currentId
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
