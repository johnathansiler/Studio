/** Kontakt-style sample instrument. PCM lives in the sample bank, not in this object. */

export type LoopMode = 'none' | 'oneshot' | 'forward' | 'sustain' | 'pingpong'
export type SampleTrigger = 'attack' | 'release' | 'first' | 'legato'
export type RoundRobinMode = 'sequential' | 'random'

export interface SampleControl {
  id: string
  name: string
  /** One sentence shown next to the control. */
  description: string
  min: number
  max: number
  default: number
  unit: string
  step: number
}

export interface SampleZone {
  id: string
  sampleId: string
  root: number
  loKey: number
  hiKey: number
  /** MIDI velocity 0–127. */
  loVel: number
  hiVel: number
  /** Cents. */
  tune: number
  /** Linear amplitude. */
  gain: number
  /** -1 is left, 1 is right. */
  pan: number
  /** Source frames. `end` is exclusive. */
  start: number
  end: number
  loopStart: number
  loopEnd: number
  loopMode: LoopMode
  /** Loop crossfade in source frames. 0 lets the instrument control decide. */
  loopCrossfade: number
  /** Velocity fade-in width. Null follows the Vel fade control. */
  velFadeIn: number | null
  velFadeOut: number | null
  /** 1-based round-robin step. 0 means the zone is not in a cycle. */
  seqPosition: number
  seqLength: number
  articulation: string
  /** Empty plays in every microphone mix. */
  mic: string
  trigger: SampleTrigger
  /** Choke id. A new zone whose group matches another zone's offBy stops that voice. */
  group: number
  offBy: number
  /** Envelope overrides in seconds / linear sustain. Null uses the instrument controls. */
  attack: number | null
  decay: number | null
  sustain: number | null
  release: number | null
}

export interface Articulation {
  id: string
  name: string
  /** MIDI note that selects this articulation. -1 if it has no keyswitch. */
  keyswitch: number
  description: string
}

export interface MicPosition {
  id: string
  name: string
  gain: number
  description: string
}

export interface SampleInstrumentDef {
  id: string
  name: string
  zones: SampleZone[]
  articulations: Articulation[]
  mics: MicPosition[]
  defaultArticulation: string
  controls: SampleControl[]
}

/** Saved on the track. Sample audio is not in here; the bank keeps it. */
export interface SampleProgramState {
  def: SampleInstrumentDef
  values: Record<string, number>
  articulation: string
  revision: number
}

export interface SampleMeta {
  id: string
  sampleRate: number
  channels: number
  frames: number
  chunkFrames: number
}

export interface ZonePick {
  zone: SampleZone
  /** Linear amplitude, including the velocity layer and the zone gain. */
  gain: number
}
