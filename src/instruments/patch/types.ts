/** Omnisphere-style patch sitting on top of the synths and the sampler. */

export const MAX_LAYERS = 4
export const MAX_ROUTES = 8

export type LayerKind = 'analog' | 'wavetable' | 'fm' | 'sampler' | 'granular'

export type ModSourceId = 'lfo1' | 'lfo2' | 'env1' | 'env2' | 'velocity' | 'aftertouch' | 'modwheel' | 'x' | 'y'

export interface GranularSettings {
  /** 0–1 read position inside the audio. */
  position: number
  /** Grain length in milliseconds. */
  size: number
  /** Grains started per second. */
  density: number
  /** 0–1 random spread around the position. */
  spray: number
  /** Semitones, before the note transpose. */
  pitch: number
  /** Hold the read position instead of scanning. */
  freeze: boolean
}

export interface PatchLayer {
  id: string
  kind: LayerKind
  enabled: boolean
  keyLo: number
  keyHi: number
  velLo: number
  velHi: number
  level: number
  pan: number
  cutoff: number
  resonance: number
  /** 0 lowpass, 1 highpass, 2 bandpass. */
  filterMode: number
  fxSend: number
  bufferId: string
  /** MIDI note that plays the audio at its recorded pitch. */
  root: number
  granular: GranularSettings
  params: Record<string, number>
}

export interface ModRoute {
  id: string
  source: ModSourceId
  /** `layer:<index>:<field>` */
  target: string
  /** -1…1. Negative flips the source. */
  depth: number
}

/** Numeric snapshot a morph corner stores. Kinds and audio files stay on the layer. */
export interface LayerNumbers {
  enabled: number
  keyLo: number
  keyHi: number
  velLo: number
  velHi: number
  level: number
  pan: number
  cutoff: number
  resonance: number
  filterMode: number
  fxSend: number
  root: number
  position: number
  size: number
  density: number
  spray: number
  pitch: number
  freeze: number
  params: Record<string, number>
}

export interface PatchNumbers {
  layers: LayerNumbers[]
  routes: number[]
  lfo1Rate: number
  lfo2Rate: number
  env1Attack: number
  env1Decay: number
  env1Sustain: number
  env1Release: number
  env2Attack: number
  env2Decay: number
  env2Sustain: number
  env2Release: number
}

export interface MorphCorner {
  id: string
  name: string
  captured: boolean
  values: PatchNumbers
}

export interface OmniPatch {
  id: string
  name: string
  /** While on, arrangement notes play this patch instead of the rack. */
  enabled: boolean
  layers: PatchLayer[]
  routes: ModRoute[]
  lfo1Rate: number
  lfo2Rate: number
  env1Attack: number
  env1Decay: number
  env1Sustain: number
  env1Release: number
  env2Attack: number
  env2Decay: number
  env2Sustain: number
  env2Release: number
  modWheel: number
  aftertouch: number
  morph: {
    x: number
    y: number
    corners: [MorphCorner, MorphCorner, MorphCorner, MorphCorner]
  }
}

export interface FieldRange {
  min: number
  max: number
}

export const FIELD_RANGE: Record<string, FieldRange> = {
  level: { min: 0, max: 1 },
  pan: { min: -1, max: 1 },
  cutoff: { min: 40, max: 16000 },
  resonance: { min: 0, max: 0.92 },
  fxSend: { min: 0, max: 1 },
  position: { min: 0, max: 1 },
  size: { min: 10, max: 400 },
  density: { min: 1, max: 40 },
  spray: { min: 0, max: 1 },
  pitch: { min: -24, max: 24 },
  keyLo: { min: 0, max: 127 },
  keyHi: { min: 0, max: 127 },
  velLo: { min: 0, max: 1 },
  velHi: { min: 0, max: 1 },
  root: { min: 0, max: 127 },
  filterMode: { min: 0, max: 2 },
}

export const BIPOLAR_SOURCES = new Set<ModSourceId>(['lfo1', 'lfo2', 'x', 'y'])

