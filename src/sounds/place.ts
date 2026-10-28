import { resampleSinc } from '../audio/quality/resample'
import { defaultStretch, detectBpm, renderTempoFollow, samplesAtBeat, tempoMapOf, timelineSamples } from '../audio/stretch/engine'
import type { StretchMode } from '../model/types'
import { uid, type AudioAsset, type AudioClip, type Project } from '../model/types'
import { decodeWavPCM } from '../model/wav'
import type { SoundEntry } from './types'

export function matchProjectRate(channels: Float32Array[], fromRate: number, toRate: number) {
  const lead = channels[0]
  if (!lead?.length || !(fromRate > 0) || !(toRate > 0) || fromRate === toRate) {
    return channels.map((channel) => Float32Array.from(channel))
  }
  const outLen = Math.max(1, Math.round(lead.length * (toRate / fromRate)))
  return channels.map((channel) => resampleSinc(channel.length === lead.length ? channel : fitLength(channel, lead.length), outLen, 96))
}

function fitLength(channel: Float32Array, length: number) {
  const out = new Float32Array(length)
  out.set(channel.subarray(0, Math.min(channel.length, length)))
  return out
}

/** Drums keep their attacks. Everything else uses the phase vocoder so pitch stays put. */
export function stretchModeFor(entry: SoundEntry): StretchMode {
  const tags = `${entry.name} ${entry.tags.join(' ')}`.toLowerCase()
  if (/\b(drum|kick|snare|hat|perc|beat|clap|shaker)\b/.test(tags)) return 'beats'
  return 'pro'
}

function beatAtSample(sample: number, project: Project) {
  const map = tempoMapOf(project.tempo, project.tempoMap, project.automation)
  const rate = project.sampleRate
  let lo = 0
  let hi = Math.max(1, (Math.max(0, sample) / rate) * (project.tempo / 60) + 8)
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (samplesAtBeat(mid, rate, project.tempo, map) < sample) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export function loopBpm(entry: SoundEntry, channel: Float32Array, sampleRate: number) {
  if (entry.type !== 'loop') return null
  if (entry.bpm && entry.bpm > 0) return entry.bpm
  return detectBpm(channel, sampleRate)
}

/**
 * Build the asset and clip for the playhead.
 * Loops follow the project tempo with the pitch-preserving stretch.
 */
export function placeSound(options: {
  entry: SoundEntry
  channels: Float32Array[]
  fileRate: number
  project: Project
  startSample: number
  bufferId?: string
  clipId?: string
}): { asset: AudioAsset; clip: AudioClip } | null {
  const rate = options.project.sampleRate
  const channels = matchProjectRate(options.channels, options.fileRate, rate)
  const lead = channels[0]
  if (!lead?.length) return null
  const bpm = loopBpm(options.entry, lead, rate)
  const mode = stretchModeFor(options.entry)
  const stretch = bpm
    ? { ...defaultStretch(lead.length, mode), followTempo: true, sourceBpm: bpm }
    : defaultStretch(lead.length, mode)
  const clip: AudioClip = {
    id: options.clipId || uid('clip'),
    name: options.entry.name,
    bufferId: options.bufferId || `lib_${options.entry.id}`,
    startSample: Math.max(0, Math.round(options.startSample)),
    offsetSamples: 0,
    durationSamples: lead.length,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'import',
    stretch,
  }
  if (stretch.followTempo) clip.durationSamples = timelineSamples(clip, options.project)
  return {
    asset: { id: clip.bufferId, name: options.entry.name, sampleRate: rate, channels },
    clip,
  }
}

/** Speaker preview. Loops are stretched to the project tempo before they play. */
export function previewChannelsFor(
  entry: SoundEntry,
  channels: Float32Array[],
  fileRate: number,
  project: Project,
  startSample = 0,
): Float32Array[] {
  const matched = matchProjectRate(channels, fileRate, project.sampleRate)
  const lead = matched[0]
  const bpm = lead ? loopBpm(entry, lead, project.sampleRate) : null
  if (!lead?.length || !bpm) return matched
  const map = tempoMapOf(project.tempo, project.tempoMap, project.automation)
  const startBeat = beatAtSample(startSample, project)
  const mode = stretchModeFor(entry)
  return matched.map((channel) => renderTempoFollow(channel, project.sampleRate, bpm, project.tempo, map, startBeat, mode))
}

export function audioTrackFor(project: Project, selectedId: string | null, droppedId?: string | null) {
  const audio = project.tracks.filter((track) => track.type === 'audio')
  if (droppedId && audio.some((track) => track.id === droppedId)) return droppedId
  if (selectedId && audio.some((track) => track.id === selectedId)) return selectedId
  return audio[0]?.id ?? null
}

export function trackIdFromDrop(target: { closest?: (selector: string) => { getAttribute(name: string): string | null } | null } | null) {
  return target?.closest?.('[data-track]')?.getAttribute('data-track') ?? null
}

export async function decodeSoundBytes(bytes: ArrayBuffer): Promise<{ sampleRate: number; channels: Float32Array[] }> {
  if (typeof AudioContext !== 'undefined') {
    const ctx = new AudioContext()
    try {
      const decoded = await ctx.decodeAudioData(bytes.slice(0))
      return {
        sampleRate: decoded.sampleRate,
        channels: Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice()),
      }
    } catch {
      /* fall through to the wav reader */
    } finally {
      await ctx.close().catch(() => undefined)
    }
  }
  const wav = decodeWavPCM(bytes)
  return { sampleRate: wav.sampleRate, channels: wav.channels }
}
