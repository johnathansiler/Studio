/**
 * Render a MIDI clip, a Beat Machine pattern, or a whole track to audio.
 * The print is what playback hears: the rack worklet, the transport drums, or the sampler.
 * Track inserts are optional. The master bus is not.
 */

import { renderHeard } from './heardPrint'
import { BASS808_RELEASE_SEC } from './bass808/voice'
import { patternHitTrack } from '../model/channelRack'
import { beatSpanSamples } from '../model/tempoMap'
import { makeTrack, uid, type AudioAsset, type AudioClip, type Project, type Track } from '../model/types'

/** -90 dBFS. Samples quieter than this are trimmed from the rendered tail. */
export const SILENCE_DB = -90
export const SILENCE_AMP = 10 ** (SILENCE_DB / 20)
/** Peak normalize lands here so a full-scale file does not touch 0 dBFS. */
export const NORMALIZE_DB = -0.1

export class RenderCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'RenderCancelled'
  }
}

export class RenderEmpty extends Error {
  constructor() {
    super('Nothing to render')
    this.name = 'RenderEmpty'
  }
}

export type RenderPlace = 'mute' | 'replace' | 'keep'

export type RenderTarget =
  | { kind: 'midi'; trackId: string; clipId: string }
  | { kind: 'pattern'; clipId: string }
  | { kind: 'track'; trackId: string }

export interface RenderRequest {
  project: Project
  assets: Map<string, AudioAsset>
  target: RenderTarget
  includeEffects: boolean
  normalize: boolean
  onProgress?: (ratio: number) => void
  shouldCancel?: () => void
}

export interface RenderedAudio {
  channels: Float32Array<ArrayBufferLike>[]
  sampleRate: number
  startSample: number
  peak: number
  peakDb: number
  clipped: boolean
  name: string
  sourceTrackId: string
  target: RenderTarget
  musicalSamples: number
}

export function peakOf(channels: ArrayLike<number>[]) {
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.abs(channel[i] || 0)
      if (sample > peak) peak = sample
    }
  }
  return peak
}

export function toPeakDb(peak: number) {
  if (!(peak > 1e-12)) return -180
  return 20 * Math.log10(peak)
}

export function withNormalize(result: RenderedAudio): RenderedAudio {
  const channels = normalizePeak(result.channels)
  const peak = peakOf(channels)
  return { ...result, channels, peak, peakDb: toPeakDb(peak), clipped: peak > 1 }
}

export function normalizePeak(channels: Float32Array<ArrayBufferLike>[], targetDb = NORMALIZE_DB) {
  const peak = peakOf(channels)
  if (peak <= 1e-8) return channels
  const gain = 10 ** (targetDb / 20) / peak
  return channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = (channel[i] || 0) * gain
    return out
  })
}

/** How far past the clip the instrument release and, optionally, the track effects still sound. */
export function releaseTailSamples(track: Track, sampleRate: number, includeEffects: boolean) {
  let seconds = 0.08
  for (const device of track.rack?.devices ?? []) {
    const releaseMs = device.params.release || 0
    if (releaseMs > 0) seconds = Math.max(seconds, (releaseMs / 1000) * 10.36)
    const sustain = device.params.sustain ?? 1
    const decayMs = device.params.decay || 0
    if (decayMs > 0 && sustain < 0.15) seconds = Math.max(seconds, (decayMs / 1000) * 4)
  }
  if (track.padKit) {
    for (const bank of track.padKit.banks) {
      for (const pad of bank) {
        const release = pad.release > 8 ? pad.release / 1000 : pad.release
        if (release > 0) seconds = Math.max(seconds, release * 8)
      }
    }
  }
  for (const plugin of track.plugins) {
    if (!plugin.enabled || plugin.pluginId !== 'sampler') continue
    const raw = plugin.params.release || 0
    if (raw > 0) seconds = Math.max(seconds, (raw > 8 ? raw : raw * 1000) / 1000 * 8)
  }
  if (includeEffects) {
    for (const plugin of track.plugins) {
      if (!plugin.enabled || plugin.wet <= 0) continue
      if (plugin.pluginId === 'reverb') seconds = Math.max(seconds, 0.35 + (plugin.params.size ?? plugin.params.decay ?? 0.6) * 4)
      if (plugin.pluginId === 'delay') {
        const time = Math.max(0.001, (plugin.params.time ?? 250) / 1000)
        const feedback = Math.min(0.95, Math.max(0, plugin.params.feedback ?? 0.35))
        const repeats = feedback < 0.05 ? 1 : Math.min(16, Math.ceil(Math.log(0.001) / Math.log(Math.max(0.05, feedback))))
        seconds = Math.max(seconds, time * Math.max(1, repeats))
      }
    }
  }
  if (track.instrument === 'pads' || track.instrument === 'drum-machine' || track.instrument === '808') seconds = Math.max(seconds, 0.45)
  if (track.instrument === 'bass808' || track.rack?.devices.some((device) => device.kind === 'bass808')) {
    seconds = Math.max(seconds, BASS808_RELEASE_SEC * 10.36)
  }
  return Math.round(Math.min(8, Math.max(0.02, seconds)) * sampleRate)
}

