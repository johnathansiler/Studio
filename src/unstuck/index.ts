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

export { applySuggestion } from './apply'
export { type AuditionNote } from './preview'

export { applyUnstuckDraft } from './place'

export type { AmountId, FeelId, LengthId, MoodId, RoleId, StructureId, UnstuckBrief } from './brief'
export type { ComposeContext, SongDraft, UnstuckJob } from './draft'

/** Shown on the button and at the top of the sheet. */

