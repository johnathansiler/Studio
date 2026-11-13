import { useRef, useState } from 'react'
import { onNextFrame } from '../audio/ticker'
import { groupForTrack } from '../model/mixGroups'
import type { Project } from '../model/types'

/**
 * Tell the engine to skip a graph rebuild only when this gesture actually drafted a change.
 * A rejected write, or a release with no draft, clears the flag so the next sync can add strips.
 */
export function settleMixFollow(
  store: { readonly mixDraftOpen: boolean; finishMixGesture: () => boolean },
  engine: { armMixFollow?: () => void; clearMixFollow?: () => void },
) {
  if (!store.mixDraftOpen) {
    engine.clearMixFollow?.()
    store.finishMixGesture()
    return false
  }
  engine.armMixFollow?.()
  const emitted = store.finishMixGesture()
  if (!emitted) engine.clearMixFollow?.()
  return emitted
}

/** Move this fader and any linked strips on the nodes that already exist. */
export function previewChannel(
  engine: { previewMix: (target: 'volume' | 'pan', id: string, value: number) => void },
  project: Project,
  target: 'volume' | 'pan',
  trackId: string,
  next: number,
) {
  const track = project.tracks.find((item) => item.id === trackId)
  engine.previewMix(target, trackId, next)
  if (!track) return
  const group = groupForTrack(project, trackId)
  if (!group?.faders) return
  const origin = target === 'volume' ? track.volume : track.pan
  const delta = next - origin
  const min = target === 'volume' ? 0 : -1
  const max = target === 'volume' ? 1.25 : 1
  for (const member of project.tracks) {
    if (member.id === trackId || !group.trackIds.includes(member.id)) continue
    const base = target === 'volume' ? member.volume : member.pan
    engine.previewMix(target, member.id, Math.min(max, Math.max(min, base + delta)))
  }
}

export interface MixSample {
  value: number
  sample: number
}

/**
 * A fader or pan drag.
 * Every move writes the AudioParam immediately.
 * The screen hears the value at most once per animation frame.
 * The project store is written once, on release.
 */
export function createMixDrag(handlers: {
  audio: (value: number) => void
  /** Project value, updated on every move and not announced to React. */
  project?: (value: number) => void
  screen: (value: number) => void
  commit: (value: number, trail: MixSample[]) => void
  sample?: () => number
}) {
  let pending: number | null = null
  let trail: MixSample[] = []
  let epoch = 0
  let scheduled = -1
  let moved = false
  return {
    move(value: number) {
      moved = true
      handlers.audio(value)
      handlers.project?.(value)
      pending = value
      trail.push({ value, sample: handlers.sample?.() ?? 0 })
      const stamp = epoch
      if (scheduled === stamp) return
      scheduled = stamp
      onNextFrame(() => {
        if (epoch !== stamp) return
        scheduled = -1
        if (pending != null) handlers.screen(pending)
      })
    },
    finish(): { value: number; trail: MixSample[] } | null {
      epoch += 1
      scheduled = -1
      const final = pending
      const samples = trail
      pending = null
      trail = []
      const did = moved
      moved = false
      if (!did || final == null) return null
      handlers.screen(final)
      return { value: final, trail: samples }
    },
    release() {
      const done = this.finish()
      if (done) handlers.commit(done.value, done.trail)
    },
  }
}

/** Local screen value for a drag. The store is not notified until release. */
export function useLiveMix(value: number, opts: {
  audio: (value: number) => void
  project?: (value: number) => void
  /** Return false when the value was rejected, so the control snaps back. */
  commit: (value: number, trail: MixSample[]) => boolean | void
  sample?: () => number
}) {
  const [shown, setShown] = useState(value)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const valueRef = useRef(value)
  valueRef.current = value
  const dragging = useRef(false)
  const drag = useRef<ReturnType<typeof createMixDrag> | null>(null)
  if (!drag.current) {
    drag.current = createMixDrag({
      audio: (next) => optsRef.current.audio(next),
      project: (next) => optsRef.current.project?.(next),
      screen: (next) => setShown(next),
      commit: (next, trail) => optsRef.current.commit(next, trail),
      sample: () => optsRef.current.sample?.() ?? 0,
    })
  }
  // Undo, reset, and a collaborator change `value` on this render. Copying it into
  // `shown` from an effect leaves a window where a drag starts at the last finger
  // position. While the finger is up, the picture and the gesture origin are the
  // store value. `shown` leads only for the frames of a drag.
  if (!dragging.current && !Object.is(shown, value)) setShown(value)
  const display = dragging.current ? shown : value
  return {
    value: display,
    move(next: number) {
      dragging.current = true
      drag.current!.move(next)
    },
    release() {
      const done = drag.current!.finish()
      dragging.current = false
      if (!done) return
      const wrote = optsRef.current.commit(done.value, done.trail)
      if (wrote === false) setShown(valueRef.current)
    },
  }
}
