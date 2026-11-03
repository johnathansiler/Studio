/** Notes from the on-screen keyboard, committed the same way a MIDI take is. */

export interface ArmedKey {
  token: string
  trackId: string
  clipId: string | null
  clipStart: number
  pitch: number
  velocity: number
  startBeat: number
}

export interface RecordedKey {
  trackId: string
  clipId: string | null
  pitch: number
  /** Beat inside the clip when clipId is set, otherwise a song beat. */
  startBeat: number
  durationBeats: number
  velocity: number
}

export function armKey(keys: ArmedKey[], key: ArmedKey): ArmedKey[] {
  if (keys.some((item) => item.token === key.token)) return keys
  return [...keys, key]
}

export function releaseKey(keys: ArmedKey[], token: string, endBeat: number): { keys: ArmedKey[]; note: RecordedKey | null } {
  const found = keys.find((item) => item.token === token)
  if (!found) return { keys, note: null }
  const durationBeats = Math.max(0.05, endBeat - found.startBeat)
  const startBeat = found.clipId ? Math.max(0, found.startBeat - found.clipStart) : Math.max(0, found.startBeat)
  return {
    keys: keys.filter((item) => item.token !== token),
    note: {
      trackId: found.trackId,
      clipId: found.clipId,
      pitch: found.pitch,
      velocity: found.velocity,
      startBeat,
      durationBeats,
    },
  }
}

export interface KeyboardTake {
  trackId: string
  startBeat: number
  notes: { pitch: number; startBeat: number; durationBeats: number; velocity: number }[]
}

/** Loose notes (no open clip) become one take per track, matching a MIDI input take. */
export function takeGroups(notes: RecordedKey[]): KeyboardTake[] {
  const groups = new Map<string, RecordedKey[]>()
  for (const note of notes) {
    if (note.clipId) continue
    const list = groups.get(note.trackId) ?? []
    list.push(note)
    groups.set(note.trackId, list)
  }
  return [...groups.entries()].map(([trackId, list]) => {
    const start = Math.min(...list.map((note) => note.startBeat))
    return {
      trackId,
      startBeat: Math.max(0, start),
      notes: list
        .map((note) => ({
          pitch: note.pitch,
          startBeat: Math.max(0, note.startBeat - start),
          durationBeats: note.durationBeats,
          velocity: note.velocity,
        }))
        .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch),
    }
  })
}
