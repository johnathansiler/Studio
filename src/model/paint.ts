import { patternNotes, snapPitch, type ScaleId } from './scale'
import type { MidiNote } from './types'

export type RollTool = 'paint' | 'brush' | 'pen' | 'slice' | 'glue' | 'mute' | 'erase' | 'velocity' | 'cc'

export const ROLL_TOOLS: RollTool[] = ['paint', 'brush', 'pen', 'slice', 'glue', 'mute', 'erase', 'velocity', 'cc']

export interface RollMemory {
  tool: RollTool
  /** 0 is free. Otherwise the grid in quarter-note beats. */
  grid: number
  length: number
  velocity: number
}

export function defaultRoll(): RollMemory {
  return { tool: 'pen', grid: 0.25, length: 0.25, velocity: 0.8 }
}

export function snapBeat(beat: number, grid: number): number {
  const safe = Math.max(0, beat)
  if (!(grid > 0)) return safe
  return Math.max(0, Math.round(safe / grid) * grid)
}

export interface PaintedNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  muted?: boolean
}

/** Repeated notes of `length` from the drag start through the drag end. */
export function paintNotes(args: {
  fromBeat: number
  toBeat: number
  pitch: number
  grid: number
  length: number
  velocity: number
  scaleLock: boolean
  root: number
  scale: ScaleId
}): PaintedNote[] {
  const length = Math.max(0.05, args.length)
  const grid = args.grid > 0 ? args.grid : length
  const start = snapBeat(Math.min(args.fromBeat, args.toBeat), args.grid)
  const far = snapBeat(Math.max(args.fromBeat, args.toBeat), args.grid)
  const end = far > start + 1e-9 ? far : start + grid
  const pitch = args.scaleLock ? snapPitch(args.pitch, args.root, args.scale) : Math.round(args.pitch)
  const notes: PaintedNote[] = []
  for (let beat = start; beat < end - 1e-6; beat += grid) {
    notes.push({ pitch, startBeat: beat, durationBeats: Math.min(length, grid), velocity: args.velocity })
  }
  return notes.length ? notes : [{ pitch, startBeat: start, durationBeats: length, velocity: args.velocity }]
}

/** Chord stamp locked to the scale. The painted pitch picks the root. */
export function chordStamp(args: {
  beat: number
  pitch: number
  length: number
  velocity: number
  grid: number
  root: number
  scale: ScaleId
  intervals: readonly number[]
}): PaintedNote[] {
  const beat = snapBeat(args.beat, args.grid)
  const rootPitch = snapPitch(args.pitch, args.root, args.scale)
  const degree = args.intervals.indexOf(((rootPitch - args.root) % 12 + 12) % 12)
  const picks = degree < 0 ? [0] : [0, 2, 4]
  return picks.map((offset) => {
    const interval = args.intervals[(Math.max(0, degree) + offset) % args.intervals.length]
    const wrapped = degree < 0 ? 0 : interval < args.intervals[degree] ? interval + 12 : interval
    const pitch = degree < 0 ? rootPitch : rootPitch - args.intervals[degree] + wrapped
    return { pitch, startBeat: beat, durationBeats: Math.max(0.05, args.length), velocity: args.velocity }
  })
}

export function paintChords(args: {
  fromBeat: number
  toBeat: number
  pitch: number
  grid: number
  length: number
  velocity: number
  root: number
  scale: ScaleId
  intervals: readonly number[]
}): PaintedNote[] {
  const length = Math.max(0.05, args.length)
  const grid = args.grid > 0 ? args.grid : length
  const start = snapBeat(Math.min(args.fromBeat, args.toBeat), args.grid)
  const far = snapBeat(Math.max(args.fromBeat, args.toBeat), args.grid)
  const end = far > start + 1e-9 ? far : start + grid
  const notes: PaintedNote[] = []
  for (let beat = start; beat < end - 1e-6; beat += grid) {
    notes.push(...chordStamp({ ...args, beat, length: Math.min(length, grid) }))
  }
  return notes
}

export function sliceNote(note: MidiNote, atBeat: number): [MidiNote, MidiNote] | null {
  const cut = atBeat - note.startBeat
  if (cut <= 0.02 || cut >= note.durationBeats - 0.02) return null
  return [
    { ...note, durationBeats: cut },
    { ...note, id: `${note.id}b`, startBeat: note.startBeat + cut, durationBeats: note.durationBeats - cut },
  ]
}

