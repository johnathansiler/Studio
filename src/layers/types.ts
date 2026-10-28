/** Layered patch model. A future multi-sample engine can register its own kind. */

export interface LayerParam {
  id: string
  name: string
  min: number
  max: number
  default: number
  unit: string
}

export type SynthEngine = 'analog' | 'wavetable' | 'fm'

export interface LayerSourceSpec {
  /** Builtin kinds are `synth`, `sample`, and `granular`. Registered factories may add more. */
  kind: string
  engine?: SynthEngine
  /** Project buffer id. Empty plays the built-in public-domain waveform. */
  bufferId?: string
  params: Record<string, number>
}

export interface LayerState {
  id: string
  name: string
  enabled: boolean
  source: LayerSourceSpec
  params: Record<string, number>
}

export const MOD_SOURCES = [
  { id: 'lfo1', name: 'LFO 1' },
  { id: 'lfo2', name: 'LFO 2' },
  { id: 'lfo3', name: 'LFO 3' },
  { id: 'lfo4', name: 'LFO 4' },
  { id: 'env1', name: 'Amp env' },
  { id: 'env2', name: 'Filter env' },
  { id: 'env3', name: 'Mod env' },
  { id: 'velocity', name: 'Velocity' },
  { id: 'modwheel', name: 'Mod wheel' },
  { id: 'aftertouch', name: 'Aftertouch' },
] as const

export type ModSourceId = (typeof MOD_SOURCES)[number]['id']

export interface ModRoute {
  id: string
  source: ModSourceId | string
  /** `layerId:cutoff`, `layerId:s:wave`, or `g:lfo1Rate`. */
  destination: string
  /** -1..1, as a fraction of the destination range. */
  amount: number
}

export interface MorphCorner {
  values: Record<string, number>
}

export interface LayerPatch {
  id: string
  name: string
  layers: LayerState[]
  routes: ModRoute[]
  /** A (0,0), B (1,0), C (0,1), D (1,1). */
  corners: MorphCorner[]
  xy: { x: number; y: number }
  modWheel: number
  aftertouch: number
  globals: Record<string, number>
  polyphony: number
}

const spec = (id: string, name: string, min: number, max: number, fallback: number, unit = ''): LayerParam => ({
  id, name, min, max, default: fallback, unit,
})

export const GLOBAL_PARAMS: LayerParam[] = [
  spec('master', 'Level', 0, 1, 0.75),
  spec('lfo1Rate', 'LFO 1', 0.02, 20, 0.25, 'Hz'),
  spec('lfo1Shape', 'LFO 1 shape', 0, 4, 0),
  spec('lfo2Rate', 'LFO 2', 0.02, 20, 0.8, 'Hz'),
  spec('lfo2Shape', 'LFO 2 shape', 0, 4, 0),
  spec('lfo3Rate', 'LFO 3', 0.02, 20, 2, 'Hz'),
  spec('lfo3Shape', 'LFO 3 shape', 0, 4, 1),
  spec('lfo4Rate', 'LFO 4', 0.02, 20, 5, 'Hz'),
  spec('lfo4Shape', 'LFO 4 shape', 0, 4, 3),
]

export const LAYER_PARAMS: LayerParam[] = [
  spec('level', 'Level', 0, 1, 0.7),
  spec('pan', 'Pan', -1, 1, 0),
  spec('tune', 'Tune', -24, 24, 0, 'st'),
  spec('fine', 'Fine', -100, 100, 0, 'ct'),
  spec('cutoff', 'Cutoff', 40, 16000, 8000, 'Hz'),
  spec('res', 'Res', 0, 0.95, 0.08),
  spec('filterMode', 'Filter', 0, 3, 0),
  spec('fAmt', 'F Env', -1, 1, 0),
  spec('attack', 'Attack', 0, 4000, 8, 'ms'),
  spec('decay', 'Decay', 5, 4000, 240, 'ms'),
  spec('sustain', 'Sustain', 0, 1, 0.75),
  spec('release', 'Release', 5, 8000, 320, 'ms'),
  spec('fAttack', 'F Atk', 0, 4000, 12, 'ms'),
  spec('fDecay', 'F Dec', 5, 4000, 280, 'ms'),
  spec('fSustain', 'F Sus', 0, 1, 0.3),
  spec('fRelease', 'F Rel', 5, 8000, 360, 'ms'),
  spec('mAttack', 'M Atk', 0, 4000, 10, 'ms'),
  spec('mDecay', 'M Dec', 5, 4000, 200, 'ms'),
  spec('mSustain', 'M Sus', 0, 1, 0.5),
  spec('mRelease', 'M Rel', 5, 8000, 280, 'ms'),
  spec('drive', 'Drive', 0, 1, 0),
  spec('chorus', 'Chorus', 0, 1, 0),
  spec('delay', 'Delay', 0, 1, 0),
  spec('delayTime', 'Time', 0.05, 0.9, 0.28, 's'),
  spec('feedback', 'Feedback', 0, 0.85, 0.3),
]