export const MOD_SOURCES: { id: ModSourceId; name: string; hint: string }[] = [
  { id: 'lfo1', name: 'LFO 1', hint: 'A repeating cycle. Slow rates wobble; fast rates buzz.' },
  { id: 'lfo2', name: 'LFO 2', hint: 'A second cycle, independent of LFO 1.' },
  { id: 'env1', name: 'Env 1', hint: 'Opens with the note, then settles and fades.' },
  { id: 'env2', name: 'Env 2', hint: 'A second envelope with its own shape.' },
  { id: 'velocity', name: 'Velocity', hint: 'How hard the note was played.' },
  { id: 'aftertouch', name: 'Aftertouch', hint: 'Pressure while the note is held.' },
  { id: 'modwheel', name: 'Mod wheel', hint: 'The wheel saved on this patch.' },
  { id: 'x', name: 'Pad X', hint: 'Horizontal position of the morph pad.' },
  { id: 'y', name: 'Pad Y', hint: 'Vertical position of the morph pad.' },
]

/** Short descriptions for every control the patch UI adds. */
export const CONTROL_HELP: Record<string, string> = {
  name: 'Name of this patch. Save stores it in the project.',
  enabled: 'The patch plays instead of the rack while this is on.',
  kind: 'Sound source for this layer: analog, wavetable, FM, sampler, or grains.',
  layerOn: 'Silence this layer without deleting it.',
  level: 'How loud this layer is against the others.',
  pan: 'Places the layer left or right.',
  cutoff: 'Filter brightness. Lower values sound darker.',
  resonance: 'Boosts the sound right at the cutoff.',
  filterMode: 'Lowpass keeps lows, highpass keeps highs, bandpass keeps the middle.',
  fxSend: 'How much of this layer feeds the patch delay and reverb.',
  keyLo: 'Lowest note this layer will play.',
  keyHi: 'Highest note this layer will play.',
  velLo: 'Softest hit that opens this layer.',
  velHi: 'Hardest hit that still opens this layer.',
  root: 'The note that plays the audio at its recorded pitch.',
  buffer: 'Audio already in this project. Nothing is downloaded.',
  position: 'Where grains read inside the audio.',
  size: 'Length of each grain, in milliseconds.',
  density: 'How many grains start each second.',
  spray: 'Random spread around the grain position.',
  pitch: 'Grain pitch in semitones, before the note.',
  freeze: 'Holds the read position. Off lets it travel through the audio.',
  source: 'What moves the target: a cycle, an envelope, or a performance control.',
  target: 'Which layer, grain, or filter setting this route moves.',
  depth: 'How far the source pushes the target. Negative flips the direction.',
  lfo1: 'Speed of the first cycle, in hertz.',
  lfo2: 'Speed of the second cycle, in hertz.',
  envAttack: 'How fast the envelope opens after a note.',
  envRelease: 'How fast the envelope closes after you let go.',
  modwheel: 'Wheel amount saved with the patch. Routes can listen to it.',
  aftertouch: 'Pressure amount. Use it when the keys do not send aftertouch.',
  morph: 'Blends the four corner sounds. Drag with a finger.',
  corner: 'Stores the sound you hear into this corner of the pad.',
  addLayer: 'Adds another sound. A patch holds up to four layers.',
  addRoute: 'Adds a modulation route from a source to a setting.',
  tabLayers: 'Each layer is a synth or audio. Up to four sound together.',
  tabGrain: 'Grains play any audio already loaded in the project.',
  tabMod: 'Route a source onto a layer, grain, or filter setting.',
  tabXY: 'Drag to blend the four saved sounds of this patch.',
}

export function controlHelp(id: string) {
  return CONTROL_HELP[id] || ''
}

export const LAYER_KINDS: { id: LayerKind; name: string }[] = [
  { id: 'analog', name: 'Analog' },
  { id: 'wavetable', name: 'Wavetable' },
  { id: 'fm', name: 'FM' },
  { id: 'sampler', name: 'Sampler' },
  { id: 'granular', name: 'Grains' },
]

export const MORPH_PARAM_KEYS = ['wave1', 'detune', 'attack', 'release', 'sustain', 'position', 'table', 'index', 'ratio', 'feedback'] as const
