export interface GlideChange {
  pointerId: number
  /** Key the pointer left. Null when the pointer was not holding one. */
  off: number | null
  /** Key the pointer entered. Null when it lifted or slid off the keyboard. */
  on: number | null
}

/**
 * One held key per pointer. A slide onto a new key releases the previous key
 * before the new note-on. Pointers do not affect each other.
 * `move` does nothing until that pointer has pressed a key.
 */
export function glideUpdate(
  held: ReadonlyMap<number, number>,
  pointerId: number,
  pitch: number | null,
  phase: 'down' | 'move' | 'up',
): { held: Map<number, number>; change: GlideChange | null } {
  const next = new Map(held)
  const current = held.get(pointerId)
  if (phase === 'move' && current == null) return { held: next, change: null }
  if (phase === 'up' || pitch == null) {
    if (current == null) return { held: next, change: null }
    next.delete(pointerId)
    return { held: next, change: { pointerId, off: current, on: null } }
  }
  if (current === pitch) return { held: next, change: null }
  next.set(pointerId, pitch)
  return { held: next, change: { pointerId, off: current ?? null, on: pitch } }
}

export interface GlideStamp {
  pointerId: number
  phase: 'down' | 'move' | 'up'
  pitch: number | null
  /** performance.now() / event.timeStamp of the pointer event. */
  timeMs: number
}

export interface GlideNote {
  pointerId: number
  pitch: number
  startMs: number
  endMs: number
}

/** Note spans taken from the pointer timestamps, not from when the handler runs. */
export function glideNotes(events: GlideStamp[]): GlideNote[] {
  let held = new Map<number, number>()
  const open = new Map<number, { pitch: number; startMs: number }>()
  const notes: GlideNote[] = []
  for (const event of events) {
    const step = glideUpdate(held, event.pointerId, event.phase === 'up' ? null : event.pitch, event.phase)
    held = step.held
    if (!step.change) continue
    if (step.change.off != null) {
      const started = open.get(event.pointerId)
      open.delete(event.pointerId)
      if (started) notes.push({ pointerId: event.pointerId, pitch: started.pitch, startMs: started.startMs, endMs: event.timeMs })
    }
    if (step.change.on != null) open.set(event.pointerId, { pitch: step.change.on, startMs: event.timeMs })
  }
  return notes
}