export function audioName(name: string) {
  const base = (name || 'Clip').trim() || 'Clip'
  const next = /\(audio\)\s*$/i.test(base) ? base : `${base} (audio)`
  return next.slice(0, 80)
}

interface WindowPlan {
  sourceTrackId: string
  name: string
  startSample: number
  musical: number
}

export async function renderClipToAudio(request: RenderRequest): Promise<RenderedAudio> {
  const project = request.project
  const rate = project.sampleRate || 48000
  request.onProgress?.(0.02)
  const plan = planWindow(project, request.target)
  const source = project.tracks.find((track) => track.id === plan.sourceTrackId)
  if (!source) throw new RenderEmpty()
  const includeEffects = request.includeEffects
  const tail = releaseTailSamples(source, rate, includeEffects)
  const length = Math.max(1, plan.musical + tail)
  request.shouldCancel?.()
  request.onProgress?.(0.08)
  let channels: Float32Array<ArrayBufferLike>[] = await renderHeard({
    project,
    assets: request.assets,
    target: request.target,
    source,
    origin: plan.startSample,
    length,
    includeEffects,
    onProgress: request.onProgress,
  })
  request.shouldCancel?.()
  request.onProgress?.(0.9)
  const musical = Math.min(plan.musical, channels[0].length)
  channels = trimTail(channels, musical)
  if (request.normalize) channels = normalizePeak(channels)
  const peak = peakOf(channels)
  request.onProgress?.(1)
  return {
    channels,
    sampleRate: rate,
    startSample: plan.startSample,
    peak,
    peakDb: toPeakDb(peak),
    clipped: peak > 1,
    name: plan.name,
    sourceTrackId: plan.sourceTrackId,
    target: request.target,
    musicalSamples: musical,
  }
}

export function installRender(project: Project, result: RenderedAudio, place: RenderPlace, bufferId: string) {
  const source = project.tracks.find((track) => track.id === result.sourceTrackId)
  const name = audioName(result.name)
  const frames = result.channels[0]?.length ?? 1
  const clip: AudioClip = {
    id: uid('clip'),
    name,
    bufferId,
    startSample: result.startSample,
    offsetSamples: 0,
    durationSamples: frames,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'midi',
    loop: true,
    stretch: {
      sourceSamples: frames,
      semitones: 0,
      cents: 0,
      mode: 'pro',
      followTempo: false,
      sourceBpm: project.tempo,
      markers: [],
    },
  }
  const track = makeTrack({
    name,
    type: 'audio',
    kind: 'loop',
    input: 'none',
    color: source?.color ?? '#73c48f',
    volume: source?.volume ?? 0.8,
    pan: source?.pan ?? 0,
  })
  track.output = source?.output ?? null
  track.groupId = source?.groupId ?? null
  track.armed = false
  track.monitor = false
  track.clips = [clip]
  const index = source ? project.tracks.findIndex((item) => item.id === source.id) : -1
  project.tracks.splice(index < 0 ? project.tracks.length : index + 1, 0, track)
  if (place === 'mute') silenceSource(project, result.target, false)
  if (place === 'replace') silenceSource(project, result.target, true)
  return { trackId: track.id, clipId: clip.id }
}

