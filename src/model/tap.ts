const MIN_MS = 200
const MAX_MS = 2000
/** Rolling window. Eight intervals is nine timestamps. */
const MAX_INTERVALS = 8
/** Clicks this soon after the pointer gesture's click are the same finger. */
const GHOST_MS = 1000

export interface TapMemory {
  taps: number[]
  whole: boolean
  /** performance.now() of the last pointerdown, so its click is not a second tap. */
  pointerAt: number | null
  /** performance.now() of the click or release that closed that pointer gesture. */
  echoAt: number | null
}

export interface TapResult {
  memory: TapMemory
  /** Rounded BPM to show and apply. Null until the second tap of a sequence. */
  bpm: number | null
  /** This event did not add a tap. */
  ignored: boolean
  /** A gap over 2s started a new sequence on this tap. */
  reset: boolean
}

export type TapSource = 'pointer' | 'click' | 'key'

export function emptyTap(whole = false): TapMemory {
  return { taps: [], whole, pointerAt: null, echoAt: null }
}

export function roundTempo(bpm: number, whole: boolean) {
  const clamped = Math.min(300, Math.max(30, bpm))
  if (whole) return Math.round(clamped)
  return Math.round(clamped * 10) / 10
}

export function formatTempo(bpm: number) {
  const rounded = roundTempo(bpm, false)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** Number the tempo field shows after this tap. Stays put until the second tap. */
export function shownTempo(previous: number, result: { bpm: number | null }) {
  return result.bpm == null ? previous : result.bpm
}

function gapsOf(taps: number[]) {
  const gaps: number[] = []
  for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1])
  return gaps
}

function average(gaps: number[]) {
  let sum = 0
  for (const gap of gaps) sum += gap
  return sum / gaps.length
}

export function tempoFromTaps(taps: number[]) {
  if (taps.length < 2) return null
  return 60000 / average(gapsOf(taps))
}

function displayBpm(memory: TapMemory) {
  const raw = tempoFromTaps(memory.taps)
  return raw == null ? null : roundTempo(raw, memory.whole)
}

function markPointer(memory: TapMemory, at: number, source: TapSource): TapMemory {
  if (source === 'pointer') return { ...memory, pointerAt: at, echoAt: null }
  return { ...memory, pointerAt: null, echoAt: null }
}

/**
 * The pointerup that ends a finger tap. A click after it, including a delayed
 * ghost click, belongs to that same gesture.
 */
export function noteTapRelease(memory: TapMemory, at: number): TapMemory {
  if (memory.pointerAt == null || at < memory.pointerAt) return memory
  if (memory.echoAt != null && memory.echoAt >= memory.pointerAt) return memory
  return { ...memory, echoAt: at }
}

/**
 * Record one tap. Pass a performance.now() stamp — event.timeStamp is a
 * different clock on some browsers, so every tap looked like a 2s gap.
 * BPM is 60 / the mean of the last 1–8 intervals (60000 / the mean in ms).
 * A gap over 2s starts over. An interval under 0.2s is a double trigger.
 * The result is rounded to 0.1 and clamped to 30–300.
 */
export function pushTap(memory: TapMemory, at: number, source: TapSource = 'pointer'): TapResult {
  const pointerAt = memory.pointerAt
  if (source === 'click' && pointerAt != null && at >= pointerAt) {
    const echoAt = memory.echoAt
    const echoed = echoAt != null && echoAt >= pointerAt
    if (!echoed || at - echoAt < GHOST_MS) {
      return { memory: { ...memory, echoAt: at }, bpm: displayBpm(memory), ignored: true, reset: false }
    }
  }
  const last = memory.taps[memory.taps.length - 1]
  if (last == null) {
    return { memory: { ...markPointer(memory, at, source), taps: [at] }, bpm: null, ignored: false, reset: false }
  }
  const gap = at - last
  if (gap > MAX_MS) {
    return { memory: { ...markPointer(memory, at, source), taps: [at] }, bpm: null, ignored: false, reset: true }
  }
  if (gap < MIN_MS) {
    return { memory: markPointer(memory, at, source), bpm: displayBpm(memory), ignored: true, reset: false }
  }
  const taps = memory.taps.concat(at).slice(-(MAX_INTERVALS + 1))
  const next: TapMemory = { ...markPointer(memory, at, source), taps }
  return { memory: next, bpm: displayBpm(next), ignored: false, reset: false }
}

export function scaleTempo(bpm: number, factor: number, whole: boolean) {
  return roundTempo(bpm * factor, whole)
}
