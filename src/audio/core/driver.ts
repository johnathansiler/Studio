/**
 * Web audio device policy. No DOM and no Web Audio types.
 * Native CoreAudio / Oboe still live in a later port. This is the browser
 * stand-in: which latencyHint to ask for, when a route change means a new
 * context, and how output latency shifts a recording.
 */

import { recordOffsetSamples } from '../../model/comp'
import { readStoredBufferHint, type BufferHint } from './buffer'

export type DeviceKind = 'ios-safari' | 'android-chrome' | 'desktop' | 'other'
export type AudioRoute = 'wired' | 'bluetooth' | 'speaker' | 'unknown'
export type RoutePlan = 'none' | 'resume' | 'rebuild'

export interface RouteSnapshot {
  sampleRate: number
  route: AudioRoute
  /** Seconds. `AudioContext.outputLatency`. */
  outputLatency: number
}

const BUFFER_SAMPLES: Record<BufferHint, number> = {
  interactive: 128,
  balanced: 256,
  playback: 1024,
}

/** A saved choice wins. Otherwise the phone or desktop default is used. */
export function initialBufferHint(storage: { getItem(key: string): string | null } | null, userAgent: string): BufferHint {
  return readStoredBufferHint(storage) ?? chooseBufferHint(deviceKind(userAgent), 'unknown')
}

export function deviceKind(userAgent: string): DeviceKind {
  const ua = userAgent || ''
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua))
  if (ios && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua)) return 'ios-safari'
  if (/Android/i.test(ua) && /Chrome/i.test(ua) && !/EdgA/i.test(ua)) return 'android-chrome'
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'desktop'
  return 'other'
}

/** Bluetooth needs a longer buffer. iOS Safari glitches on the smallest hint. */
export function chooseBufferHint(kind: DeviceKind, route: AudioRoute): BufferHint {
  if (route === 'bluetooth') return kind === 'android-chrome' ? 'balanced' : 'playback'
  if (kind === 'ios-safari') return 'balanced'
  if (kind === 'android-chrome') return 'interactive'
  return 'interactive'
}

export function bufferSamplesFor(hint: BufferHint) {
  return BUFFER_SAMPLES[hint]
}

export function routeOf(label: string): AudioRoute {
  const text = label.toLowerCase()
  if (!text.trim()) return 'unknown'
  if (/airpod|bluetooth|headset|buds|wh-|qc\d|bose|sony wh|jabra/.test(text)) return 'bluetooth'
  if (/headphone|earpod|wired|usb|jack|line out|focusrite|scarlett|interface/.test(text)) return 'wired'
  if (/speaker|receiver|handset|earpiece/.test(text)) return 'speaker'
  return 'unknown'
}

/**
 * A new sample rate or a wired/Bluetooth switch needs a new context.
 * A latency jump on the same route only needs resume.
 */
export function routeChangePlan(prev: RouteSnapshot | null, next: RouteSnapshot): RoutePlan {
  if (!prev || prev.sampleRate <= 0) return 'none'
  if (next.sampleRate > 0 && prev.sampleRate !== next.sampleRate) return 'rebuild'
  if (prev.route !== 'unknown' && next.route !== 'unknown' && prev.route !== next.route) return 'rebuild'
  if (Math.abs(prev.outputLatency - next.outputLatency) > 0.02) return 'resume'
  return 'none'
}

/** iOS will not leave `suspended` until the listener taps. */
export function resumeNeedsGesture(kind: DeviceKind, state: string, gesture: boolean) {
  return kind === 'ios-safari' && state === 'suspended' && !gesture
}

export function outputLatencySamples(outputLatencySec: number, sampleRate: number) {
  if (!Number.isFinite(outputLatencySec) || outputLatencySec <= 0 || sampleRate <= 0) return 0
  return Math.round(outputLatencySec * sampleRate)
}

/** Shift a take earlier by the graph block plus the device output latency. */
export function recordingAlignmentSamples(baseLatencySec: number, outputLatencySec: number, sampleRate: number) {
  return recordOffsetSamples(baseLatencySec, outputLatencySec, sampleRate)
}

/**
 * Plugin PDC plus the device output delay, for the monitoring clock.
 * The mix graph does not add this device delay as a DelayNode: that would
 * hold the speaker back by the hardware buffer a second time.
 */
export function monitoringSamples(graphSamples: number, outputLatencySec: number, sampleRate: number) {
  return Math.max(0, graphSamples) + outputLatencySamples(outputLatencySec, sampleRate)
}
