/** Fine snap is a shared bypass for the loop handles. Alt does the same while it is held. */

let fine = false
const listeners = new Set<() => void>()

export function loopFineSnap() {
  return fine
}

export function setLoopFineSnap(value: boolean) {
  if (fine === value) return
  fine = value
  for (const listener of listeners) listener()
}

export function subscribeLoopFine(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
