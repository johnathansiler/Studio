import { resampleSinc } from './quality/resample'
import type { AudioClip, ClipStretch } from '../model/types'

/** Input trim stays inside this range. 0 dB is unity. */
export const INPUT_GAIN_MIN = -24
export const INPUT_GAIN_MAX = 24

export function clampInputDb(db: number): number {
  if (!Number.isFinite(db)) return 0
  return Math.round(Math.min(INPUT_GAIN_MAX, Math.max(INPUT_GAIN_MIN, db)) * 10) / 10
}

export function inputGainLinear(db: number): number {
  return 10 ** (clampInputDb(db) / 20)
}

/** A recorded take. No tempo follow, no warp markers, no pitch. */
export function recordedStretch(sourceSamples: number): ClipStretch {
  return {
    sourceSamples: Math.max(1, Math.round(sourceSamples)),
    semitones: 0,
    cents: 0,
    mode: 'pro',
    followTempo: false,
    sourceBpm: null,
    markers: [],
  }
}

export function isRecordedClip(clip: { playback?: string } | null | undefined): boolean {
  return clip?.playback === 'recorded'
}

/**
 * Playback rate for a clip the scheduler is about to start.
 * A recorded take is always exactly 1. Anything else returns null and the
 * existing stretch / warp path decides.
 */
export function clipPlaybackRate(clip: { playback?: string } | null | undefined): number | null {
  return isRecordedClip(clip) ? 1 : null
}

/**
 * Fit captured PCM onto the project rate.
 * The worklet already ran at the AudioContext rate, so this is a no-op when
 * the context and the project agree. A mismatch is a real sample-rate
 * conversion: one second stays one second and a 440 Hz tone stays 440 Hz.
 */
export function fitRecordedChannels(channels: Float32Array[], fromRate: number, toRate: number): Float32Array[] {
  const lead = channels[0]
  if (!lead?.length || !(fromRate > 0) || !(toRate > 0) || Math.abs(fromRate - toRate) < 1) {
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

/** The clip fields a take needs so playback cannot stretch or follow tempo. */
export function recordedClipFields(sourceSamples: number, durationSamples = sourceSamples): Pick<AudioClip, 'playback' | 'stretch' | 'warp' | 'durationBeats' | 'durationSamples'> {
  const samples = Math.max(1, Math.round(sourceSamples))
  const duration = Math.max(1, Math.round(durationSamples))
  return {
    playback: 'recorded',
    warp: false,
    durationBeats: undefined,
    durationSamples: duration,
    stretch: recordedStretch(samples),
  }
}

/** True when the mic did not open at the AudioContext rate. */
export function captureRatesDiffer(contextRate: number, deviceRate: number | undefined | null): boolean {
  return typeof deviceRate === 'number' && deviceRate > 0 && contextRate > 0 && Math.abs(deviceRate - contextRate) >= 1
}

/**
 * Multiply one block by the input trim.
 * Samples may pass ±1. This is float PCM, so nothing is rounded or clipped.
 */
export function scaleBlock(samples: Float32Array, gainDb: number): Float32Array {
  const gain = inputGainLinear(gainDb)
  if (Math.abs(gain - 1) < 1e-8) return samples
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] || 0) * gain
  return out
}

export function scaleInPlace(samples: Float32Array, gainDb: number) {
  const gain = inputGainLinear(gainDb)
  if (Math.abs(gain - 1) < 1e-8) return
  for (let i = 0; i < samples.length; i++) samples[i] *= gain
}

export function concatFloats(chunks: Float32Array[]): Float32Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export interface AudioPlaneData {
  format?: string
  numberOfFrames: number
  numberOfChannels: number
  copyTo: (destination: Float32Array | Int16Array, options?: { planeIndex?: number }) => void
}

/**
 * Float PCM from a mic frame.
 * f32 stays f32. s16 is the device format, widened to float, never narrowed again.
 */
export function floatChannelsFromAudioData(data: AudioPlaneData): Float32Array[] {
  const frames = Math.max(0, Math.round(data.numberOfFrames))
  const count = Math.max(1, Math.round(data.numberOfChannels) || 1)
  if (!frames) return []
  const format = data.format || 'f32-planar'
  const words = format.includes('s16')
  const planar = format.includes('planar')
  if (words && !planar) {
    const interleaved = new Int16Array(frames * count)
    data.copyTo(interleaved)
    const channels = Array.from({ length: count }, () => new Float32Array(frames))
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < count; c++) channels[c][i] = interleaved[i * count + c] / 32768
    }
    return channels
  }
  if (words) {
    return Array.from({ length: count }, (_, plane) => {
      const planeWords = new Int16Array(frames)
      data.copyTo(planeWords, { planeIndex: plane })
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i++) out[i] = planeWords[i] / 32768
      return out
    })
  }
  if (!planar) {
    const interleaved = new Float32Array(frames * count)
    data.copyTo(interleaved)
    const channels = Array.from({ length: count }, () => new Float32Array(frames))
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < count; c++) channels[c][i] = interleaved[i * count + c] || 0
    }
    return channels
  }
  return Array.from({ length: count }, (_, plane) => {
    const out = new Float32Array(frames)
    data.copyTo(out, { planeIndex: plane })
    return out
  })
}

/**
 * Lay a high-quality resample onto the timeline of `reference`.
 * `reference` is the context-rate capture, used only to find the start.
 * The returned samples are `fitted`, shifted so a 440 Hz tone stays 440 Hz,
 * and the length matches `reference` so latency compensation does not move.
 */
export function alignTakeToReference(reference: Float32Array, fitted: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(1, reference.length))
  if (!fitted.length) return out
  const lag = correlationLag(reference, fitted)
  for (let i = 0; i < out.length; i++) {
    const j = i + lag
    if (j >= 0 && j < fitted.length) out[i] = fitted[j]
  }
  return out
}

function correlationLag(reference: Float32Array, fitted: Float32Array) {
  const window = Math.min(reference.length, fitted.length, 4096)
  const maxLag = Math.min(2400, Math.floor(window / 3))
  if (window < 64 || maxLag < 1) return 0
  let best = 0
  let bestLag = 0
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let acc = 0
    const start = Math.max(0, -lag)
    const end = Math.min(window, fitted.length - lag)
    for (let i = start; i < end; i += 4) acc += (reference[i] || 0) * (fitted[i + lag] || 0)
    if (acc > best) {
      best = acc
      bestLag = lag
    }
  }
  return best > 0 ? bestLag : 0
}

/** Peak and RMS of one block, after the track's input trim. */
export function measureInputLevel(samples: Float32Array, gainDb = 0): { peak: number; rms: number; clip: boolean } {
  const gain = inputGainLinear(gainDb)
  let peak = 0
  let sum = 0
  const n = samples.length || 1
  for (let i = 0; i < samples.length; i++) {
    const sample = (samples[i] || 0) * gain
    const mag = Math.abs(sample)
    if (mag > peak) peak = mag
    sum += sample * sample
  }
  return { peak, rms: Math.sqrt(sum / n), clip: peak >= 0.98 }
}
