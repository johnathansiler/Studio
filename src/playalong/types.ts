/** What the play-along sheet draws. Beats are quarter notes inside the clip. */

export type PlayKind = 'midi' | 'mono' | 'poly' | 'drums'

export interface PlayNote {
  pitch: number
  startBeat: number
  durationBeats: number
  /** 0–1. */
  velocity: number
  /** 0–1. MIDI notes are 1. */
  confidence: number
  /** Drum pad name when this hit is unpitched. */
  drum?: string
}

export interface PlayChord {
  symbol: string
  /** Pitch class of the chord root. */
  root: number
  /** MIDI pitch of the bass, when one was heard. */
  bass: number | null
  startBeat: number
  durationBeats: number
  confidence: number
  /** MIDI pitches to light for this chord, bass included. */
  tones: number[]
}

export interface PlayScore {
  kind: PlayKind
  /** Audio transcription is an estimate. MIDI is the clip itself. */
  approximate: boolean
  /** 0–1 mean confidence of the notes or chords that were kept. */
  confidence: number
  notes: PlayNote[]
  chords: PlayChord[]
  /** Clip length in quarter notes. */
  durationBeats: number
}

export type PracticeRate = 0.5 | 0.75 | 1

export type NameMode = 'letters' | 'solfege'
