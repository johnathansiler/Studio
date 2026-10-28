import type { GeneratorSettings } from '../generators/types'
import { activeScaleId, followSource } from '../generators/adapt'
import { normalizePlayer } from '../players/settings'
import type { ScaleState } from '../model/scale'
import type { QuantizeSettings } from '../model/quantize'
import { descriptor } from '../audio/plugins/catalog'
import { audibleIds } from '../model/audible'
import { findLane, modeOf, specKey, valueAtSample, type AutoSpec } from '../model/automation'
import { groupForTrack } from '../model/mixGroups'
import { DEVICE_PARAMS } from '../model/rack'
import type { PluginInstance, Project, Track } from '../model/types'

/**
 * Read models for the studio surfaces.
 * Views render these instead of keeping a private copy of the project.
 * A later UI change can keep calling the same selector.
 */
type Store = {
  project: Project
  scaleState(): ScaleState
  track(id: string): Track | undefined
  selectedMidiClipId: string | null
  launched: Record<string, string | null>
  quantizeOpen: boolean
  quantizeDraft: QuantizeSettings
}

export function selectProject(store: { project: Project }) {
  return store.project
}

export function selectArrange(store: { project: Project }) {
  return {
    project: store.project,
    tracks: store.project.tracks,
    tempo: store.project.tempo,
    snap: store.project.snap,
    timeSignature: store.project.timeSignature,
  }
}

export function selectMixer(store: { project: Project }) {
  return {
    project: store.project,
    tracks: store.project.tracks,
    masterVolume: store.project.masterVolume,
    masterPlugins: store.project.masterPlugins,
    tempo: store.project.tempo,
  }
}

export function selectBeats(store: { project: Project }) {
  const beats = store.project.beats
  const pattern = beats?.patterns.find((item) => item.id === beats.activeId) ?? beats?.patterns[0] ?? null
  return {
    project: store.project,
    pattern,
    patterns: beats?.patterns ?? [],
    tempo: store.project.tempo,
    tracks: store.project.tracks,
  }
}

export function selectSession(store: { project: Project; launched: Record<string, string | null> }) {
  return {
    project: store.project,
    tracks: store.project.tracks,
    tempo: store.project.tempo,
    launchQuant: store.project.launchQuant ?? '1bar',
    recordBars: store.project.recordBars ?? 0,
    launched: store.launched,
  }
}

export function selectTransport(store: { project: Project }) {
  return {
    project: store.project,
    tempo: store.project.tempo,
    timeSignature: store.project.timeSignature,
    masterVolume: store.project.masterVolume,
    loopEnabled: store.project.loopEnabled,
    metronomeEnabled: store.project.metronomeEnabled,
    snap: store.project.snap,
  }
}

export function selectScale(store: { scaleState(): ScaleState }) {
  return store.scaleState()
}

export function selectPiano(store: Pick<Store, 'project' | 'selectedMidiClipId' | 'scaleState'>) {
  const track = store.project.tracks.find((item) => item.midiClips.some((clip) => clip.id === store.selectedMidiClipId)) ?? null
  const clip = track?.midiClips.find((item) => item.id === store.selectedMidiClipId) ?? null
  return {
    project: store.project,
    track,
    clip,
    tempo: store.project.tempo,
    scale: store.scaleState(),
    roll: store.project.roll ?? null,
  }
}

export function selectInstrument(store: Pick<Store, 'project' | 'track'>, trackId: string) {
  const track = store.track(trackId) ?? null
  const program = track?.library ?? null
  return {
    project: store.project,
    track,
    program,
    mics: program?.mics ?? [],
    keyswitches: program?.keyswitches ?? [],
    activeSwitch: program?.defaultSwitch ?? null,
    zones: program?.zones.length ?? 0,
  }
}

export function selectRack(store: Pick<Store, 'project' | 'track'>, trackId: string) {
  const track = store.track(trackId) ?? null
  return {
    project: store.project,
    track,
    rack: track?.rack ?? null,
    tempo: store.project.tempo,
    patches: store.project.rackPatches,
    favorites: store.project.presetFavorites ?? [],
  }
}

export function selectPlugin(store: Pick<Store, 'project' | 'track'>, trackId: string, pluginId: string): PluginInstance | null {
  const list = trackId === 'master' ? store.project.masterPlugins : store.track(trackId)?.plugins
  return list?.find((item) => item.id === pluginId) ?? null
}

export function selectChain(store: Pick<Store, 'project' | 'track'>, trackId: string): PluginInstance[] {
  return trackId === 'master' ? store.project.masterPlugins : store.track(trackId)?.plugins ?? []
}

export function selectClip(store: { project: Project }, trackId: string, clipId: string) {
  const track = store.project.tracks.find((item) => item.id === trackId) ?? null
  const clip = track?.clips.find((item) => item.id === clipId) ?? null
  return { project: store.project, track, clip, tempo: store.project.tempo }
}

