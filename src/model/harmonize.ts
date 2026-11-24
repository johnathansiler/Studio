/**
 * Move every melodic clip onto one key.
 * Drums, one-shots, effects, Beat Machine, and vocal tracks stay put.
 * The short way around the clock is used, from −6 to +5.
 * A minor into C major is the same notes, so that pair does not move.
 */

import { keyFromFilename, keyFromText } from '../library/musicalKey'
import { isBeatMachineInstrument } from './beatKeys'
import { isDrumTrack } from './drumLanes'
import {
  MINOR_SCALES,
  fitToProject,
  nameIsDrum,
  parseMusicalKey,
  projectMusicalKey,
  type KeyFit,
  type MusicalKey,
} from './keyFit'
import { NOTE_NAMES, detectKey } from './scale'
import type { AudioClip, MidiClip, Project, Track } from './types'

export interface HarmonizeMeta {
  type?: string
  category?: string
  tags?: string[]
  musicalKey?: string
  instrument?: string
  name?: string
  /** Catalog object path, used when the row itself was not loaded. */
  key?: string
}

export interface HeardKey {
  clear: boolean
  root: number | null
  minor: boolean
  label: string
}

export interface HarmonizeShift {
  action: 'shift'
  trackId: string
  clipId: string
  name: string
  kind: 'audio' | 'midi'
  fromRoot: number
  fromMinor: boolean
  from: string
  to: string
  semitones: number
  tonicOnly: boolean
}

export interface HarmonizeSkip {
  action: 'skip'
  trackId: string
  clipId: string
  name: string
  kind: 'audio' | 'midi'
  reason: string
}

export interface HarmonizeListen {
  action: 'listen'
  trackId: string
  clipId: string
  name: string
  kind: 'audio'
}

export type HarmonizeRow = HarmonizeShift | HarmonizeSkip | HarmonizeListen

const MELODIC = new Set([
  'guitar', 'keys', 'piano', 'bass', 'synth', 'synths', 'strings', 'string',
  'brass', 'lead', 'pad', 'pads', 'organ', 'choir', 'melody', 'chord', 'chords',
  'music', 'pluck', 'arp', 'horn', 'winds', 'mallet', 'marimba', 'flute', 'sax',
  'violin', 'cello', 'rhodes', 'epiano',
])

const DRUMS = new Set([
  'drum', 'drums', 'kick', 'snare', 'hat', 'hi-hat', 'hihat', 'clap', 'cymbal',
  'tom', 'shaker', 'rim', '808', 'cowbell', 'tambourine', 'crash', 'ride',
  'conga', 'clave', 'perc',
])

/** A clear MIDI key. Below this the notes are treated as having no key. */
const MIDI_CLEAR = 0.45

export function musicalKey(root: number, minor: boolean): MusicalKey {
  const pc = ((Math.round(root) % 12) + 12) % 12
  const name = NOTE_NAMES[pc]
  return {
    root: pc,
    minor,
    label: `${name} ${minor ? 'minor' : 'major'}`,
    scaleId: minor ? 'aeolian' : 'ionian',
  }
}

/** Smallest move, in −6..+5. A tritone goes down. Relative major and minor stay. */
export function harmonizeMove(from: MusicalKey, to: MusicalKey): KeyFit {
  const fit = fitToProject(from, to)
  if (fit.semitones === 6) return { ...fit, semitones: -6 }
  return fit
}

export function formatHarmonizeSemitones(semitones: number) {
  if (semitones > 0) return `+${semitones}`
  return String(semitones)
}

export function mostCommonKey(keys: MusicalKey[]): MusicalKey | null {
  if (!keys.length) return null
  const counts = new Map<string, { key: MusicalKey; n: number; index: number }>()
  keys.forEach((key, index) => {
    const id = `${key.root}:${key.minor ? 1 : 0}`
    const row = counts.get(id)
    if (row) row.n += 1
    else counts.set(id, { key, n: 1, index })
  })
  let best: { key: MusicalKey; n: number; index: number } | null = null
  for (const row of counts.values()) {
    if (!best || row.n > best.n || (row.n === best.n && row.index < best.index)) best = row
  }
  return best?.key ?? null
}

/** Song key when the musician has set one. Otherwise the key most of the harmonic clips already use. */
export function defaultHarmonizeKey(
  scale: { keySet?: boolean; root?: number; scale?: string; library?: string } | null | undefined,
  shifts: Pick<HarmonizeShift, 'fromRoot' | 'fromMinor'>[],
): MusicalKey {
  if (scale?.keySet) {
    const project = projectMusicalKey(scale)
    if (project) return musicalKey(project.root, project.minor)
  }
  return mostCommonKey(shifts.map((row) => musicalKey(row.fromRoot, row.fromMinor))) ?? musicalKey(0, false)
}

