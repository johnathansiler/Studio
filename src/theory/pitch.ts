/** Pitch spelling in 12-tone and 24-tone equal temperament. Cents are relative to MIDI note 0. */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** Quarter-tone names. `Ed` is E half-flat, `C+` is C half-sharp. */
export const QUARTER_NAMES = [
  'C', 'C+', 'C#', 'Dd', 'D', 'D+', 'D#', 'Ed', 'E', 'E+', 'F', 'F+',
  'F#', 'Gd', 'G', 'G+', 'G#', 'Ad', 'A', 'A+', 'A#', 'Bd', 'B', 'B+',
] as const

export interface TunedPitch {
  /** Integer MIDI note the piano roll can sit on. */
  pitch: number
  /** Cents added to `pitch` when the note sounds. Usually −50, 0, or +50. */
  cents: number
}

export function mod(value: number, span: number) {
  return ((value % span) + span) % span
}

export function pitchClass(pitch: number) {
  return mod(Math.round(pitch), 12)
}

/** Fold a MIDI position into an integer note plus a cents offset of −50…+50. */
export function splitTuned(midi: number): TunedPitch {
  if (!Number.isFinite(midi)) return { pitch: 60, cents: 0 }
  let pitch = Math.round(midi)
  let cents = Math.round((midi - pitch) * 100)
  if (cents >= 100) {
    pitch += Math.floor(cents / 100)
    cents -= Math.floor(cents / 100) * 100
  } else if (cents <= -100) {
    const steps = Math.ceil(-cents / 100)
    pitch -= steps
    cents += steps * 100
  }
  if (cents > 50) {
    pitch += 1
    cents -= 100
  } else if (cents < -50) {
    pitch -= 1
    cents += 100
  }
  return { pitch, cents }
}

export function soundingMidi(note: TunedPitch) {
  return note.pitch + note.cents / 100
}

export function spellPitch(midi: number) {
  const cents = Math.round(mod(midi, 12) * 100)
  const step = mod(Math.round(cents / 50), 24)
  return QUARTER_NAMES[step]
}

export function spellOctave(midi: number) {
  return `${spellPitch(midi)}${Math.floor(midi / 12) - 1}`
}
