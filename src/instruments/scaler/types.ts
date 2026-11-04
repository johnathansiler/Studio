import type { ArpDirection, RhythmPattern, ScaleId } from '../../model/scale'
import type { VoicingId } from '../../theory/types'

export type VariationAmount = 'subtle' | 'medium' | 'major'
export type EvolveMode = 'off' | 'bar' | 'loop'
export type RecordSource = 'input' | 'output'

export type KeysLock = 'off' | 'scale-snap' | 'scale-hide' | 'chord' | 'chord-notes' | 'one-finger'
export type VoiceGroup = 'all' | 'bass' | 'upper' | 'dynamic'
export type ScalerOutput = 'audio' | 'midi' | 'both'
export type ScalerInput = 'midi' | 'audio'

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
    keysLock: 'off',
    performanceId: '',
    swing: 0,
    voiceGroup: 'all',
    output: 'both',
    input: 'midi',
    chordIndex: 0,
    variation: 'subtle',
    variationSeed: 1,
    variationLock: false,
    variationTakes: [],
    variationTake: 0,
    evolve: 'off',
    favorites: [],
    thru: false,
    recordSource: 'output',
    midiTo: [],
  }
}

/** Built-in instrument the pads play, or MIDI forwarded to another track. */
export type ScalerSound = 'synth' | 'sampler' | '808' | 'drum-machine' | 'library' | 'forward'

export type ScalerGroup = 'triad' | 'seventh' | 'ninth' | 'sus' | 'add' | 'altered'

export type ScalerPage = 'play' | 'key' | 'voice' | 'sound' | 'write'

export const SCALER_PAGES: { id: ScalerPage; label: string; hint: string }[] = [
  { id: 'play', label: 'Play', hint: 'Chord pads. Rec writes them as MIDI.' },
  { id: 'key', label: 'Key', hint: 'Key and scale for this track.' },
  { id: 'voice', label: 'Voice', hint: 'Voicing, bass, and how the chord is played.' },
  { id: 'sound', label: 'Sound', hint: 'Which instrument plays the chords.' },
  { id: 'write', label: 'Write', hint: 'Generate chords, bass, melody, arp, strum, or drums as MIDI.' },
]

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
  /** How piano keys, pads, the computer keyboard, and MIDI keys are interpreted. */
  keysLock: KeysLock
  /** Empty keeps the block chord. Otherwise a performance from the catalog. */
  performanceId: string
  swing: number
  voiceGroup: VoiceGroup
  /** Audio plays the instrument. MIDI sends the notes out. Both does each. */
  output: ScalerOutput
  /** Detect reads MIDI clips or an audio clip. */
  input: ScalerInput
  /** Pad the keys-lock chord modes follow. */
  chordIndex: number
  /** How far a new take may wander from the style. */
  variation: VariationAmount
  /** Seed of the take that is playing. Locked takes keep this in the project. */
  variationSeed: number
  variationLock: boolean
  /** Recent seeds, newest last. About eight. */
  variationTakes: number[]
  variationTake: number
  /** Off repeats the take. Bar and loop derive the next pass from the seed. */
  evolve: EvolveMode
  /** Performance, pack, and scale ids marked in the browser. */
  favorites: string[]
  /** Also send the note that came in, beside Scaler's output. */
  thru: boolean
  /** Record the keys that were played, or the notes Scaler generated. */
  recordSource: RecordSource
  /** Other tracks that also receive Scaler's notes. */
  midiTo: string[]
}

export interface ScalerNote {
  pitch: number
  fine?: number
  startBeat: number
  durationBeats: number
  velocity: number
}
