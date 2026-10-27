import { createPlugin } from './plugins/catalog'
import { loadModule, peekModule } from './plugins/registry'
import { renderGraph, type GraphTrack } from './renderGraph'
import { scaleById } from '../model/scale'
import { beatsToSamples, projectEndSample } from '../model/time'
import { makeTrack, uid, type AudioAsset, type AudioClip, type PluginInstance, type Project, type Track } from '../model/types'
import { encodeWav, linearResample, type DitherMode, type WavBits } from '../model/wav'
import { encodeFlac } from '../model/flac'
import { encodeMidi } from '../model/midiFile'
import { zipFiles } from '../model/zip'
import { packProject } from '../model/archive'
import { encodeMp3, keyLabel } from './mp3'
import { normalizeAudio } from './normalize'
import { limitBuffer } from './master/process'
import { measureProgram } from './master/meter'
import type { Processor } from './plugins/types'

export class BounceCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'BounceCancelled'
  }
}

export type BounceKind = 'mix' | 'wav' | 'stems' | 'track' | 'midi' | 'project' | 'flac' | 'mp3'

export interface BounceJob {
  kind: BounceKind
  project: Project
  assets: AudioAsset[]
  scope: 'song' | 'loop' | 'selection' | 'time'
  startSample: number
  endSample: number
  tail: 'auto' | number
  sampleRate: number
  bits: WavBits
  dither: DitherMode
  normalize: 'off' | 'peak' | 'lufs'
  normalizeTarget: number
  limiter: boolean
  stemIds: string[] | null
  trackId: string | null
  mp3Mode: 'cbr' | 'vbr'
  mp3Bitrate: number
  mp3Quality: number
  title: string
  artist: string
  artwork: Uint8Array | null
  projectAudio: 'wav' | 'flac'
  /** Keep the file at or under this true-peak ceiling after loudness normalize. */
  truePeakCeiling?: number
  /** Write the loudness report, and the ISRC when one is set. */
  isrc?: string
  report?: boolean
}

export interface BounceFile {
  name: string
  mime: string
  bytes: Uint8Array
}

export function tailSamples(project: Project, sampleRate: number) {
  let seconds = 0
  const plugins = [...project.masterPlugins, ...project.tracks.flatMap((track) => track.plugins)]
  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.wet <= 0) continue
    if (plugin.pluginId === 'brick' || plugin.pluginId === 'maxim') seconds = Math.max(seconds, ((plugin.params.lookahead || 5) / 1000) + 0.02)
    if (plugin.pluginId === 'meq' && (plugin.params.phase ?? 1) >= 0.5) seconds = Math.max(seconds, 0.04)
    if (plugin.pluginId === 'delay') {
      const time = Math.max(0.001, (plugin.params.time ?? 250) / 1000)
      const feedback = Math.min(0.95, Math.max(0, plugin.params.feedback ?? 0.35))
      const repeats = feedback < 0.05 ? 1 : Math.min(16, Math.ceil(Math.log(0.001) / Math.log(Math.max(0.05, feedback))))
      seconds = Math.max(seconds, time * Math.max(1, repeats))
    } else if (plugin.pluginId === 'reverb') {
      seconds = Math.max(seconds, 0.35 + (plugin.params.size ?? 0.6) * 4)
    }
  }
  return Math.round(Math.min(12, seconds) * sampleRate)
}

export function bounceBounds(project: Project, scope: BounceJob['scope'], startSample: number, endSample: number) {
  if (scope === 'loop') return { start: Math.max(0, project.loopStartSample), end: Math.max(project.loopStartSample + 1, project.loopEndSample) }
  if (scope === 'time' || scope === 'selection') return { start: Math.max(0, startSample), end: Math.max(startSample + 1, endSample) }
  return { start: 0, end: Math.max(project.sampleRate, projectEndSample(project.tracks, project.sampleRate, project.tempo)) }
}

export async function renderArrangement(project: Project, assets: Map<string, AudioAsset>, start: number, length: number, limiter: boolean, stemId: string | null = null) {
  const rendered = await renderChannels(project, assets, start, length, limiter, stemId)
  return rendered.master
}

