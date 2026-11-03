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
export { applyUnstuckDraft, arrangementEnd, collectRole, unstuckSpan } from './place'
export { composeUnstuck, pickTempo } from './compose'
export { readClip, complementRole } from './read'
export { varyNotes } from './vary'
export {
  AMOUNTS,
  FEELS,
  GENRES,
  LENGTHS,
  MAQAMS,
  MOODS,
  ROLES,
  SCALE_CHOICES,
  STRUCTURES,
  briefFromProject,
  defaultBrief,
  formOf,
  genreById,
  normalizeBrief,
  roleLabel,
} from './brief'
export type { AmountId, FeelId, LengthId, MoodId, RoleId, StructureId, UnstuckBrief } from './brief'
export type { ComposeContext, SongDraft, UnstuckJob } from './draft'

/** Shown on the button and at the top of the sheet. */
export const UNSTUCK_BUTTON = 'Pick a part, or write a full song. The MIDI stays editable.'

export const UNSTUCK_TABS = [
  { id: 'progression', label: 'Next', description: 'Chord progressions that follow this song.' },
  { id: 'section', label: 'Section', description: 'What the next section could be, with chords.' },
  { id: 'transition', label: 'Move', description: 'A fill, riser, pickup, key change, or borrowed chord.' },
  { id: 'arrangement', label: 'Mix', description: 'Drop or add a part, switch to half-time, or break it down.' },
  { id: 'harmonize', label: 'Melody', description: 'Chords that fit the melody.' },
] as const
