/** Typed theory API. Generators can import these types without loading the scale catalog. */

export interface Tone {
  /** Integer MIDI note. */
  midi: number
  /** Cents away from that MIDI note. Quarter tones use ±50. */
  cents: number
}

export interface ScaleSpec {
  id: string
  name: string
  family: string
  /** Cents above the tonic, ascending, in [0, 1200). The octave is not repeated. */
  cents: number[]
  description: string
}

export type ChordGroup =
  | 'triad'
  | 'sixth'
  | 'seventh'
  | 'ninth'
  | 'eleventh'
  | 'thirteenth'
  | 'altered'
  | 'sus'
  | 'add'
  | 'quartal'
  | 'cluster'

export interface ChordSpec {
  id: string
  name: string
  /** Written after the root, such as "m7" or "sus4". Empty for a major triad. */
  suffix: string
  /** Intervals in cents from the root. */
  cents: number[]
  group: ChordGroup
  description: string
}

export interface SpelledChord {
  id: string
  symbol: string
  rootPc: number
  bassPc: number
  tones: Tone[]
  degree?: number
  roman?: string
}

export interface DiatonicChord {
  degree: number
  roman: string
  chordId: string
  symbol: string
  tones: Tone[]
  /** Cents of each chord tone above the chord root. */
  intervals: number[]
}

export interface ScaleChord extends DiatonicChord {
  /** 1 when every chord tone is a scale degree. */
  fit: number
}

export type VoicingId = 'close' | 'drop2' | 'drop3' | 'drop24' | 'spread' | 'shell' | 'rootless' | 'quartal' | 'cluster'

export interface VoicingSpec {
  id: VoicingId
  name: string
  description: string
}

export interface Detection {
  root: number
  scaleId: string
  name: string
  score: number
}

export interface TheoryProgression {
  id: string
  name: string
  description: string
  /** Preferred cents of each chord root above the tonic. */
  targets: number[]
}

export interface RealizedChord {
  symbol: string
  roman: string
  degree: number
  beats: number
  tones: Tone[]
}

export interface WeightedPitch {
  midi: number
  cents?: number
  weight?: number
}
