import { sliceNote, snapBeat } from '../model/paint'
import type { MidiNote } from '../model/types'

const MIN_BEAT = 1 / 16

interface NoteCommit {
  draft: (fn: () => void) => void
  endDraft: () => void
  project: { tracks: { id: string; midiClips: { id: string; notes: MidiNote[] }[] }[] }
}

export function commitMidiNotes(store: NoteCommit, trackId: string, clipId: string, notes: MidiNote[]) {
  store.draft(() => {
    const clip = store.project.tracks.find((track) => track.id === trackId)?.midiClips.find((item) => item.id === clipId)
    if (clip) clip.notes = notes.map((note) => ({ ...note }))
  })
  store.endDraft()
}

export function clampPitch(pitch: number) {
  return Math.max(0, Math.min(127, Math.round(pitch)))
}

function clampVelocity(velocity: number) {
  if (!Number.isFinite(velocity)) return 0.8
  return Math.max(0.05, Math.min(1, velocity))
}

export function hitNote(notes: readonly MidiNote[], beat: number, pitch: number): MidiNote | null {
  const row = Math.round(pitch)
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index]
    if (note.pitch !== row) continue
    if (beat + 1e-6 >= note.startBeat && beat <= note.startBeat + note.durationBeats + 1e-6) return note
  }
  return null
}

/** Draw one note. A click is one grid long; dragging either way sets the length. */
export function pencilNote(fromBeat: number, toBeat: number, pitch: number, grid: number, velocity: number, id: string): MidiNote {
  const anchor = snapBeat(Math.max(0, fromBeat), grid)
  const pointer = snapBeat(Math.max(0, toBeat), grid)
  const step = grid > 0 ? grid : MIN_BEAT
  const start = Math.min(anchor, pointer)
  const end = Math.max(anchor, pointer, start + step)
  return {
    id,
    pitch: clampPitch(pitch),
    startBeat: start,
    durationBeats: Math.max(step, end - start),
    velocity: clampVelocity(velocity),
  }
}

export function resizeNote(note: MidiNote, edge: 'start' | 'end', beat: number, grid: number): MidiNote {
  const step = grid > 0 ? grid : MIN_BEAT
  const end = note.startBeat + note.durationBeats
  if (edge === 'end') {
    const at = Math.max(note.startBeat + step, snapBeat(Math.max(0, beat), grid))
    return { ...note, durationBeats: at - note.startBeat }
  }
  const start = Math.max(0, Math.min(snapBeat(Math.max(0, beat), grid), end - step))
  return { ...note, startBeat: start, durationBeats: end - start }
}

/** Move a chord together. Time snaps as a group so the intervals stay put. */
export function moveNotes(
  notes: readonly MidiNote[],
  ids: readonly string[],
  deltaBeat: number,
  deltaPitch: number,
  grid: number,
  pitchSnap?: (pitch: number) => number,
): MidiNote[] {
  const moving = new Set(ids)
  const group = notes.filter((note) => moving.has(note.id))
  if (!group.length) return notes.slice()
  const origin = Math.min(...group.map((note) => note.startBeat))
  let delta = snapBeat(Math.max(0, origin + deltaBeat), grid) - origin
  if (origin + delta < 0) delta = -origin
  const steps = Math.round(deltaPitch)
  return notes.map((note) => {
    if (!moving.has(note.id)) return note
    const shifted = clampPitch(note.pitch + steps)
    const pitch = steps === 0 ? note.pitch : pitchSnap ? pitchSnap(shifted) : shifted
    return { ...note, startBeat: note.startBeat + delta, pitch }
  })
}

export function forkNotes(notes: readonly MidiNote[], ids: readonly string[], newId: () => string) {
  const wanted = new Set(ids)
  const copyIds: string[] = []
  const copies: MidiNote[] = []
  for (const note of notes) {
    if (!wanted.has(note.id)) continue
    const id = newId()
    copies.push({ ...note, id })
    copyIds.push(id)
  }
  return { notes: [...notes, ...copies], copyIds }
}

export function duplicateNotes(notes: readonly MidiNote[], ids: readonly string[], grid: number, newId: () => string) {
  const forked = forkNotes(notes, ids, newId)
  if (!forked.copyIds.length) return forked
  const selected = notes.filter((note) => ids.includes(note.id))
  const start = Math.min(...selected.map((note) => note.startBeat))
  const end = Math.max(...selected.map((note) => note.startBeat + note.durationBeats))
  const shift = Math.max(grid > 0 ? grid : MIN_BEAT, end - start)
  return { notes: moveNotes(forked.notes, forked.copyIds, shift, 0, grid), copyIds: forked.copyIds }
}

export function splitNotes(notes: readonly MidiNote[], id: string, atBeat: number, newId: string): MidiNote[] | null {
  let cut = false
  const next = notes.flatMap((note) => {
    if (note.id !== id) return [note]
    const parts = sliceNote(note, atBeat)
    if (!parts) return [note]
    cut = true
    return [parts[0], { ...parts[1], id: newId }]
  })
  return cut ? next : null
}

export function withoutNotes(notes: readonly MidiNote[], ids: readonly string[]) {
  const drop = new Set(ids)
  return notes.filter((note) => !drop.has(note.id))
}

export function notesInRect(notes: readonly MidiNote[], beatA: number, beatB: number, pitchA: number, pitchB: number) {
  const beat0 = Math.min(beatA, beatB)
  const beat1 = Math.max(beatA, beatB)
  const pitch0 = Math.min(pitchA, pitchB)
  const pitch1 = Math.max(pitchA, pitchB)
  return notes.filter((note) => {
    const end = note.startBeat + note.durationBeats
    return note.pitch >= pitch0 && note.pitch <= pitch1 && note.startBeat <= beat1 + 1e-6 && end >= beat0 - 1e-6
  }).map((note) => note.id)
}

export function paintVelocity(notes: readonly MidiNote[], ids: readonly string[], velocity: number) {
  const value = clampVelocity(velocity)
  const wanted = new Set(ids)
  return notes.map((note) => (wanted.has(note.id) ? { ...note, velocity: value } : note))
}

export function pinchZoom(pxBeat: number, row: number, factor: number) {
  const scale = Number.isFinite(factor) && factor > 0 ? factor : 1
  return {
    pxBeat: Math.min(220, Math.max(24, pxBeat * scale)),
    row: Math.min(44, Math.max(12, row * scale)),
  }
}
