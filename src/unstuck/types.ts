/**
 * What Unstuck reads. The analysis module can build this later (key, chords,
 * sections, a hummed melody). Until then, `deriveSongContext` fills it from MIDI.
 */

export type Mode = 'major' | 'minor'

export type SectionKind =
  | 'intro'
  | 'verse'
  | 'pre-chorus'
  | 'chorus'
  | 'post-chorus'
  | 'bridge'
  | 'drop'
  | 'breakdown'
  | 'outro'

export type TrackRole = 'chords' | 'bass' | 'drums' | 'melody' | 'pad' | 'other'

export type SuggestionKind = 'progression' | 'section' | 'transition' | 'arrangement' | 'harmonize'

export interface ChordBar {
  /** Zero-based bar index. */
  bar: number
  /** Roman numeral when the key is known, otherwise a spelled name such as Am. */
  symbol: string
  /** Pitch class of the root, 0–11. */
  root?: number
  /** MIDI pitches actually sounding, when the source had them. */
  pitches?: number[]
  beats?: number
}

export interface SongSection {
  kind: SectionKind
  startBar: number
  bars: number
}

export interface MelodyNote {
  pitch: number
  /** Beats from the start of the song. */
  startBeat: number
  durationBeats: number
  velocity?: number
}

export interface ContextTrack {
  id: string
  name: string
  role: TrackRole
  muted: boolean
}

/**
 * Minimal input the other module can pass. Missing fields are filled by
 * `normalizeSongContext` (4/4, mode from the scale, a verse if no sections).
 */
export interface SongContextInput {
  key: number
  scale: string
  tempo: number
  chordsByBar?: ChordBar[]
  sections?: SongSection[]
  melodyNotes?: MelodyNote[]
  mode?: Mode
  beatsPerBar?: number
  playheadBeat?: number
  tracks?: ContextTrack[]
  /** Beats of music already on the timeline. Suggestions append after this. */
  contentEndBeat?: number
  activeRoles?: TrackRole[]
}

export interface SongContext {
  key: number
  scale: string
  mode: Mode
  tempo: number
  beatsPerBar: number
  chordsByBar: ChordBar[]
  sections: SongSection[]
  melodyNotes: MelodyNote[]
  playheadBeat: number
  tracks: ContextTrack[]
  contentEndBeat: number
  activeRoles: TrackRole[]
}

export interface SuggestionNote {
  pitch: number
  /** Beats from the suggestion's `startBeat`, not from the start of the song. */
  startBeat: number
  durationBeats: number
  velocity: number
}

export type PartRole = TrackRole | 'fill'

export interface SuggestionPart {
  role: PartRole
  notes: SuggestionNote[]
  /** False plays the part in the preview and does not write it. */
  write?: boolean
}

export interface ArrangementOp {
  /** Silence every note of these roles inside the span. */
  dropRoles?: TrackRole[]
  /** Silence these drum pitches (kick and snare) and leave hats. */
  dropPitches?: number[]
  /** Remove drum notes in the span and write the drum part instead. */
  replaceDrums?: boolean
}

export interface Suggestion {
  id: string
  kind: SuggestionKind
  title: string
  /** One sentence. */
  why: string
  /** Roman numerals or a short label, for the card. */
  line: string
  /** Timeline beat where the suggestion begins. */
  startBeat: number
  bars: number
  parts: SuggestionPart[]
  arrangement?: ArrangementOp
  /** Applied after the notes, so the next suggestion is in the new key. */
  modulation?: { key: number; mode: Mode; scale: string }
  /** `continue` plays the previous chord, then this. `arrange` plays the rewrite. */
  hear: 'continue' | 'arrange'
}