export function glueNotes(notes: MidiNote[]): MidiNote[] {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  const out: MidiNote[] = []
  for (const note of sorted) {
    const prev = out[out.length - 1]
    if (prev && prev.pitch === note.pitch && note.startBeat <= prev.startBeat + prev.durationBeats + 0.03) {
      const end = Math.max(prev.startBeat + prev.durationBeats, note.startBeat + note.durationBeats)
      prev.durationBeats = end - prev.startBeat
      prev.velocity = Math.max(prev.velocity, note.velocity)
    } else out.push({ ...note })
  }
  return out
}

export function eraseNotes(notes: MidiNote[], fromBeat: number, toBeat: number, pitch: number | null): MidiNote[] {
  const start = Math.min(fromBeat, toBeat)
  const end = Math.max(fromBeat, toBeat)
  return notes.filter((note) => {
    if (pitch != null && note.pitch !== pitch) return true
    const noteEnd = note.startBeat + note.durationBeats
    return noteEnd <= start || note.startBeat >= end
  })
}

export function quantizeNotes(notes: MidiNote[], grid: number, only?: string[]): MidiNote[] {
  return notes.map((note) => (!only || only.includes(note.id) ? { ...note, startBeat: snapBeat(note.startBeat, grid) } : note))
}

/** Scaler arp, written from the earliest selected note. */
export function arpeggiateSelection(
  notes: MidiNote[],
  options: { arp?: 'off' | 'up' | 'down' | 'upDown' | 'random'; rate?: number; gate?: number; octaves?: number; timing?: number; velocity?: number; spanBeats?: number; rng?: () => number },
): MidiNote[] {
  if (!notes.length) return []
  const start = Math.min(...notes.map((note) => note.startBeat))
  const played = patternNotes(notes.map((note) => note.pitch), {
    arp: options.arp && options.arp !== 'off' ? options.arp : 'up',
    rate: options.rate ?? 0.25,
    gate: options.gate ?? 0.8,
    octaves: options.octaves ?? 1,
    timing: options.timing ?? 0,
    velocity: options.velocity ?? 0,
    spanBeats: options.spanBeats ?? 4,
    rng: options.rng,
  })
  return played.map((note, index) => ({
    id: `${notes[0].id}_arp${index}`,
    pitch: note.pitch,
    startBeat: start + note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
  }))
}

export function strumSelection(notes: MidiNote[], gap = 0.03): MidiNote[] {
  if (!notes.length) return []
  const start = Math.min(...notes.map((note) => note.startBeat))
  const span = Math.max(...notes.map((note) => note.startBeat + note.durationBeats)) - start
  const played = patternNotes(
    [...notes].sort((a, b) => a.pitch - b.pitch).map((note) => note.pitch),
    { rhythm: 'strum', timing: gap, spanBeats: Math.max(0.25, span) },
  )
  return played.map((note, index) => ({
    id: `${notes[0].id}_strum${index}`,
    pitch: note.pitch,
    startBeat: start + note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
  }))
}

/** Same timing and velocity nudge Scaler uses at the end of patternNotes. */
export function humanizeNotes(notes: MidiNote[], timing: number, velocity: number, rng: () => number = Math.random): MidiNote[] {
  const time = Math.max(0, Math.min(0.2, timing))
  const vel = Math.max(0, Math.min(1, velocity))
  return notes.map((note) => ({
    ...note,
    startBeat: Math.max(0, note.startBeat + (rng() - 0.5) * 2 * time),
    velocity: Math.max(0.05, Math.min(1, note.velocity * (1 + (rng() - 0.5) * 2 * vel))),
  }))
}

export interface CcPoint {
  beat: number
  value: number
}

export function paintCc(points: CcPoint[], fromBeat: number, toBeat: number, value: number, grid: number): CcPoint[] {
  const start = snapBeat(Math.min(fromBeat, toBeat), grid)
  const end = snapBeat(Math.max(fromBeat, toBeat), grid)
  const step = grid > 0 ? grid : 0.25
  const next = points.filter((point) => point.beat < start - 1e-6 || point.beat > end + step)
  for (let beat = start; beat <= end + 1e-6; beat += step) next.push({ beat, value: Math.max(0, Math.min(1, value)) })
  next.sort((a, b) => a.beat - b.beat)
  return next
}
