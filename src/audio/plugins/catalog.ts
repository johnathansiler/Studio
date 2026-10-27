import { emptyLooper, emptySampler } from '../sample/engine'
import type { AutomationLane, Insert, PluginInstance, Project, UserPreset } from '../../model/types'
import { uid } from '../../model/types'
import { normalizeScale } from '../../model/scale'
import type { FactoryPreset, ParamSpec, PluginDescriptor } from './types'

const VERSION = '1'

function param(id: string, name: string, min: number, max: number, fallback: number, unit: string, automatable = true): ParamSpec {
  return { id, name, min, max, default: fallback, unit, automatable }
}

export const CATALOG: PluginDescriptor[] = [
  {
    id: 'eq',
    name: 'EQ',
    version: VERSION,
    params: [
      param('hp', 'HP', 20, 1000, 20, 'Hz'),
      param('lp', 'LP', 1000, 20000, 20000, 'Hz'),
      param('lowF', 'Low', 40, 800, 180, 'Hz'),
      param('lowG', 'Low', -18, 12, 0, 'dB'),
      param('lowQ', 'Q', 0.2, 8, 0.7, ''),
      param('midF', 'Mid', 200, 8000, 1500, 'Hz'),
      param('midG', 'Mid', -18, 12, 0, 'dB'),
      param('midQ', 'Q', 0.2, 8, 1, ''),
      param('highF', 'High', 1000, 16000, 8000, 'Hz'),
      param('highG', 'High', -18, 12, 0, 'dB'),
      param('highQ', 'Q', 0.2, 8, 0.7, ''),
    ],
  },
  {
    id: 'compressor',
    name: 'Comp',
    version: VERSION,
    params: [
      param('threshold', 'Thresh', -60, 0, 0, 'dB'),
      param('ratio', 'Ratio', 1, 20, 1, ':1'),
      param('attack', 'Attack', 0.1, 80, 10, 'ms'),
      param('release', 'Release', 5, 400, 120, 'ms'),
      param('knee', 'Knee', 0, 24, 0, 'dB'),
      param('makeup', 'Makeup', 0, 24, 0, 'dB'),
      param('mix', 'Mix', 0, 1, 1, ''),
    ],
  },
  {
    id: 'deesser',
    name: 'De-ess',
    version: VERSION,
    params: [
      param('freq', 'Freq', 3000, 12000, 6500, 'Hz'),
      param('threshold', 'Thresh', -50, 0, -18, 'dB'),
      param('amount', 'Amount', 0, 1, 0, ''),
    ],
  },
  {
    id: 'gate',
    name: 'Gate',
    version: VERSION,
    params: [
      param('threshold', 'Thresh', -80, 0, -80, 'dB'),
      param('ratio', 'Ratio', 1, 20, 1, ':1'),
      param('attack', 'Attack', 0.1, 40, 5, 'ms'),
      param('release', 'Release', 5, 400, 80, 'ms'),
      param('hold', 'Hold', 0, 200, 20, 'ms'),
      param('range', 'Range', 0, 80, 40, 'dB'),
    ],
  },
  {
    id: 'limiter',
    name: 'Limiter',
    version: VERSION,
    params: [
      param('threshold', 'Thresh', -24, 0, 0, 'dB'),
      param('release', 'Release', 5, 200, 50, 'ms'),
      param('ceiling', 'Ceiling', -3, 0, -0.1, 'dB'),
    ],
  },
  {
    id: 'saturator',
    name: 'Sat',
    version: VERSION,
    params: [
      param('drive', 'Drive', 0, 1, 0, ''),
      param('tone', 'Tone', 800, 12000, 8000, 'Hz'),
      param('mix', 'Mix', 0, 1, 1, ''),
    ],
  },
  {
    id: 'doubler',
    name: 'Double',
    version: VERSION,
    params: [
      param('width', 'Width', 0, 1, 0.5, ''),
      param('delay', 'Delay', 5, 40, 18, 'ms'),
      param('depth', 'Depth', 0, 1, 0.3, ''),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  {
    id: 'chorus',
    name: 'Chorus',
    version: VERSION,
    params: [
      param('rate', 'Rate', 0.05, 4, 0.4, 'Hz'),
      param('depth', 'Depth', 0, 1, 0.4, ''),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  {
    id: 'delay',
    name: 'Delay',
    version: VERSION,
    params: [
      param('sync', 'Sync', 0, 1, 1, ''),
      param('division', 'Div', 0.125, 1, 0.375, 'beat'),
      param('time', 'Time', 1, 1000, 250, 'ms'),
      param('feedback', 'Feedback', 0, 0.9, 0.35, ''),
      param('pingpong', 'Ping', 0, 1, 1, ''),
      param('filter', 'Filter', 400, 12000, 5000, 'Hz'),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  {
    id: 'reverb',
    name: 'Reverb',
    version: VERSION,
    params: [
      param('mode', 'Mode', 0, 2, 2, ''),
      param('size', 'Size', 0.1, 1, 0.6, ''),
      param('damp', 'Damp', 0, 1, 0.4, ''),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  {
    id: 'tune',
    name: 'Tune',
    version: VERSION,
    params: [
      param('retune', 'Speed', 0.02, 1, 0.65, ''),
      param('humanize', 'Human', 0, 1, 0.25, ''),
      param('amount', 'Amount', 0, 1, 0, ''),
      param('transpose', 'Transpose', -12, 12, 0, 'st'),
      param('mode', 'Mode', 0, 1, 1, ''),
      param('root', 'Root', -1, 11, -1, ''),
      param('scaleIndex', 'Scale', -1, 18, -1, ''),
      param('minHz', 'Low', 50, 400, 120, 'Hz'),
      param('maxHz', 'High', 300, 1600, 800, 'Hz'),
      param('mask', 'Mask', 0, 4095, 0, ''),
    ],
  },
  {
    id: 'pitch',
    name: 'Pitch',
    version: VERSION,
    params: [
      param('semis', 'Semi', -12, 12, 0, 'st'),
      param('harmony', 'Harm', -12, 12, 7, 'st'),
      param('harmonyMix', 'Harm', 0, 1, 0, ''),
      param('mix', 'Mix', 0, 1, 0, ''),
    ],
  },
  {
    id: 'sampler',
    name: 'Sampler',
    version: VERSION,
    params: [
      param('gain', 'Gain', 0, 1, 0.8, ''),
      param('pitch', 'Pitch', -24, 24, 0, 'st'),
      param('pan', 'Pan', -1, 1, 0, ''),
      param('attack', 'Attack', 1, 2000, 4, 'ms'),
      param('decay', 'Decay', 5, 3000, 200, 'ms'),
      param('sustain', 'Sustain', 0, 1, 0.8, ''),
      param('release', 'Release', 5, 4000, 180, 'ms'),
      param('cutoff', 'Cutoff', 80, 16000, 16000, 'Hz'),
      param('res', 'Res', 0, 0.9, 0, ''),
      param('stretch', 'Stretch', 0, 1, 1, ''),
      param('keys', 'Keys', 0, 1, 0, ''),
      param('mono', 'Mono', 0, 1, 0, ''),
      param('record', 'Rec', 0, 1, 0, ''),
      param('loopMode', 'Loop', 0, 2, 0, ''),
      param('crossfade', 'Fade', 0, 0.5, 0.02, ''),
      param('sensitivity', 'Sense', 0, 1, 0.45, ''),
    ],
  },
  {
    id: 'looper',
    name: 'Looper',
    version: VERSION,
    params: [
      param('transport', 'Play', 0, 3, 0, ''),
      param('bars', 'Bars', 1, 8, 1, ''),
      param('sync', 'Sync', 0, 1, 1, ''),
      param('feedback', 'Decay', 0, 1, 0.85, ''),
      param('level', 'Level', 0, 1, 0.9, ''),
      param('speed', 'Speed', 0.5, 2, 1, ''),
      param('reverse', 'Reverse', 0, 1, 0, ''),
    ],
  },
]

export const FACTORY: Record<string, FactoryPreset[]> = {
  eq: [
    { name: 'Flat', params: {} },
    { name: 'Vocal', params: { hp: 90, lowF: 250, lowG: -1.5, midF: 3200, midG: 2.5, midQ: 1.1, highF: 10000, highG: 1.5, lp: 18000 } },
    { name: 'Air', params: { highF: 12000, highG: 3, hp: 70 } },
    { name: 'Low cut', params: { hp: 120, lowG: -2, lowF: 200 } },
  ],
  compressor: [
    { name: 'Gentle', params: { threshold: -12, ratio: 2, attack: 15, release: 140, knee: 8, makeup: 1, mix: 1 } },
    { name: 'Vocal', params: { threshold: -18, ratio: 3, attack: 8, release: 120, knee: 6, makeup: 3, mix: 1 } },
    { name: 'Squeeze', params: { threshold: -24, ratio: 6, attack: 5, release: 80, knee: 4, makeup: 6, mix: 1 } },
  ],
  deesser: [
    { name: 'Vocal', params: { freq: 6800, threshold: -22, amount: 0.55 } },
    { name: 'Hard', params: { freq: 6000, threshold: -28, amount: 0.85 } },
  ],
  gate: [
    { name: 'Vocal', params: { threshold: -42, ratio: 8, attack: 3, release: 90, hold: 25, range: 36 } },
    { name: 'Tight', params: { threshold: -36, ratio: 14, attack: 1, release: 50, hold: 10, range: 60 } },
  ],
  limiter: [
    { name: 'Transparent', params: { threshold: 0, release: 40, ceiling: -0.1 } },
    { name: 'Safe', params: { threshold: -6, release: 80, ceiling: -1 } },
  ],
  saturator: [
    { name: 'Tape', params: { drive: 0.35, tone: 7000, mix: 0.5 } },
    { name: 'Warm', params: { drive: 0.2, tone: 5000, mix: 0.7 } },
  ],
  doubler: [
    { name: 'Wide', params: { width: 0.8, delay: 22, depth: 0.4, mix: 0.45 } },
    { name: 'Tight', params: { width: 0.35, delay: 12, depth: 0.2, mix: 0.4 } },
  ],
  chorus: [
    { name: 'Soft', params: { rate: 0.3, depth: 0.35, mix: 0.3 } },
    { name: 'Wide', params: { rate: 0.6, depth: 0.7, mix: 0.45 } },
  ],
  delay: [
    { name: 'Quarter', params: { sync: 1, division: 1, feedback: 0.3, pingpong: 0, filter: 6000, mix: 0.28 } },
    { name: 'Dotted', params: { sync: 1, division: 0.75, feedback: 0.38, pingpong: 1, filter: 4500, mix: 0.3 } },
    { name: 'Ping-pong', params: { sync: 1, division: 0.375, feedback: 0.42, pingpong: 1, filter: 4000, mix: 0.32 } },
  ],
  reverb: [
    { name: 'Plate', params: { mode: 0, size: 0.45, damp: 0.35, mix: 0.22 } },
    { name: 'Room', params: { mode: 1, size: 0.35, damp: 0.5, mix: 0.18 } },
    { name: 'Hall', params: { mode: 2, size: 0.75, damp: 0.4, mix: 0.24 } },
  ],
  tune: [
    { name: 'Soprano', params: { retune: 0.75, humanize: 0.2, amount: 0.85, mode: 1, minHz: 200, maxHz: 1200, transpose: 0, root: -1, scaleIndex: -1, mask: 0 } },
    { name: 'Alto/Tenor', params: { retune: 0.6, humanize: 0.35, amount: 0.8, mode: 1, minHz: 120, maxHz: 700, transpose: 0, root: -1, scaleIndex: -1, mask: 0 } },
    { name: 'Low male', params: { retune: 0.5, humanize: 0.4, amount: 0.75, mode: 1, minHz: 70, maxHz: 420, transpose: 0, root: -1, scaleIndex: -1, mask: 0 } },
    { name: 'Instrument', params: { retune: 0.9, humanize: 0.1, amount: 0.9, mode: 0, minHz: 50, maxHz: 1500, transpose: 0, root: -1, scaleIndex: -1, mask: 0 } },
  ],
  pitch: [
    { name: 'Octave up', params: { semis: 12, harmony: 7, harmonyMix: 0, mix: 1 } },
    { name: 'Fifth', params: { semis: 0, harmony: 7, harmonyMix: 0.6, mix: 0.8 } },
    { name: 'Double', params: { semis: 0.1, harmony: 12, harmonyMix: 0.35, mix: 0.5 } },
  ],
  sampler: [
    { name: 'Loop', params: { stretch: 1, keys: 0, loopMode: 0, crossfade: 0.04 } },
    { name: 'One shot', params: { stretch: 0, loopMode: 2, attack: 1, sustain: 1, release: 40 } },
    { name: 'Keys', params: { keys: 1, stretch: 0, loopMode: 0, attack: 6, sustain: 0.85 } },
  ],
  looper: [
    { name: '1 bar', params: { sync: 1, bars: 1, feedback: 0.9, transport: 0 } },
    { name: '4 bars', params: { sync: 1, bars: 4, feedback: 0.85 } },
    { name: 'Free', params: { sync: 0, bars: 1, feedback: 1 } },
  ],
}

export function descriptor(id: string) {
  return CATALOG.find((plugin) => plugin.id === id) ?? null
}

export function defaultParams(id: string) {
  const spec = descriptor(id)
  const params: Record<string, number> = {}
  if (!spec) return params
  for (const item of spec.params) params[item.id] = item.default
  return params
}

export function createPlugin(pluginId: string, preset?: string): PluginInstance {
  const params = defaultParams(pluginId)
  const chosen = (FACTORY[pluginId] ?? []).find((item) => item.name === preset)
  if (chosen) Object.assign(params, chosen.params)
  return {
    id: uid('fx'),
    pluginId,
    version: descriptor(pluginId)?.version ?? VERSION,
    enabled: true,
    wet: 1,
    params,
    sidechain: '',
    sampler: pluginId === 'sampler' ? emptySampler() : undefined,
    looper: pluginId === 'looper' ? emptyLooper() : undefined,
  }
}

export function latencyOf(pluginId: string, params: Record<string, number>, sampleRate: number, enabled = true) {
  if (!enabled) return 0
  if (pluginId === 'tune' && (params.amount ?? 0) > 0.001) return tuneLatency(sampleRate)
  if (pluginId === 'pitch' && (params.mix ?? 0) > 0.001) return tuneLatency(sampleRate)
  if (pluginId === 'limiter') return 64
  return 0
}

export function tuneLatency(sampleRate: number) {
  const span = Math.max(1024, Math.round(1536 * (sampleRate / 48000)))
  return span + Math.floor(span / 2)
}

function fillInstrument(plugin: PluginInstance): PluginInstance {
  if (plugin.pluginId === 'sampler' && !plugin.sampler) plugin.sampler = emptySampler()
  if (plugin.pluginId === 'looper' && !plugin.looper) plugin.looper = emptyLooper()
  return plugin
}

export function normalizeProject(project: Project): Project {
  project.scale = normalizeScale(project.scale)
  project.masterPlugins = project.masterPlugins ?? []
  project.automation = project.automation ?? []
  project.presets = project.presets ?? []
  project.masterInserts = project.masterInserts ?? []
  for (const track of project.tracks) {
    track.plugins = (track.plugins ?? []).map(fillInstrument)
    track.sends = track.sends ?? []
    track.inserts = track.inserts ?? []
    track.output = track.output ?? null
    track.groupId = track.groupId ?? null
    if (track.inserts.length && track.plugins.length === 0) {
      for (const insert of track.inserts) track.plugins.push(fromLegacy(insert))
      track.inserts = []
    }
  }
  project.masterPlugins = (project.masterPlugins ?? []).map(fillInstrument)
  if (project.masterInserts.length && project.masterPlugins.length === 0) {
    for (const insert of project.masterInserts) project.masterPlugins.push(fromLegacy(insert))
    project.masterInserts = []
  }
  if (!project.masterPlugins.some((plugin) => plugin.pluginId === 'limiter')) {
    const limiter = createPlugin('limiter', 'Transparent')
    limiter.enabled = false
    project.masterPlugins.unshift(limiter)
  }
  return project
}

export function fromLegacy(insert: Insert): PluginInstance {
  const plugin = createPlugin(insert.type === 'compressor' ? 'compressor' : insert.type === 'eq' ? 'eq' : insert.type === 'delay' ? 'delay' : 'reverb')
  plugin.enabled = insert.enabled
  const params = insert.params
  if (insert.type === 'eq') {
    plugin.params.lowG = params.low ?? 0
    plugin.params.midG = params.mid ?? 0
    plugin.params.midF = params.midFreq ?? 1000
    plugin.params.highG = params.high ?? 0
  } else if (insert.type === 'compressor') {
    plugin.params.threshold = params.threshold ?? -18
    plugin.params.ratio = params.ratio ?? 3
    plugin.params.attack = (params.attack ?? 0.01) * 1000
    plugin.params.release = (params.release ?? 0.12) * 1000
    plugin.params.knee = params.knee ?? 6
    plugin.params.makeup = params.makeup ?? 0
  } else if (insert.type === 'delay') {
    plugin.params.sync = 0
    plugin.params.time = (params.time ?? 0.25) * 1000
    plugin.params.feedback = params.feedback ?? 0.3
    plugin.params.mix = params.mix ?? 0.2
  } else {
    plugin.params.size = Math.min(1, (params.decay ?? 1.5) / 4)
    plugin.params.mix = params.mix ?? 0.18
    plugin.params.mode = 1
  }
  return plugin
}

export function presetParams(pluginId: string, name: string, user: UserPreset[]) {
  const factory = (FACTORY[pluginId] ?? []).find((item) => item.name === name)
  if (factory) return { ...defaultParams(pluginId), ...factory.params }
  const saved = user.find((item) => item.pluginId === pluginId && item.name === name)
  if (saved) return { ...defaultParams(pluginId), ...saved.params }
  return null
}

export function automationAt(lanes: AutomationLane[], pluginId: string, params: Record<string, number>, beat: number) {
  const next = { ...params }
  for (const lane of lanes) {
    if (lane.pluginId !== pluginId || !lane.points.length) continue
    next[lane.param] = interpolate(lane.points, beat, params[lane.param] ?? 0)
  }
  return next
}

function interpolate(points: { beat: number; value: number }[], beat: number, fallback: number) {
  const sorted = [...points].sort((a, b) => a.beat - b.beat)
  if (beat <= sorted[0].beat) return sorted[0].value
  const last = sorted[sorted.length - 1]
  if (beat >= last.beat) return last.value
  for (let i = 1; i < sorted.length; i++) {
    if (beat <= sorted[i].beat) {
      const a = sorted[i - 1]
      const b = sorted[i]
      const span = b.beat - a.beat || 1
      return a.value + ((beat - a.beat) / span) * (b.value - a.value)
    }
  }
  return fallback
}
