import { renderClipChannels, sourceSamplesOf } from '../audio/stretch/engine'
import { formantPitchChannels } from '../audio/stretch/formantPitch'
import { channelPrint, formantPitchKey, readFormantPitch, writeFormantPitch } from '../audio/stretch/pitchCache'
import { monoMix } from './mix'
import { clipDeniesKey, detectKey, detectTempo, hearingOf, unnamedKey } from './clipKey'
import type { AudioClip, ClipHearing, Project, TempoPoint } from '../model/types'

export interface ClipDetectRequest {
  id: number
  type: 'clip-detect'
  sampleRate: number
  channels: Float32Array[]
  clip: AudioClip
  tempo: number
  tempoMap?: TempoPoint[]
  automation?: Project['automation']
}

export interface ClipDetectResponse {
  id: number
  type: 'result' | 'error'
  hearing?: ClipHearing
  message?: string
}

function windowed(clip: AudioClip, channels: Float32Array[]) {
  const source = sourceSamplesOf(clip)
  const offset = Math.max(0, clip.offsetSamples || 0)
  const available = Math.max(0, (channels[0]?.length ?? 0) - offset)
  const length = Math.max(1, Math.min(source, available))
  if (length >= source - 1 && length >= available - 1) return { clip, channels }
  const sliced = channels.map((channel) => Float32Array.from(channel.subarray(offset, offset + length)))
  const ratio = length / Math.max(1, source)
  const next: AudioClip = {
    ...clip,
    offsetSamples: 0,
    durationSamples: Math.max(1, Math.round((clip.durationSamples || length) * ratio)),
    stretch: clip.stretch
      ? { ...clip.stretch, sourceSamples: length, markers: [] }
      : undefined,
  }
  return { clip: next, channels: sliced }
}

/** Render the clip the way it sounds, then read key from that and tempo from the source. */
export function handleClipDetect(message: ClipDetectRequest): ClipDetectResponse {
  try {
    const sampleRate = message.sampleRate || 48000
    const opened = windowed(message.clip, message.channels ?? [])
    const project = {
      tempo: message.tempo || 120,
      sampleRate,
      tempoMap: message.tempoMap,
      automation: message.automation,
    } as Project
    const sourceLen = sourceSamplesOf(opened.clip)
    const offset = Math.max(0, opened.clip.offsetSamples || 0)
    const sourceChannels = opened.channels.map((channel) => channel.subarray(offset, Math.min(channel.length, offset + sourceLen)))
    const source = monoMix(sourceChannels)
    warmFormantPitch(opened.channels, opened.clip, sampleRate)
    const sounded = monoMix(renderClipChannels(opened.channels, opened.clip, project, 'hq'))
    const key = clipDeniesKey(opened.clip) ? unnamedKey() : detectKey(sounded, sampleRate)
    const hearing = hearingOf(key, detectTempo(source, sampleRate))
    return { id: message.id, type: 'result', hearing }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Detection failed'
    return { id: message.id, type: 'error', message: messageText }
  }
}

/** Detect hears the shifted pitch, the same render playback caches as float PCM. */
function warmFormantPitch(channels: Float32Array[], clip: AudioClip, sampleRate: number) {
  const stretch = clip.stretch
  if (!stretch?.formant || !(stretch.semitones || stretch.cents)) return
  if (stretch.mode !== 'pro' && stretch.mode !== 'tonal') return
  const offset = Math.max(0, clip.offsetSamples || 0)
  const source = Math.max(1, stretch.sourceSamples || channels[0]?.length || 1)
  const sliced = channels.map((channel) => Float32Array.from(channel.subarray(offset, Math.min(channel.length, offset + source))))
  const length = sliced[0]?.length ?? 0
  if (length < 8) return
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
  if (readFormantPitch(key)) return
  writeFormantPitch(key, formantPitchChannels(sliced, sampleRate, {
    semitones: stretch.semitones,
    cents: stretch.cents,
    formant: true,
  }))
}

const scope = globalThis as { postMessage?: (data: unknown, transfer?: Transferable[]) => void; onmessage?: ((event: MessageEvent<ClipDetectRequest>) => void) | null }
const inWorker = typeof window === 'undefined' && typeof scope.postMessage === 'function' && typeof document === 'undefined'

if (inWorker) {
  scope.onmessage = (event: MessageEvent<ClipDetectRequest>) => {
    const response = handleClipDetect(event.data)
    scope.postMessage?.(response)
  }
}