export function selectMaster(store: { project: Project }) {
  return {
    project: store.project,
    plugins: store.project.masterPlugins,
    inserts: store.project.masterInserts,
    volume: store.project.masterVolume,
    tempo: store.project.tempo,
  }
}

export function selectQuantize(store: Pick<Store, 'project' | 'quantizeOpen' | 'quantizeDraft'>) {
  return {
    open: store.quantizeOpen,
    draft: store.quantizeDraft,
    presets: store.project.quantizePresets ?? [],
    tempo: store.project.tempo,
  }
}

export function selectGenerator(store: { project: Project; generatorState(): GeneratorSettings; scaleState(): ScaleState }) {
  const scale = store.scaleState()
  return {
    project: store.project,
    settings: store.generatorState(),
    scale,
    scaleId: activeScaleId(store.project),
    tempo: store.project.tempo,
    timeSignature: store.project.timeSignature,
    tracks: store.project.tracks,
  }
}

export function selectPlayers(store: { project: Project }) {
  return {
    settings: normalizePlayer(store.project.players),
    follow: followSource(store.project),
  }
}

export function selectKnock(store: { project: Project }) {
  const track = store.project.tracks.find((item) => item.type === 'midi' && item.rack?.devices.some((device) => device.kind === 'knock')) ?? null
  const device = track?.rack?.devices.find((item) => item.kind === 'knock') ?? null
  return { project: store.project, track, device, tempo: store.project.tempo }
}

/** Sound browser. Favorites live on the project so every screen and device sees them. */
export function selectSounds(store: { project: Project; selectedTrackId: string | null }) {
  const tracks = store.project.tracks.filter((track) => track.type === 'audio')
  const selected = tracks.find((track) => track.id === store.selectedTrackId) ?? tracks[0] ?? null
  return {
    favorites: store.project.soundFavorites ?? [],
    tempo: store.project.tempo,
    sampleRate: store.project.sampleRate,
    tracks,
    trackId: selected?.id ?? null,
    trackName: selected?.name ?? '',
  }
}

export interface LaneChoice {
  key: string
  label: string
  min: number
  max: number
  spec: AutoSpec
}

export function automationWriteMode(project: Project) {
  return modeOf(project)
}

export function mixGroupsOf(project: Project) {
  return project.mixGroups ?? []
}

export function trackGroupId(project: Project, trackId: string) {
  return groupForTrack(project, trackId)?.id ?? null
}

export function trackAudible(project: Project, trackId: string) {
  return audibleIds(project.tracks).has(trackId)
}

export function laneChoices(project: Project, trackId: string): LaneChoice[] {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track) return []
  const choices: LaneChoice[] = [
    { key: specKey({ trackId, target: 'volume', param: 'volume', min: 0, max: 1.25 }), label: 'Volume', min: 0, max: 1.25, spec: { trackId, target: 'volume', param: 'volume', min: 0, max: 1.25 } },
    { key: specKey({ trackId, target: 'pan', param: 'pan', min: -1, max: 1 }), label: 'Pan', min: -1, max: 1, spec: { trackId, target: 'pan', param: 'pan', min: -1, max: 1 } },
  ]
  for (const send of track.sends) {
    const bus = project.tracks.find((item) => item.id === send.busId)
    const spec: AutoSpec = { trackId, target: 'send', param: 'gain', sendId: send.id, min: 0, max: 1 }
    choices.push({ key: specKey(spec), label: `${bus?.name ?? 'Send'} send`, min: 0, max: 1, spec })
  }
  for (const plugin of track.plugins) {
    const specDesc = descriptor(plugin.pluginId)
    for (const param of specDesc?.params ?? []) {
      const spec: AutoSpec = { trackId, target: 'plugin', param: param.id, pluginId: plugin.id, min: param.min, max: param.max }
      choices.push({ key: specKey(spec), label: `${specDesc?.name ?? plugin.pluginId} ${param.name}`, min: param.min, max: param.max, spec })
    }
  }
  for (const device of track.rack?.devices ?? []) {
    for (const param of DEVICE_PARAMS[device.kind] ?? []) {
      const spec: AutoSpec = { trackId, target: 'instrument', param: param.id, deviceId: device.id, min: param.min, max: param.max }
      choices.push({ key: specKey(spec), label: `${device.kind} ${param.name}`, min: param.min, max: param.max, spec })
    }
  }
  return choices
}

export function lanePoints(project: Project, spec: AutoSpec) {
  if (spec.target === 'instrument' && spec.deviceId) {
    return project.rackAutomation.find((lane) => lane.deviceId === spec.deviceId && lane.param === spec.param)?.points ?? []
  }
  return findLane(project, spec)?.points ?? []
}

export function automatedValue(project: Project, spec: AutoSpec, sample: number, fallback: number) {
  const points = lanePoints(project, spec)
  if (!points.length) return fallback
  return valueAtSample(points, sample, project.sampleRate, project.tempo, fallback)
}
