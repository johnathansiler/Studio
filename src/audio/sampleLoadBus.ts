/** Shared progress for samples that download when a note asks for them. */

export interface SampleLoadState {
  pending: number
  ratio: number
  fault: string
}

const ratios = new Map<string, number>()
const listeners = new Set<() => void>()
let fault = ''
const EMPTY: SampleLoadState = { pending: 0, ratio: 0, fault: '' }
let snapshot: SampleLoadState = EMPTY

function emit() {
  const pending = ratios.size
  let ratio = 0
  if (pending) {
    let sum = 0
    for (const value of ratios.values()) sum += value
    ratio = sum / pending
  }
  if (snapshot.pending !== pending || snapshot.ratio !== ratio || snapshot.fault !== fault) {
    snapshot = pending ? { pending, ratio, fault } : { pending: 0, ratio: 0, fault }
  }
  for (const listener of listeners) listener()
}

/** A failed zone download. Empty string clears it. Shown next to the instrument list. */
export function sampleLoadFault(message: string) {
  const next = message.trim()
  if (fault === next) return
  fault = next
  emit()
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
  fault = ''
  emit()
}
