/** Minimal input for every generator. The theory library can fill this later. */

export type GeneratorKind = 'chords' | 'bass' | 'melody' | 'arp' | 'rhythm' | 'drums'

export type ArpPattern = 'up' | 'down' | 'upDown' | 'downUp' | 'inside' | 'outside' | 'broken' | 'random'

export type StrumPattern = 'block' | 'down' | 'folk' | 'skank' | 'funk' | 'disco' | 'jazz' | 'tresillo' | 'rock' | 'afro' | 'gospel' | 'montuno'

/** A scale step from the tonic. `cents` is the microtonal offset on top of `semitones`. */
export type ScaleInterval = number | { semitones: number; cents?: number }

export interface GeneratorChord {
  pitches: number[]
  /** Cents per pitch, aligned with `pitches`. Omit for equal temperament. */
  cents?: number[]
  beats: number
  symbol?: string
  /** Root pitch class, when the voicing does not put the root on the bottom. */
  root?: number
}

export interface GeneratorOptions {
  arpPattern?: ArpPattern
  /** Step length in quarter-note beats. */
  rate?: number
  octaves?: number
  /** Note length as a fraction of the step. */
  gate?: number
  strum?: StrumPattern
}

export interface GeneratorInput {
  /** Tonic pitch class, 0–11. */
  key: number
  /** Id from the scale library (`src/theory`). Wins over `scale` when that id is registered. */
  scaleId?: string
  /** Intervals from the tonic, including cent offsets. Used when `scaleId` is not registered. */
  scale: ScaleInterval[]
  /** Chords the line should follow. Empty lets the generator write a progression. */
  chords: GeneratorChord[]
  tempo: number
  bars: number
  style: string
  seed: number
  /** 0 is the seed's main idea. Higher values are the Vary button. */
  variation?: number
  /** Quarter notes in a bar. 4/4 is 4, 6/8 is 3. */
  beatsPerBar?: number
  options?: GeneratorOptions
}

export interface GeneratedNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  /** Cents, -50…50. Playback already treats `fine` as cents. */
  fine?: number
  slide?: boolean
}

export interface GeneratedPart {
  kind: GeneratorKind
  name: string
  trackName: string
  instrument: 'synth' | '808' | 'drum-machine'
  notes: GeneratedNote[]
  /** The progression this part follows, voice-led and ready to reuse. */
  chords: GeneratorChord[]
  label: string
  bars: number
  seed: number
  variation: number
}

export interface GeneratorSettings {
  kind: GeneratorKind
  style: string
  bars: number
  seed: number
  variation: number
  arpPattern: ArpPattern
  rate: number
  octaves: number
  gate: number
  strum: StrumPattern
  chords: GeneratorChord[]
}
