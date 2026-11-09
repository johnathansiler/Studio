import { renderClipChannels, timelineSamples, type StretchQuality } from './engine'
import type { AudioClip, Project } from '../../model/types'

export interface StretchSlot {
  quality: StretchQuality | 'pending'
  channels: Float32Array[] | null
}

interface Slot extends StretchSlot {
  token: number
  clipId: string
}

const slots = new Map<string, Slot>()
const listeners = new Set<(key: string) => void>()
/** Latest key a clip is allowed to swap into playback. Older renders still fill their own slot. */
const currentKey = new Map<string, string>()
let token = 0

/** Tempo and map copied so a later song-tempo edit cannot change this render. */
export function clockSnapshot(project: Project): Project {
  return {
    tempo: project.tempo,
    sampleRate: project.sampleRate,
    tempoMap: project.tempoMap?.map((point) => ({ ...point })),
    automation: project.automation?.map((lane) => ({
      ...lane,
      points: lane.points.map((point) => ({ ...point })),
    })),
  } as Project
}

export function clipSnapshot(clip: AudioClip): AudioClip {
  const stretch = clip.stretch
  return {
    ...clip,
    stretch: stretch ? { ...stretch, markers: stretch.markers.map((marker) => ({ ...marker })) } : undefined,
  }
}

/** Changes when a follow-tempo clip must be rendered and scheduled again. */
export function followClockToken(project: Project) {
  const points = (project.tempoMap ?? []).map((point) => `${point.beat}:${point.bpm}:${point.ramp ? 1 : 0}`).join(',')
  let clips = ''
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const stretch = clip.stretch
      if (!stretch?.followTempo || !(stretch.sourceBpm && stretch.sourceBpm > 0)) continue
      clips += `${clip.id}:${clip.startSample}:${clip.durationSamples}:${clip.offsetSamples}:${stretch.sourceSamples}:${stretch.sourceBpm};`
    }
  }
  return `${project.tempo}|${project.sampleRate}|${points}|${clips}`
}

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
  clipId = '',
) {
  const existing = slots.get(key)
  if (existing) return existing
  const mine = ++token
  const preview = renderPreview ? renderPreview() : null
  slots.set(key, { token: mine, quality: preview ? 'preview' : 'pending', channels: preview, clipId })
  const run = () => {
    const current = slots.get(key)
    if (!current || current.token !== mine) return
    const channels = renderHq()
    const slot = slots.get(key)
    if (!slot || slot.token !== mine) return
    slots.set(key, { token: mine, quality: 'hq', channels, clipId })
    if (clipId && currentKey.get(clipId) !== key) return
    for (const listener of listeners) listener(key)
  }
  if (typeof setTimeout === 'function') setTimeout(run, 0)
  else run()
  return slots.get(key) ?? null
}

/** Render from the tempo at call time. A later tempo change keeps its own key. */
export function queueClipStretch(clip: AudioClip, channels: Float32Array[], project: Project) {
  const frozenClip = clipSnapshot(clip)
  const frozenProject = clockSnapshot(project)
  const key = stretchCacheKey(frozenClip, frozenProject)
  currentKey.set(frozenClip.id, key)
  scheduleStretchCommit(
    key,
    () => renderClipChannels(channels, frozenClip, frozenProject, 'hq'),
    () => renderClipChannels(channels, frozenClip, frozenProject, 'preview'),
    frozenClip.id,
  )
  return key
}

export function readStretch(key: string, channels: Float32Array[], clip: AudioClip, project: Project) {
  const frozenClip = clipSnapshot(clip)
  const frozenProject = clockSnapshot(project)
  const frozenKey = stretchCacheKey(frozenClip, frozenProject)
  const cacheKey = key === frozenKey ? key : frozenKey
  currentKey.set(frozenClip.id, cacheKey)
  const hit = slots.get(cacheKey)
  if (hit?.quality === 'hq' && hit.channels) return hit.channels
  if (hit?.channels) return hit.channels
  scheduleStretchCommit(
    cacheKey,
    () => renderClipChannels(channels, frozenClip, frozenProject, 'hq'),
    () => renderClipChannels(channels, frozenClip, frozenProject, 'preview'),
    frozenClip.id,
  )
  return slots.get(cacheKey)?.channels ?? renderClipChannels(channels, frozenClip, frozenProject, 'preview')
}

export function storeStretch(key: string, channels: Float32Array[]) {
  slots.set(key, { token: ++token, quality: 'hq', channels, clipId: '' })
}
