import type { SamplerProgram } from '../audio/multisample/types'
import type { RollMemory } from './paint'
import type { QuantizePreset, QuantizeSettings, WarpPoint } from './quantize'
import type { OmniPatch } from '../instruments/patch/types'
import type { DevicePreset, RackAutomation, RackPatch, RackState } from './rack'
import type { GeneratorSettings } from '../generators/types'
import type { PlayerSettings } from '../players/types'
import { defaultScale, type ScaleState } from './scale'
import type { BeatRack, PatternClip } from './steps'

export type TrackType = 'audio' | 'midi' | 'bus' | 'group'
export type TrackInstrument = 'synth' | 'sampler' | '808' | 'drum-machine' | 'library' | 'none'

export function isLocalInput(input: string) {
  return input === 'mic' || input === 'line'
}

export interface SampleZone {
  id: string
  bufferId: string
  root: number
  lo: number
  hi: number
  loopStart: number
  loopEnd: number
  tune: number
  gain: number
  pan: number
  reverse: boolean
  choke: number
}

export interface SamplerState {
  bufferId: string
  start: number
  end: number
  loopStart: number
  loopEnd: number
  fadeIn: number
  fadeOut: number
  crossfade: number
  loopMode: number
  root: number
  slices: SampleZone[]
}

export interface LooperLayer {
  id: string
  bufferId: string
  gain: number
  mute: boolean
  reverse: boolean
  speed: number
}

export interface LooperState {
  layers: LooperLayer[]
  undone: LooperLayer[]
  sync: boolean
  bars: number
  feedback: number
  transport: number
  startBeat: number
  lengthSamples: number
}

export interface PluginInstance {
  id: string
  pluginId: string
  version: string
  enabled: boolean
  wet: number
  params: Record<string, number>
  /** Sidechain source track or bus id. Empty uses the plugin input. */
  sidechain: string
  sampler?: SamplerState
  looper?: LooperState
}

export interface Send {
  id: string
  busId: string
  gain: number
  preFader: boolean
  enabled: boolean
}

export interface AutomationPoint {
  beat: number
  value: number
}

export interface AutomationLane {
  id: string
  pluginId: string
  param: string
  points: AutomationPoint[]
}

export interface UserPreset {
  id: string
  pluginId: string
  name: string
  params: Record<string, number>
}
export type InsertType = 'eq' | 'compressor' | 'delay' | 'reverb'
export type ClipSource = 'local' | 'import' | 'demo' | 'guide' | 'aligned-take' | 'midi'
export type LaunchQuant = 'none' | '1/16' | '1/4' | '1bar' | '2bar' | '4bar'
export type LaunchMode = 'trigger' | 'gate' | 'toggle' | 'repeat'
export type FollowAction = 'none' | 'next' | 'prev' | 'any' | 'other' | 'stop'
export type StretchMode = 'pro' | 'beats' | 'tonal' | 'voice' | 'speech' | 'tape'

/** Source sample locked to a musical beat. Targets are beats from the clip start. */
export interface WarpMarker {
  id: string
  source: number
  target: number
}

/** Non-destructive time-stretch. Playback and export render from the source, never from a previous render. */
export interface ClipStretch {
  sourceSamples: number
  semitones: number
  cents: number
  mode: StretchMode
  /** Pitch shift keeps the spectral envelope. Voice and speech default to on. */
  formant?: boolean
  followTempo: boolean
  sourceBpm: number | null
  markers: WarpMarker[]
}

export interface TempoPoint {
  beat: number
  bpm: number
}

export interface Insert {
  id: string
  type: InsertType
  enabled: boolean
  params: Record<string, number>
}

export interface AudioClip {
  id: string
  name: string
  bufferId: string
  startSample: number
  offsetSamples: number
  durationSamples: number
  fadeInSamples: number
  fadeOutSamples: number
  gain: number
  source: ClipSource
  peerId?: string
  takeId?: string
  alignmentMs?: number
  quant?: LaunchQuant
  mode?: LaunchMode
  loop?: boolean
  legato?: boolean
  follow?: FollowAction
  followBeats?: number
  /** Tempo-follow. Missing means on when durationBeats is set. */
  warp?: boolean
  durationBeats?: number
  stretch?: ClipStretch
  /** Session slot only, until Capture copies it onto the arrangement. */
  slotOnly?: boolean
  /** Transient warp. Source samples map onto beats inside the clip. */
  warpPoints?: WarpPoint[]
  /** Swipe-comp take folder. Playback uses the active comp, not the parent buffer. */
  folder?: TakeFolder
}

/** One recorded pass inside a take folder. */
export interface TakeLane {
  id: string
  name: string
  bufferId: string
  offsetSamples: number
  startSample: number
  durationSamples: number
  peerId?: string
  takeId?: string
  source: ClipSource
}

