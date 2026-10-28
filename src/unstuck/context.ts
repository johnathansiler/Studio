/** Build a SongContext from the project, or fill in a partial one from analysis. */

import { renderPattern } from '../model/steps'
import { detectKey, normalizeScale, pitchClass, scaleById, type ScaleId } from '../model/scale'
import { quartersPerBar, samplesToBeats } from '../model/time'
import type { MidiNote, Project, Track } from '../model/types'
import type { ChordBar, ContextTrack, MelodyNote, Mode, SectionKind, SongContext, SongContextInput, SongSection, TrackRole } from './types'
import { chordFromPitches, modeOfScale, romanFor, scaleForMode } from './theory'

const DRUM_PITCHES = new Set([35, 36, 37, 38, 39, 40, 41, 42, 44, 45, 46, 47, 48, 49, 51])

const SECTION_WORDS: { pattern: RegExp; kind: SectionKind }[] = [
  { pattern: /pre[-\s]?chorus|prechorus/, kind: 'pre-chorus' },
  { pattern: /post[-\s]?chorus|postchorus/, kind: 'post-chorus' },
  { pattern: /break/, kind: 'breakdown' },
  { pattern: /chorus|hook/, kind: 'chorus' },
  { pattern: /bridge/, kind: 'bridge' },
  { pattern: /drop/, kind: 'drop' },
  { pattern: /intro/, kind: 'intro' },
  { pattern: /outro|ending/, kind: 'outro' },
  { pattern: /verse/, kind: 'verse' },
]

interface AbsNote {
  pitch: number
  start: number
  dur: number
  velocity: number
  muted: boolean
  role: TrackRole
  trackId: string
}

export function normalizeSongContext(input: SongContextInput): SongContext {
  const beatsPerBar = clampBar(input.beatsPerBar)
  const mode = input.mode ?? modeOfScale(input.scale)
  const chords = (input.chordsByBar ?? []).map((chord) => ({ ...chord, symbol: chord.symbol.trim() })).filter((chord) => chord.symbol)
  const melody = (input.melodyNotes ?? []).filter((note) => Number.isFinite(note.pitch) && note.durationBeats > 0)
  const noteEnd = melody.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0)
  const chordEnd = chords.reduce((max, chord) => Math.max(max, (chord.bar + 1) * (chord.beats || beatsPerBar)), 0)
  const contentEndBeat = Math.max(0, input.contentEndBeat ?? Math.max(noteEnd, chordEnd))
  const sections = normalizeSections(input.sections ?? [], contentEndBeat, beatsPerBar)
  const tracks = input.tracks ?? []
  const activeRoles = input.activeRoles ?? [...new Set(tracks.filter((track) => !track.muted).map((track) => track.role))]
  return {
    key: ((input.key % 12) + 12) % 12,
    scale: input.scale || scaleForMode(mode),
    mode,
    tempo: clampTempo(input.tempo),
    beatsPerBar,
    chordsByBar: chords,
    sections,
    melodyNotes: melody,
    playheadBeat: Math.max(0, input.playheadBeat ?? 0),
    tracks,
    contentEndBeat,
    activeRoles,
  }
}

/** Fallback until analysis supplies a SongContext. Harmonic MIDI becomes chords; monophonic lines become the melody. */
export function deriveSongContext(project: Project, playheadBeat = 0): SongContext {
  const beatsPerBar = clampBar(quartersPerBar(project.timeSignature))
  const roles = new Map<string, TrackRole>()
  for (const track of project.tracks) roles.set(track.id, roleOf(track))
  const notes = collectNotes(project, roles)
  const harmonic = notes.filter((note) => !note.muted && (note.role === 'chords' || note.role === 'pad' || note.role === 'other'))
  const tonal = chooseKey(project, harmonic)
  const melody = collectMelody(notes)
  const contentEndBeat = contentEnd(project, notes, melody)
  const bars = Math.max(0, Math.ceil((contentEndBeat - 1e-6) / beatsPerBar))
  const chordsByBar = chordsInBars(harmonic.filter((note) => note.role !== 'other' || isStackTone(note, harmonic)), tonal.key, tonal.mode, beatsPerBar, bars)
  const named = sectionsFromNames(project, beatsPerBar)
  const active = new Set<TrackRole>()
  for (const track of project.tracks) {
    if (track.mute) continue
    const role = roles.get(track.id) ?? 'other'
    if (notes.some((note) => note.trackId === track.id && !note.muted)) active.add(role)
  }
  if (patternHasDrums(project)) active.add('drums')
  const tracks: ContextTrack[] = project.tracks
    .filter((track) => track.type === 'midi')
    .map((track) => ({ id: track.id, name: track.name, role: roles.get(track.id) ?? 'other', muted: track.mute }))
  return normalizeSongContext({
    key: tonal.key,
    scale: tonal.scale,
    mode: tonal.mode,
    tempo: project.tempo,
    beatsPerBar,
    chordsByBar,
    sections: named,
    melodyNotes: melody,
    playheadBeat,
    tracks,
    contentEndBeat,
    activeRoles: [...active],
  })
}

