/** Refusal sent to a guest who tries to reset the room. */
export const RESET_REJECTED = 'Only the host can reset the room.'

export function transportAction(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const action = (payload as { action?: unknown }).action
  return typeof action === 'string' ? action : ''
}

export type TransportSeat = 'broadcast' | 'reject' | 'ignore'

/** Room transport is relayed from the host. Reset from any other seat is refused. */
export function hostTransportDecision(role: 'host' | 'guest', payload: unknown): TransportSeat {
  if (role === 'host') return 'broadcast'
  if (transportAction(payload) === 'reset') return 'reject'
  return 'ignore'
}

export interface TransportRelayResult {
  /** Payload to send to everyone else in the room. */
  broadcast?: unknown
  /** Close the message and tell the sender why. */
  error?: string
}

/**
 * How the room socket treats one transport message.
 * Null means this message is not a transport command.
 */
export function relayTransportMessage(role: 'host' | 'guest', msg: { t?: unknown; payload?: unknown }): TransportRelayResult | null {
  if (msg.t === 'transport') {
    const decision = hostTransportDecision(role, msg.payload)
    if (decision === 'reject') return { error: RESET_REJECTED }
    if (decision === 'broadcast') return { broadcast: msg.payload }
    return {}
  }
  if (msg.t === 'transport-request' && transportAction(msg.payload) === 'reset') return { error: RESET_REJECTED }
  return null
}
