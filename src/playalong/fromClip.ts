/** MIDI and pattern clips already know their notes. Audio goes through the worker. */

import { DRUM_PADS } from '../model/drums'
import { isDrumTrack, soundingNotes } from '../model/drumLanes'
import { renderPattern } from '../model/steps'
import type { MidiClip, Project, Track } from '../model/types'
import type { PlayNote, PlayScore } from './types'

export function drumName(pitch: number) {
  const found = DRUM_PADS.find((pad) => pad.pitch === Math.round(pitch))
  return found?.name ?? ''
}

function toPlay(note: { pitch: number; startBeat: number; durationBeats: number; velocity: number; muted?: boolean }, drums: boolean): PlayNote | null {
  if (note.muted || !(note.velocity > 0)) return null
  const pitch = Math.round(note.pitch)
  return {
    pitch,
    startBeat: note.startBeat,
    durationBeats: Math.max(0.02, note.durationBeats),
    velocity: note.velocity,
    confidence: 1,
    drum: drums ? drumName(pitch) || `Pad ${pitch}` : undefined,
  }
}

/** The notes a MIDI clip will sound, including swing, flam, and a key shift. */
export function scoreFromMidi(track: Track, clip: MidiClip): PlayScore {
  const drums = isDrumTrack(track)
  const shift = clip.keyShift?.semitones ?? 0
  const notes: PlayNote[] = []
  for (const note of soundingNotes(clip)) {
    const played = toPlay({ ...note, pitch: note.pitch + shift }, drums)
    if (played) notes.push(played)
  }
  return {
    kind: drums ? 'drums' : 'midi',
    approximate: false,
    confidence: notes.length ? 1 : 0,
    notes,
    chords: [],
    durationBeats: Math.max(0.25, clip.durationBeats),
  }
}

/** A placed step pattern, read as drum hits. */
export function scoreFromPattern(project: Project, patternId: string, lengthBeats: number): PlayScore | null {
  const pattern = project.beats?.patterns.find((item) => item.id === patternId)
  if (!pattern) return null
  const hits = renderPattern(pattern, 0, Math.max(0.25, lengthBeats))
  const notes: PlayNote[] = []
  for (const hit of hits) {
    const played = toPlay(hit, true)
    if (played) notes.push(played)
  }
  return {
    kind: 'drums',
    approximate: false,
    confidence: notes.length ? 1 : 0,
    notes,
    chords: [],
    durationBeats: Math.max(0.25, lengthBeats),
  }
}
