import { planAudioRoutes, planMidiRoutes } from './midiTools'
import type { Track } from './types'

export type TransportPhase = 'stopped' | 'playing' | 'recording' | 'counting-in'

export interface TransportSpan {
  loopEnabled: boolean
  loopStartSample: number
  loopEndSample: number
}

/** Where Play begins. Inside the loop, the playhead wins. Outside it, the loop start does. */
export function playOriginSample(project: TransportSpan, playhead: number): number {
  const head = Math.max(0, Math.round(playhead))
  if (!project.loopEnabled) return head
  const start = Math.max(0, Math.round(project.loopStartSample))
  const end = Math.max(start + 1, Math.round(project.loopEndSample))
  if (head < start || head >= end) return start
  return head
}

/** Bar 1, or the loop start while the loop is on. */
export function homeSample(project: TransportSpan): number {
  if (!project.loopEnabled) return 0
  return Math.max(0, Math.round(project.loopStartSample))
}

export type PlayPress =
  | { action: 'start'; sample: number }
  | { action: 'pause' }
  | { action: 'ignore' }

/**
 * Play starts from the playhead. Pressing it again pauses and leaves the playhead.
 * Recording is ended with Record or Stop, so Play does not restart a take.
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

export type RecordPress = 'stop' | 'start' | 'empty'

export function recordPress(phase: TransportPhase, tracks: Track[]): RecordPress {
  if (phase === 'recording' || phase === 'counting-in') return 'stop'
  return hasArmedRecord(tracks) ? 'start' : 'empty'
}