export async function runBounce(job: BounceJob, onProgress?: (progress: number) => void, shouldCancel?: () => boolean): Promise<BounceFile[]> {
  const stop = () => {
    if (shouldCancel?.()) throw new BounceCancelled()
  }
  stop()
  onProgress?.(0)
  if (job.kind === 'midi') {
    onProgress?.(1)
    return [{ name: `${fileSlug(job.project.name)}.mid`, mime: 'audio/midi', bytes: encodeMidi(job.project) }]
  }
  if (job.kind === 'project') {
    const bytes = await packProject(job.project, job.assets, { audio: job.projectAudio })
    onProgress?.(1)
    return [{ name: `${fileSlug(job.project.name)}.cueharbor`, mime: 'application/octet-stream', bytes }]
  }
  const assets = new Map(job.assets.map((asset) => [asset.id, asset]))
  const bounds = bounceBounds(job.project, job.scope, job.startSample, job.endSample)
  const tail = job.tail === 'auto' ? tailSamples(job.project, job.project.sampleRate) : Math.round(Math.max(0, job.tail) * job.project.sampleRate)
  const length = Math.max(1, bounds.end - bounds.start + tail)
  if (job.kind === 'stems') {
    const ids = stemIds(job)
    const files: { name: string; channels: Float32Array[] }[] = []
    for (let index = 0; index < ids.length; index++) {
      stop()
      const track = job.project.tracks.find((item) => item.id === ids[index])
      if (!track) continue
      const channels = await renderArrangement(job.project, assets, bounds.start, length, false, track.id)
      files.push({ name: `${String(index + 1).padStart(2, '0')}-${fileSlug(track.name)}.wav`, channels })
      onProgress?.((index + 1) / ids.length)
    }
    const encoded = files.map((file) => ({
      name: file.name,
      data: new Uint8Array(encodeWav(resample(finish(file.channels, job), job.project.sampleRate, job.sampleRate), job.sampleRate, { bits: job.bits, dither: job.dither })),
    }))
    return [{ name: `${fileSlug(job.project.name)}-stems.zip`, mime: 'application/zip', bytes: await zipFiles(encoded) }]
  }
  stop()
  const stemId = job.kind === 'track' ? job.trackId : null
  const useLimiter = (job.kind === 'mix' || job.kind === 'wav' || job.kind === 'mp3' || job.kind === 'flac') && job.limiter
  const rendered = await renderChannels(job.project, assets, bounds.start, length, useLimiter, stemId)
  onProgress?.(0.7)
  stop()
  const rate = job.kind === 'mp3' && job.sampleRate !== 44100 ? 48000 : job.sampleRate
  let channels = resample(finish(rendered.master, job), job.project.sampleRate, rate)
  if (job.truePeakCeiling != null && Number.isFinite(job.truePeakCeiling)) channels = limitBuffer(channels, rate, job.truePeakCeiling, true)
  const note = job.report ? loudnessNote(channels, rate, job.isrc) : ''
  onProgress?.(0.85)
  if (job.kind === 'flac') {
    onProgress?.(1)
    return [{ name: `${fileSlug(job.project.name)}.flac`, mime: 'audio/flac', bytes: encodeFlac(channels, rate, job.bits === 24 ? 24 : 16) }]
  }
  if (job.kind === 'mp3') {
    const bytes = encodeMp3(channels, rate, {
      mode: job.mp3Mode,
      bitrate: job.mp3Bitrate,
      quality: job.mp3Quality,
      tags: { title: job.title || job.project.name, artist: job.artist, bpm: job.project.tempo, key: keyLabel(job.project), artwork: job.artwork, comment: note, isrc: job.isrc },
    })
    onProgress?.(1)
    return [{ name: `${fileSlug(job.project.name)}.mp3`, mime: 'audio/mpeg', bytes }]
  }
  onProgress?.(1)
  return [{ name: `${fileSlug(job.project.name)}.wav`, mime: 'audio/wav', bytes: new Uint8Array(encodeWav(channels, rate, { bits: job.bits, dither: job.dither, comment: note })) }]
}

function loudnessNote(channels: Float32Array[], sampleRate: number, isrc?: string) {
  const reading = measureProgram(channels[0] ?? new Float32Array(0), channels[1] ?? null, sampleRate)
  const code = isrc?.trim() ? ` ISRC ${isrc.trim()}.` : ''
  return `Integrated ${reading.integrated.toFixed(1)} LUFS, short-term ${reading.shortTerm.toFixed(1)} LUFS, LRA ${reading.lra.toFixed(1)} LU, true peak ${reading.truePeak.toFixed(2)} dBTP.${code}`
}

