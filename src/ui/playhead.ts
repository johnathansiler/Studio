/** Timeline pixels for a sample. Fractional on purpose, so the line does not step by whole pixels. */
export function playheadPx(sample: number, sampleRate: number, pxPerSecond: number) {
  if (!(sampleRate > 0) || !Number.isFinite(sample) || !Number.isFinite(pxPerSecond)) return 0
  return (sample / sampleRate) * pxPerSecond
}

export function playheadTransform(px: number) {
  return `translateX(${px}px)`
}

/**
 * The seek target is the on-screen ruler strip.
 * A long arrangement can be thousands of pixels wide; the hit target is only the visible slice.
 */
export function playheadStripWidth(viewWidth: number, timelineWidth = viewWidth) {
  if (!(viewWidth > 0)) return 0
  const view = viewWidth
  if (!(timelineWidth > 0)) return view
  return Math.min(view, timelineWidth)
}

/** Content x under a finger on the visible strip. `viewLeft` is the strip's screen left. */
export function playheadContentX(clientX: number, viewLeft: number, scrollLeft: number) {
  return scrollLeft + (clientX - viewLeft)
}

interface PlayheadStyle {
  transform: string
  willChange?: string
}

interface PlayheadMotion {
  currentTime: CSSNumberish | null
  playbackRate: number
  playState?: string
  play?: () => void
  pause?: () => void
  cancel?: () => void
}

interface PlayheadNode {
  style: PlayheadStyle
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => PlayheadMotion
}

interface PlayheadSync {
  motion: PlayheadMotion
  px: number
  at: number
  rate: number
  running: boolean
}

/** Resync only after the audio clock and the compositor clock disagree by this many pixels. */
const PLAYHEAD_DRIFT = 2
/** The transform animation covers this much song time. Playback rate stays 1. */
const PLAYHEAD_SECONDS = 60 * 30

const motions = new WeakMap<PlayheadNode, PlayheadSync>()

function startMotion(node: PlayheadNode, pxPerSecond: number) {
  const distance = Math.max(1, pxPerSecond) * PLAYHEAD_SECONDS
  const motion = node.animate!(
    [
      { transform: 'translateX(0px)' },
      { transform: `translateX(${distance}px)` },
    ],
    { duration: PLAYHEAD_SECONDS * 1000, easing: 'linear', fill: 'both' },
  )
  motion.playbackRate = 1
  motion.pause?.()
  return motion
}

function compositorMotion(node: PlayheadNode, pxPerSecond: number) {
  const existing = motions.get(node)
  if (existing && Math.abs(existing.rate - pxPerSecond) < 0.01) return existing
  if (typeof node.animate !== 'function') return null
  existing?.motion.cancel?.()
  const motion = startMotion(node, pxPerSecond)
  const sync = existing ?? { motion, px: Number.NaN, at: 0, rate: pxPerSecond, running: false }
  sync.motion = motion
  sync.rate = pxPerSecond
  sync.running = false
  motions.set(node, sync)
  return sync
}

/**
 * Move a playhead from the audio clock without rendering React.
 * While playback is running, a transform animation advances on the compositor.
 * The audio clock only rewrites that animation after it drifts, so a steady
 * playhead does not invalidate style on the timeline every frame.
 */
export function placePlayhead(
  node: PlayheadNode,
  sample: number,
  sampleRate: number,
  pxPerSecond: number,
  running = false,
) {
  const px = playheadPx(sample, sampleRate, pxPerSecond)
  if (node.style.willChange !== 'transform') node.style.willChange = 'transform'
  const sync = compositorMotion(node, pxPerSecond)
  if (!sync) {
    const transform = playheadTransform(px)
    if (node.style.transform !== transform) node.style.transform = transform
    return px
  }
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  const estimated = sync.running ? sync.px + ((now - sync.at) * sync.rate) / 1000 : sync.px
  const drifted = !Number.isFinite(sync.px) || Math.abs(estimated - px) > PLAYHEAD_DRIFT
  if (sync.running === running && !drifted) return px
  const next = pxPerSecond > 0 ? Math.max(0, Math.min(PLAYHEAD_SECONDS * 1000, (px / pxPerSecond) * 1000)) : 0
  if (Number(sync.motion.currentTime) !== next) sync.motion.currentTime = next
  if (running) {
    if (!sync.running) sync.motion.play?.()
  } else if (sync.running) {
    sync.motion.pause?.()
  }
  sync.px = px
  sync.at = now
  sync.rate = pxPerSecond
  sync.running = running
  return px
}
