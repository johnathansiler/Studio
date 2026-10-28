import { normalizeScale } from './scale'
import { createEmptyProject, defaultRecord, type PluginInstance, type Project, type Track } from './types'

/** Set for the life of the tab. A reload keeps it; a new tab does not. */
export const TAB_LIVE = 'cueharbor-tab'
/** Id of the project this tab is editing, or NEW_PROJECT when it is still a blank. */
export const TAB_PROJECT = 'cueharbor-project'
export const NEW_PROJECT = 'new'

type TabStore = Pick<Storage, 'getItem' | 'setItem'>

export function readTab(storage: TabStore): { reload: boolean; current: string | null } {
  const reload = storage.getItem(TAB_LIVE) === '1'
  const current = storage.getItem(TAB_PROJECT)
  storage.setItem(TAB_LIVE, '1')
  return { reload, current }
}

/** An invite link is `?session=` with a code. That open joins the room. */
export function isSessionLink(search: string): boolean {
  const query = search.includes('?') ? search.slice(search.indexOf('?')) : search.startsWith('?') ? search : `?${search}`
  const code = (new URLSearchParams(query).get('session') || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return code.length > 0
}

export type LaunchPlan = 'restore' | 'empty'

/**
 * A new tab starts empty. Reloading the same tab restores.
 * A session invite restores, so the room opens instead of a blank project.
 * Reloading a tab whose project was never saved stays on that blank.
 */
export function planLaunch(input: { reload: boolean; search: string; current: string | null }): LaunchPlan {
  if (isSessionLink(input.search)) return 'restore'
  if (input.reload && input.current === NEW_PROJECT) return 'empty'
  if (input.reload) return 'restore'
  return 'empty'
}

/** Factory Vocal / Music / Keys session with no edits. Safe to skip in the project list. */
export function isUntouchedEmpty(project: Project): boolean {
  const blank = createEmptyProject(project.sampleRate)
  return project.name === blank.name && signature(project) === signature(blank)
}

export function shouldKeepProject(project: Project, bufferCount = 0): boolean {
  if (bufferCount > 0) return true
  return !isUntouchedEmpty(project)
}

function signature(project: Project): string {
  const loopEnd = project.loopEndSample || 0
  const record = { ...defaultRecord(loopEnd), ...(project.record || {}) }
  return JSON.stringify({
    tempo: project.tempo,
    timeSignature: project.timeSignature,
    masterVolume: project.masterVolume,
    loopEnabled: project.loopEnabled,
    loopStartSample: project.loopStartSample,
    loopEndSample: project.loopEndSample,
    metronomeEnabled: project.metronomeEnabled,
    countIn: project.countIn,
    snap: project.snap,
    launchQuant: project.launchQuant ?? '1bar',
    recordBars: project.recordBars ?? 4,
    tempoMap: project.tempoMap ?? [],
    waveforms: project.waveforms ?? {},
    automation: project.automation ?? [],
    presets: project.presets ?? [],
    devicePresets: project.devicePresets ?? [],
    rackPatches: project.rackPatches ?? [],
    rackAutomation: project.rackAutomation ?? [],
    omniLibrary: (project.omniLibrary ?? []).map((patch) => patch.name),
    masterInserts: project.masterInserts ?? [],
    masterPlugins: meaningfulPlugins(project.masterPlugins ?? []),
    record,
    scale: normalizeScale(project.scale),
    tracks: project.tracks.map(trackSignature),
  })
}

function meaningfulPlugins(plugins: PluginInstance[]) {
  return plugins
    .filter((plugin) => !(plugin.pluginId === 'limiter' && plugin.enabled === false))
    .map((plugin) => ({ id: plugin.pluginId, enabled: plugin.enabled, params: plugin.params }))
}

function trackSignature(track: Track) {
  return {
    name: track.name,
    type: track.type,
    color: track.color,
    volume: track.volume,
    pan: track.pan,
    mute: track.mute,
    solo: track.solo,
    armed: track.armed,
    monitor: track.monitor,
    input: track.input,
    channels: track.channels ?? null,
    instrument: track.instrument ?? null,
    output: track.output ?? null,
    groupId: track.groupId ?? null,
    inserts: track.inserts?.length ?? 0,
    plugins: (track.plugins ?? []).map((plugin) => ({ id: plugin.pluginId, enabled: plugin.enabled, params: plugin.params })),
    sends: track.sends?.length ?? 0,
    clips: track.clips.map((clip) => [clip.bufferId, clip.startSample, clip.durationSamples, clip.gain]),
    midi: track.midiClips.map((clip) => [clip.startBeat, clip.durationBeats, clip.notes.map((note) => [note.pitch, note.startBeat, note.durationBeats, note.velocity])]),
    rack: track.rack?.devices.map((device) => device.kind) ?? [],
    omni: track.omniPatch
      ? {
          name: track.omniPatch.name,
          enabled: track.omniPatch.enabled,
          x: track.omniPatch.morph.x,
          y: track.omniPatch.morph.y,
          wheel: track.omniPatch.modWheel,
          layers: track.omniPatch.layers.map((layer) => [
            layer.kind,
            layer.enabled ? 1 : 0,
            layer.level,
            layer.pan,
            layer.cutoff,
            layer.fxSend,
            layer.bufferId,
            layer.granular.position,
            layer.granular.freeze ? 1 : 0,
          ]),
          routes: track.omniPatch.routes.map((route) => [route.source, route.target, route.depth]),
        }
      : null,
    audioSlots: track.audioSlots ?? [],
    midiSlots: track.midiSlots ?? [],
  }
}
