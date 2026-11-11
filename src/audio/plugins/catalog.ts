import { emptyLooper, emptySampler } from '../sample/engine'
import type { AutomationLane, Insert, PluginInstance, Project, UserPreset } from '../../model/types'
import { AMP_PRESETS } from '../../model/ampPresets'
import { defaultRoll } from '../../model/paint'
import { normalizeQuantize } from '../../model/quantize'
import { defaultRecord, uid } from '../../model/types'
import { normalizeMidiProject } from '../../model/midiTools'
import { migrateScalerTrack } from '../../instruments/scaler/chain'
import { normalizeTrackScaler } from '../../instruments/scaler/model'
import { normalizeScale } from '../../model/scale'
import { normalizePadKit } from '../../model/padMachine'
import { bindPatternClips, normalizeBeats, repairArrangementIdentities } from '../../model/steps'
import { adoptStepSequencers, createStepsPlugin } from '../../model/stepPlugin'
import { normalizeMix } from '../../model/mixGroups'
import { normalizeOmniProject } from '../../instruments/patch/model'
import { tuneLiveLatency } from './autoTune'
import { CORE_CATALOG } from './coreCatalog'
import { shaperLatencySamples } from '../quality/oversample'
import { effectLatency, migratePlugin, migratePreset, targetOf, MOVES } from './ids'
import { LEGACY_DEFAULTS } from './legacyDefaults'
import type { FactoryPreset, ParamSpec, PluginDescriptor } from './types'

const VERSION = '1'

function param(id: string, name: string, min: number, max: number, fallback: number, unit: string, automatable = true): ParamSpec {
  return { id, name, min, max, default: fallback, unit, automatable }
}

function ampDescriptor(): PluginDescriptor {
  const params: ParamSpec[] = [
    param('model', 'Amp', 0, 8, 0, '', false),
    param('gain', 'Gain', 0, 1, 0.35, ''),
    param('bass', 'Bass', 0, 1, 0.5, ''),
    param('mid', 'Mid', 0, 1, 0.5, ''),
    param('treble', 'Treble', 0, 1, 0.5, ''),
    param('presence', 'Presence', 0, 1, 0.5, ''),
    param('master', 'Master', 0, 1, 0.65, ''),
    param('bright', 'Bright', 0, 1, 0, '', false),
    param('cab', 'Cab', 0, 1, 1, '', false),
    param('cabA', 'Cab A', 0, 8, 0, '', false),
    param('cabB', 'Cab B', 0, 8, 2, '', false),
    param('blend', 'Blend', 0, 1, 0, ''),
    param('mic', 'Mic', 0, 2, 0, '', false),
    param('axis', 'Axis', 0, 1, 0, '', false),
    param('distance', 'Distance', 0, 1, 0.2, ''),
    param('cal', 'A4', 430, 450, 440, 'Hz', false),
    param('preset', 'Tuning', 0, 6, 1, '', false),
    param('mute', 'Mute', 0, 1, 0, '', false),
    param('expr', 'Expr', 0, 1, 0.3, ''),
    param('loop', 'Loop', 0, 2, 0, '', false),
  ]
  for (let i = 0; i < 8; i++) {
    params.push(param(`s${i}`, `Pedal ${i + 1}`, 0, 23, i === 0 ? 1 : 0, '', false))
    params.push(param(`a${i}`, `Level ${i + 1}`, 0, 1, 0.5, ''))
    params.push(param(`b${i}`, `Tone ${i + 1}`, 0, 1, 0.35, ''))
    params.push(param(`z${i}`, `Place ${i + 1}`, 0, 1, 0, '', false))
  }
  return { id: 'amp', name: 'Amp', version: VERSION, params }
}

export const CATALOG: PluginDescriptor[] = CORE_CATALOG

