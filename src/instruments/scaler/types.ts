import type { ArpDirection, RhythmPattern, ScaleId } from '../../model/scale'
import type { VoicingId } from '../../theory/types'

export function defaultScaler(): ScalerState {
  return {
    root: 0,
    scale: 'ionian',
    library: '',
    snap: false,
    group: 'triad',
    voicing: 'close',
    inversion: 0,
    voiceLead: true,
    bassDegree: null,
    arp: 'off',
    rate: 0.5,
    gate: 0.8,
    octaves: 1,
    rhythm: 'block',
    sound: 'synth',
    forwardTrackId: '',
    lastVoicing: [],
    lastCents: [],
  }
}

/** Built-in instrument the pads play, or MIDI forwarded to another track. */
export type ScalerSound = 'synth' | 'sampler' | '808' | 'drum-machine' | 'library' | 'forward'

export type ScalerGroup = 'triad' | 'seventh' | 'ninth' | 'sus' | 'add' | 'altered'

/** Chord instrument state stored on the track, not in a separate view. */
export interface ScalerState {
  root: number
  scale: ScaleId
  /** Catalog scale id. Empty uses `scale`. */
  library: string
  snap: boolean
  group: ScalerGroup
  voicing: VoicingId
  inversion: number
  voiceLead: boolean
  /** Scale degree held in the bass. Null keeps the chord root. */
  bassDegree: number | null
  arp: ArpDirection
  rate: number
  gate: number
  octaves: number
  rhythm: RhythmPattern
  sound: ScalerSound
  forwardTrackId: string
  lastVoicing: number[]
  lastCents: number[]
}

export interface ScalerNote {
  pitch: number
  fine?: number
  startBeat: number
  durationBeats: number
  velocity: number
}
