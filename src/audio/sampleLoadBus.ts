/** Shared progress for samples that download when a note asks for them. */

export interface SampleLoadState {
  pending: number
  ratio: number
}

const ratios = new Map<string, number>()
const listeners = new Set<() => void>()
const EMPTY: SampleLoadState = { pending: 0, ratio: 0 }
let snapshot: SampleLoadState = EMPTY

function emit() {
  if (!ratios.size) snapshot = EMPTY
  else {
    let sum = 0
    for (const ratio of ratios.values()) sum += ratio
    const next = sum / ratios.size
    if (snapshot.pending !== ratios.size || snapshot.ratio !== next) snapshot = { pending: ratios.size, ratio: next }
  }
  for (const listener of listeners) listener()
}

export function sampleLoadBegin(id: string) {
  if (!id || ratios.has(id)) return
  ratios.set(id, 0)
  emit()
}

export function sampleLoadRatio(id: string, ratio: number) {
  if (!id) return
  const next = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
  if (!ratios.has(id)) ratios.set(id, next)
  else ratios.set(id, Math.max(ratios.get(id) ?? 0, next))
  emit()
}

export function sampleLoadFinish(id: string) {
  if (!ratios.delete(id)) return
  emit()
}

export function sampleLoadState(): SampleLoadState {
  return snapshot
}

export function subscribeSampleLoad(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tests start from an empty queue. */
export function resetSampleLoad() {
  ratios.clear()
  emit()
}
