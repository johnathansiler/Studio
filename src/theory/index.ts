/**
 * Chord and scale library for CueHarbor.
 *
 * Generators (progression, bass, melody, arpeggio, rhythm, drums) should import
 * from here and stay out of the piano-roll UI. Everything in this module is
 * local data: no network, no model files.
 *
 * - `scales`, `scaleById`, `searchScales` — modes, jazz, blues, pentatonic, world, maqam
 * - `chords`, `spellChord`, `nameChord` — qualities, extensions, and quarter-tone names
 * - `voiceNotes` — inversions, drop-2/3, spread, shell, voice leading
 * - `chordsInKey`, `chordOnDegree`, `scaleDegreePitches`, `snapToScale` — in-key lookup
 *
 * Intervals are cents. 100 is a semitone. 50 is a quarter tone (24-EDO maqam).
 * `splitTuned` turns a fractional MIDI note into `{ pitch, cents }` for `MidiNote.fine`.
 */

export {
  NOTE_NAMES,
  QUARTER_NAMES,
  pitchClass,
  spellOctave,
  spellPitch,
  splitTuned,
  soundingMidi,
  type TunedPitch,
} from './pitch'
export {
  FAMILY_LABEL,
  SCALE_FAMILIES,
  SCALE_LIBRARY,
  TUNER_SCALE_COUNT,
  isMicrotonal,
  scaleById,
  scales,
  scalesInFamily,
  searchScales,
  semitoneIntervals,
  type ScaleFamily,
  type ScaleId,
  type ScaleSpec,
} from './scales'
export {
  chordById,
  chords,
  chordsInGroup,
  nameChord,
  nameTunedChord,
  spellChord,
  tunedNotes,
  type ChordGroup,
  type ChordSpec,
  type SpelledChord,
} from './chords'
export {
  movement,
  voiceNotes,
  type VoicingId,
  type VoicingOptions,
} from './voicing'
export {
  chordOnDegree,
  chordsInKey,
  scaleDegreePitches,
  type ChordSet,
  type KeyChord,
} from './inkey'
export {
  centsOffScale,
  inScale,
  nearQuarter,
  snapToScale,
} from './fit'
