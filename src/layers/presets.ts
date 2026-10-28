import { uid, type Track } from '../model/types'
import { flattenPatch } from './matrix'
import {
  ANALOG_PARAMS,
  FM_PARAMS,
  GLOBAL_PARAMS,
  GRAIN_PARAMS,
  LAYER_PARAMS,
  SAMPLE_PARAMS,
  WAVE_PARAMS,
  defaultParams,
  flatLayer,
  flatSource,
  type LayerPatch,
  type LayerSourceSpec,
  type LayerState,
  type ModRoute,
  type SynthEngine,
} from './types'

export const STARTERS = [
  { id: 'glass-pad', name: 'Glass Pad' },
  { id: 'fm-stack', name: 'FM Stack' },
  { id: 'grain-cloud', name: 'Grain Cloud' },
  { id: 'duo-morph', name: 'Duo Morph' },
] as const

export function makeLayer(
  name: string,
  kind: string,
  engine: SynthEngine | undefined,
  params: Record<string, number>,
  source: Record<string, number>,
  bufferId = '',
): LayerState {
  const spec: LayerSourceSpec = { kind, engine, bufferId, params: { ...sourceDefaults(kind, engine), ...source } }
  return {
    id: uid('lyr'),
    name,
    enabled: true,
    source: spec,
    params: { ...defaultParams(LAYER_PARAMS), ...params },
  }
}

function sourceDefaults(kind: string, engine?: SynthEngine) {
  if (kind === 'granular') return defaultParams(GRAIN_PARAMS)
  if (kind === 'sample') return defaultParams(SAMPLE_PARAMS)
  if (engine === 'wavetable') return defaultParams(WAVE_PARAMS)
  if (engine === 'fm') return defaultParams(FM_PARAMS)
  return defaultParams(ANALOG_PARAMS)
}

function blankPatch(name: string, layers: LayerState[], routes: ModRoute[], globals: Record<string, number> = {}): LayerPatch {
  return {
    id: uid('lpatch'),
    name,
    layers,
    routes,
    corners: [],
    xy: { x: 0, y: 0 },
    modWheel: 0,
    aftertouch: 0,
    globals: { ...defaultParams(GLOBAL_PARAMS), ...globals },
    polyphony: 8,
  }
}

function bake(patch: LayerPatch, edits: Record<string, number>[]) {
  const base = flattenPatch(patch)
  patch.corners = [0, 1, 2, 3].map((index) => ({ values: { ...base, ...(edits[index] ?? {}) } }))
  return patch
}

function route(source: string, destination: string, amount: number): ModRoute {
  return { id: uid('mod'), source, destination, amount }
}

export function starterPatch(id: string): LayerPatch {
  if (id === 'fm-stack') return fmStack()
  if (id === 'grain-cloud') return grainCloud()
  if (id === 'duo-morph') return duoMorph()
  return glassPad()
}

function glassPad() {
  const air = makeLayer('Air', 'synth', 'wavetable', {
    level: 0.55, attack: 280, decay: 600, sustain: 0.8, release: 900, cutoff: 3200, res: 0.16, chorus: 0.22,
  }, { table: 3, position: 0.35, uni: 2 })
  const drift = makeLayer('Drift', 'synth', 'analog', {
    level: 0.34, attack: 160, decay: 400, sustain: 0.7, release: 700, cutoff: 1800, res: 0.12,
  }, { wave: 0, mix2: 0.4, detune: 8, uni: 2 })
  const patch = blankPatch('Glass Pad', [air, drift], [
    route('lfo1', flatLayer(air.id, 'cutoff'), 0.22),
    route('env2', flatLayer(air.id, 'cutoff'), 0.14),
    route('velocity', flatLayer(drift.id, 'level'), 0.25),
  ], { lfo1Rate: 0.15, lfo1Shape: 0 })
  air.params.fAttack = 40
  air.params.fDecay = 500
  air.params.fSustain = 0.4
  return bake(patch, [
    {},
    { [flatLayer(air.id, 'cutoff')]: 640, [flatLayer(drift.id, 'cutoff')]: 420, [flatLayer(air.id, 'chorus')]: 0 },
    { [flatLayer(air.id, 'level')]: 0.28, [flatLayer(drift.id, 'level')]: 0.62, [flatSource(drift.id, 'detune')]: 18 },
    { [flatSource(air.id, 'position')]: 0.9, [flatLayer(air.id, 'chorus')]: 0.45, [flatLayer(drift.id, 'cutoff')]: 900 },
  ])
}