export const ANALOG_PARAMS: LayerParam[] = [
  spec('wave', 'Wave', 0, 5, 0),
  spec('detune', 'Detune', -40, 40, 6, 'ct'),
  spec('mix2', 'Osc 2', 0, 1, 0.2),
  spec('pw', 'Width', 0.05, 0.95, 0.5),
  spec('uni', 'Unison', 1, 4, 1),
]

export const WAVE_PARAMS: LayerParam[] = [
  spec('table', 'Table', 0, 4, 0),
  spec('position', 'Position', 0, 1, 0.2),
  spec('warp', 'Warp', 0, 3, 0),
  spec('warpAmt', 'Warp', 0, 1, 0),
  spec('uni', 'Unison', 1, 4, 1),
]

export const FM_PARAMS: LayerParam[] = [
  spec('ratio', 'Ratio', 0.5, 8, 2),
  spec('index', 'Index', 0, 6, 1.2),
  spec('algo', 'Algo', 0, 5, 0),
  spec('feedback', 'Feedback', 0, 1, 0),
]

export const SAMPLE_PARAMS: LayerParam[] = [
  spec('root', 'Root', 0, 127, 60),
  spec('tune', 'Tune', -24, 24, 0, 'st'),
  spec('loop', 'Loop', 0, 2, 0),
  spec('start', 'Start', 0, 1, 0),
  spec('end', 'End', 0, 1, 1),
  spec('crossfade', 'Fade', 0, 0.5, 0.02),
]

export const GRAIN_PARAMS: LayerParam[] = [
  spec('root', 'Root', 0, 127, 60),
  spec('pitch', 'Pitch', -24, 24, 0, 'st'),
  spec('size', 'Size', 10, 400, 80, 'ms'),
  spec('density', 'Density', 1, 40, 12, 'Hz'),
  spec('position', 'Position', 0, 1, 0.25),
  spec('spray', 'Spray', 0, 1, 0.12),
  spec('spread', 'Spread', 0, 1, 0.35),
  spec('reverse', 'Reverse', 0, 1, 0),
]

const extraParams = new Map<string, LayerParam[]>()

export function registerParamList(kind: string, params: LayerParam[]) {
  extraParams.set(kind, params.slice())
}

export function sourceKey(spec: LayerSourceSpec): string {
  if (spec.kind === 'synth') {
    if (spec.engine === 'wavetable') return 'synth:wavetable'
    if (spec.engine === 'fm') return 'synth:fm'
    return 'synth:analog'
  }
  return spec.kind || 'sample'
}

export function sourceParamList(spec: LayerSourceSpec): LayerParam[] {
  const key = sourceKey(spec)
  if (extraParams.has(key)) return extraParams.get(key) ?? []
  if (key === 'synth:wavetable') return WAVE_PARAMS
  if (key === 'synth:fm') return FM_PARAMS
  if (key === 'synth:analog') return ANALOG_PARAMS
  if (spec.kind === 'sample') return SAMPLE_PARAMS
  if (spec.kind === 'granular') return GRAIN_PARAMS
  return []
}

export function defaultParams(list: LayerParam[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of list) out[item.id] = item.default
  return out
}

export function flatGlobal(id: string) {
  return `g:${id}`
}

export function flatLayer(layerId: string, id: string) {
  return `${layerId}:${id}`
}

export function flatSource(layerId: string, id: string) {
  return `${layerId}:s:${id}`
}