export const FACTORY: Record<string, FactoryPreset[]> = {
  eq: [
    { name: 'Vocal', params: { hp: 90, lowF: 250, lowG: -1.5, midF: 3200, midG: 2.5, midQ: 1.1, highF: 10000, highG: 1.5, lp: 18000 } },
    { name: 'Vocal Air', params: { hp: 80, lowF: 200, lowG: -1, midF: 4500, midG: 1.5, midQ: 0.8, highF: 12000, highG: 4.5, highQ: 0.6, lp: 20000 } },
    { name: 'Low cut', params: { hp: 120, lowG: -2, lowF: 200 } },
  ],
  compressor: [
    { name: 'Gentle', params: { threshold: -12, ratio: 2, attack: 15, release: 140, knee: 8, makeup: 1, mix: 1 } },
    { name: 'Vocal', params: { threshold: -18, ratio: 3, attack: 8, release: 120, knee: 6, makeup: 3, mix: 1 } },
    { name: 'Squeeze', params: { threshold: -24, ratio: 6, attack: 5, release: 80, knee: 4, makeup: 6, mix: 1 } },
    { name: 'Duck', params: { threshold: -30, ratio: 10, attack: 1, release: 160, knee: 6, makeup: 0, mix: 1 } },
  ],
  limiter: [
    { name: 'Transparent', params: { kind: 0, threshold: 0, release: 40, ceiling: -0.1 } },
    { name: 'Safe', params: { kind: 0, threshold: -6, release: 80, ceiling: -1 } },
    { name: 'Stream', params: { kind: 1, ceiling: -1.5, release: 140, lookahead: 5, releaseMode: 1 } },
    { name: 'Club', params: { kind: 2, target: -6, ceiling: -0.3, release: 80, lookahead: 5, width: 1.15 } },
  ],
  saturator: [
    { name: 'Tape', params: { kind: 1, drive: 0.35, tone: 7000, mix: 0.5, speed: 1, bias: 0.35, wow: 0.08 } },
    { name: 'Warm', params: { kind: 0, drive: 0.2, tone: 5000, mix: 0.7 } },
    { name: 'Amp', params: { kind: 5, gain: 0.55, bass: 0.6, mid: 0.45, treble: 0.58, presence: 0.4, master: 0.7 } },
  ],
  delay: [
    { name: 'Quarter', params: { kind: 0, sync: 1, division: 1, feedback: 0.3, pingpong: 0, filter: 6000, mix: 0.28 } },
    { name: 'Dotted', params: { kind: 0, sync: 1, division: 0.75, feedback: 0.38, pingpong: 1, filter: 4500, mix: 0.3 } },
    { name: 'Ping-pong', params: { kind: 0, sync: 1, division: 0.375, feedback: 0.42, pingpong: 1, filter: 4000, mix: 0.32 } },
    { name: 'Echo', params: { kind: 1, time: 320, feedback: 0.28, wow: 0.3, drive: 0.35, mix: 0.22 } },
  ],
  reverb: [
    { name: 'Plate', params: { kind: 1, mode: 0, size: 0.45, decay: 0.68, damp: 0.35, mix: 0.22 } },
    { name: 'Room', params: { kind: 0, mode: 1, size: 0.35, damp: 0.5, mix: 0.18 } },
    { name: 'Hall', params: { kind: 2, mode: 1, size: 0.72, decay: 0.8, damp: 0.38, mix: 0.22 } },
    { name: 'Big Hall', params: { kind: 2, mode: 1, size: 0.96, decay: 0.94, damp: 0.22, mix: 0.34 } },
    { name: 'Space', params: { kind: 3, ir: 0, mix: 0.28 } },
  ],
  tune: [
    { name: 'Hard tune/T-Pain', params: { retune: 0.95, humanize: 0.05, flex: 0, amount: 0.85, mode: 1, minHz: 80, maxHz: 1000, transpose: 0, formant: 0.15, root: -1, scaleIndex: -1, mask: 0 } },
    { name: 'Natural', params: { retune: 0.42, humanize: 0.55, flex: 0.35, amount: 0.72, mode: 1, minHz: 80, maxHz: 900, transpose: 0, formant: 0, root: -1, scaleIndex: -1, mask: 0 } },
    { name: 'Soprano', params: { retune: 0.75, humanize: 0.2, amount: 0.85, mode: 1, minHz: 200, maxHz: 1200, transpose: 0, root: -1, scaleIndex: -1, mask: 0, formant: 0 } },
    { name: 'Alto/Tenor', params: { retune: 0.6, humanize: 0.35, amount: 0.8, mode: 1, minHz: 120, maxHz: 700, transpose: 0, root: -1, scaleIndex: -1, mask: 0, formant: 0 } },
    { name: 'Low male', params: { retune: 0.5, humanize: 0.4, amount: 0.75, mode: 1, minHz: 70, maxHz: 420, transpose: 0, root: -1, scaleIndex: -1, mask: 0, formant: 0 } },
    { name: 'Instrument', params: { retune: 0.9, humanize: 0.1, amount: 0.9, mode: 0, minHz: 50, maxHz: 1500, transpose: 0, root: -1, scaleIndex: -1, mask: 0, formant: 0 } },
    { name: 'Classic', params: { color: 1, tracking: 0.35, transition: 0.4, retune: 0.8, humanize: 0.12, flex: 0, amount: 0.88, mode: 1, formant: 0, root: -1, scaleIndex: -1, mask: 0, minHz: 80, maxHz: 1000, transpose: 0 } },
    { name: 'Harmony', params: { harmony: 0.45, h1: 3, h2: 7, h3: 12, h4: -12, retune: 0.62, humanize: 0.2, flex: 0.1, amount: 0.8, mode: 1, formant: 0.25, root: -1, scaleIndex: -1, mask: 0, minHz: 80, maxHz: 1000, transpose: 0 } },
    { name: 'MIDI target', params: { midi: 1, retune: 1, humanize: 0, flex: 0, amount: 1, mode: 1, formant: 0, root: -1, scaleIndex: -1, mask: 0, minHz: 80, maxHz: 1000, transpose: 0 } },
  ],
  amp: AMP_PRESETS,
  sampler: [
    { name: 'Loop', params: { stretch: 1, keys: 0, loopMode: 0, crossfade: 0.04 } },
    { name: 'One shot', params: { stretch: 0, loopMode: 2, attack: 1, sustain: 1, release: 40 } },
    { name: 'Keys', params: { keys: 1, stretch: 0, loopMode: 0, attack: 6, sustain: 0.85 } },
  ],
  vocal: [
    { name: 'Vocal', params: { kind: 0, freq: 6800, threshold: -22, amount: 0.55, gate: -42, gateRatio: 8, gateAtk: 3, gateRel: 90, hold: 25, range: 36 } },
    { name: 'De-ess', params: { kind: 1, freq: 6500, threshold: -24, amount: 0.7 } },
    { name: 'Gate', params: { kind: 2, gate: -36, gateRatio: 12, gateAtk: 1, gateRel: 60, hold: 12, range: 60 } },
  ],
  mod: [
    { name: 'Soft', params: { kind: 0, rate: 0.3, depth: 0.35, mix: 0.3 } },
    { name: 'Double', params: { kind: 1, width: 0.8, delay: 22, depth: 0.35, mix: 0.45 } },
    { name: 'Phase', params: { kind: 3, rate: 0.2, depth: 0.6, feedback: 0.4, mix: 0.4 } },
    { name: 'Shift', params: { kind: 5, semis: 0, harmony: 7, harmonyMix: 0.45, mix: 0.7 } },
  ],
}


