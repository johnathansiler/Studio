/** Core plugin ids and the map from every retired id. */

import type { PluginInstance, UserPreset } from '../../model/types'
import { emptySampler } from '../sample/engine'

export const CORE_IDS = [
  'tune',
  'eq',
  'compressor',
  'vocal',
  'saturator',
  'reverb',
  'delay',
  'mod',
  'scaler',
  'synth',
  'sampler',
  'limiter',
] as const

export type CoreId = (typeof CORE_IDS)[number]

export const INSTRUMENT_IDS = new Set<string>(['scaler', 'synth', 'sampler'])

export function isCoreId(id: string): id is CoreId {
  return (CORE_IDS as readonly string[]).includes(id)
}

interface Move {
  to: CoreId
  kind: number
  drop?: string[]
  rename?: Record<string, string>
  /** Assistant chain. Replaced when a new master chain is built. */
  chain?: boolean
  /** Drop the insert. Metering lives on the master limiter. */
  remove?: boolean
}

/** Retired id → the core plugin and the mode that keeps its settings. */
export const MOVES: Record<string, Move> = {
  tune: { to: 'tune', kind: 0 },
  eq: { to: 'eq', kind: 0 },
  passive: { to: 'eq', kind: 1, rename: { lowF: 'pLow', lowBoost: 'pBoost', lowAtten: 'pAtten', highF: 'pHigh', highBoost: 'pAir', highBw: 'pWidth', highAtten: 'pCut', highAttenF: 'pCutF' } },
  pre: { to: 'eq', kind: 2, rename: { hp: 'preHp', lowF: 'preLow', lowG: 'preLowG', midF: 'preMid', midG: 'preMidG', highF: 'preHigh', highG: 'preHighG', drive: 'preDrive' } },
  channel: { to: 'eq', kind: 3 },
  prop: { to: 'eq', kind: 4, rename: { freq: 'tiltF', gain: 'tiltG' } },
  focus: { to: 'eq', kind: 5, drop: ['ms'], rename: { threshold: 'focusThresh' } },
  meq: { to: 'eq', kind: 6, drop: ['ms', 'sLow', 'sMid', 'sHigh'], chain: true },
  deq: { to: 'eq', kind: 7, chain: true, rename: { freq: 'dynF', q: 'dynQ', threshold: 'dynThresh', gain: 'dynG', attack: 'dynA', release: 'dynR' } },
  compressor: { to: 'compressor', kind: 0 },
  fet: { to: 'compressor', kind: 1, rename: { input: 'fetIn', output: 'fetOut', ratio: 'fetRatio', attack: 'fetAtk', release: 'fetRel' } },
  opto: { to: 'compressor', kind: 2, rename: { peak: 'optoPeak', gain: 'optoGain' } },
  bus: { to: 'compressor', kind: 3, rename: { threshold: 'busThresh', ratio: 'busRatio', attack: 'busAtk', release: 'busRel', makeup: 'busMakeup' } },
  vari: { to: 'compressor', kind: 4, rename: { time: 'variTime', input: 'variIn', output: 'variOut', color: 'variColor' } },
  glue: { to: 'compressor', kind: 5, chain: true },
  mbcomp: { to: 'compressor', kind: 6, drop: ['ms'], chain: true },
  vocal: { to: 'vocal', kind: 0 },
  gate: { to: 'vocal', kind: 2, rename: { threshold: 'gate', ratio: 'gateRatio', attack: 'gateAtk', release: 'gateRel' } },
  deesser: { to: 'vocal', kind: 1 },
  saturator: { to: 'saturator', kind: 0 },
  tape: { to: 'saturator', kind: 1 },
  sum: { to: 'saturator', kind: 2 },
  mtape: { to: 'saturator', kind: 3, chain: true },
  clip: { to: 'saturator', kind: 4, chain: true, rename: { mode: 'clipMode' } },
  amp: { to: 'saturator', kind: 5 },
  reverb: { to: 'reverb', kind: 0 },
  plate: { to: 'reverb', kind: 1 },
  hall: { to: 'reverb', kind: 2 },
  conv: { to: 'reverb', kind: 3 },
  delay: { to: 'delay', kind: 0 },
  echo: { to: 'delay', kind: 1 },
  bbd: { to: 'delay', kind: 2 },
  digital: { to: 'delay', kind: 3 },
  mod: { to: 'mod', kind: 0 },
  chorus: { to: 'mod', kind: 0 },
  doubler: { to: 'mod', kind: 1 },
  ensemble: { to: 'mod', kind: 2 },
  phase: { to: 'mod', kind: 3 },
  rotor: { to: 'mod', kind: 4 },
  pitch: { to: 'mod', kind: 5 },
  scaler: { to: 'scaler', kind: 0 },
  synth: { to: 'synth', kind: 0 },
  sampler: { to: 'sampler', kind: 0 },
  pads: { to: 'sampler', kind: 1 },
  looper: { to: 'sampler', kind: 0 },
  limiter: { to: 'limiter', kind: 0 },
  peak: { to: 'limiter', kind: 1 },
  brick: { to: 'limiter', kind: 1, chain: true },
  maxim: { to: 'limiter', kind: 2, chain: true },
  image: { to: 'limiter', kind: 0, chain: true },
  dither: { to: 'limiter', kind: 0, chain: true },
  msbox: { to: 'eq', kind: 0, rename: { mid: 'midG' }, drop: ['side'], chain: true },
  meter: { to: 'limiter', kind: 0, remove: true },
}