export function retargetHarmonize(rows: HarmonizeRow[], target: MusicalKey): HarmonizeRow[] {
  return rows.map((row) => {
    if (row.action !== 'shift') return row
    const move = harmonizeMove(musicalKey(row.fromRoot, row.fromMinor), target)
    return { ...row, to: target.label, semitones: move.semitones, tonicOnly: move.modesDiffer }
  })
}

export function harmonizeGate(rows: HarmonizeRow[]): { open: boolean; toast: string } {
  if (!rows.length) {
    return { open: false, toast: 'Nothing to harmonize yet. Drop a melodic loop or play some MIDI notes.' }
  }
  const useful = rows.some((row) => row.action === 'shift' || row.action === 'listen' || (row.action === 'skip' && row.reason === 'Vocal track'))
  if (useful) return { open: true, toast: '' }
  return { open: false, toast: 'Nothing to harmonize. Drums, one-shots, and SFX stay put.' }
}

export function midiClipKey(notes: { pitch: number; durationBeats?: number }[]): MusicalKey | null {
  if (!notes.length) return null
  const found = detectKey(notes.map((note) => ({ pitch: note.pitch, weight: Math.max(0.01, note.durationBeats ?? 1) })))
  if (!(found.score >= MIDI_CLEAR)) return null
  return musicalKey(found.root, MINOR_SCALES.has(found.scale))
}

export function transposeMidiNotes(notes: { pitch: number }[], semitones: number) {
  if (!semitones) return
  for (const note of notes) {
    const next = Math.round(note.pitch) + semitones
    note.pitch = Math.max(0, Math.min(127, next))
  }
}

export function harmonizeRows(
  project: Project,
  metaFor: (bufferId: string) => HarmonizeMeta | null,
  heard: ReadonlyMap<string, HeardKey | null>,
  options: { includeVocals: boolean },
): HarmonizeRow[] {
  const rows: HarmonizeRow[] = []
  for (const track of project.tracks) {
    for (const clip of track.clips) rows.push(audioRow(track, clip, metaFor(clip.bufferId), heard.get(clip.id), options.includeVocals))
    for (const clip of track.midiClips) rows.push(midiRow(track, clip))
  }
  return rows
}

function audioRow(
  track: Track,
  clip: AudioClip,
  meta: HarmonizeMeta | null,
  heard: HeardKey | null | undefined,
  includeVocals: boolean,
): HarmonizeRow {
  const name = clip.name?.trim() || 'Audio clip'
  const base = { trackId: track.id, clipId: clip.id, name, kind: 'audio' as const }
  if (track.kind === 'vocal' && !includeVocals) return { ...base, action: 'skip', reason: 'Vocal track' }
  const machine = midiMachine(track)
  if (machine) return { ...base, action: 'skip', reason: machine }
  const metaRole = libraryRole(mergeMeta(meta), name)
  if (metaRole === 'oneshot') return { ...base, action: 'skip', reason: 'One-shot' }
  if (metaRole === 'sfx') return { ...base, action: 'skip', reason: 'SFX' }
  if (metaRole === 'percussion') return { ...base, action: 'skip', reason: 'Percussion' }
  if (metaRole === 'drum') return { ...base, action: 'skip', reason: clip.stretch?.mode === 'beats' || /loop/i.test(name) ? 'Drum loop' : 'Drums' }
  if (clip.stretch?.mode === 'beats') return { ...base, action: 'skip', reason: 'Drum loop' }
  const tagged = taggedKey(clip, meta)
  if (!tagged) {
    if (heard === undefined) return { ...base, action: 'listen' }
    if (!heard?.clear || heard.root == null) return { ...base, action: 'skip', reason: 'No clear key' }
    return shiftRow(base, musicalKey(heard.root, heard.minor))
  }
  return shiftRow(base, tagged)
}

function midiRow(track: Track, clip: MidiClip): HarmonizeRow {
  const name = clip.name?.trim() || 'MIDI clip'
  const base = { trackId: track.id, clipId: clip.id, name, kind: 'midi' as const }
  const machine = midiMachine(track)
  if (machine) return { ...base, action: 'skip', reason: machine }
  if (clip.patternId) return { ...base, action: 'skip', reason: 'Beat pattern' }
  if (!track.instrument && nameIsDrum(track.name)) return { ...base, action: 'skip', reason: 'Drums' }
  if (!clip.notes.length) return { ...base, action: 'skip', reason: 'No notes' }
  const key = midiClipKey(clip.notes)
  if (!key) return { ...base, action: 'skip', reason: 'No clear key' }
  return shiftRow(base, key)
}

