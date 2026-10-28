/** One-step note entry. Notes land on the cursor, then the cursor moves forward. */

import { quartersPerBar, type TimeSignature } from './time'
import type { MidiEditorMode, MidiEditorPrefs, MidiNote } from './types'

export const STEP_LENGTHS: { id: string; label: string; beats: number }[] = [
  { id: '1/32', label: '1/32', beats: 0.125 },
  { id: '1/16', label: '1/16', beats: 0.25 },
  { id: '1/16.', label: '1/16.', beats: 0.375 },
  { id: '1/8t', label: '1/8t', beats: 1 / 3 },
  { id: '1/8', label: '1/8', beats: 0.5 },
  { id: '1/8.', label: '1/8.', beats: 0.75 },
  { id: '1/4', label: '1/4', beats: 1 },
  { id: '1/4.', label: '1/4.', beats: 1.5 },
  { id: '1/2', label: '1/2', beats: 2 },
  { id: '1/1', label: '1/1', beats: 4 },
]

export const SCORE_DURATIONS: { id: string; label: string; beats: number }[] = [
  { id: '16', label: '1/16', beats: 0.25 },
  { id: '8', label: '1/8', beats: 0.5 },
  { id: '8.', label: '1/8.', beats: 0.75 },
  { id: '4', label: '1/4', beats: 1 },
  { id: '4.', label: '1/4.', beats: 1.5 },
  { id: '2', label: '1/2', beats: 2 },
  { id: '1', label: '1/1', beats: 4 },
]

const MODES: MidiEditorMode[] = ['roll', 'step', 'drums', 'score']

export interface StepTone {
  pitch: number
  velocity?: number
  fine?: number
}

export function defaultMidiEditor(): MidiEditorPrefs {
  return {
    mode: 'roll',
    step: 0.25,
    cursor: 0,
    tie: false,
    velocity: 0.8,
    octave: 0,
    scoreDuration: 1,
    page: 0,
    scorePage: 0,
  }
}

export function normalizeMidiEditor(value: Partial<MidiEditorPrefs> | undefined): MidiEditorPrefs {
  const base = defaultMidiEditor()
  if (!value) return base
  const mode = MODES.includes(value.mode as MidiEditorMode) ? (value.mode as MidiEditorMode) : base.mode
  return {
    mode,
    step: nearestStep(value.step ?? base.step),
    cursor: Number.isFinite(value.cursor) ? Math.max(0, value.cursor as number) : 0,
    tie: value.tie === true,
    velocity: clamp(value.velocity ?? base.velocity, 0.05, 1),
    octave: clamp(Math.round(value.octave ?? 0), -3, 3),
    scoreDuration: nearestScore(value.scoreDuration ?? base.scoreDuration),
    page: Math.max(0, Math.round(value.page ?? 0) || 0),
    scorePage: Math.max(0, Math.round(value.scorePage ?? 0) || 0),
  }
}

export function nearestStep(beats: number): number {
  if (!Number.isFinite(beats) || beats <= 0) return 0.25
  let best = STEP_LENGTHS[0]
  let err = Infinity
  for (const item of STEP_LENGTHS) {
    const next = Math.abs(item.beats - beats)
    if (next < err) {
      err = next
      best = item
    }
  }
  return best.beats
}

export function nearestScore(beats: number): number {
  if (!Number.isFinite(beats) || beats <= 0) return 1
  let best = SCORE_DURATIONS[3]
  let err = Infinity
  for (const item of SCORE_DURATIONS) {
    const next = Math.abs(item.beats - beats)
    if (next < err) {
      err = next
      best = item
    }
  }
  return best.beats
}

export interface StepPlace {
  notes: MidiNote[]
  cursor: number
  ids: string[]
}

/**
 * Write the held pitches at the cursor and advance one step.
 * With tie on, a pitch that already ends here grows instead of starting again.
 */
export function placeStep(
  notes: MidiNote[],
  cursor: number,
  tones: StepTone[],
  length: number,
  velocity: number,
  tie: boolean,
  id: () => string,
): StepPlace {
  const step = nearestStep(length)
  const at = Math.max(0, cursor)
  const next = notes.map((note) => ({ ...note }))
  const ids: string[] = []
  const seen = new Set<number>()
  for (const tone of tones) {
    const pitch = clamp(Math.round(tone.pitch), 0, 127)
    if (seen.has(pitch)) continue
    seen.add(pitch)
    const level = clamp(tone.velocity ?? velocity, 0.05, 1)
    if (tie) {
      const prev = [...next].reverse().find((note) => note.pitch === pitch && endsAt(note, at))
      if (prev) {
        prev.durationBeats += step
        ids.push(prev.id)
        continue
      }
    }
    const same = next.find((note) => note.pitch === pitch && Math.abs(note.startBeat - at) < 0.02)
    if (same) {
      same.durationBeats = step
      same.velocity = level
      if (tone.fine) same.fine = tone.fine
      else delete same.fine
      ids.push(same.id)
      continue
    }
    const made: MidiNote = { id: id(), pitch, startBeat: at, durationBeats: step, velocity: level }
    if (tone.fine) made.fine = tone.fine
    next.push(made)
    ids.push(made.id)
  }
  return { notes: next, cursor: at + step, ids }
}

/** Lengthen every note that ends on the cursor, then move ahead. */
export function tieHeld(notes: MidiNote[], cursor: number, length: number): { notes: MidiNote[]; cursor: number; tied: boolean } {
  const step = nearestStep(length)
  const at = Math.max(0, cursor)
  const ending = notes.filter((note) => endsAt(note, at))
  if (!ending.length) return { notes, cursor: at, tied: false }
  const ids = new Set(ending.map((note) => note.id))
  return {
    notes: notes.map((note) => (ids.has(note.id) ? { ...note, durationBeats: note.durationBeats + step } : note)),
    cursor: at + step,
    tied: true,
  }
}

/** Bar.beat for the step cursor, using the project time signature. */
export function stepPlace(beat: number, sig: TimeSignature): string {
  const barBeats = Math.max(0.25, quartersPerBar(sig))
  const safe = Math.max(0, beat)
  const bar = Math.floor(safe / barBeats) + 1
  const within = safe - (bar - 1) * barBeats
  const unit = 4 / Math.max(1, sig.denominator)
  const beatNo = Math.floor(within / unit + 1e-6) + 1
  return `${bar}.${beatNo}`
}

export function clearStep(notes: MidiNote[], cursor: number, length: number): MidiNote[] {
  const step = nearestStep(length)
  const at = Math.max(0, cursor)
  return notes.filter((note) => note.startBeat < at - 0.02 || note.startBeat >= at + step - 0.02)
}

function endsAt(note: MidiNote, beat: number) {
  return Math.abs(note.startBeat + note.durationBeats - beat) < 0.02
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
