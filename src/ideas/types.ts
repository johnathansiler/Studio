/** Shared shapes for the Ideas generator and Arrange variations. */

import type { GeneratorChord } from '../generators/types'

export const PART_ROLES = ['chords', 'bass', 'melody', 'drums'] as const

export type PartRole = (typeof PART_ROLES)[number]

export type VaryAmount = 'subtle' | 'medium' | 'bold'

export interface PartNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  fine?: number
  slide?: boolean
  /** Beats of human timing. Playback adds this to the grid. */
  nudge?: number
  /** A deliberate non-scale tone: an 808 approach or a passing bass note. */
  passing?: boolean
}

export interface EnsemblePart {
  role: PartRole
  name: string
  notes: PartNote[]
  salt: number
  locked: boolean
}

export interface Ensemble {
  seed: number
  key: number
  scaleId: string
  tempo: number
  genre: string
  bars: number
  beatsPerBar: number
  complexity: number
  energy: number
  swing: number
  /** Clip swing for straight genres. Swung genres already move the notes. */
  clipSwing: number
  chords: GeneratorChord[]
  parts: EnsemblePart[]
}

export interface EnsembleRequest {
  key: number
  scaleId: string
  tempo: number
  genre: string
  bars: number
  roles: PartRole[]
  /** 0 is triads. 1 keeps extensions and more motion. */
  complexity: number
  /** 0 is spare and quiet. 1 is full and loud. */
  energy: number
  /** 0 is straight. 1 is a deep swing. */
  swing: number
  seed: number
  beatsPerBar?: number
  /** Extra salt so one part can be rolled again. */
  salts?: Partial<Record<PartRole, number>>
  /** Notes a Lock keeps. Regenerate and a new seed leave these alone. */
  locked?: Partial<Record<PartRole, PartNote[]>>
  /** Progression the locked chords already spell, so bass and melody still follow them. */
  progression?: GeneratorChord[]
}
