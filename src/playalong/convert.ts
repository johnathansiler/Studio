/** Notes an editable MIDI clip can store. Polyphonic audio becomes chord tones plus the bass. */

import type { PlayScore } from './types'

export interface MidiDraft {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
}

export function notesForMidi(score: PlayScore): MidiDraft[] {
  if (score.kind === 'poly' && score.chords.length) {
    const notes: MidiDraft[] = []
    for (const chord of score.chords) {
      const tones = chord.tones.length ? chord.tones : chord.bass == null ? [] : [chord.bass]
      for (const tone of tones) {
        notes.push({
          pitch: Math.round(tone),
          startBeat: Math.max(0, chord.startBeat),
          durationBeats: Math.max(0.1, chord.durationBeats),
          velocity: 0.82,
        })
      }
    }
    return notes
  }
  return score.notes
    .filter((note) => note.velocity > 0)
    .map((note) => ({
      pitch: Math.round(note.pitch),
      startBeat: Math.max(0, note.startBeat),
      durationBeats: Math.max(0.05, note.durationBeats),
      velocity: Math.max(0.05, Math.min(1, note.velocity)),
    }))
}
