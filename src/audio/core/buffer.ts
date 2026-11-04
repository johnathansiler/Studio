/**
 * Device buffer hint. These names are the Web Audio latencyHint values.
 * The screen shows the full words: Lowest, Balanced, Playback.
 * No DOM and no Web Audio types live in this file.
 */

export type BufferHint = 'interactive' | 'balanced' | 'playback'

export const BUFFER_HINTS: readonly { id: BufferHint; label: string }[] = [
  { id: 'interactive', label: 'Lowest' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'playback', label: 'Playback' },
]

const STORAGE_KEY = 'cueharbor-latency'

export function bufferHintOf(value: string | null | undefined): BufferHint {
  if (value === 'balanced' || value === 'playback' || value === 'interactive') return value
  return 'interactive'
}

export function bufferHintLabel(hint: BufferHint) {
  return BUFFER_HINTS.find((item) => item.id === hint)?.label ?? 'Lowest'
}

/** Try the chosen hint first, then the other two. */
export function latencyHintOrder(hint: BufferHint): BufferHint[] {
  const first = bufferHintOf(hint)
  const rest = BUFFER_HINTS.map((item) => item.id).filter((item) => item !== first)
  return [first, ...rest]
}

/** Null when the listener has not chosen a hint. The device policy picks one then. */
export function readStoredBufferHint(storage: { getItem(key: string): string | null } | null): BufferHint | null {
  try {
    const value = storage?.getItem(STORAGE_KEY)
    if (value === 'balanced' || value === 'playback' || value === 'interactive') return value
    return null
  } catch {
    return null
  }
}

export function readBufferHint(storage: { getItem(key: string): string | null } | null): BufferHint {
  try {
    return bufferHintOf(storage?.getItem(STORAGE_KEY))
  } catch {
    return 'interactive'
  }
}

export function writeBufferHint(hint: BufferHint, storage: { setItem(key: string, value: string): void } | null) {
  try {
    storage?.setItem(STORAGE_KEY, bufferHintOf(hint))
  } catch {
    /* Private mode can reject the write. The running context still uses the choice. */
  }
}

/** Measured device latency for the Settings row. Null means the context is not open yet. */
export function formatLatencyReadout(baseMs: number | null, outputMs: number | null) {
  const text = (value: number | null) => (value == null || !Number.isFinite(value) ? 'not measured' : `${value.toFixed(1)} ms`)
  return `Base ${text(baseMs)}. Output ${text(outputMs)}.`
}