function silenceSource(project: Project, target: RenderTarget, remove: boolean) {
  if (target.kind === 'midi') {
    const track = project.tracks.find((item) => item.id === target.trackId)
    if (!track) return
    if (remove) track.midiClips = track.midiClips.filter((clip) => clip.id !== target.clipId)
    else {
      const clip = track.midiClips.find((item) => item.id === target.clipId)
      if (clip) clip.muted = true
    }
    return
  }
  if (target.kind === 'pattern') {
    const clips = project.patternClips ?? []
    if (remove) project.patternClips = clips.filter((clip) => clip.id !== target.clipId)
    else {
      const clip = clips.find((item) => item.id === target.clipId)
      if (clip) clip.muted = true
    }
    return
  }
  const track = project.tracks.find((item) => item.id === target.trackId)
  if (track) {
    if (remove) track.midiClips = track.midiClips.filter((clip) => clip.slotOnly || clip.scene != null)
    else for (const clip of track.midiClips) if (clip.scene == null && !clip.slotOnly) clip.muted = true
  }
  const patterns = project.patternClips ?? []
  if (remove) project.patternClips = patterns.filter((clip) => clip.trackId !== target.trackId || clip.scene != null)
  else for (const clip of patterns) if (clip.trackId === target.trackId && clip.scene == null) clip.muted = true
}

function planWindow(project: Project, target: RenderTarget): WindowPlan {
  if (target.kind === 'midi') {
    const track = project.tracks.find((item) => item.id === target.trackId)
    const clip = track?.midiClips.find((item) => item.id === target.clipId)
    if (!track || !clip) throw new RenderEmpty()
    const span = beatSpanSamples(project, clip.startBeat, Math.max(0.01, clip.durationBeats))
    return { sourceTrackId: track.id, name: clip.name || 'MIDI', startSample: span.start, musical: Math.max(1, span.duration) }
  }
  if (target.kind === 'pattern') {
    const clip = (project.patternClips ?? []).find((item) => item.id === target.clipId)
    if (!clip) throw new RenderEmpty()
    const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
    const span = beatSpanSamples(project, clip.startBeat, Math.max(0.01, clip.lengthBeats))
    const routed = patternHitTrack(project, { output: null }, clip)
    const sourceTrackId = (clip.trackId && project.tracks.some((track) => track.id === clip.trackId) ? clip.trackId : null)
      ?? routed
      ?? project.tracks.find((track) => track.type === 'midi')?.id
      ?? project.tracks[0]?.id
    if (!sourceTrackId) throw new RenderEmpty()
    return { sourceTrackId, name: pattern?.name || 'Pattern', startSample: span.start, musical: Math.max(1, span.duration) }
  }
  const track = project.tracks.find((item) => item.id === target.trackId)
  if (!track) throw new RenderEmpty()
  let start = Infinity
  let end = 0
  for (const clip of track.midiClips) {
    if (clip.slotOnly || clip.scene != null) continue
    const span = beatSpanSamples(project, clip.startBeat, Math.max(0.01, clip.durationBeats))
    start = Math.min(start, span.start)
    end = Math.max(end, span.start + span.duration)
  }
  for (const clip of project.patternClips ?? []) {
    if (clip.scene != null || clip.suppressed || clip.trackId !== track.id) continue
    const span = beatSpanSamples(project, clip.startBeat, Math.max(0.01, clip.lengthBeats))
    start = Math.min(start, span.start)
    end = Math.max(end, span.start + span.duration)
  }
  if (!Number.isFinite(start) || end <= start) throw new RenderEmpty()
  return { sourceTrackId: track.id, name: track.name || 'Track', startSample: start, musical: Math.max(1, Math.round(end - start)) }
}

export function trimTail(channels: Float32Array<ArrayBufferLike>[], keep: number, floor = SILENCE_AMP) {
  const length = channels[0]?.length ?? 0
  const body = Math.max(1, Math.min(length, keep))
  let end = length
  while (end > body) {
    let hot = false
    for (const channel of channels) {
      if (Math.abs(channel[end - 1] || 0) >= floor) {
        hot = true
        break
      }
    }
    if (hot) break
    end -= 1
  }
  if (end === length) return channels
  return channels.map((channel) => channel.slice(0, end))
}
