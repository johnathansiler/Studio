import { isDrumsPlugin } from '../../audio/plugins/ids'

/** User-facing name of the pad beat machine. */
export const BEAT_MACHINE_NAME = 'Beat Machine'

/** Track-header control that opens the beat machine again. */
export const OPEN_BEAT_MACHINE = 'Open Beat Machine'

/**
 * Ids that still reach the beat machine.
 * `pads` is the track instrument. `drums` is the track-sheet control.
 * `drum-machine` is the legacy kit id. `sampler` is the stored plugin id
 * when its kind is drums (see `isDrumsPlugin`).
 */
export const BEAT_MACHINE_IDS = ['sampler', 'pads', 'drums', 'drum-machine'] as const

export type BeatMachineId = (typeof BEAT_MACHINE_IDS)[number]

export function isBeatMachineId(id: string): id is BeatMachineId {
  return (BEAT_MACHINE_IDS as readonly string[]).includes(id)
}

/** Plugin and device ids that swap a MIDI track onto the beat machine. A plain sampler insert stays chromatic. */
export function insertsBeatMachine(id: string): boolean {
  return id === 'pads' || id === 'drums' || id === 'drum-machine'
}

export function pluginIsBeatMachine(plugin: { pluginId: string; params?: Record<string, number> }): boolean {
  return insertsBeatMachine(plugin.pluginId) || isDrumsPlugin(plugin)
}

/** Header control once this instrument track is the beat machine, so the panel can be opened again. */
export function showsOpenBeatMachine(track: {
  type: string
  instrument?: string
  plugins?: { pluginId: string; params?: Record<string, number> }[]
}): boolean {
  if (track.type !== 'midi') return false
  if (track.instrument === 'pads' || track.instrument === 'drum-machine') return true
  return !!track.plugins?.some((plugin) => pluginIsBeatMachine(plugin))
}
