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
