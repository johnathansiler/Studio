const MIN_MS = 200
const MAX_MS = 2000
/** Rolling window. Eight intervals is nine timestamps. */
const MAX_INTERVALS = 8
const OUTLIER = 0.3
/** A click this soon after pointerdown is the same finger, not another tap. */
const CLICK_DUP_MS = 750

export interface TapMemory {
  taps: number[]
  whole: boolean
  /** performance.now() of the last pointerdown, so the click after it is ignored. */
  pointerAt: number | null
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
  return { taps: [], whole, pointerAt: null }
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

/**
 * Record one tap. Pass a performance.now() stamp — event.timeStamp is a
 * different clock on some browsers, so every tap looked like a 2s gap and
 * the sequence never stuck. BPM is the average of the last 4–8 intervals.
 */
export function pushTap(memory: TapMemory, at: number, source: TapSource = 'pointer'): TapResult {
  const pointerAt = memory.pointerAt ?? null
  if (source === 'click' && pointerAt != null && at >= pointerAt && at - pointerAt < CLICK_DUP_MS) {
    return { memory: { ...memory, pointerAt: null }, bpm: displayBpm(memory), ignored: true, reset: false }
  }
  const stamped = source === 'pointer' ? at : null
  const last = memory.taps[memory.taps.length - 1]
  if (last == null) {
    return { memory: { ...memory, taps: [at], pointerAt: stamped }, bpm: null, ignored: false, reset: false }
  }
  const gap = at - last
  if (gap > MAX_MS) {
    return { memory: { ...memory, taps: [at], pointerAt: stamped }, bpm: null, ignored: false, reset: true }
  }
  if (gap < MIN_MS) {
    return { memory: { ...memory, pointerAt: stamped }, bpm: displayBpm(memory), ignored: true, reset: false }
  }
  const gaps = gapsOf(memory.taps)
  if (gaps.length > 0) {
    const mean = average(gaps)
    if (mean > 0 && Math.abs(gap - mean) / mean > OUTLIER) {
      return { memory: { ...memory, pointerAt: stamped }, bpm: displayBpm(memory), ignored: true, reset: false }
    }
  }
  const taps = memory.taps.concat(at).slice(-(MAX_INTERVALS + 1))
  const next: TapMemory = { ...memory, taps, pointerAt: stamped }
  return { memory: next, bpm: displayBpm(next), ignored: false, reset: false }
}

export function scaleTempo(bpm: number, factor: number, whole: boolean) {
  return roundTempo(bpm * factor, whole)
}
