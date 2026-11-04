import type { AudioClip } from '../model/types'
import { lockToZero } from './zeroCross'

type ClipEdge = Pick<AudioClip, 'startSample' | 'offsetSamples' | 'durationSamples' | 'stretch'>

function sourceLength(clip: ClipEdge) {
  const stored = clip.stretch?.sourceSamples
  if (stored && stored > 0) return stored
  return Math.max(1, clip.durationSamples)
}

/** Timeline samples per source sample. A clip that is not stretched is 1. */
export function clipPlayRatio(clip: ClipEdge) {
  return clip.durationSamples / sourceLength(clip) || 1
}

/**
 * Move a timeline sample onto the source buffer's nearest zero crossing.
 * `locked` is false when snap is off or the buffer has no crossing in range.
 */
export function snapClipTimeline(
  clip: ClipEdge,
  channel: ArrayLike<number> | null | undefined,
  timeline: number,
  enabled: boolean,
) {
  const ratio = clipPlayRatio(clip)
  if (!enabled || !channel || channel.length < 2) return { sample: Math.round(timeline), locked: false }
  const source = clip.offsetSamples + (timeline - clip.startSample) / ratio
  const hit = lockToZero(channel, source, true, channel.length)
  if (!hit.locked) return { sample: Math.round(timeline), locked: false }
  return { sample: Math.round(clip.startSample + (hit.index - clip.offsetSamples) * ratio), locked: true }
}
