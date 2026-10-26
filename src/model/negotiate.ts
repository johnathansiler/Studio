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
 * A UDP path on a thin pipe goes disconnected and then checks itself back.
 * Restarting that path at two seconds is what froze the 1 Mbps uplink: the
 * new offer tore down a pair that was still carrying frames.
 * A TCP relay does not come back. The carrier reset takes it with the socket,
 * and waiting eight seconds is the 10s freeze. Leave TCP after two seconds.
 */
export const ICE_UDP_DISCONNECT_RESTART_MS = 8000
export const ICE_TCP_DISCONNECT_RESTART_MS = 2000
/** After a restart, hold the encoder at the start rate so the new estimate can climb. */
export const ICE_RESTART_VIDEO_HOLD_MS = 2000
/**
 * The first gather has to be allowed to finish. A carrier that swallows TURN
 * for 12s looks like a disconnect, and restarting there throws away the
 * allocate that is about to succeed.
 */
export const ICE_INITIAL_GATHER_MS = 20000
/**
 * ICE stays `new` until a remote candidate is added. Ten seconds after the
 * remote description with no candidate means the trickle was lost. `checking`
 * is different: a carrier that swallows TURN UDP for 12s sits here on purpose,
 * so that wait is the opening gather, not this timer.
 */
export const ICE_STUCK_RESTART_MS = 10000

export function iceDisconnectLimit(tcpRelay: boolean) {
  return tcpRelay ? ICE_TCP_DISCONNECT_RESTART_MS : ICE_UDP_DISCONNECT_RESTART_MS
}

/**
 * The host recovers a failed peer connection, one that has stayed
 * disconnected, or one that is still `new` / `checking` long after the remote
 * description arrived. An offer still in flight is sent again. A stable
 * connection restarts ICE. A short disconnect waits. Nothing rolls an offer
 * back, and nothing builds a second peer connection.
 * The guest never restarts. It asks the host to, once ICE has failed or the
 * same stuck timer has run out.
 */
export function iceRecoveryAction(input: {
  polite: boolean
  connection: string
  ice: string
  signaling: string
  disconnectedForMs?: number
  /** The nominated pair is a TCP/TLS relay, so a short disconnect is a dead path. */
  tcpRelay?: boolean
  /** This peer connection has already carried a pair. The opening gather has not. */
  established?: boolean
  /** Age of this peer connection. The opening gather is left alone until ICE_INITIAL_GATHER_MS. */
  ageMs?: number
  /** How long the remote description has been applied. Unset until then. */
  remoteForMs?: number
}): 'none' | 'restart' | 'resend' | 'wait' | 'request' {
  const failed = input.connection === 'failed' || input.ice === 'failed'
  const disconnected = input.connection === 'disconnected' || input.ice === 'disconnected'
  const remoteFor = input.remoteForMs
  const opening = !input.established && !input.tcpRelay && input.ageMs != null && input.ageMs < ICE_INITIAL_GATHER_MS
  const described = input.signaling === 'stable' && remoteFor != null
  const stuckNew = Boolean(described && input.ice === 'new' && remoteFor >= ICE_STUCK_RESTART_MS)
  const stuckChecking = Boolean(described && input.ice === 'checking' && remoteFor >= ICE_STUCK_RESTART_MS && !opening)
  const pendingStuck = Boolean(described && (
    (input.ice === 'new' && remoteFor < ICE_STUCK_RESTART_MS)
    || (input.ice === 'checking' && (opening || remoteFor < ICE_STUCK_RESTART_MS))
  ))
  if (input.polite) {
    if (input.signaling !== 'stable') return 'none'
    if (failed || stuckNew || stuckChecking) return 'request'
    if (pendingStuck) return 'wait'
    return 'none'
  }
  if (stuckNew || stuckChecking) {
    if (input.signaling === 'have-local-offer') return 'resend'
    if (input.signaling === 'stable') return 'restart'
    return 'wait'
  }
  if (!failed && !disconnected) return pendingStuck ? 'wait' : 'none'
  if (opening) return 'wait'
  const stalled = failed || (input.disconnectedForMs ?? 0) >= iceDisconnectLimit(Boolean(input.tcpRelay))
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
