/** Playhead math for the on-screen keyboard. The speaker is later than the audio clock. */

import { beatsToSamples, samplesToBeats } from '../model/time'

export interface TimedNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity?: number
  muted?: boolean
}

/** Samples the device output still has to play. The lights wait this long. */
export function latencySamples(outputLatencyMs: number, sampleRate: number) {
  if (!(outputLatencyMs > 0) || !(sampleRate > 0)) return 0
  return (outputLatencyMs / 1000) * sampleRate
}

/**
 * Timeline sample the listener is hearing.
 * While stopped, the edit playhead is the position. While playing, subtract
 * the output latency so a note lights when it comes out of the speaker.
 */
export function heardTimelineSample(visualSample: number, outputLatencySamples: number, playing: boolean) {
  const sample = Number.isFinite(visualSample) ? visualSample : 0
  if (!playing) return Math.max(0, sample)
  const lag = Number.isFinite(outputLatencySamples) ? Math.max(0, outputLatencySamples) : 0
  return Math.max(0, sample - lag)
}

export function beatAtSample(sample: number, sampleRate: number, tempo: number) {
  return samplesToBeats(Math.max(0, sample), sampleRate, Math.max(1, tempo))
}

export function sampleAtBeat(beat: number, sampleRate: number, tempo: number) {
  return beatsToSamples(Math.max(0, beat), sampleRate, Math.max(1, tempo))
}

/** Quarter-note position inside the clip. Null before the clip starts. */
export function clipLocalBeat(timelineBeat: number, clipStartBeat: number, durationBeats: number) {
  if (!Number.isFinite(timelineBeat) || !Number.isFinite(clipStartBeat)) return null
  const local = timelineBeat - clipStartBeat
  if (local < -0.001) return null
  if (durationBeats > 0 && local > durationBeats + 0.001) return null
  return Math.max(0, local)
}

/** Notes whose body covers this beat. A muted note stays dark. */
export function notesSounding<T extends TimedNote>(notes: T[], beat: number): T[] {
  if (!Number.isFinite(beat)) return []
  return notes.filter((note) => {
    if (note.muted) return false
    if (note.velocity != null && !(note.velocity > 0)) return false
    const start = note.startBeat
    const end = start + Math.max(0.02, note.durationBeats)
    return beat >= start - 1e-4 && beat < end - 1e-4
  })
}

/** Next or previous note attack. The ends wrap so the control always moves. */
export function stepTo(notes: { startBeat: number }[], beat: number, direction: 1 | -1): number | null {
  const starts = [...new Set(notes.map((note) => note.startBeat).filter((start) => Number.isFinite(start)))].sort((a, b) => a - b)
  if (!starts.length) return null
  if (direction > 0) {
    const next = starts.find((start) => start > beat + 1e-4)
    return next ?? starts[0]
  }
  for (let index = starts.length - 1; index >= 0; index--) {
    if (starts[index] < beat - 1e-4) return starts[index]
  }
  return starts[starts.length - 1]
}

/** Chord whose bar covers this beat. */
export function chordAt<T extends { startBeat: number; durationBeats: number }>(chords: T[], beat: number): T | null {
  if (!Number.isFinite(beat)) return null
  for (let index = chords.length - 1; index >= 0; index--) {
    const chord = chords[index]
    if (beat >= chord.startBeat - 1e-4 && beat < chord.startBeat + chord.durationBeats - 1e-4) return chord
  }
  return null
}

/** Loop the beats between A and B, in either order. */
export function sectionSamples(sampleRate: number, tempo: number, beatA: number, beatB: number) {
  const startBeat = Math.max(0, Math.min(beatA, beatB))
  const endBeat = Math.max(startBeat + 0.05, Math.max(beatA, beatB))
  const startSample = Math.round(sampleAtBeat(startBeat, sampleRate, tempo))
  const endSample = Math.max(startSample + 1, Math.round(sampleAtBeat(endBeat, sampleRate, tempo)))
  return { startBeat, endBeat, startSample, endSample }
}

/** How many source samples a slower practice rate needs. Pitch is not part of this. */
export function practiceLength(sourceLength: number, rate: number) {
  const speed = rate > 0 && rate < 1 ? rate : 1
  return Math.max(1, Math.round(sourceLength / speed))
}
