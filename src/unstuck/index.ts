/**
 * Unstuck. Pass a SongContext from analysis, or let deriveSongContext read the MIDI.
 * suggest() is local: transition weights, section form, and the chord library.
 */

export type {
  ArrangementOp,
  ChordBar,
  ContextTrack,
  MelodyNote,
  Mode,
  PartRole,
  SectionKind,
  SongContext,
  SongContextInput,
  SongSection,
  Suggestion,
  SuggestionKind,
  SuggestionNote,
  SuggestionPart,
  TrackRole,
} from './types'
export { deriveSongContext, editSpan, landingBeat, normalizeSongContext, roleOf, songContext } from './context'
export { normalizeSectionKind, spellToRoman } from './adapt'
export { suggest, suggestionsFor } from './suggest'
export { applySuggestion } from './apply'
export { audition, type AuditionNote } from './preview'
export { degreeKey, nextWeights, sectionWeights } from './theory'

/** Shown on the button and at the top of the sheet. */
export const UNSTUCK_BUTTON = 'Suggest the next chord, section, transition, or arrangement.'

export const UNSTUCK_TABS = [
  { id: 'progression', label: 'Next', description: 'Chord progressions that follow this song.' },
  { id: 'section', label: 'Section', description: 'What the next section could be, with chords.' },
  { id: 'transition', label: 'Move', description: 'A fill, riser, pickup, key change, or borrowed chord.' },
  { id: 'arrangement', label: 'Mix', description: 'Drop or add a part, switch to half-time, or break it down.' },
  { id: 'harmonize', label: 'Melody', description: 'Chords that fit the melody.' },
] as const