function fmStack() {
  const bell = makeLayer('Bell', 'synth', 'fm', {
    level: 0.5, attack: 4, decay: 420, sustain: 0.15, release: 500, cutoff: 6400, res: 0.08,
  }, { ratio: 3.5, index: 1.6, algo: 0, feedback: 0.05 })
  const body = makeLayer('Body', 'synth', 'analog', {
    level: 0.28, attack: 6, decay: 280, sustain: 0.4, release: 360, cutoff: 2200,
  }, { wave: 4, mix2: 0, detune: 0, uni: 1 })
  const patch = blankPatch('FM Stack', [bell, body], [
    route('velocity', flatSource(bell.id, 'index'), 0.4),
    route('env2', flatLayer(bell.id, 'cutoff'), 0.28),
    route('modwheel', flatSource(bell.id, 'index'), 0.22),
  ], { lfo1Rate: 0.4 })
  bell.params.fAttack = 2
  bell.params.fDecay = 280
  bell.params.fSustain = 0.2
  return bake(patch, [
    {},
    { [flatSource(bell.id, 'ratio')]: 1, [flatSource(bell.id, 'index')]: 2.8, [flatLayer(bell.id, 'cutoff')]: 1400 },
    { [flatLayer(body.id, 'level')]: 0.55, [flatLayer(bell.id, 'level')]: 0.22 },
    { [flatLayer(bell.id, 'cutoff')]: 900, [flatLayer(body.id, 'cutoff')]: 700, [flatSource(bell.id, 'feedback')]: 0.4 },
  ])
}

function grainCloud() {
  const cloud = makeLayer('Cloud', 'granular', undefined, {
    level: 0.62, attack: 140, decay: 400, sustain: 0.85, release: 800, cutoff: 5200, res: 0.1, chorus: 0.18,
  }, { size: 90, density: 16, position: 0.3, spray: 0.2, spread: 0.4, root: 60 })
  const sine = makeLayer('Sine', 'synth', 'analog', {
    level: 0.16, attack: 40, release: 500, cutoff: 900, sustain: 0.8,
  }, { wave: 4, mix2: 0, detune: 0, uni: 1 })
  const patch = blankPatch('Grain Cloud', [cloud, sine], [
    route('modwheel', flatSource(cloud.id, 'position'), 0.65),
    route('aftertouch', flatSource(cloud.id, 'density'), 0.4),
    route('lfo2', flatLayer(cloud.id, 'cutoff'), 0.16),
  ], { lfo2Rate: 0.12, lfo2Shape: 0 })
  return bake(patch, [
    { [flatSource(cloud.id, 'position')]: 0.12, [flatSource(cloud.id, 'size')]: 50 },
    { [flatSource(cloud.id, 'position')]: 0.82, [flatSource(cloud.id, 'size')]: 150 },
    { [flatSource(cloud.id, 'density')]: 28, [flatLayer(cloud.id, 'chorus')]: 0.4 },
    { [flatLayer(cloud.id, 'cutoff')]: 900, [flatSource(cloud.id, 'size')]: 220, [flatLayer(sine.id, 'level')]: 0.05 },
  ])
}