/** Amp stays a full descriptor. The face reads its ranges. Other retired ids only keep a name and defaults. */
function legacyDescriptor(id: string): PluginDescriptor | null {
  if (id === 'amp') return ampDescriptor()
  const row = LEGACY_DEFAULTS[id]
  if (!row) return null
  return {
    id,
    name: row.name,
    version: VERSION,
    params: Object.entries(row.defaults).map(([key, value]) => param(key, key, Math.min(value, 0), Math.max(value, 1), value, '')),
  }
}

export function descriptor(id: string) {
  return CATALOG.find((plugin) => plugin.id === id) ?? legacyDescriptor(id)
}

/** Plugins the picker can insert. Retired ids stay out of this list. */
export function pluginSpecs(): PluginDescriptor[] {
  return CATALOG
}

export function defaultParams(id: string) {
  const spec = descriptor(id)
  const params: Record<string, number> = {}
  if (!spec) return params
  for (const item of spec.params) params[item.id] = item.default
  return params
}

export function createPlugin(pluginId: string, preset?: string): PluginInstance {
  if (pluginId === 'steps') return createStepsPlugin()
  const move = MOVES[pluginId] ?? { to: 'eq' as const, kind: 0 }
  const core = move.remove ? 'limiter' : move.to
  const params = defaultParams(core)
  if (pluginId === 'amp') Object.assign(params, defaultParams('amp'))
  const chosen = (FACTORY[pluginId] ?? FACTORY[core] ?? []).find((item) => item.name === preset)
  if (chosen) Object.assign(params, chosen.params)
  if (chosen?.params.kind == null) params.kind = move.kind
  if (move.chain && pluginId !== core) params.chain = 1
  return {
    id: uid('fx'),
    pluginId: core,
    version: descriptor(core)?.version ?? VERSION,
    enabled: true,
    wet: 1,
    params,
    sidechain: '',
    sampler: core === 'sampler' ? emptySampler() : undefined,
  }
}

export function latencyOf(pluginId: string, params: Record<string, number>, sampleRate: number, enabled = true, live = false) {
  if (!enabled) return 0
  const id = targetOf(pluginId)
  const kind = Math.round(params.kind ?? MOVES[pluginId]?.kind ?? 0)
  if (id === 'tune' && (params.amount ?? 0) > 0.001) {
    if (live && (params.hq ?? 0) < 0.5) return tuneLiveLatency(sampleRate)
    return tuneLatency(sampleRate)
  }
  if (id === 'mod' && kind === 5 && (params.mix ?? 0) > 0.001) return tuneLatency(sampleRate)
  // The graph reads this before process(). The soft shaper's own latencySamples
  // stays 0 until the first block, which left a driven saturator late.
  if (id === 'saturator' && kind === 0 && (params.drive ?? 0) > 0.0001) return shaperLatencySamples()
  return effectLatency(id, { ...params, kind }, sampleRate)
}

