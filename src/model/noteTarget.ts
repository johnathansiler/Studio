/** Where the on-screen keyboard, computer keys, and MIDI input may go. */

export const INSTRUMENT_HINT = 'Select an instrument track'

export interface NotePlugin {
  id: string
  pluginId: string
  enabled: boolean
}

export interface NoteTrack {
  id: string
  type: string
  armed: boolean
  input?: string
  plugins?: NotePlugin[]
}

export type NoteTarget =
  | { kind: 'instrument'; trackId: string; armed: boolean }
  | { kind: 'tune'; trackId: string; pluginId: string }
  | { kind: 'silent' }

/** The selected track only. An audio track plays notes when Auto-Tune can hold a MIDI target. */
export function noteTarget(tracks: NoteTrack[], selectedId: string | null): NoteTarget {
  const selected = tracks.find((track) => track.id === selectedId)
  if (!selected) return { kind: 'silent' }
  if (selected.type === 'midi') return { kind: 'instrument', trackId: selected.id, armed: selected.armed }
  const tune = selected.plugins?.find((plugin) => plugin.enabled && plugin.pluginId === 'tune')
  if (tune) return { kind: 'tune', trackId: selected.id, pluginId: tune.id }
  return { kind: 'silent' }
}

/** Hardware MIDI reaches the selected instrument unless that track is pinned to another port. */
export function hardwareReaches(input: string | undefined, portId: string): boolean {
  if (!input || input === 'none' || input === 'midi' || input === 'midi:all') return true
  return input === `midi:${portId}`
}
