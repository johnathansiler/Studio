import { latencyHintOrder, type BufferHint } from './buffer'

export interface ContextAttempt {
  latencyHint?: BufferHint
}

/**
 * Options for a new AudioContext.
 * The device sample rate is left alone. A forced rate makes the browser resample the whole graph.
 */
export function contextAttempts(hint: BufferHint): ContextAttempt[] {
  const attempts: ContextAttempt[] = latencyHintOrder(hint).map((latencyHint) => ({ latencyHint }))
  attempts.push({})
  return attempts
}