export interface CompSegment {
  laneId: string
  startSample: number
  endSample: number
}

export interface SavedComp {
  id: string
  name: string
  segments: CompSegment[]
}

export interface TakeFolder {
  lanes: TakeLane[]
  comps: SavedComp[]
  activeCompId: string
  crossfadeSamples: number
}

export interface MidiNote {
  id: string
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  /** 0–1 chance this step plays. Omitted steps always play. */
  probability?: number
  condition?: 'always' | '1:2' | '1:4' | 'fill'
  /** Beats after the step grid. The sounding beat is the step plus this nudge. */
  nudge?: number
  /** Values applied only when playback lands on this step. */
  locks?: Record<string, number>
  velocityLo?: number
  velocityHi?: number
  muted?: boolean
  pan?: number
  fine?: number
  /** Slide into this note from the one still held. */
  slide?: boolean
}

export interface MidiTake {
  id: string
  name: string
  notes: MidiNote[]
}

export interface MidiClip {
  id: string
  name: string
  startBeat: number
  durationBeats: number
  notes: MidiNote[]
  quant?: LaunchQuant
  mode?: LaunchMode
  loop?: boolean
  legato?: boolean
  follow?: FollowAction
  followBeats?: number
  slotOnly?: boolean
  /** Live link to a beat pattern. Playback renders the pattern instead of notes. */
  patternId?: string
  /** Channel row that was sent to this clip. */
  channelId?: string
  /** Session scene. Unset clips stay on the arrangement. */
  scene?: number
  /** Earlier loop passes. The clip notes are the active pass. */
  takes?: MidiTake[]
  activeTakeId?: string
}

export interface RecordSettings {
  /** Cycle recording stacks a take lane per loop pass. */
  loop: boolean
  midiLoop: 'merge' | 'takes'
  punchEnabled: boolean
  punchIn: number
  punchOut: number
  preRoll: number
  postRoll: number
  rollUnit: 'bars' | 'seconds'
  /** One-shot punch that ignores pre-roll and stops at the out point. */
  quick: boolean
}

export type MidiFxKind = 'arp' | 'chord' | 'scale' | 'repeat' | 'humanize' | 'velocity'

/** One MIDI effect in the chain that sits in front of an instrument. */
export interface MidiFx {
  id: string
  kind: MidiFxKind
  enabled: boolean
  params: Record<string, number>
}

/** Hardware control bound to an on-screen target. Saved with the project. */
export interface MidiMapEntry {
  id: string
  target: string
  label: string
  source: 'cc' | 'note'
  /** -1 listens on every channel. */
  channel: number
  number: number
  min: number
  max: number
  mode: 'absolute' | 'toggle'
}

export interface MidiOutSettings {
  enabled: boolean
  /** Empty sends to every connected output. Otherwise a port id or name. */
  port: string
  channel: number
  clock: boolean
}

export interface LiveCaptureSettings {
  enabled: boolean
  bars: number
}

export interface Track {
  id: string
  name: string
  type: TrackType
  color: string
  volume: number
  pan: number
  mute: boolean
  solo: boolean
  armed: boolean
  monitor: boolean
  input: string
  /** 1 is mono, 2 is stereo. Audio tracks only. */
  channels?: 1 | 2
  /** Chosen instrument for a MIDI track. */
  instrument?: TrackInstrument
  /** Multi-sample program for a library instrument. PCM is not stored here. */
  library?: SamplerProgram
  inserts: Insert[]
  plugins: PluginInstance[]
  sends: Send[]
  /** Bus or group id. Null reaches the master, or the monitor bus for a remote input. */
  output: string | null
  /** Folder group that sums this track. Wins over output. */
  groupId: string | null
  clips: AudioClip[]
  midiClips: MidiClip[]
  /** Modular instrument rack. Present on instrument tracks. */
  rack?: RackState
  /** Layered synth/sample patch. Saved with the project. */
  omniPatch?: OmniPatch | null
  /** Scene index → clip id. Missing means scene N is clips[N]. */
  audioSlots?: (string | null)[]
  midiSlots?: (string | null)[]
  /** Effects that reshape notes before they reach the instrument. */
  midiFx?: MidiFx[]
}

/** Bump when saved documents change shape. migrateProject opens older numbers. */
export const SCHEMA_VERSION = 2

