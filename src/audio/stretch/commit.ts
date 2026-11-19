import { clipTempoMode, tempoDrivesLength } from '../../model/clipTempo'
import { renderClipChannels, timelineSamples, type StretchQuality } from './engine'
import { channelPrint, formantPitchKey, readFormantPitch } from './pitchCache'
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
      const mode = clipTempoMode(stretch)
      if (mode === 'free' || !(stretch?.sourceBpm && stretch.sourceBpm > 0)) continue
      clips += `${clip.id}:${clip.startSample}:${clip.durationSamples}:${clip.offsetSamples}:${stretch.sourceSamples}:${stretch.sourceBpm}:${mode}:${stretch.lockBpm ?? 0};`
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
 * Store the committed render now.
 * A tempo-driven loop plays this buffer first. A later preview swap restarts
 * the source and clicks, so nothing is announced.
 */
function commitTempoStretch(key: string, render: () => Float32Array[], clipId: string): Float32Array[] {
  const existing = slots.get(key)
  if (existing?.quality === 'hq' && existing.channels) return existing.channels
  const channels = render()
  slots.set(key, { token: ++token, quality: 'hq', channels, clipId })
  return channels
}

/**
 * Preview is available immediately. The offline phase-vocoder render replaces it
 * on a later turn, and listeners can swap playback to that buffer.
 * Tempo-driven clips do not use this path. Their first buffer is the committed render.
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
  const cold = formantPitchPending(frozenClip, channels, frozenProject.sampleRate)
  if (tempoDrivesLength(frozenClip.stretch)) {
    commitTempoStretch(key, () => renderClipChannels(channels, frozenClip, frozenProject, 'hq'), frozenClip.id)
  } else {
    scheduleStretchCommit(
      key,
      () => renderClipChannels(channels, frozenClip, frozenProject, 'hq'),
      () => renderClipChannels(channels, frozenClip, frozenProject, 'preview'),
      frozenClip.id,
    )
  }
  if (cold) {
    void import('./pitchJob').then((mod) => mod.upgradeFormantPitch(channels, frozenClip, frozenProject, key))
  }
  return key
}

export function readStretch(key: string, channels: Float32Array[], clip: AudioClip, project: Project) {
  const frozenClip = clipSnapshot(clip)
  const frozenProject = clockSnapshot(project)
  const frozenKey = stretchCacheKey(frozenClip, frozenProject)
  const cacheKey = key === frozenKey ? key : frozenKey
  currentKey.set(frozenClip.id, cacheKey)
  if (tempoDrivesLength(frozenClip.stretch)) {
    const rendered = commitTempoStretch(cacheKey, () => renderClipChannels(channels, frozenClip, frozenProject, 'hq'), frozenClip.id)
    if (formantPitchPending(frozenClip, channels, frozenProject.sampleRate)) {
      void import('./pitchJob').then((mod) => mod.upgradeFormantPitch(channels, frozenClip, frozenProject, cacheKey))
    }
    return rendered
  }
  const hit = slots.get(cacheKey)
  if (!(hit?.quality === 'hq' && hit.channels)) {
    const cold = formantPitchPending(frozenClip, channels, frozenProject.sampleRate)
    if (!hit?.channels) {
      scheduleStretchCommit(
        cacheKey,
        () => renderClipChannels(channels, frozenClip, frozenProject, 'hq'),
        () => renderClipChannels(channels, frozenClip, frozenProject, 'preview'),
        frozenClip.id,
      )
    }
    if (cold) void import('./pitchJob').then((mod) => mod.upgradeFormantPitch(channels, frozenClip, frozenProject, cacheKey))
  }
  if (hit?.quality === 'hq' && hit.channels) return hit.channels
  if (hit?.channels) return hit.channels
  return slots.get(cacheKey)?.channels ?? renderClipChannels(channels, frozenClip, frozenProject, 'preview')
}

export function storeStretch(key: string, channels: Float32Array[]) {
  slots.set(key, { token: ++token, quality: 'hq', channels, clipId: '' })
}

/** Swap in the offline pitch render and tell playback to pick it up. */
export function publishStretch(key: string, channels: Float32Array[], clipId = '') {
  const current = slots.get(key)
  slots.set(key, { token: current?.token ?? ++token, quality: 'hq', channels, clipId: clipId || current?.clipId || '' })
  if (clipId && currentKey.get(clipId) && currentKey.get(clipId) !== key) return
  for (const listener of listeners) listener(key)
}

function formantPitchPending(clip: AudioClip, channels: Float32Array[], sampleRate: number) {
  const stretch = clip.stretch
  if (!stretch?.formant || !(stretch.semitones || stretch.cents)) return false
  if (stretch.mode !== 'pro' && stretch.mode !== 'tonal') return false
  const offset = Math.max(0, clip.offsetSamples || 0)
  const source = Math.max(1, stretch.sourceSamples || 0)
  const end = Math.min(channels[0]?.length ?? 0, offset + source)
  const sliced = channels.map((channel) => channel.subarray(offset, end))
  const length = sliced[0]?.length ?? 0
  if (length < 8) return false
  const key = formantPitchKey({
    bufferId: clip.bufferId,
    offsetSamples: offset,
    sourceSamples: source,
    length,
    sampleRate,
    semitones: stretch.semitones,
    cents: stretch.cents,
    formant: true,
    mode: stretch.mode,
    print: channelPrint(sliced),
  })
  return !readFormantPitch(key)
}