function shiftRow(base: { trackId: string; clipId: string; name: string; kind: 'audio' | 'midi' }, from: MusicalKey): HarmonizeShift {
  return {
    ...base,
    action: 'shift',
    fromRoot: from.root,
    fromMinor: from.minor,
    from: from.label,
    to: from.label,
    semitones: 0,
    tonicOnly: false,
  }
}

function midiMachine(track: Pick<Track, 'instrument'>): 'Beat Machine' | 'Drum kit' | null {
  if (track.instrument === 'pads' || (isBeatMachineInstrument(track.instrument) && track.instrument !== 'drum-machine')) return 'Beat Machine'
  if (track.instrument === 'drum-machine' || track.instrument === '808' || isDrumTrack(track)) return 'Drum kit'
  return null
}

function mergeMeta(meta: HarmonizeMeta | null): HarmonizeMeta | null {
  if (!meta) return null
  const inferred = inferPath(meta.key)
  return {
    ...inferred,
    ...meta,
    type: meta.type || inferred.type,
    category: meta.category || inferred.category,
    tags: meta.tags?.length ? meta.tags : inferred.tags,
  }
}

function inferPath(key: string | undefined): HarmonizeMeta {
  const path = (key ?? '').replace(/\\/g, '/').toLowerCase()
  if (!path) return {}
  if (/(^|\/)(sfx|fx)\//.test(path)) return { type: 'sfx' }
  if (/(^|\/)one[- ]?shots?\//.test(path)) return { type: 'one-shot' }
  if (/(^|\/)(drums?|percussion)\//.test(path)) return { type: 'loop', category: 'drums' }
  if (/(^|\/)loops?\//.test(path)) return { type: 'loop' }
  return {}
}

type LibraryRole = 'harmonic' | 'drum' | 'percussion' | 'oneshot' | 'sfx' | 'unknown'

function libraryRole(meta: HarmonizeMeta | null, name: string): LibraryRole {
  const type = clean(meta?.type)
  const category = clean(meta?.category)
  const tags = (meta?.tags ?? []).map(clean)
  const hay = `${name} ${meta?.name ?? ''} ${tags.join(' ')}`
  const loop = type === 'loop' || type === 'loops' || type === 'melodic-loop' || type === 'melodic loop' || type === 'instrument'
  if (type === 'multisample note') return 'oneshot'
  const melodic = MELODIC.has(category)
  if (type === 'one-shot' || type === 'one shot' || type === 'oneshot' || tags.includes('one-shot') || tags.includes('oneshot')) return 'oneshot'
  if (type === 'sfx' || type === 'fx' || category === 'sfx' || category === 'fx' || tags.includes('sfx')) return 'sfx'
  if (type === 'drum-kit' || type === 'drum kit' || type === 'kit' || category === 'drum-kit' || category === 'drum kit' || category === 'kit') return 'drum'
  if (category === 'percussion') return 'percussion'
  if (type === 'drum-loop' || type === 'drum loop') return 'drum'
  if (DRUMS.has(category) && !melodic) return 'drum'
  if (melodic) return 'harmonic'
  if (loop && !nameIsDrum(name, tags) && !nameIsDrum(meta?.name, tags)) return 'harmonic'
  if (loop) return 'drum'
  if (nameIsDrum(name, tags) || nameIsDrum(meta?.name, tags)) return 'drum'
  if (/\bone[- ]?shots?\b|\boneshots?\b/i.test(hay)) return 'oneshot'
  if (/\bsfx\b|\bsound effects?\b/i.test(hay)) return 'sfx'
  return 'unknown'
}

function taggedKey(clip: AudioClip, meta: HarmonizeMeta | null): MusicalKey | null {
  const candidates = [clip.loopKey, meta?.musicalKey, ...(meta?.tags ?? []), meta?.name, clip.name, meta?.key]
  for (const candidate of candidates) {
    const text = candidate?.trim()
    if (!text) continue
    const direct = parseMusicalKey(text)
    if (direct && /minor|major|maj|min|m/i.test(text.replace(/[_./-]+/g, ' '))) return direct
    const fromFile = keyFromFilename(text)
    if (fromFile) {
      const parsed = parseMusicalKey(fromFile.label)
      if (parsed) return parsed
    }
    const fromText = keyFromText(text)
    if (fromText) {
      const parsed = parseMusicalKey(fromText.label)
      if (parsed) return parsed
    }
  }
  if (clip.hearing?.clearKey && clip.hearing.key) return parseMusicalKey(clip.hearing.key)
  return null
}

function clean(value: string | undefined) {
  return (value ?? '').trim().toLowerCase()
}
