/** Pad recording, quantize, choke, and kit assignment. Uses the shared pad machine. */

import { isDrumSound } from '../../sounds/catalog'
import { chokeTargets, recordTake, timingCorrect, type PadVoice, type RecordTakeMode } from '../../model/padMachine'

export interface PadHit {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  locks?: Record<string, number>
}

export interface PadSound {
  id: string
  name: string
  path: string
  type: string
  tags?: string[]
}

/** Shared loop, or one bar at the playhead when the loop is off. */
export function padRecordWindow(opts: {
  playheadBeat: number
  loopEnabled: boolean
  loopStartBeat: number
  loopEndBeat: number
  barBeats: number
}): { startBeat: number; durationBeats: number } {
  const bar = Math.max(0.25, opts.barBeats)
  if (opts.loopEnabled && opts.loopEndBeat > opts.loopStartBeat + 0.01) {
    return { startBeat: opts.loopStartBeat, durationBeats: opts.loopEndBeat - opts.loopStartBeat }
  }
  const start = Math.floor(Math.max(0, opts.playheadBeat) / bar) * bar
  return { startBeat: start, durationBeats: bar }
}

/** Timeline beat folded into the loop, then stored from the start of the clip. */
export function clipBeat(timelineBeat: number, clipStart: number, loopStart: number, loopEnd: number): number {
  const span = loopEnd - loopStart
  let beat = timelineBeat
  if (span > 0.01 && Number.isFinite(timelineBeat)) {
    const shifted = timelineBeat - loopStart
    beat = loopStart + ((shifted % span) + span) % span
  }
  const local = beat - clipStart
  if (!Number.isFinite(local) || local < 0) return 0
  return local
}

/** MPC swing. 0 is straight (50%). 0.5 is the classic 75% shuffle. */
export function swingPercent(amount: number): number {
  const unit = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0))
  return 50 + unit * 50
}

/** Grid pull, then MPC swing on the off-beat. Off leaves the beat where it was played. */
export function quantizePadBeat(beat: number, grid: number, strength: number, swing: number, enabled: boolean): number {
  return timingCorrect(beat, grid, strength, swing, enabled)
}

/** Overdub appends. Replace keeps notes outside the loop window. */
export function recordPadHits<T extends { startBeat: number }>(
  existing: T[],
  incoming: T[],
  mode: RecordTakeMode,
  loopStart: number,
  loopEnd: number,
): T[] {
  return recordTake(existing, incoming, mode, loopStart, loopEnd)
}

/** Pitches a new hit should cut. Empty when the pad is not in a choke group. */
export function chokeGroup(pads: { pitch: number; choke: number }[], pitch: number): number[] {
  return chokeTargets(pads, pitch)
}

/** Shorten notes a choke-group hit cuts off. */
export function applyChoke<T extends { pitch: number; startBeat: number; durationBeats: number }>(
  notes: T[],
  pads: { pitch: number; choke: number }[],
  hitPitch: number,
  hitBeat: number,
): T[] {
  const targets = new Set(chokeTargets(pads, hitPitch))
  if (!targets.size) return notes
  return notes.map((note) => {
    if (!targets.has(note.pitch)) return note
    if (note.startBeat >= hitBeat - 1e-9) return note
    const end = note.startBeat + note.durationBeats
    if (end <= hitBeat) return note
    return { ...note, durationBeats: Math.max(0.01, hitBeat - note.startBeat) }
  })
}

export interface PadAssignment {
  name: string
  bufferId?: string
  choke?: number
}

/** Put a library sound on a pad. The GM pitch stays so the mapping does not move. */
export function assignPad(pad: PadVoice, assignment: PadAssignment): PadVoice {
  return {
    ...pad,
    name: assignment.name.trim() || pad.name,
    choke: assignment.choke ?? pad.choke,
    layers: [{
      velocityLo: 0,
      velocityHi: 1,
      tune: 0,
      bufferId: assignment.bufferId,
    }],
  }
}

const ROLES: { words: string[]; avoid?: string[] }[] = [
  { words: ['kick'], avoid: ['snare'] },
  { words: ['snare'], avoid: ['rim'] },
  { words: ['rim'] },
  { words: ['clap'] },
  { words: ['hat'], avoid: ['open'] },
  { words: ['open'] },
  { words: ['tom'] },
  { words: ['tom'] },
  { words: ['tom'] },
  { words: ['crash'] },
  { words: ['ride'] },
  { words: ['tamb'] },
  { words: ['cow'] },
  { words: ['conga'] },
  { words: ['conga'] },
  { words: ['clave'] },
]

function soundHay(entry: PadSound): string {
  return `${entry.name} ${entry.path} ${entry.tags?.join(' ') ?? ''}`.toLowerCase()
}

/** A pad face shows the sound, wrapped, never cut off with an ellipsis. */
export function shortPadName(name: string): string {
  const head = name.split(/\s[–—-]\s/)[0]?.trim() || name
  const cleaned = head
    .replace(/\b(vel(?:ocity)?|rr|round)\s*\d+\b/gi, '')
    .replace(/\bsum\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || name.trim() || 'Pad'
}

/** Bank A slots filled from CC0 drum one-shots. The same catalog always picks the same files. */
export function pickDefaultKit(entries: PadSound[]): { index: number; id: string; name: string; path: string }[] {
  const pool = entries.filter((entry) => entry.type === 'one-shot' && isDrumSound({ name: entry.name, path: entry.path, tags: entry.tags ?? [] }))
  const used = new Set<string>()
  const picks: { index: number; id: string; name: string; path: string }[] = []
  ROLES.forEach((role, index) => {
    const found = pool.find((entry) => {
      if (used.has(entry.id)) return false
      const hay = soundHay(entry)
      if (role.avoid?.some((word) => hay.includes(word))) return false
      return role.words.every((word) => hay.includes(word))
    })
    if (!found) return
    used.add(found.id)
    picks.push({ index, id: found.id, name: found.name, path: found.path })
  })
  return picks
}
