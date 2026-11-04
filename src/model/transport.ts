import { planAudioRoutes, planMidiRoutes } from './midiTools'
import type { Track } from './types'

export type TransportPhase = 'stopped' | 'playing' | 'recording' | 'counting-in'

export interface TransportSpan {
  loopEnabled: boolean
  loopStartSample: number
  loopEndSample: number
}

/** Where Play begins. Resume from the current playhead, even outside the loop. */
export function playOriginSample(_project: TransportSpan, playhead: number): number {
  return Math.max(0, Math.round(playhead))
}

/** Bar 1. Start always uses time 0, whether or not the loop is on. */
export function homeSample(_project: TransportSpan): number {
  return 0
}

export type StartPress = { action: 'roll'; sample: 0 } | { action: 'park'; sample: 0 }

/**
 * Start moves the playhead to bar 1 and keeps the transport state.
 * Playing and recording keep rolling from the top. Stopped stays stopped.
 */
export function startPress(phase: TransportPhase): StartPress {
  if (phase === 'playing' || phase === 'recording' || phase === 'counting-in') return { action: 'roll', sample: 0 }
  return { action: 'park', sample: 0 }
}

export type PlayPress =
  | { action: 'start'; sample: number }
  | { action: 'pause' }
  | { action: 'ignore' }

/**
 * Play resumes from the playhead. Pressing it again pauses and leaves the playhead.
 * It does not jump to bar 1 or the loop start. Recording is ended with Record or Stop.
 */
export function playPress(phase: TransportPhase, project: TransportSpan, playhead: number): PlayPress {
  if (phase === 'counting-in' || phase === 'recording') return { action: 'ignore' }
  if (phase === 'playing') return { action: 'pause' }
  return { action: 'start', sample: playOriginSample(project, playhead) }
}

export type StopPress = { action: 'halt' } | { action: 'home'; sample: number }

/** The first Stop halts audio and keeps the playhead. The next Stop returns home. */
export function stopPress(phase: TransportPhase, project: TransportSpan, playhead: number): StopPress {
  if (phase === 'playing' || phase === 'recording' || phase === 'counting-in') return { action: 'halt' }
  const home = homeSample(project)
  if (Math.round(playhead) === home) return { action: 'halt' }
  return { action: 'home', sample: home }
}

export function returnSample(project: TransportSpan): number {
  return homeSample(project)
}

export interface RecordPlan {
  audio: string[]
  midi: string[]
}

/** Armed tracks only. An unarmed Vocal, or any other idle track, is not a target. */
export function armedRecordPlan(tracks: Track[]): RecordPlan {
  return {
    audio: planAudioRoutes(tracks).map((route) => route.trackId),
    midi: planMidiRoutes(tracks).map((route) => route.trackId),
  }
}

export function hasArmedRecord(tracks: Track[]): boolean {
  const plan = armedRecordPlan(tracks)
  return plan.audio.length + plan.midi.length > 0
}

export type RecordPress = 'stop' | 'start' | 'arm' | 'disarm'

/**
 * Record arms global record. With an armed track it also starts capture.
 * A second press before anything is armed clears that standby.
 * Play does not record unless this standby is already on.
 */
export function recordPress(phase: TransportPhase, tracks: Track[], globalArmed = false): RecordPress {
  if (phase === 'recording' || phase === 'counting-in') return 'stop'
  if (!hasArmedRecord(tracks)) return globalArmed ? 'disarm' : 'arm'
  return 'start'
}

/** The next Play captures only when Record is already armed and a track is armed. */
export function playStartsCapture(phase: TransportPhase, globalArmed: boolean, tracks: Track[]): boolean {
  return phase === 'stopped' && globalArmed && hasArmedRecord(tracks)
}

/** Lit only while samples or notes are actually being captured. Count-in and Play stay dark. */
export function recordButtonOn(phase: TransportPhase): boolean {
  return phase === 'recording'
}