function fillInstrument(plugin: PluginInstance): PluginInstance {
  if (plugin.pluginId === 'sampler' && !plugin.sampler) plugin.sampler = emptySampler()
  if (plugin.pluginId === 'looper' && !plugin.looper) plugin.looper = emptyLooper()
  return plugin
}

export function tuneLatency(sampleRate: number) {
  const span = Math.max(1024, Math.round(1536 * (sampleRate / 48000)))
  return span + Math.floor(span / 2)
}

export function normalizeProject(project: Project): Project {
  normalizeMidiProject(project)
  normalizeOmniProject(project)
  project.scale = normalizeScale(project.scale)
  project.padKit = normalizePadKit(project.padKit)
  const beats = normalizeBeats(project.beats, project.patternClips)
  project.beats = beats.beats
  project.patternClips = bindPatternClips(beats.patternClips, project.tracks)
  adoptStepSequencers(project)
  repairArrangementIdentities(project)
  project.roll = { ...defaultRoll(), ...project.roll }
  project.quantize = normalizeQuantize(project.quantize)
  project.quantizePresets = project.quantizePresets ?? []
  project.record = { ...defaultRecord(project.loopEndSample || 0), ...(project.record || {}) }
  project.masterPlugins = migrateList(project.masterPlugins)
  project.automation = project.automation ?? []
  project.presets = (project.presets ?? []).flatMap((preset) => {
    const next = migratePreset(preset)
    return next ? [next] : []
  })
  project.masterInserts = project.masterInserts ?? []
  for (const track of project.tracks) {
    normalizeTrackScaler(track)
    if (track.instrument === 'pads' || track.padKit) track.padKit = normalizePadKit(track.padKit)
    track.armed = track.armed === true
    track.plugins = migrateList(track.plugins)
    track.sends = track.sends ?? []
    track.inserts = track.inserts ?? []
    track.output = track.output ?? null
    track.groupId = track.groupId ?? null
    if (track.inserts.length && track.plugins.length === 0) {
      for (const insert of track.inserts) track.plugins.push(fromLegacy(insert))
      track.inserts = []
    }
    migrateScalerTrack(track)
  }
  if (project.masterInserts.length && project.masterPlugins.length === 0) {
    for (const insert of project.masterInserts) project.masterPlugins.push(fromLegacy(insert))
    project.masterInserts = []
  }
  if (!project.masterPlugins.some((plugin) => plugin.pluginId === 'limiter')) {
    const limiter = createPlugin('limiter', 'Transparent')
    limiter.enabled = false
    project.masterPlugins.push(limiter)
  }
  return normalizeMix(project)
}

function migrateList(list: PluginInstance[] | undefined): PluginInstance[] {
  const out: PluginInstance[] = []
  for (const plugin of list ?? []) {
    const next = migratePlugin(fillInstrument(plugin), defaultParams)
    if (next) out.push(next)
  }
  return out
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

/** The factory or saved preset whose full parameter set matches, if any. */
export function activePresetName(pluginId: string, params: Record<string, number>, user: UserPreset[] = []) {
  const base = defaultParams(pluginId)
  const keys = Object.keys(base)
  if (!keys.length) return ''
  const list = [...(FACTORY[pluginId] ?? []), ...user.filter((item) => item.pluginId === pluginId)]
  for (const preset of list) {
    const full = { ...base, ...preset.params }
    const match = keys.every((key) => Math.abs((params[key] ?? full[key] ?? 0) - (full[key] ?? 0)) < 0.001)
    if (match) return preset.name
  }
  return ''
}

export function presetParams(pluginId: string, name: string, user: UserPreset[]) {
  const factory = (FACTORY[pluginId] ?? []).find((item) => item.name === name)
  if (factory) return { ...defaultParams(pluginId), ...factory.params }
  const saved = user.find((item) => item.pluginId === pluginId && item.name === name)
  if (saved) return { ...defaultParams(pluginId), ...saved.params }
  return null
}

export function automationAt(
  lanes: AutomationLane[],
  pluginId: string,
  params: Record<string, number>,
  beat: number,
  into?: Record<string, number>,
  keys?: readonly string[],
) {
  const next = into ?? { ...params }
  if (into) {
    if (keys && keys.length) {
      for (let i = 0; i < keys.length; i++) next[keys[i]] = params[keys[i]]
    } else {
      for (const key of Object.keys(params)) next[key] = params[key]
    }
  }
  for (const lane of lanes) {
    if (lane.target && lane.target !== 'plugin') continue
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