function finish(channels: Float32Array[], job: BounceJob) {
  return normalizeAudio(channels, job.project.sampleRate, job.normalize, job.normalizeTarget)
}

function resample(channels: Float32Array[], from: number, to: number) {
  if (from === to) return channels
  return channels.map((channel) => linearResample(channel, from, to))
}

function stemIds(job: BounceJob) {
  if (job.stemIds?.length) return job.stemIds
  return job.project.tracks.map((track) => track.id)
}

export function fileSlug(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return slug || 'cueharbor'
}

export function applyFreeze(project: Project, buffers: Map<string, AudioAsset>, sourceId: string, audio: { sampleRate: number; channels: Float32Array[] }, startSample: number) {
  const next = JSON.parse(JSON.stringify(project)) as Project
  const source = next.tracks.find((track) => track.id === sourceId)
  const map = new Map(buffers)
  if (!source) return { project: next, buffers: map }
  const id = uid('buf')
  const track = makeTrack({ name: `${source.name} bounce`, type: 'audio', input: 'none', color: source.color })
  track.volume = 1
  track.pan = 0
  const clip: AudioClip = {
    id: uid('clip'),
    name: track.name,
    bufferId: id,
    startSample: Math.max(0, startSample),
    offsetSamples: 0,
    durationSamples: audio.channels[0]?.length ?? 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'import',
  }
  track.clips = [clip]
  const index = next.tracks.findIndex((item) => item.id === sourceId)
  next.tracks.splice(index + 1, 0, track)
  source.mute = true
  source.plugins = source.plugins.map((plugin) => ({ ...plugin, enabled: false }))
  map.set(id, { id, name: track.name, sampleRate: audio.sampleRate, channels: audio.channels })
  return { project: next, buffers: map }
}

async function renderChannels(project: Project, assets: Map<string, AudioAsset>, start: number, length: number, limiter: boolean, stemId: string | null) {
  await ensurePlugins(project)
  const scale = scaleById(project.scale?.scale)
  const routed = routeForStem(project.tracks, stemId)
  let masterPlugins = project.masterPlugins.map(copyPlugin)
  let masterVolume = project.masterVolume
  if (stemId) {
    masterPlugins = masterPlugins.map((plugin) => ({ ...plugin, enabled: false }))
    masterVolume = 1
  } else if (limiter) masterPlugins = enableLimiter(masterPlugins)
  else masterPlugins = masterPlugins.map((plugin) => (plugin.pluginId === 'limiter' ? { ...plugin, enabled: false } : plugin))
  const graphTracks: GraphTrack[] = routed.map((track) => ({
    id: track.id,
    type: track.type,
    input: track.input,
    buffer: mixTrack(track, assets, start, length, project.sampleRate, project.tempo),
    volume: track.volume,
    pan: track.pan,
    mute: track.mute,
    solo: track.solo,
    plugins: track.plugins,
    sends: track.sends,
    output: track.output,
    groupId: track.groupId,
  }))
  if (stemId && graphTracks.length === 1) {
    graphTracks[0].output = null
    graphTracks[0].groupId = null
    graphTracks[0].sends = []
  }
  return renderGraph({
    tracks: graphTracks,
    masterPlugins,
    masterVolume,
    sampleRate: project.sampleRate,
    tempo: project.tempo,
    length,
    scaleRoot: project.scale?.root ?? 0,
    scaleIntervals: scale.intervals,
    automation: project.automation,
    liveRemote: false,
    create: (pluginId, sampleRate) => peekModule(pluginId)?.create(sampleRate) ?? passthrough(),
  })
}

function routeForStem(tracks: Track[], stemId: string | null): Track[] {
  if (!stemId) return tracks
  const stem = tracks.find((track) => track.id === stemId)
  if (!stem) return tracks
  if (stem.type !== 'bus' && stem.type !== 'group') return [{ ...stem, mute: false, solo: false }]
  return tracks.map((track) => {
    if (track.id === stem.id) return { ...track, output: null, groupId: null, mute: false, solo: false }
    if (feeds(track, stem.id, tracks)) return { ...track, mute: false }
    return { ...track, mute: true, solo: false }
  })
}