export const KIND_LABELS: Record<string, string[]> = {
  eq: ['Clean', 'Passive', 'Pre', 'Channel', 'Tilt', 'Focus', 'Linear', 'Dynamic'],
  compressor: ['VCA', 'FET', 'Opto', 'Bus', 'Vari-mu', 'Glue', 'Multiband'],
  vocal: ['Both', 'De-ess', 'Gate'],
  saturator: ['Soft', 'Tape', 'Sum', 'Oxide', 'Clip', 'Amp'],
  reverb: ['Algorithm', 'Plate', 'Hall', 'Space'],
  delay: ['Studio', 'Echo', 'Bucket', 'Digital'],
  mod: ['Chorus', 'Double', 'Ensemble', 'Phase', 'Rotor', 'Shift'],
  sampler: ['Sampler', 'Beat Machine'],
  limiter: ['Transparent', 'Brick', 'Loud'],
}

const KIND_PARAMS: Record<string, Record<number, string[]>> = {
  eq: {
    0: ['kind', 'hp', 'lp', 'lowF', 'lowG', 'lowQ', 'midF', 'midG', 'midQ', 'highF', 'highG', 'highQ'],
    1: ['kind', 'pLow', 'pBoost', 'pAtten', 'pHigh', 'pAir', 'pWidth', 'pCut', 'pCutF'],
    2: ['kind', 'preHp', 'preLow', 'preLowG', 'preMid', 'preMidG', 'preHigh', 'preHighG', 'preDrive'],
    3: ['kind', 'curve', 'lfF', 'lfG', 'lmfF', 'lmfG', 'hmfF', 'hmfG', 'hfF', 'hfG'],
    4: ['kind', 'tiltF', 'tiltG'],
    5: ['kind', 'f0', 'g0', 'q0', 'f1', 'g1', 'q1', 'f2', 'g2', 'q2', 'dynamic', 'focusThresh', 'linear'],
    6: ['kind', 'phase', 'hp', 'lp', 'lowG', 'midF', 'midG', 'midQ', 'highG'],
    7: ['kind', 'dynF', 'dynQ', 'dynThresh', 'dynG', 'dynA', 'dynR'],
  },
  compressor: {
    0: ['kind', 'threshold', 'ratio', 'attack', 'release', 'knee', 'makeup', 'mix'],
    1: ['kind', 'fetIn', 'fetOut', 'fetRatio', 'fetAtk', 'fetRel'],
    2: ['kind', 'optoPeak', 'optoGain'],
    3: ['kind', 'busThresh', 'busRatio', 'busAtk', 'busRel', 'hpf', 'busMakeup'],
    4: ['kind', 'variTime', 'variIn', 'variOut', 'variColor'],
    5: ['kind', 'threshold', 'ratio', 'attack', 'release', 'releaseMode', 'makeup', 'mix'],
    6: ['kind', 'bands', 'x1', 'x2', 'x3', 'x4', 'threshold', 'ratio', 'attack', 'release', 'makeup'],
  },
  vocal: {
    0: ['kind', 'freq', 'threshold', 'amount', 'gate', 'gateRatio', 'gateAtk', 'gateRel', 'hold', 'range'],
    1: ['kind', 'freq', 'threshold', 'amount'],
    2: ['kind', 'gate', 'gateRatio', 'gateAtk', 'gateRel', 'hold', 'range'],
  },
  saturator: {
    0: ['kind', 'drive', 'tone', 'mix'],
    1: ['kind', 'drive', 'speed', 'bias', 'wow', 'bump', 'hiss'],
    2: ['kind', 'drive', 'tube'],
    3: ['kind', 'drive', 'color', 'mix'],
    4: ['kind', 'drive', 'clipMode', 'ceiling'],
    5: ['kind', 'gain', 'bass', 'mid', 'treble', 'presence', 'master', 'cab'],
  },
  reverb: {
    0: ['kind', 'mode', 'size', 'damp', 'mix'],
    1: ['kind', 'size', 'decay', 'damp', 'mix'],
    2: ['kind', 'mode', 'size', 'decay', 'damp', 'mix'],
    3: ['kind', 'ir', 'mix'],
  },
  delay: {
    0: ['kind', 'sync', 'division', 'time', 'feedback', 'pingpong', 'filter', 'mix'],
    1: ['kind', 'time', 'feedback', 'wow', 'drive', 'mix'],
    2: ['kind', 'time', 'feedback', 'clock', 'mix'],
    3: ['kind', 'time', 'feedback', 'mix'],
  },
  mod: {
    0: ['kind', 'rate', 'depth', 'mix'],
    1: ['kind', 'width', 'delay', 'depth', 'mix'],
    2: ['kind', 'rate', 'depth', 'mode', 'mix'],
    3: ['kind', 'rate', 'depth', 'feedback', 'mix'],
    4: ['kind', 'speed', 'mix'],
    5: ['kind', 'semis', 'harmony', 'harmonyMix', 'mix'],
  },
  sampler: {
    0: ['kind', 'gain', 'pitch', 'attack', 'decay', 'sustain', 'release'],
    1: ['kind'],
  },
  limiter: {
    0: ['kind', 'threshold', 'release', 'ceiling', 'width', 'bass', 'bits', 'shape'],
    1: ['kind', 'ceiling', 'release', 'lookahead', 'releaseMode', 'bits', 'shape'],
    2: ['kind', 'target', 'ceiling', 'release', 'lookahead', 'width', 'bass', 'low', 'high', 'bits', 'shape'],
  },
}

