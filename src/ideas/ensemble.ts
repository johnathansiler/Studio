/**
 * One seeded arrangement: the same progression under chords, bass, and melody.
 * Drums use the genre groove. Lock keeps a part's notes. A new salt rolls one part.
 */

import { generate } from '../generators/generate'
import type { GeneratedNote, GeneratorChord, ScaleInterval } from '../generators/types'
import { hashSeed, mulberry32, roundBeat } from '../generators/rng'
import { styleById } from '../generators/styles'
import { getScale } from '../theory/scales'
import { partGenre } from './genres'
import { fitsScale, mod12, nearestInScale } from './scaleFit'
import type { Ensemble, EnsemblePart, EnsembleRequest, PartNote, PartRole } from './types'

const PASSING = new Set(['trap', 'drill', 'rnb'])
const RICH = new Set(['lofi', 'rnb'])

export { PART_GENRES, partGenre } from './genres'

export function barsOf(value: number): 4 | 8 | 16 {
  if (value >= 12) return 16
  if (value >= 6) return 8
  return 4
}

export function generateEnsemble(raw: EnsembleRequest): Ensemble {
  const genre = partGenre(raw.genre)
  const style = styleById(genre.style)
  const bars = barsOf(raw.bars)
  const beatsPerBar = clamp(raw.beatsPerBar ?? 4, 1, 12)
  const key = mod12(raw.key)
  const scaleId = raw.scaleId || 'ionian'
  const seed = Number.isFinite(raw.seed) ? raw.seed >>> 0 : 1
  const complexity = clamp(raw.complexity, 0, 1)
  const energy = clamp(raw.energy, 0, 1)
  const swing = clamp(raw.swing, 0, 1)
  const tempo = clamp(raw.tempo, 40, 240)
  const salts = raw.salts ?? {}
  const locked = raw.locked ?? {}
  const roles = uniqueRoles(raw.roles)
  const scale = intervalsOf(scaleId)
  const total = bars * beatsPerBar
  const base = {
    key,
    scaleId,
    scale,
    tempo,
    bars,
    style: genre.style,
    beatsPerBar,
  }
  const chordSalt = salts.chords ?? 0
  const made = locked.chords
    ? null
    : generate('chords', { ...base, chords: [], seed: hashSeed(seed, chordSalt, 2), variation: chordSalt })
  const progression = locked.chords
    ? (raw.progression?.length ? raw.progression : progressionFrom(locked.chords, beatsPerBar, key))
    : made!.chords
  const parts: EnsemblePart[] = []
  for (const role of roles) {
    const salt = salts[role] ?? 0
    const name = `${style.name} ${role}`
    if (locked[role]) {
      parts.push({ role, name, notes: locked[role]!.map(copyNote), salt, locked: true })
      continue
    }
    const rawNotes = role === 'chords'
      ? made!.notes
      : generate(role, {
        ...base,
        chords: progression,
        seed,
        variation: salt,
      }).notes
    const shaped = shape(rawNotes, role, {
      genre: genre.id,
      scaleId,
      key,
      complexity,
      energy,
      swing,
      seed: hashSeed(seed, salt, roleSalt(role)),
      total,
      beatsPerBar,
    })
    parts.push({ role, name, notes: shaped, salt, locked: false })
  }
  const clipSwing = style.swing > 0.2 ? 0 : roundBeat(Math.min(0.9, swing * 0.7))
  return {
    seed,
    key,
    scaleId,
    tempo,
    genre: genre.id,
    bars,
    beatsPerBar,
    complexity,
    energy,
    swing,
    clipSwing,
    chords: progression.map((chord) => ({ ...chord, pitches: [...chord.pitches] })),
    parts,
  }
}

function uniqueRoles(roles: PartRole[]): PartRole[] {
  const out: PartRole[] = []
  for (const role of roles) {
    if (!out.includes(role)) out.push(role)
  }
  return out.length ? out : ['chords']
}

function intervalsOf(scaleId: string): ScaleInterval[] {
  return getScale(scaleId).cents.map((cents) => ({ semitones: cents / 100, cents: 0 }))
}

function roleSalt(role: PartRole) {
  if (role === 'bass') return 4
  if (role === 'melody') return 5
  if (role === 'drums') return 3
  return 2
}

interface Shape {
  genre: string
  scaleId: string
  key: number
  complexity: number
  energy: number
  swing: number
  seed: number
  total: number
  beatsPerBar: number
}