function feeds(track: Track, target: string, tracks: Track[], seen = new Set<string>()): boolean {
  if (seen.has(track.id)) return false
  seen.add(track.id)
  const dest = track.groupId || track.output
  if (!dest) return false
  if (dest === target) return true
  const next = tracks.find((item) => item.id === dest)
  return next ? feeds(next, target, tracks, seen) : false
}

function mixTrack(track: Track, assets: Map<string, AudioAsset>, start: number, length: number, rate: number, tempo: number) {
  const out = [new Float32Array(length), new Float32Array(length)]
  for (const clip of track.clips) {
    const asset = assets.get(clip.bufferId)
    if (!asset?.channels.length) continue
    const channels = asset.sampleRate === rate ? asset.channels : asset.channels.map((channel) => linearResample(channel, asset.sampleRate, rate))
    const clipEnd = clip.startSample + clip.durationSamples
    const from = Math.max(clip.startSample, start)
    const to = Math.min(clipEnd, start + length)
    const clipDur = clip.durationSamples / rate
    const fadeIn = clip.fadeInSamples / rate
    const fadeOut = clip.fadeOutSamples / rate
    for (let i = from; i < to; i++) {
      const rel = (i - clip.startSample) / rate
      let gain = clip.gain
      if (fadeIn > 0 && rel < fadeIn) gain *= rel / fadeIn
      if (fadeOut > 0 && rel > clipDur - fadeOut) gain *= Math.max(0, (clipDur - rel) / fadeOut)
      gain = Math.max(0.0001, gain)
      const src = clip.offsetSamples + (i - clip.startSample)
      const dst = i - start
      if (src < 0 || dst < 0 || dst >= length) continue
      for (let c = 0; c < 2; c++) {
        const channel = channels[Math.min(c, channels.length - 1)]
        out[c][dst] += (channel?.[src] ?? 0) * gain
      }
    }
  }
  for (const clip of track.midiClips) {
    for (const note of clip.notes) {
      const noteStart = Math.round(beatsToSamples(clip.startBeat + note.startBeat, rate, tempo))
      const duration = Math.round(beatsToSamples(note.durationBeats, rate, tempo))
      addVoice(out, note.pitch, note.velocity, noteStart, duration, start, rate)
    }
  }
  return out
}

function addVoice(out: Float32Array[], pitch: number, velocity: number, startSample: number, duration: number, origin: number, rate: number) {
  const freq = 440 * 2 ** ((pitch - 69) / 12)
  const peak = Math.max(0.001, 0.07 * (velocity <= 1 ? velocity : velocity / 127))
  const total = duration + Math.round(0.03 * rate)
  let phase = 0
  let low = 0
  let cutoff = 2200
  for (let i = 0; i < total; i++) {
    const dst = startSample + i - origin
    if (dst >= out[0].length) break
    if (dst < 0) continue
    const t = i / rate
    phase += freq / rate
    const saw = 2 * ((phase % 1) - 0.5)
    cutoff += (900 - cutoff) * (1 - Math.exp(-1 / (0.05 * rate)))
    low += Math.min(1, cutoff / rate) * (saw - low)
    const attack = 0.012
    const releaseAt = Math.max(0.05, duration / rate)
    const env = t < attack ? 0.0001 * (peak / 0.0001) ** (t / attack) : peak * (0.0001 / peak) ** ((t - attack) / Math.max(0.001, releaseAt - attack))
    out[0][dst] += low * env
    out[1][dst] += low * env
  }
}

async function ensurePlugins(project: Project) {
  const ids = new Set<string>()
  for (const track of project.tracks) for (const plugin of track.plugins) ids.add(plugin.pluginId)
  for (const plugin of project.masterPlugins) ids.add(plugin.pluginId)
  await Promise.all([...ids].map((id) => loadModule(id)))
}

function enableLimiter(plugins: PluginInstance[]) {
  const copy = plugins.map(copyPlugin)
  const found = copy.find((plugin) => plugin.pluginId === 'limiter')
  if (found) {
    found.enabled = true
    return copy
  }
  const limiter = createPlugin('limiter', 'Transparent')
  limiter.enabled = true
  return [limiter, ...copy]
}

function copyPlugin(plugin: PluginInstance): PluginInstance {
  return { ...plugin, params: { ...plugin.params } }
}

function passthrough(): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)]
        if (src) output[c].set(src)
      }
    },
  }
}
