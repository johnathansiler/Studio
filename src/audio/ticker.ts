/**
 * One animation frame for meters, the playhead, and coalesced control readouts.
 * The loop stops when nobody is subscribed, and when every subscriber reports idle
 * (transport stopped and meters have fallen back to silence).
 */

export type FrameListener = (now: number) => boolean | void

const listeners = new Set<FrameListener>()
const once = new Set<() => void>()
let handle = 0
let active = false
/** Extra frames after a wake, so a meter can see a note that has not reached the analyser yet. */
let grace = 0

function raf(cb: FrameRequestCallback) {
  const host = globalThis.requestAnimationFrame
  if (typeof host === 'function') return host(cb)
  return setTimeout(() => cb(typeof performance !== 'undefined' ? performance.now() : Date.now()), 16) as unknown as number
}

function cancel(id: number) {
  if (!id) return
  const host = globalThis.cancelAnimationFrame
  if (typeof host === 'function') host(id)
  else clearTimeout(id)
}

function stop() {
  active = false
  if (handle) cancel(handle)
  handle = 0
}

function frame(now: number) {
  handle = 0
  const shots = [...once]
  once.clear()
  const pending = grace
  if (grace > 0) grace -= 1
  for (const shot of shots) shot()
  let need = pending > 0
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue
    if (listener(now) !== false) need = true
  }
  if (!active) return
  if (listeners.size === 0 || !need) {
    active = false
    return
  }
  handle = raf(frame)
}

function ensure() {
  if (active) return
  if (listeners.size === 0 && once.size === 0) return
  active = true
  handle = raf(frame)
}

/** Subscribe to the shared frame. Return false from the listener when it no longer needs frames. */
export function subscribeFrame(listener: FrameListener) {
  listeners.add(listener)
  ensure()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && once.size === 0) stop()
  }
}

/** Run once on the next shared frame. Repeated calls before that frame still share it. */
export function onNextFrame(fn: () => void) {
  once.add(fn)
  ensure()
}

/** Start the loop again after transport or a meter wakes up. `frames` keeps it alive briefly. */
export function wakeTicker(frames = 1) {
  grace = Math.max(grace, frames)
  ensure()
}

/** Test hook. Drops every subscriber and cancels the pending frame. */
export function resetTicker() {
  listeners.clear()
  once.clear()
  grace = 0
  stop()
}
