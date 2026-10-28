import { uid, type MidiClip, type MidiNote, type Track } from '../../model/types'
import { normalizeScaler } from './model'
import type { ScalerNote } from './types'

export function clipFromNotes(notes: ScalerNote[], startBeat: number, name: string): MidiClip {
  const end = notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0.25)
  return {
    id: uid('midi'),
    name: name || 'Scaler',
    startBeat: Math.max(0, startBeat),
    durationBeats: Math.max(0.25, Math.ceil(end * 4) / 4),
    notes: notes.map((note) => toNote(note, note.startBeat)),
  }
}

/** Append a chord onto the open Scaler take, or start one at `startBeat`. */
export function recordOnto(track: Track, notes: ScalerNote[], startBeat: number): MidiClip {
  const open = track.midiClips.find((clip) => clip.name === 'Scaler' && startBeat >= clip.startBeat - 0.02 && startBeat <= clip.startBeat + clip.durationBeats + 0.02)
  if (!open) {
    const clip = clipFromNotes(notes, startBeat, 'Scaler')
    track.midiClips.push(clip)
    return clip
  }
  const rel = Math.max(0, startBeat - open.startBeat)
  for (const note of notes) open.notes.push(toNote(note, rel + note.startBeat))
  const end = open.notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), open.durationBeats)
  open.durationBeats = Math.max(open.durationBeats, Math.ceil(end * 4) / 4)
  return open
}

export function rememberVoice(track: Track, midi: number[], cents: number[]) {
  if (!track.scaler && track.instrument !== 'scaler') return
  const state = normalizeScaler(track.scaler)
  track.scaler = { ...state, lastVoicing: midi, lastCents: cents }
}

function toNote(note: ScalerNote, startBeat: number): MidiNote {
  return {
    id: uid('note'),
    pitch: Math.max(0, Math.min(127, Math.round(note.pitch))),
    startBeat,
    durationBeats: Math.max(0.05, note.durationBeats),
    velocity: Math.max(0.05, Math.min(1, note.velocity || 0.8)),
    ...(note.fine ? { fine: Math.max(-100, Math.min(100, Math.round(note.fine))) } : {}),
  }
}
