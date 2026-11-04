import type { PluginInstance, Track, TrackInstrument } from '../../model/types'
import { uid } from '../../model/types'
import { needsScalerSound, normalizeScaler, trackHasScaler } from './model'

export { needsScalerSound, trackHasScaler }

const HELD: TrackInstrument[] = ['synth', 'sampler', 'pads', 'drum-machine', 'library', '808']

/** A synth, sampler, or Beat Machine insert. Scaler sits in front of these. */
export function isSoundPlugin(plugin: { pluginId: string; params?: Record<string, number> }) {
  return plugin.pluginId === 'synth' || plugin.pluginId === 'sampler' || plugin.pluginId === 'pads'
}

export function isHeldSound(instrument: string | undefined): instrument is TrackInstrument {
  return !!instrument && (HELD as string[]).includes(instrument)
}

function drums(plugin: { pluginId: string; params?: Record<string, number> }) {
  return plugin.pluginId === 'sampler' && Math.round(plugin.params?.kind ?? 0) >= 1
}

/** The instrument a sound insert should play, when one is on the track. */
export function soundInstrumentOf(track: { plugins?: { pluginId: string; params?: Record<string, number> }[] }): TrackInstrument | null {
  const plugin = track.plugins?.find(isSoundPlugin)
  if (!plugin) return null
  if (plugin.pluginId === 'synth') return 'synth'
  if (drums(plugin) || plugin.pluginId === 'pads') return 'pads'
  return 'sampler'
}

export function scalerPlugin(): PluginInstance {
  return {
    id: uid('fx'),
    pluginId: 'scaler',
    version: '1',
    enabled: true,
    wet: 1,
    params: {},
    sidechain: '',
  }
}

/** MIDI effects, then the sound. Other inserts stay after the instrument. */
export function orderScalerPlugins(plugins: PluginInstance[]): PluginInstance[] {
  const scalers = plugins.filter((plugin) => plugin.pluginId === 'scaler')
  if (!scalers.length) return plugins
  const rest = plugins.filter((plugin) => plugin.pluginId !== 'scaler')
  const at = rest.findIndex(isSoundPlugin)
  if (at < 0) return [...scalers, ...rest]
  return [...rest.slice(0, at), ...scalers, ...rest.slice(at)]
}

export function ensureScalerPlugin(track: Track) {
  if (!track.plugins) track.plugins = []
  if (!track.plugins.some((plugin) => plugin.pluginId === 'scaler')) track.plugins.unshift(scalerPlugin())
  track.plugins = orderScalerPlugins(track.plugins)
}

/**
 * Old projects stored Scaler as the instrument and had no insert.
 * Keep that built-in voice until a synth, sampler, or Beat Machine is added.
 * A project that already has one of those keeps it as the sound under Scaler.
 */
export function migrateScalerTrack(track: Track) {
  if (track.type !== 'midi') return
  const legacy = track.instrument === 'scaler' || !!track.scaler
  const has = (track.plugins ?? []).some((plugin) => plugin.pluginId === 'scaler')
  if (!legacy && !has) return
  ensureScalerPlugin(track)
  const sound = soundInstrumentOf(track)
  if (sound) track.instrument = sound
  else if (track.instrument !== 'scaler') track.instrument = 'scaler'
}

export interface ChainSections {
  midi: PluginInstance[]
  sound: PluginInstance[]
  rest: PluginInstance[]
  /** Label under Sound when no synth, sampler, or Beat Machine insert is present. */
  caption: string | null
  addInstrument: boolean
}

/** Insert list groups. MIDI, then Sound. */
export function chainSections(track: Track): ChainSections {
  const plugins = track.plugins ?? []
  const midi = plugins.filter((plugin) => plugin.pluginId === 'scaler' || plugin.pluginId === 'steps')
  const sound = plugins.filter((plugin) => isSoundPlugin(plugin))
  const rest = plugins.filter((plugin) => !midi.includes(plugin) && !sound.includes(plugin))
  const caption = soundCaption(track)
  return {
    midi,
    sound,
    rest,
    caption,
    addInstrument: caption === 'Scaler sound',
  }
}

export function soundCaption(track: Track): string | null {
  if (!trackHasScaler(track)) return null
  if (track.plugins?.some(isSoundPlugin)) return null
  if (track.instrument === 'sampler') return 'Sampler'
  if (track.instrument === 'pads' || track.instrument === 'drum-machine' || track.instrument === '808') return 'Beat Machine'
  if (track.instrument === 'library') return 'Library'
  if (track.instrument === 'synth') return 'Synth'
  const state = normalizeScaler(track.scaler)
  if (state.sound === 'library') return 'Library'
  if (state.sound === 'forward') return 'Track'
  return 'Scaler sound'
}