export function landingBeat(context: SongContext): number {
  const bar = context.beatsPerBar
  const after = Math.ceil(Math.max(0, context.contentEndBeat - 1e-6) / bar) * bar
  const playBar = Math.ceil(Math.max(0, context.playheadBeat - 1e-6) / bar) * bar
  return playBar > after ? playBar : after
}

/** Bars an arrangement change rewrites: the last four, or the whole song if it is shorter. */
export function editSpan(context: SongContext): { start: number; bars: number } {
  const bar = context.beatsPerBar
  if (context.contentEndBeat <= 1e-6) return { start: landingBeat(context), bars: 4 }
  const endBar = Math.ceil((context.contentEndBeat - 1e-6) / bar)
  const bars = Math.min(4, Math.max(1, endBar))
  const startBar = Math.max(0, endBar - bars)
  return { start: startBar * bar, bars: endBar - startBar }
}

export function currentSection(context: SongContext): SectionKind {
  const bar = context.beatsPerBar
  const lastBar = Math.max(0, Math.ceil(Math.max(0, context.contentEndBeat - 1e-6) / bar) - 1)
  let kind: SectionKind = context.sections[0]?.kind ?? 'verse'
  for (const section of context.sections) {
    if (section.startBar <= lastBar) kind = section.kind
  }
  return kind
}

export function recentSymbols(context: SongContext): string[] {
  return context.chordsByBar.map((chord) => chord.symbol)
}

function chooseKey(project: Project, notes: AbsNote[]): { key: number; scale: string; mode: Mode } {
  const scale = normalizeScale(project.scale)
  const mode = modeOfScale(scale.scale)
  if (!notes.length) return { key: scale.root, scale: scale.scale, mode }
  const cover = coverage(notes, scale.root, scale.scale)
  if (cover >= 0.62) return { key: scale.root, scale: scale.scale, mode }
  const found = detectKey(notes.map((note) => ({ pitch: note.pitch, weight: note.dur })))
  return { key: found.root, scale: found.scale, mode: modeOfScale(found.scale) }
}

function coverage(notes: AbsNote[], root: number, scale: string): number {
  const intervals = scaleById(scale as ScaleId).intervals
  let hit = 0
  let total = 0
  for (const note of notes) {
    const weight = Math.max(0.01, note.dur)
    total += weight
    if (intervals.some((interval) => interval === pitchClass(note.pitch - root))) hit += weight
  }
  return total ? hit / total : 1
}

function collectNotes(project: Project, roles: Map<string, TrackRole>): AbsNote[] {
  const notes: AbsNote[] = []
  for (const track of project.tracks) {
    if (track.type !== 'midi') continue
    const role = roles.get(track.id) ?? 'other'
    for (const clip of track.midiClips) {
      if (clip.slotOnly) continue
      for (const note of clip.notes) notes.push(absNote(note, clip.startBeat, role, track.id))
    }
  }
  return notes
}

function absNote(note: MidiNote, clipStart: number, role: TrackRole, trackId: string): AbsNote {
  return {
    pitch: note.pitch,
    start: clipStart + note.startBeat,
    dur: note.durationBeats,
    velocity: note.velocity,
    muted: !!note.muted,
    role,
    trackId,
  }
}

function collectMelody(notes: AbsNote[]): MelodyNote[] {
  const sung = notes.filter((note) => !note.muted && note.role === 'melody')
  if (sung.length) return sung.map(toMelody)
  const pool = notes.filter((note) => !note.muted && (note.role === 'chords' || note.role === 'other' || note.role === 'pad'))
  return pool.filter((note) => !isStackTone(note, pool) && note.dur < 2).map(toMelody)
}

function toMelody(note: AbsNote): MelodyNote {
  return { pitch: note.pitch, startBeat: note.start, durationBeats: note.dur, velocity: note.velocity }
}

function isStackTone(note: AbsNote, pool: AbsNote[]): boolean {
  const bucket = Math.round(note.start * 16) / 16
  let count = 0
  for (const other of pool) {
    if (other.trackId !== note.trackId || other.muted) continue
    if (Math.round(other.start * 16) / 16 === bucket) count += 1
    if (count >= 2) return true
  }
  return false
}

function chordsInBars(notes: AbsNote[], key: number, mode: Mode, beatsPerBar: number, bars: number): ChordBar[] {
  const chords: ChordBar[] = []
  const sounding = notes.filter((note) => !note.muted && note.role !== 'drums' && note.role !== 'bass' && note.role !== 'melody')
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * beatsPerBar
    const end = start + beatsPerBar
    const stack = stackAt(sounding, start, end)
    if (!stack.length) continue
    const parsed = chordFromPitches(stack.map((note) => note.pitch))
    if (!parsed) continue
    chords.push({
      bar,
      symbol: romanFor(parsed.root, parsed.intervals, key, mode),
      root: parsed.root,
      pitches: stack.map((note) => note.pitch),
      beats: beatsPerBar,
    })
  }
  return chords
}

