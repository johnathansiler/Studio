/**
 * When a later preview slice may begin.
 * A start after the audio already scheduled has ended would be silence in the middle.
 * That slice is refused instead.
 */
export function abutPreviewSlice(previousEnd: number | null, now: number, leadSec = 0.02): number | null {
  if (!(now >= 0)) return null
  const lead = Math.max(0, leadSec)
  if (previousEnd == null) return now + lead
  if (now > previousEnd) return null
  return previousEnd
}

/** Remaining download must fit inside the buffered audio, with margin for a slower spell. */
export const PREVIEW_STREAM_SAFETY = 2

/** Extra seconds kept ahead of the estimate so a late chunk is still early. */
export const PREVIEW_STREAM_CUSHION_SEC = 0.2

export const PREVIEW_STREAM_MIN_SEC = 0.2

export const PREVIEW_STREAM_MIN_BYTES = 8 * 1024

/**
 * True when the audio already decoded will still be playing after the rest of the
 * file arrives at the throughput measured so far. Otherwise the caller waits and
 * plays the finished decode as one buffer.
 */
export function canStartGaplessPreview(input: {
  receivedBytes: number
  totalBytes: number
  elapsedSec: number
  bufferedSec: number
}): boolean {
  const total = input.totalBytes
  const received = input.receivedBytes
  if (!(total > 0) || !(received > 0) || !(input.elapsedSec > 0)) return false
  if (received >= total) return true
  if (input.elapsedSec < PREVIEW_STREAM_MIN_SEC || received < PREVIEW_STREAM_MIN_BYTES) return false
  const throughput = received / input.elapsedSec
  if (!(throughput > 0) || !(input.bufferedSec > 0)) return false
  const eta = (total - received) / throughput
  return input.bufferedSec >= eta * PREVIEW_STREAM_SAFETY + PREVIEW_STREAM_CUSHION_SEC
}