function shape(notes: GeneratedNote[], role: PartRole, shapeArgs: Shape): PartNote[] {
  const rng = mulberry32(shapeArgs.seed)
  let next = notes.map((note) => toPart(note))
  if (role === 'chords') next = colorChords(next, shapeArgs)
  if (role === 'melody') next = colorMelody(next, shapeArgs)
  if (role === 'drums') next = colorDrums(next, shapeArgs, rng)
  else next = next.map((note) => conform(note, role, shapeArgs))
  const gain = 0.55 + shapeArgs.energy * 0.5
  return next
    .filter((note) => note.startBeat >= -0.001 && note.startBeat < shapeArgs.total - 0.001)
    .map((note) => {
      const nudge = shapeArgs.swing > 0 ? roundBeat((rng() - 0.5) * shapeArgs.swing * 0.03) : 0
      return {
        ...note,
        pitch: clamp(Math.round(note.pitch), 0, 127),
        startBeat: roundBeat(Math.max(0, note.startBeat)),
        durationBeats: roundBeat(Math.max(0.05, note.durationBeats)),
        velocity: clamp(note.velocity * gain * (0.94 + rng() * 0.1), 0.05, 1),
        ...(nudge ? { nudge } : {}),
      }
    })
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
}

function toPart(note: GeneratedNote): PartNote {
  return {
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
    ...(note.fine ? { fine: note.fine } : {}),
    ...(note.slide ? { slide: true } : {}),
  }
}

function conform(note: PartNote, role: PartRole, shapeArgs: Shape): PartNote {
  if (fitsScale(note.pitch, note.fine, shapeArgs.scaleId, shapeArgs.key)) {
    return {
      pitch: note.pitch,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      velocity: note.velocity,
      ...(note.fine ? { fine: note.fine } : {}),
      ...(note.slide ? { slide: true } : {}),
      ...(note.nudge ? { nudge: note.nudge } : {}),
    }
  }
  if (role === 'bass' && PASSING.has(shapeArgs.genre)) return { ...note, passing: true }
  const snapped = nearestInScale(note.pitch, shapeArgs.scaleId, shapeArgs.key)
  return {
    pitch: snapped.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
    ...(snapped.fine ? { fine: snapped.fine } : {}),
    ...(note.slide ? { slide: true } : {}),
    ...(note.nudge ? { nudge: note.nudge } : {}),
  }
}

/** Lo-fi and R&B keep sevenths. A high complexity adds one more scale tone. A low one thins to triads. */
function colorChords(notes: PartNote[], shapeArgs: Shape): PartNote[] {
  const rich = RICH.has(shapeArgs.genre)
  const cap = shapeArgs.complexity < 0.34 ? (rich ? 4 : 3) : shapeArgs.complexity < 0.66 ? (rich ? 5 : 4) : 6
  const out: PartNote[] = []
  for (const group of groupAt(notes)) {
    const tones = [...group].sort((a, b) => a.pitch - b.pitch)
    const kept = tones.length > cap ? tones.slice(0, cap) : tones
    if (shapeArgs.complexity >= 0.66 && rich && kept.length < 6) {
      const top = Math.max(...kept.map((note) => note.pitch))
      const added = nearestInScale(top + 3, shapeArgs.scaleId, shapeArgs.key)
      if (added.pitch > top && added.pitch < 96 && !kept.some((note) => note.pitch === added.pitch)) {
        kept.push({ ...kept[0], pitch: added.pitch, fine: added.fine, velocity: 0.56 })
      }
    }
    out.push(...kept)
  }
  return out
}

function colorMelody(notes: PartNote[], shapeArgs: Shape): PartNote[] {
  if (shapeArgs.complexity >= 0.45) return notes
  const kept = notes.filter((note, index) => index % 2 === 0 || Math.abs(note.startBeat - Math.round(note.startBeat)) < 0.04)
  return kept.length >= 2 ? kept : notes
}

function colorDrums(notes: PartNote[], shapeArgs: Shape, rng: () => number): PartNote[] {
  if (shapeArgs.energy >= 0.5) return notes
  return notes.filter((note) => {
    const drum = note.pitch === 36 || note.pitch === 35 || note.pitch === 38 || note.pitch === 40
    if (drum) return true
    return rng() < 0.4 + shapeArgs.energy
  })
}

function groupAt(notes: PartNote[]): PartNote[][] {
  const groups: PartNote[][] = []
  for (const note of [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)) {
    const last = groups[groups.length - 1]
    if (!last || note.startBeat - last[0].startBeat > 0.08) groups.push([note])
    else last.push(note)
  }
  return groups
}

function progressionFrom(notes: PartNote[], beatsPerBar: number, key: number): GeneratorChord[] {
  const groups = groupAt(notes)
  return groups.map((group, index) => {
    const start = group[0].startBeat
    const next = groups[index + 1]?.[0].startBeat ?? start + beatsPerBar
    const lowest = Math.min(...group.map((note) => note.pitch))
    return {
      pitches: group.map((note) => note.pitch),
      beats: Math.max(0.25, next - start),
      root: mod12(lowest || key),
    }
  })
}

function copyNote(note: PartNote): PartNote {
  return { ...note }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