function stackAt(notes: AbsNote[], start: number, end: number): AbsNote[] {
  const groups = new Map<number, AbsNote[]>()
  for (const note of notes) {
    if (note.start >= end || note.start + note.dur <= start) continue
    const bucket = Math.round(note.start * 16) / 16
    const list = groups.get(bucket) ?? []
    list.push(note)
    groups.set(bucket, list)
  }
  let best: AbsNote[] = []
  let bestScore = -1
  for (const [bucket, group] of groups) {
    if (group.length < 2 && best.length >= 2) continue
    const near = bucket <= start + (end - start) * 0.35 ? 2 : 0
    const score = group.length * 2 + near - Math.abs(bucket - start)
    if (score > bestScore) {
      best = group
      bestScore = score
    }
  }
  if (best.length) return best
  return notes.filter((note) => note.start <= start + 0.15 && note.start + note.dur > start + 0.05)
}

function sectionsFromNames(project: Project, beatsPerBar: number): SongSection[] {
  const found: SongSection[] = []
  for (const track of project.tracks) {
    for (const clip of track.midiClips) {
      if (clip.slotOnly) continue
      const kind = kindFromName(clip.name)
      if (!kind) continue
      const startBar = Math.max(0, Math.floor(clip.startBeat / beatsPerBar))
      const bars = Math.max(1, Math.round(clip.durationBeats / beatsPerBar))
      found.push({ kind, startBar, bars })
    }
  }
  found.sort((a, b) => a.startBar - b.startBar)
  return found
}

function kindFromName(name: string): SectionKind | null {
  const text = name.toLowerCase()
  for (const word of SECTION_WORDS) {
    if (word.pattern.test(text)) return word.kind
  }
  return null
}

function contentEnd(project: Project, notes: AbsNote[], melody: MelodyNote[]): number {
  let end = 0
  for (const note of notes) if (!note.muted) end = Math.max(end, note.start + note.dur)
  for (const note of melody) end = Math.max(end, note.startBeat + note.durationBeats)
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.slotOnly) continue
      const start = samplesToBeats(clip.startSample, project.sampleRate, project.tempo)
      const length = clip.durationBeats ?? samplesToBeats(clip.durationSamples, project.sampleRate, project.tempo)
      end = Math.max(end, start + length)
    }
  }
  for (const clip of project.patternClips ?? []) end = Math.max(end, clip.startBeat + clip.lengthBeats)
  return end
}

function patternHasDrums(project: Project): boolean {
  const rack = project.beats
  if (!rack || !project.patternClips?.length) return false
  for (const clip of project.patternClips) {
    const pattern = rack.patterns.find((item) => item.id === clip.patternId)
    if (!pattern) continue
    const hits = renderPattern(pattern, 0, Math.min(clip.lengthBeats, 4))
    if (hits.some((hit) => hit.kind === 'kick' || hit.kind === 'snare' || hit.kind === 'hat' || hit.kind === 'clap')) return true
  }
  return false
}

export function roleOf(track: Track): TrackRole {
  const name = track.name.toLowerCase()
  if (/drum|perc|beat(?!s)/.test(name) || name === 'beats') return 'drums'
  if (/bass|808/.test(name)) return 'bass'
  if (/pad|string|atmos/.test(name)) return 'pad'
  if (/melody|lead|vocal|topline|hum/.test(name)) return 'melody'
  if (/chord|key|piano|harm|guitar|rhodes|organ/.test(name)) return 'chords'
  const notes = track.midiClips.flatMap((clip) => clip.slotOnly ? [] : clip.notes)
  if (!notes.length) return 'other'
  const drums = notes.filter((note) => DRUM_PITCHES.has(note.pitch)).length
  if (drums / notes.length >= 0.7 && notes.every((note) => note.pitch < 70)) return 'drums'
  const maxStack = maxSimultaneous(notes)
  const median = medianPitch(notes)
  if (maxStack <= 1 && median < 52) return 'bass'
  if (maxStack <= 1 && median >= 64) return 'melody'
  if (maxStack >= 2) return 'chords'
  return 'other'
}

function maxSimultaneous(notes: MidiNote[]): number {
  let max = 1
  for (const note of notes) {
    const bucket = Math.round(note.startBeat * 16) / 16
    let count = 0
    for (const other of notes) {
      if (Math.round(other.startBeat * 16) / 16 === bucket) count += 1
    }
    if (count > max) max = count
  }
  return max
}

function medianPitch(notes: MidiNote[]): number {
  const sorted = notes.map((note) => note.pitch).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 60
}

function normalizeSections(sections: SongSection[], contentEndBeat: number, beatsPerBar: number): SongSection[] {
  const clean = sections
    .filter((section) => section.bars > 0)
    .map((section) => ({ kind: section.kind, startBar: Math.max(0, section.startBar), bars: Math.max(1, section.bars) }))
  if (clean.length) return clean
  const bars = Math.max(1, Math.round(contentEndBeat / beatsPerBar) || 1)
  return [{ kind: 'verse', startBar: 0, bars }]
}

function clampBar(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 4
  return Math.max(1, Math.min(12, value))
}

function clampTempo(value: number): number {
  if (!Number.isFinite(value)) return 120
  return Math.max(40, Math.min(240, value))
}
