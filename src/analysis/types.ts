/** Shared result types for the Unstuck analysis module. */

export interface AnalysisKey {
  /** Pitch class. 0 is C, 11 is B. */
  root: number
  /** Spelling of the tonic, such as "F#". */
  name: string
  /** "major", "minor", or a mode name such as "dorian". */
  mode: string
  /** "C major", "A minor", "D dorian". */
  label: string
  /** Correlation of the pitch profile with the chosen key. 0 when there is no music. */
  confidence: number
}

export interface AnalysisChord {
  /** Zero-based bar index from the start of the analysis. */
  bar: number
  startBeat: number
  beats: number
  /** Chord symbol, such as "Am" or "G7". */
  symbol: string
  /** Pitch class of the chord root. */
  root: number
  confidence: number
}

export type SectionKind = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'breakdown' | 'outro' | 'section'

export interface AnalysisSection {
  kind: SectionKind
  /** "Intro", "Verse 2", "Chorus". */
  label: string
  /** Zero-based, inclusive. */
  startBar: number
  /** Zero-based, exclusive. */
  endBar: number
  startBeat: number
  endBeat: number
}

export interface AnalysisResult {
  key: AnalysisKey
  /** Scale id from the theory model, such as "ionian" or "aeolian". */
  scale: string
  chordsByBar: AnalysisChord[]
  sections: AnalysisSection[]
  /** Beats per minute. */
  tempo: number
}

export interface HumNote {
  /** MIDI note number. */
  pitch: number
  startBeat: number
  durationBeats: number
  /** 0–1. */
  velocity: number
  /** Tracked fundamental before semitone rounding, in hertz. */
  hz: number
  confidence: number
}

export interface TimeSig {
  numerator: number
  denominator: number
}

/** PCM the analyzers accept. One channel, or several channels mixed to mono. */
export interface AnalysisBuffer {
  sampleRate: number
  channels: ArrayLike<number> | ArrayLike<number>[]
  /** When set, bars follow this tempo instead of an estimate. */
  tempo?: number
  timeSignature?: TimeSig
}

export interface TranscribeOptions {
  /** Beats per minute. Falls back to the buffer tempo, then an estimate. */
  tempo?: number
  /**
   * Quantize note starts and lengths to this many quarter notes.
   * 0.25 is a sixteenth. 0 keeps the performed timing.
   */
  grid?: number
  minHz?: number
  maxHz?: number
  timeSignature?: TimeSig
}
