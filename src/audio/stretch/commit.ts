import { renderClipChannels, timelineSamples, type StretchQuality } from './engine'
import type { AudioClip, Project } from '../../model/types'

export interface StretchSlot {
  quality: StretchQuality | 'pending'
  channels: Float32Array[] | null
}

interface Slot extends StretchSlot {
  token: number
}

const slots = new Map<string, Slot>()
const listeners = new Set<(key: string) => void>()
let token = 0

export function stretchCacheKey(clip: AudioClip, project: Project) {
  return JSON.stringify([
    clip.bufferId,
    clip.offsetSamples,
    clip.startSample,
    timelineSamples(clip, project),
    clip.stretch ?? null,
    project.tempo,
    project.tempoMap ?? [],
    project.sampleRate,
  ])
}

export function onStretchCommit(listener: (key: string) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function stretchSlot(key: string): StretchSlot | null {
  const slot = slots.get(key)
  if (!slot) return null
  return { quality: slot.quality, channels: slot.channels }
}

/**
 * Preview is available immediately. The offline phase-vocoder render replaces it
 * on a later turn, and listeners can swap playback to that buffer.
 */
export function scheduleStretchCommit(
  key: string,
  renderHq: () => Float32Array[],
  renderPreview?: () => Float32Array[],
) {
  const existing = slots.get(key)
  if (existing) return existing
  const mine = ++token
  const preview = renderPreview ? renderPreview() : null
  slots.set(key, { token: mine, quality: preview ? 'preview' : 'pending', channels: preview })
  const run = () => {
    const current = slots.get(key)
    if (!current || current.token !== mine) return
    const channels = renderHq()
    slots.set(key, { token: mine, quality: 'hq', channels })
    for (const listener of listeners) listener(key)
  }
  if (typeof setTimeout === 'function') setTimeout(run, 0)
  else run()
  return slots.get(key) ?? null
}

export function readStretch(key: string, channels: Float32Array[], clip: AudioClip, project: Project) {
  const hit = slots.get(key)
  if (hit?.quality === 'hq' && hit.channels) return hit.channels
  if (hit?.channels) return hit.channels
  scheduleStretchCommit(
    key,
    () => renderClipChannels(channels, clip, project, 'hq'),
    () => renderClipChannels(channels, clip, project, 'preview'),
  )
  return slots.get(key)?.channels ?? renderClipChannels(channels, clip, project, 'preview')
}

export function storeStretch(key: string, channels: Float32Array[]) {
  slots.set(key, { token: ++token, quality: 'hq', channels })
}
