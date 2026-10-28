/**
 * Theory core for generators and the scale library.
 *
 * Scales are cent offsets from the tonic: 100 is one semitone, 150 is a quarter tone above a semitone.
 * Built-in Western scales are registered immediately. `loadScaleCatalog()` adds ragas, maqamat,
 * Turkish makam, Persian dastgah, and the rest as a separate chunk.
 *
 * Chords, diatonic harmonization, chord-in-scale lookup, voicings, and voice leading are synchronous
 * and work for any scale that is already registered.
 */
export type {
  Tone,
  ScaleSpec,
  ChordSpec,
  ChordGroup,
  SpelledChord,
  DiatonicChord,
  ScaleChord,
  VoicingId,
  VoicingSpec,
  Detection,
  TheoryProgression,
  RealizedChord,
  WeightedPitch,
} from './types'

export {
  FAMILY_INFO,
  allScales,
  findScale,
  getScale,
  registerScales,
  scaleFamilies,
  scalesInFamily,
  isTwelveTone,
  spellScale,
  snapToScale,
  toneInScale,
  degreeTone,
  nearestDegree,
  rotateCents,
} from './scales'

export {
  CHORDS,
  listChords,
  getChord,
  spellChord,
  withBass,
  nameIntervals,
  romanNumeral,
  harmonize,
  chordsInScale,
} from './chords'

export { VOICINGS, voiceTones, voiceLead, movementCents, type VoiceOptions } from './voice'

export { detectScale } from './detect'

export { progressionsFor, realizeProgression } from './progress'

export { loadScaleCatalog, catalogLoaded } from './catalog'

export {
  isBuiltinScale,
  nearestBuiltin,
  scaleIsMicrotonal,
  lockedTone,
  suggestKey,
  pitchRole,
  type LockState,
  type KeySuggestion,
} from './lock'

export { NOTE_NAMES, toneName, toneFromCents, absoluteCents, pitchClassName } from './pitch'
