const GAP_MS = 2000
const MAX_TAPS = 8

export interface TapMemory {
  taps: number[]
  whole: boolean
}

export function emptyTap(whole = false): TapMemory {
  return { taps: [], whole }
}

export function roundTempo(bpm: number, whole: boolean) {
  const clamped = Math.min(300, Math.max(30, bpm))
  if (whole) return Math.round(clamped)
  return Math.round(clamped * 10) / 10
}

export function tempoFromTaps(taps: number[]) {
  if (taps.length < 2) return null
  let sum = 0
  for (let i = 1; i < taps.length; i++) sum += taps[i] - taps[i - 1]
  return 60000 / (sum / (taps.length - 1))
}

function outlier(taps: number[], at: number) {
  if (taps.length < 2) return false
  const gaps: number[] = []
  for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1])
  const mid = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
  const gap = at - taps[taps.length - 1]
  return gap < mid * 0.6 || gap > mid * 1.6
}

/** Record one tap. Tempo is committed on the third tap. A 2s gap starts over. */
export function pushTap(memory: TapMemory, at: number) {
  const last = memory.taps[memory.taps.length - 1]
  if (last != null && at - last > GAP_MS) {
    return { memory: { ...memory, taps: [at] }, live: null as number | null, commit: null as number | null, ignored: false }
  }
  if (last != null && outlier(memory.taps, at)) {
    const raw = tempoFromTaps(memory.taps)
    return { memory, live: raw == null ? null : roundTempo(raw, memory.whole), commit: null, ignored: true }
  }
  const taps = memory.taps.concat(at).slice(-MAX_TAPS)
  const raw = tempoFromTaps(taps)
  const live = raw == null ? null : roundTempo(raw, memory.whole)
  return { memory: { ...memory, taps }, live, commit: taps.length >= 3 ? live : null, ignored: false }
}

export function scaleTempo(bpm: number, factor: number, whole: boolean) {
  return roundTempo(bpm * factor, whole)
}
