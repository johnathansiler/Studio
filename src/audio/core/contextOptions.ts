import { latencyHintOrder, type BufferHint } from './buffer'
import { contextSampleRate, type DeviceKind } from './driver'

export interface ContextAttempt {
  latencyHint?: BufferHint
  sampleRate?: number
}

/**
 * Options for a new AudioContext.
 * Desktop leaves the rate alone. Android asks for 48 kHz, then tries again
 * with no rate if that request is rejected. A file rate is never passed:
 * 44100 on a 48 kHz speaker is the callback click.
 */
export function contextAttempts(hint: BufferHint, kind?: DeviceKind): ContextAttempt[] {
  const sampleRate = kind ? contextSampleRate(kind) : undefined
  const attempts: ContextAttempt[] = latencyHintOrder(hint).map((latencyHint) => (
    sampleRate ? { latencyHint, sampleRate } : { latencyHint }
  ))
  if (sampleRate) attempts.push({ sampleRate })
  attempts.push({})
  return attempts
}
