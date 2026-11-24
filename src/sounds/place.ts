import { isAacFile, readLameDelay, trimAacPriming, trimCodecPadding } from '../audio/codecTrim'
import { interactiveAudioContext } from '../audio/micTap'
import { normalizePeak } from '../audio/level'
import { bpmFromName, fitLoopBeats } from '../audio/loopSeam'
import { resampleSinc } from '../audio/quality/resample'
import { defaultStretch, detectBpm, timelineSamples } from '../audio/stretch/engine'
import type { StretchMode } from '../model/types'
import { quartersPerBar } from '../model/time'
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

/**
 * Drums keep their attacks. A pitched loop uses the phase vocoder so the note stays put.
 * An 808 bass is a note even when the file is also tagged beat, drum, kick, or BD.
 * Hats, snares, claps, shakers, cowbells, and tambourines stay on the beats stretcher,
 * including plurals and names like SHAKER1, and even when the kit is an 808.
 */
export function stretchModeFor(entry: SoundEntry): StretchMode {
  const hay = `${entry.name} ${entry.path} ${entry.category ?? ''} ${entry.tags.join(' ')}`.toLowerCase()
  if (attackLoop(hay)) return 'beats'
  if (/\b(bass|sub|tonal|pads?|keys|pianos?|vocals?|vox|melod(?:y|ies)|chords?)\b/.test(hay)) return 'pro'
  if (/808/.test(hay)) return 'pro'
  if (drumLoop(hay)) return 'beats'
  return 'pro'
}

/** A transient instrument. Checked before the 808 bass rule so a hat in an 808 kit stays a drum. */
function attackLoop(hay: string): boolean {
  if (/\b(hats?|snares?|claps?|shakers?|cymbals?|rims?|cowbells?|tambourines?)\b/.test(hay)) return true
  return /shaker/.test(hay)
}

/** Drum-machine and kit words, including the plurals the catalog actually uses. */
function drumLoop(hay: string): boolean {
  return /\b(drums?|kicks?|snares?|hats?|percussion|percs?|beats?|claps?|shakers?|cymbals?|rims?|toms?|cowbells?|tambourines?)\b/.test(hay)
}

/**
 * Tempo follow uses the catalog BPM only.
 * A loop with no BPM keeps its natural length unless the caller passes `conform`.
 */
export function loopBpm(entry: SoundEntry, channel?: Float32Array, sampleRate?: number, conform = false) {
  if (entry.type !== 'loop') return null
  if (entry.bpm && entry.bpm > 0) return entry.bpm
  const named = bpmFromName(`${entry.name} ${entry.path}`)
  if (named) return named
  if (conform && channel && sampleRate && sampleRate > 0) return detectBpm(channel, sampleRate)
  return null
}

/**
 * Build the asset and clip for the playhead.
 * A loop with a catalog tempo follows the song (Follow). The file tempo stays
 * on the clip so half, double, and lock can still change it. Preview playback
 * is separate and stays at the file tempo.
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
  const channels = normalizePeak(matchProjectRate(options.channels, options.fileRate, rate))
  const lead = channels[0]
  if (!lead?.length) return null
  const bpm = loopBpm(options.entry, lead, rate)
  const mode = stretchModeFor(options.entry)
  const stretch = bpm
    ? { ...defaultStretch(lead.length, mode), followTempo: true, tempoMode: 'follow' as const, sourceBpm: bpm }
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
  if (options.entry.type) clip.soundType = options.entry.type
  if (options.entry.category) clip.soundCategory = options.entry.category
  if (options.entry.role) clip.soundRole = options.entry.role
  if (options.entry.tags.length) clip.soundTags = [...options.entry.tags]
  if (options.entry.key) clip.soundKey = options.entry.key
  if (stretch.followTempo && stretch.sourceBpm) {
    const fit = fitLoopBeats({
      samples: lead.length,
      sampleRate: rate,
      bpm: stretch.sourceBpm,
      name: `${options.entry.name} ${options.entry.path}`,
      beatsPerBar: quartersPerBar(options.project.timeSignature),
    })
    if (fit) stretch.sourceBpm = fit.sourceBpm
    clip.durationSamples = timelineSamples(clip, options.project)
  }
  return {
    asset: { id: clip.bufferId, name: options.entry.name, sampleRate: rate, channels },
    clip,
  }
}

/**
 * Speaker preview at the file tempo.
 * Only the sample rate is fitted. Stretching a 105 BPM 808 to the song tempo
 * in the browser preview is what made the bass crunch. The clip on the track
 * follows the song; this button does not.
 */
export function previewChannelsFor(
  _entry: SoundEntry,
  channels: Float32Array[],
  fileRate: number,
  project: Project,
  _startSample = 0,
): Float32Array[] {
  void _entry
  void _startSample
  return matchProjectRate(channels, fileRate, project.sampleRate)
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

function isWav(bytes: ArrayBuffer) {
  if (bytes.byteLength < 12) return false
  const head = new Uint8Array(bytes, 0, 12)
  return head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
    && head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45
}

export async function decodeSoundBytes(bytes: ArrayBuffer): Promise<{ sampleRate: number; channels: Float32Array[] }> {
  if (isWav(bytes)) {
    try {
      const wav = decodeWavPCM(bytes)
      return { sampleRate: wav.sampleRate, channels: wav.channels }
    } catch {
      /* a WAV the reader does not know can still play through the browser decoder */
    }
  }
  if (typeof AudioContext !== 'undefined') {
    const ctx = interactiveAudioContext()
    try {
      const decoded = await ctx.decodeAudioData(bytes.slice(0))
      const raw = new Uint8Array(bytes)
      let channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice())
      const lame = readLameDelay(raw)
      if (lame) channels = trimCodecPadding(channels, lame.delay, lame.padding).map((channel) => Float32Array.from(channel) as unknown as Float32Array<ArrayBuffer>)
      else if (isAacFile(raw)) channels = trimAacPriming(channels, decoded.sampleRate).map((channel) => Float32Array.from(channel) as unknown as Float32Array<ArrayBuffer>)
      return { sampleRate: decoded.sampleRate, channels }
    } catch {
      /* fall through to the wav reader */
    } finally {
      await ctx.close().catch(() => undefined)
    }
  }
  const wav = decodeWavPCM(bytes)
  return { sampleRate: wav.sampleRate, channels: wav.channels }
}
