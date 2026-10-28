import type { GeneratorSettings } from '../generators/types'
import { activeScaleId, followSource } from '../generators/adapt'
import { normalizePlayer } from '../players/settings'
import type { ScaleState } from '../model/scale'
import type { QuantizeSettings } from '../model/quantize'
import type { AudioClip, PluginInstance, Project, Track } from '../model/types'

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

export function selectSpectral(store: { project: Project; spectralTrackId: string | null; spectralClipId: string | null }) {
  const track = store.project.tracks.find((item) => item.id === store.spectralTrackId) ?? null
  const clip = track?.clips.find((item) => item.id === store.spectralClipId) ?? null
  return {
    project: store.project,
    track,
    clip,
    repair: clip?.spectral ?? null,
    sampleRate: store.project.sampleRate,
  }
}

export function selectClipRepair(clip: AudioClip | null | undefined) {
  return clip?.spectral ?? null
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