function duoMorph() {
  const saw = makeLayer('Saw', 'synth', 'analog', {
    level: 0.62, attack: 12, decay: 240, sustain: 0.7, release: 280, cutoff: 2400, res: 0.1,
  }, { wave: 0, mix2: 0.15, detune: 4, uni: 1 })
  const square = makeLayer('Square', 'synth', 'analog', {
    level: 0.18, attack: 20, decay: 200, sustain: 0.65, release: 260, cutoff: 4200, res: 0.14,
  }, { wave: 1, mix2: 0, detune: 0, uni: 1, pw: 0.5 })
  const patch = blankPatch('Duo Morph', [saw, square], [
    route('lfo1', flatLayer(saw.id, 'cutoff'), 0.12),
    route('lfo1', flatLayer(square.id, 'cutoff'), 0.1),
    route('velocity', flatLayer(saw.id, 'level'), 0.2),
  ], { lfo1Rate: 0.3, lfo1Shape: 1 })
  return bake(patch, [
    { [flatLayer(saw.id, 'level')]: 0.7, [flatLayer(square.id, 'level')]: 0.05 },
    { [flatLayer(saw.id, 'level')]: 0.05, [flatLayer(square.id, 'level')]: 0.7 },
    { [flatLayer(saw.id, 'level')]: 0.45, [flatLayer(square.id, 'level')]: 0.45, [flatSource(saw.id, 'detune')]: 16, [flatLayer(saw.id, 'chorus')]: 0.3 },
    { [flatLayer(saw.id, 'level')]: 0.4, [flatLayer(square.id, 'level')]: 0.4, [flatLayer(saw.id, 'cutoff')]: 600, [flatLayer(square.id, 'cutoff')]: 700 },
  ])
}

export function normalizeLayerPatch(input: LayerPatch | undefined | null): LayerPatch {
  if (!input || !Array.isArray(input.layers) || input.layers.length === 0) return starterPatch('glass-pad')
  input.layers = input.layers.slice(0, 8).map((layer, index) => {
    const kind = layer.source?.kind || 'synth'
    const engine = layer.source?.engine
    return {
      id: layer.id || uid('lyr'),
      name: layer.name || `Layer ${index + 1}`,
      enabled: layer.enabled !== false,
      source: {
        kind,
        engine,
        bufferId: layer.source?.bufferId || '',
        params: { ...sourceDefaults(kind, engine), ...(layer.source?.params ?? {}) },
      },
      params: { ...defaultParams(LAYER_PARAMS), ...(layer.params ?? {}) },
    }
  })
  input.routes = (input.routes ?? []).slice(0, 24).map((item) => ({
    id: item.id || uid('mod'),
    source: item.source,
    destination: item.destination,
    amount: Math.min(1, Math.max(-1, Number.isFinite(item.amount) ? item.amount : 0)),
  }))
  input.globals = { ...defaultParams(GLOBAL_PARAMS), ...(input.globals ?? {}) }
  input.xy = {
    x: Math.min(1, Math.max(0, input.xy?.x ?? 0)),
    y: Math.min(1, Math.max(0, input.xy?.y ?? 0)),
  }
  input.modWheel = Math.min(1, Math.max(0, input.modWheel ?? 0))
  input.aftertouch = Math.min(1, Math.max(0, input.aftertouch ?? 0))
  input.polyphony = Math.min(16, Math.max(1, Math.round(input.polyphony || 8)))
  input.name = input.name || 'Layers'
  input.id = input.id || uid('lpatch')
  const base = flattenPatch(input)
  const corners = (input.corners ?? []).slice(0, 4).map((corner) => ({ values: { ...base, ...(corner?.values ?? {}) } }))
  while (corners.length < 4) corners.push({ values: { ...base } })
  input.corners = corners
  return input
}

export function normalizeLayerTracks(tracks: Track[]) {
  for (const track of tracks) {
    if (track.instrument !== 'layers') continue
    track.layerPatch = normalizeLayerPatch(track.layerPatch)
  }
}