export function kindLabels(pluginId: string): string[] {
  return KIND_LABELS[pluginId] ?? []
}

export function paramsForKind(pluginId: string, kind: number): string[] | null {
  const table = KIND_PARAMS[pluginId]
  if (!table) return null
  const labels = KIND_LABELS[pluginId] ?? []
  const index = Math.max(0, Math.min(labels.length - 1, Math.round(kind)))
  return table[index] ?? table[0] ?? null
}

export function targetOf(id: string): CoreId {
  return MOVES[id]?.to ?? (isCoreId(id) ? id : 'eq')
}

export function effectLatency(id: string, params: Record<string, number>, sampleRate: number): number {
  const kind = Math.round(params.kind ?? 0)
  if (id === 'limiter') {
    if (kind >= 1) return Math.round(((params.lookahead || 5) / 1000) * sampleRate)
    return 64
  }
  if (id === 'eq' && kind === 5 && (params.linear ?? 0) >= 0.5) return 256
  return 0
}

export function isDrumsPlugin(plugin: { pluginId: string; params?: Record<string, number> }): boolean {
  return plugin.pluginId === 'sampler' && Math.round(plugin.params?.kind ?? 0) >= 1
}

export function isChainPlugin(plugin: { params?: Record<string, number> }): boolean {
  return (plugin.params?.chain ?? 0) >= 0.5
}

function copyParams(move: Move, from: Record<string, number>, defaults: Record<string, number>) {
  const params = { ...defaults }
  for (const [key, value] of Object.entries(from)) {
    if (key === 'kind' || key === 'chain') continue
    if (move.drop?.includes(key)) continue
    const name = move.rename?.[key] ?? key
    params[name] = value
  }
  params.kind = move.kind
  if (move.chain) params.chain = 1
  return params
}

/** Load a saved insert as the core plugin it now belongs to. Null drops the insert. */
export function migratePlugin(plugin: PluginInstance, defaults: (id: string) => Record<string, number>): PluginInstance | null {
  const move = MOVES[plugin.pluginId]
  if (!move) return isCoreId(plugin.pluginId) ? plugin : null
  if (move.remove) return null
  if (plugin.pluginId === move.to && plugin.params.kind != null && isCoreId(plugin.pluginId)) return plugin
  if (plugin.pluginId === move.to && isCoreId(plugin.pluginId)) {
    return { ...plugin, params: { ...defaults(move.to), ...plugin.params, kind: move.kind } }
  }
  const params = copyParams(move, plugin.params, defaults(move.to))
  const next: PluginInstance = { ...plugin, pluginId: move.to, params, looper: undefined }
  if (move.to === 'sampler') {
    next.sampler = plugin.sampler ?? emptySampler()
    const layer = plugin.looper?.layers.find((item) => item.bufferId && !item.mute)
    if (layer && next.sampler && !next.sampler.bufferId) {
      next.sampler.bufferId = layer.bufferId
      if (plugin.looper?.sourceRate) next.sampler.sourceRate = plugin.looper.sourceRate
    }
  }
  return next
}

export function migratePreset(preset: UserPreset): UserPreset | null {
  const move = MOVES[preset.pluginId]
  if (!move || move.remove) return move?.remove ? null : preset
  if (preset.pluginId === move.to) return preset
  return { ...preset, pluginId: move.to, params: copyParams(move, preset.params, {}) }
}
