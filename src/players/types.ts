/** Choices for the virtual drummer and the bass and keys players. Saved with the project. */

export interface PlayerSettings {
  style: string
  /** 0 is the sparse arrangement. 1 is the busiest. 0.5 follows each section. */
  complexity: number
  /** 0 is quiet. 1 is the full velocity of the generated part. */
  loudness: number
  /** 0 leaves the groove. 1 adds the generator's end-of-section roll. */
  fills: number
  /** Inclusive, zero-based. */
  startBar: number
  /** Exclusive. */
  endBar: number
  /** Shape the drummer from analyzed intro, verse, and chorus. */
  followSections: boolean
  drummer: boolean
  bass: boolean
  keys: boolean
  seed: number
}

export type PlayerRole = 'drums' | 'bass' | 'keys'

export type ChordSource = 'track' | 'idea' | 'memory' | 'detected' | 'style'

export interface SessionNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  fine?: number
  slide?: boolean
}

export interface SessionPart {
  role: PlayerRole
  trackName: string
  clipName: string
  color: string
  instrument: 'synth' | '808' | 'drum-machine'
  startBeat: number
  durationBeats: number
  notes: SessionNote[]
}

export interface SessionBuild {
  parts: SessionPart[]
  source: ChordSource
  /** Short line for the sheet, such as "Chord track · C Am F G". */
  summary: string
}
