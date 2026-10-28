import type { MidiClip, MidiNote } from './types'
import { uid } from './types'

export function rectsHit(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

export function splitMidiClip(clip: MidiClip, atBeat: number): [MidiClip, MidiClip] | null {
  const at = atBeat
  const end = clip.startBeat + clip.durationBeats
  if (at <= clip.startBeat + 0.02 || at >= end - 0.02) return null
  const local = at - clip.startBeat
  const leftNotes = clip.notes.flatMap((note) => {
    if (note.startBeat >= local) return []
    const noteEnd = note.startBeat + note.durationBeats
    if (noteEnd <= local) return [note]
    return [{ ...note, durationBeats: Math.max(0.05, local - note.startBeat) }]
  })
  const rightNotes = clip.notes.flatMap((note) => {
    const noteEnd = note.startBeat + note.durationBeats
    if (noteEnd <= local) return []
    if (note.startBeat >= local) return [{ ...note, id: uid('note'), startBeat: note.startBeat - local }]
    return [{ ...note, id: uid('note'), startBeat: 0, durationBeats: Math.max(0.05, noteEnd - local) }]
  })
  const left: MidiClip = { ...clip, id: uid('midi'), durationBeats: local, notes: leftNotes }
  const right: MidiClip = {
    ...clip,
    id: uid('midi'),
    name: `${clip.name} b`,
    startBeat: at,
    durationBeats: clip.durationBeats - local,
    notes: rightNotes,
  }
  return [left, right]
}

export function trimMidiClip(clip: MidiClip, edge: 'start' | 'end', beat: number): MidiClip {
  const end = clip.startBeat + clip.durationBeats
  if (edge === 'start') {
    const start = Math.min(end - 0.25, Math.max(0, beat))
    const delta = start - clip.startBeat
    const duration = clip.durationBeats - delta
    const notes = clip.notes.flatMap((note) => {
      const noteEnd = note.startBeat + note.durationBeats - delta
      const startBeat = note.startBeat - delta
      if (noteEnd <= 0 || startBeat >= duration) return []
      const nextStart = Math.max(0, startBeat)
      return [{ ...note, startBeat: nextStart, durationBeats: Math.max(0.05, Math.min(duration, noteEnd) - nextStart) }]
    })
    return { ...clip, startBeat: start, durationBeats: duration, notes }
  }
  const duration = Math.max(0.25, beat - clip.startBeat)
  const notes = clip.notes.flatMap((note) => {
    if (note.startBeat >= duration) return []
    return [{ ...note, durationBeats: Math.max(0.05, Math.min(note.durationBeats, duration - note.startBeat)) }]
  })
  return { ...clip, durationBeats: duration, notes }
}

export function stretchMidiClip(clip: MidiClip, edge: 'start' | 'end', beat: number): MidiClip {
  const end = clip.startBeat + clip.durationBeats
  const start = edge === 'start' ? Math.min(end - 0.25, Math.max(0, beat)) : clip.startBeat
  const nextEnd = edge === 'end' ? Math.max(start + 0.25, beat) : end
  const duration = Math.max(0.25, nextEnd - start)
  const scale = clip.durationBeats > 0 ? duration / clip.durationBeats : 1
  const notes: MidiNote[] = clip.notes.map((note) => ({
    ...note,
    startBeat: note.startBeat * scale,
    durationBeats: Math.max(0.05, note.durationBeats * scale),
  }))
  return { ...clip, startBeat: start, durationBeats: duration, notes }
}
