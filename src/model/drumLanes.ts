/** Drum lanes over a MIDI clip. Hits stay on the sixteenth grid. Swing, flam, and rolls are applied when the clip plays. */

import { DRUM_PADS } from './drums'
import { noteName } from './scale'
import { clampSwing } from './steps'
import type { MidiNote } from './types'

export const DRUM_STEP = 0.25
export const FLAM_BEATS = 0.05
export const DRUM_PAGE = 16

export function isDrumTrack(track: { instrument?: string }): boolean {
  return track.instrument === 'drum-machine' || track.instrument === '808'
}

export function stepCount(durationBeats: number): number {
  if (!Number.isFinite(durationBeats) || durationBeats <= 0) return DRUM_PAGE
  return Math.max(DRUM_PAGE, Math.ceil((durationBeats - 1e-6) / DRUM_STEP))
}

export function drumRows(notes: { pitch: number }[]): { pitch: number; name: string }[] {
  const known = new Set(DRUM_PADS.map((pad) => pad.pitch))
  const extra = new Set<number>()
  for (const note of notes) {
    const pitch = Math.round(note.pitch)
    if (!known.has(pitch)) extra.add(pitch)
  }
  return [
    ...DRUM_PADS.map((pad) => ({ pitch: pad.pitch, name: pad.name })),
    ...[...extra].sort((a, b) => a - b).map((pitch) => ({ pitch, name: noteName(pitch) })),
  ]
}

export function hitAt(notes: MidiNote[], pitch: number, step: number): MidiNote | undefined {
  const beat = step * DRUM_STEP
  return notes.find((note) => note.pitch === pitch && Math.abs(note.startBeat - beat) < 0.02)
}

export function clampRoll(value: number): number {
  const rounded = Math.round(value)
  if (rounded >= 4) return 4
  if (rounded === 3) return 3
  if (rounded === 2) return 2
  return 1
}

/** Odd sixteenths move later by `swing` times one sixteenth. */
export function swingShift(startBeat: number, swing: number): number {
  const amount = clampSwing(swing)
  if (amount <= 0) return 0
  const step = Math.round(startBeat / DRUM_STEP)
  return step % 2 === 1 ? amount * DRUM_STEP : 0
}

/**
 * Notes the engine should play. A clip with no swing, flam, or roll is returned as-is.
 */
export function soundingNotes(clip: { notes: MidiNote[]; swing?: number }): MidiNote[] {
  const swing = clampSwing(clip.swing ?? 0)
  const articulated = swing > 0 || clip.notes.some((note) => note.flam || (note.roll ?? 1) > 1)
  if (!articulated) return clip.notes
  const out: MidiNote[] = []
  for (const note of clip.notes) {
    const start = note.startBeat + swingShift(note.startBeat, swing)
    const rolls = clampRoll(note.roll ?? 1)
    if (rolls > 1) {
      const span = Math.max(note.durationBeats, DRUM_STEP)
      const slice = span / rolls
      for (let index = 0; index < rolls; index++) {
        const at = start + index * slice
        if (note.flam && index === 0) out.push(grace(note, at))
        out.push(hit(note, at, Math.min(0.12, slice * 0.85), `${note.id}~${index}`))
      }
      continue
    }
    if (note.flam) out.push(grace(note, start))
    out.push(hit(note, start, note.durationBeats, note.id))
  }
  return out
}

function grace(note: MidiNote, start: number): MidiNote {
  return hit(note, Math.max(0, start - FLAM_BEATS), Math.min(0.04, note.durationBeats), `${note.id}~flam`, Math.max(0.05, note.velocity * 0.65))
}

function hit(note: MidiNote, startBeat: number, durationBeats: number, id: string, velocity = note.velocity): MidiNote {
  const copy: MidiNote = { ...note, id, startBeat, durationBeats, velocity }
  delete copy.flam
  delete copy.roll
  return copy
}
