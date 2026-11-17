import { useSyncExternalStore } from 'react'

/**
 * Playback UI must not run inside the button handler.
 * While transport is moving, store listeners and view preloads wait for one
 * animation frame that tops up the audio queue first.
 */

let playing = false
let frame = 0
let wake: (() => void) | null = null
const waiters = new Set<() => void>()

export function setPlaybackUi(on: boolean) {
  playing = on
}

export function playbackUiDeferred() {
  return playing
}

export function bindAudioWake(fn: (() => void) | null) {
  wake = fn
}

/** Run now when stopped. During playback, run on the next frame after the audio clock. */
export function afterAudioFrame(fn: () => void) {
  if (!playing) {
    fn()
    return
  }
  waiters.add(fn)
  if (frame) return
  const host = globalThis.requestAnimationFrame
  const run = () => {
    frame = 0
    try { wake?.() } catch { /* the clock can be closed mid-gesture */ }
    const batch = [...waiters]
    waiters.clear()
    for (const item of batch) item()
  }
  frame = typeof host === 'function' ? host(run) : setTimeout(run, 16) as unknown as number
}

/** Re-render on project changes without doing it inside a playback click. */
export function useProjectVersion(store: { subscribe: (fn: () => void) => () => void; version: number }) {
  return useSyncExternalStore(
    (notify) => store.subscribe(() => { afterAudioFrame(notify) }),
    () => store.version,
    () => store.version,
  )
}
