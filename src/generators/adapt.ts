import { quartersPerBar } from '../model/time'
import { progressionById, spellProgression, voiceLead } from '../model/progressions'
import { normalizeScale } from '../model/scale'
import type { Project } from '../model/types'
import { findScale } from '../theory/scales'
import { mod12 } from './rng'
import { normalizeGenerator } from './settings'
import type { GeneratorChord, GeneratorInput, GeneratorSettings } from './types'

export interface FollowSource {
  chords: GeneratorChord[]
  source: 'track' | 'idea' | 'memory' | 'none'
}

/** Group MIDI into chords. Strums that share a pitch-class set stay one chord. */
export function chordsFromNotes(notes: { pitch: number; startBeat: number; durationBeats: number; fine?: number }[]): GeneratorChord[] {
  if (!notes.length) return []
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  const groups: { start: number; notes: typeof sorted }[] = []
  for (const note of sorted) {
    const last = groups[groups.length - 1]
    if (!last || note.startBeat - last.start > 0.12) groups.push({ start: note.startBeat, notes: [note] })
    else last.notes.push(note)
  }
  const merged: { start: number; end: number; pitches: number[]; cents: number[]; key: string }[] = []
  for (const group of groups) {
    const pitches = [...new Set(group.notes.map((note) => Math.round(note.pitch)))].sort((a, b) => a - b)
    const cents = pitches.map((pitch) => group.notes.find((note) => Math.round(note.pitch) === pitch)?.fine ?? 0)
    const key = pitches.map((pitch) => mod12(pitch)).join(',')
    const end = Math.max(group.start + 0.25, ...group.notes.map((note) => note.startBeat + note.durationBeats))
    const prev = merged[merged.length - 1]
    if (prev && prev.key === key && group.start <= prev.end + 0.2) prev.end = Math.max(prev.end, end)
    else merged.push({ start: group.start, end, pitches, cents, key })
  }
  return merged.map((chord, index) => {
    const next = merged[index + 1]
    const beats = next ? Math.max(0.25, next.start - chord.start) : Math.max(0.25, chord.end - chord.start)
    return {
      pitches: chord.pitches,
      ...(chord.cents.some((cent) => cent) ? { cents: chord.cents } : {}),
      beats,
      root: mod12(Math.min(...chord.pitches)),
    }
  })
}

export function followSource(project: Project): FollowSource {
  const track = project.tracks.find((item) => item.type === 'midi' && item.name === 'Chords')
  const notes = track?.midiClips.flatMap((clip) => clip.notes.map((note) => ({
    pitch: note.pitch,
    startBeat: note.startBeat + clip.startBeat,
    durationBeats: note.durationBeats,
    fine: note.fine,
  }))) ?? []
  const fromTrack = chordsFromNotes(notes)
  if (fromTrack.length) return { chords: fromTrack, source: 'track' }
  const memory = normalizeGenerator(project.generator).chords
  if (memory.length) return { chords: memory, source: 'memory' }
  const scale = normalizeScale(project.scale)
  const idea = scale.idea ? progressionById(scale.idea) : null
  if (!idea) return { chords: [], source: 'none' }
  const spelled = voiceLead(spellProgression(idea.chords, idea.mode, scale.root))
  return {
    source: 'idea',
    chords: spelled.map((chord) => ({
      pitches: chord.pitches,
      beats: chord.beats,
      symbol: chord.name,
      root: mod12(Math.min(...chord.pitches)),
    })),
  }
}

/** The scale the project is actually in: a library maqam when one is chosen, otherwise the built-in scale. */
export function activeScaleId(project: Project) {
  const scale = normalizeScale(project.scale)
  if (scale.library && findScale(scale.library)) return scale.library
  return scale.scale
}

export function generatorInput(project: Project, settings: GeneratorSettings, chords: GeneratorChord[]): GeneratorInput {
  const scale = normalizeScale(project.scale)
  const scaleId = activeScaleId(project)
  return {
    key: scale.root,
    scaleId,
    scale: [],
    chords: settings.kind === 'chords' ? [] : chords,
    tempo: project.tempo,
    bars: settings.bars,
    style: settings.style,
    seed: settings.seed,
    variation: settings.variation,
    beatsPerBar: quartersPerBar(project.timeSignature),
    options: {
      arpPattern: settings.arpPattern,
      rate: settings.rate,
      octaves: settings.octaves,
      gate: settings.gate,
      strum: settings.strum,
    },
  }
}
