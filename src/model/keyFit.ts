/**
 * How far to move a loop so it sits in the project key.
 * The short way around the clock wins, and never asks for more than six semitones.
 * A minor into C major is the same notes, so that pair does not move.
 */

import { NOTE_NAMES, scaleById, type ScaleId } from './scale'

export interface MusicalKey {
  root: number
  minor: boolean
  label: string
  scaleId: string
}

export interface KeyFit {
  semitones: number
  /** Relative major/minor already share the notes. */
  relative: boolean
  /** Major into minor, or the other way, with no relative match. The tonic still moves. */
  modesDiffer: boolean
  from: string
  to: string
}

const NAMES = NOTE_NAMES
const FLATS: Record<string, string> = {
  CB: 'B',
  DB: 'C#',
  EB: 'D#',
  FB: 'E',
  GB: 'F#',
  AB: 'G#',
  BB: 'A#',
}

const MINOR_SCALES = new Set<string>([
  'aeolian',
  'dorian',
  'phrygian',
  'locrian',
  'harmonicMinor',
  'melodicMinor',
  'minorPentatonic',
  'blues',
  'phrygianDominant',
  'hungarianMinor',
])

export function projectKeyChosen(scale: { keySet?: boolean; root?: number; scale?: string; library?: string } | null | undefined) {
  if (!scale) return false
  if (scale.keySet) return true
  if ((scale.root ?? 0) !== 0) return true
  if (scale.scale && scale.scale !== 'ionian') return true
  if (scale.library) return true
  return false
}

export function projectMusicalKey(scale: { root?: number; scale?: string; library?: string; keySet?: boolean } | null | undefined): MusicalKey | null {
  if (!projectKeyChosen(scale) || !scale) return null
  const root = ((Math.round(scale.root ?? 0) % 12) + 12) % 12
  const scaleId = scaleById(scale.scale).id
  const minor = MINOR_SCALES.has(scaleId)
  return { root, minor, label: keyLabel(root, scaleId), scaleId }
}

export function parseMusicalKey(value: string | undefined | null): MusicalKey | null {
  const text = (value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  if (!text) return null
  const match = text.match(/^([a-g])\s*([#b♯♭]?)\s*(major|minor|maj|min|m)?$/)
  if (!match) return null
  let accidental = match[2] ?? ''
  if (accidental === '♯') accidental = '#'
  if (accidental === '♭') accidental = 'b'
  let spelling = `${match[1].toUpperCase()}${accidental.toUpperCase()}`
  if (accidental === 'b') spelling = FLATS[spelling] ?? spelling
  const root = NAMES.indexOf(spelling as (typeof NAMES)[number])
  if (root < 0) return null
  const mode = match[3] ?? ''
  const minor = mode === 'minor' || mode === 'min' || mode === 'm'
  const scaleId = minor ? 'aeolian' : 'ionian'
  return { root, minor, label: keyLabel(root, scaleId), scaleId }
}

/** Smallest move from one tonic onto another, in −6..+6. +6 stays +6. */
export function nearestSemitones(from: number, to: number) {
  let delta = (((Math.round(to) - Math.round(from)) % 12) + 12) % 12
  if (delta > 6) delta -= 12
  return delta
}

export function fitToProject(loop: MusicalKey, project: MusicalKey): KeyFit {
  const relative = isRelative(loop, project)
  if (relative) {
    return { semitones: 0, relative: true, modesDiffer: false, from: loop.label, to: project.label }
  }
  const semitones = nearestSemitones(loop.root, project.root)
  const modesDiffer = loop.minor !== project.minor
  return { semitones, relative: false, modesDiffer, from: loop.label, to: project.label }
}

export function keyShiftPrompt(fit: KeyFit) {
  const sign = fit.semitones > 0 ? `+${fit.semitones}` : String(fit.semitones)
  const note = fit.modesDiffer ? ', tonic' : ''
  return `Loop is ${fit.from} — shift to project key ${fit.to}? (${sign} st${note})`
}

export function keyShiftReadout(clip: {
  stretch?: { semitones?: number } | null
  keyShift?: { semitones: number; to: string } | null
}) {
  const semis = Math.round(clip.stretch?.semitones ?? 0)
  if (!semis || !clip.keyShift?.to) return null
  const extra = semis - clip.keyShift.semitones
  const label = extra === 0 ? clip.keyShift.to : transposeLabel(clip.keyShift.to, extra)
  const sign = semis > 0 ? `+${semis}` : String(semis)
  return `Key: ${shortKey(label)} (shifted ${sign})`
}

/** Missing kind is a loop track. A vocal track never offers the shift. */
export function trackAcceptsLoopKey(track: { type?: string; kind?: unknown } | null | undefined) {
  if (!track || track.type !== 'audio') return false
  return track.kind !== 'vocal'
}

export function clipIsRecordedTake(source: string | undefined) {
  return source === 'local' || source === 'aligned-take'
}

export function nameIsDrum(name: string | undefined, tags?: string[]) {
  const hay = `${name ?? ''} ${(tags ?? []).join(' ')}`.toLowerCase()
  return /\b(drums?|kicks?|snares?|hats?|percussion|percs?|claps?|shakers?|cymbals?|tambourines?)\b/.test(hay)
}

function isRelative(loop: MusicalKey, project: MusicalKey) {
  if (loop.minor === project.minor) return false
  if (loop.minor && project.scaleId === 'ionian' && loop.scaleId === 'aeolian') {
    return (loop.root + 3) % 12 === project.root
  }
  if (!loop.minor && project.scaleId === 'aeolian' && loop.scaleId === 'ionian') {
    return (loop.root + 9) % 12 === project.root
  }
  return false
}

function keyLabel(root: number, scaleId: string) {
  const name = NAMES[((root % 12) + 12) % 12]
  if (scaleId === 'ionian') return `${name} major`
  if (scaleId === 'aeolian') return `${name} minor`
  const spec = scaleById(scaleId as ScaleId)
  return `${name} ${spec.name.toLowerCase()}`
}

function shortKey(label: string) {
  return label.replace(/minor/g, 'min').replace(/major/g, 'maj')
}

function transposeLabel(label: string, semitones: number) {
  const parsed = parseMusicalKey(label)
  if (!parsed) return label
  const root = (parsed.root + semitones + 120) % 12
  return keyLabel(root, parsed.scaleId)
}