export interface Project {
  version: number
  id: string
  name: string
  sampleRate: number
  tempo: number
  timeSignature: { numerator: number; denominator: number }
  tracks: Track[]
  masterVolume: number
  masterInserts: Insert[]
  masterPlugins: PluginInstance[]
  automation: AutomationLane[]
  presets: UserPreset[]
  loopEnabled: boolean
  loopStartSample: number
  loopEndSample: number
  metronomeEnabled: boolean
  countIn: boolean
  snap: boolean
  devicePresets: DevicePreset[]
  rackPatches: RackPatch[]
  /** Named layered patches saved with this project. */
  omniLibrary?: OmniPatch[]
  /** Parameter lanes for devices in the modular rack. */
  rackAutomation: RackAutomation[]
  /** Global clip launch grid. A clip quant overrides it. */
  launchQuant?: LaunchQuant
  /** 0 records until stop. A positive count trims a session take to that many bars. */
  recordBars?: number
  /** Tempo changes. Empty keeps `tempo` for the whole arrangement. */
  tempoMap?: TempoPoint[]
  record?: RecordSettings
  /** Key, scale, and chord-pad performance settings. */
  scale?: ScaleState
  /** Last one-tap generator choices. The MIDI itself lives on the tracks. */
  generator?: GeneratorSettings
  /** Drummer and session-player choices. The MIDI itself lives on the tracks. */
  players?: PlayerSettings
  /** Musical grid for performed MIDI. 0 leaves the note where it was played. */
  quantizeBeats?: number
  /** `${kind}:${name}` factory and user presets marked in the browser. */
  presetFavorites?: string[]
  beats?: BeatRack
  patternClips?: PatternClip[]
  roll?: RollMemory
  quantize?: QuantizeSettings
  quantizePresets?: QuantizePreset[]
  /** Compact clip outlines so a guest can draw waveforms before the wav arrives. */
  waveforms?: Record<string, { min: number; max: number }[]>
  /** Pad banks, swing, and song chain for the drum deck. */
  padKit?: import('./padMachine').PadProgram
  /** Hardware CC and note bindings. One entry per on-screen control. */
  midiMaps?: MidiMapEntry[]
  /** Notes and clock sent to external gear. */
  midiOut?: MidiOutSettings
  /** Always-on performance buffer that can become a clip. */
  liveCapture?: LiveCaptureSettings
}

export interface AudioAsset {
  id: string
  name: string
  sampleRate: number
  channels: Float32Array[]
}

export const TRACK_COLORS = ['#ef6b6b', '#73c48f', '#79b8d4', '#e0b15a', '#c58be0', '#f09a6a']

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}`
}

export function defaultInsert(type: InsertType): Insert {
  const params: Record<InsertType, Record<string, number>> = {
    eq: { low: 0, mid: 0, midFreq: 1000, high: 0 },
    compressor: { threshold: -18, knee: 8, ratio: 3, attack: 0.003, release: 0.12, makeup: 0 },
    delay: { time: 0.22, feedback: 0.32, mix: 0.2 },
    reverb: { decay: 1.5, mix: 0.18 },
  }
  return { id: uid('ins'), type, enabled: true, params: { ...params[type] } }
}

export function makeTrack(partial: Partial<Track> & Pick<Track, 'name' | 'type'>): Track {
  return {
    id: uid('trk'),
    color: TRACK_COLORS[0],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    armed: false,
    monitor: false,
    input: partial.type === 'audio' ? 'mic' : 'none',
    inserts: [],
    plugins: [],
    sends: [],
    output: null,
    groupId: null,
    clips: [],
    midiClips: [],
    ...partial,
  }
}

export function createEmptyProject(sampleRate = 48000, name = 'Untitled session'): Project {
  const vocal = makeTrack({ name: 'Vocal', type: 'audio', color: TRACK_COLORS[0], armed: true, monitor: false })
  const music = makeTrack({ name: 'Music', type: 'audio', color: TRACK_COLORS[1], input: 'none' })
  const keys = makeTrack({ name: 'Keys', type: 'midi', color: TRACK_COLORS[2], input: 'none' })
  const bar = Math.round(sampleRate * 2) // 1 bar at 120bpm is 2s; tempo applied by caller via loop length
  return {
    version: SCHEMA_VERSION,
    id: uid('prj'),
    name,
    sampleRate,
    tempo: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    tracks: [vocal, music, keys],
    masterVolume: 0.9,
    masterInserts: [],
    masterPlugins: [],
    automation: [],
    presets: [],
    loopEnabled: false,
    loopStartSample: 0,
    loopEndSample: bar * 4,
    metronomeEnabled: true,
    countIn: true,
    snap: true,
    devicePresets: [],
    rackPatches: [],
    omniLibrary: [],
    rackAutomation: [],
    launchQuant: '1bar',
    recordBars: 4,
    record: defaultRecord(bar * 4),
    scale: defaultScale(),
    quantizeBeats: 0,
    presetFavorites: [],
  }
}

export function defaultRecord(span = 0): RecordSettings {
  return {
    loop: false,
    midiLoop: 'takes',
    punchEnabled: false,
    punchIn: 0,
    punchOut: span,
    preRoll: 1,
    postRoll: 1,
    rollUnit: 'bars',
    quick: false,
  }
}
