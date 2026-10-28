/** Write a suggestion onto the project. The store snapshots first, so undo restores it. */

import { normalizeScale, type ScaleId } from '../model/scale'
import { quartersPerBar } from '../model/time'
import { makeTrack, uid, type MidiClip, type MidiNote, type Project, type Track } from '../model/types'
import { roleOf } from './context'
import { scaleForMode } from './theory'
import type { ArrangementOp, PartRole, Suggestion, SuggestionNote, TrackRole } from './types'

const META: Record<TrackRole, { name: string; color: string }> = {
  chords: { name: 'Chords', color: '#e0b15a' },
  bass: { name: 'Bass', color: '#79b8d4' },
  drums: { name: 'Drums', color: '#c58be0' },
  melody: { name: 'Melody', color: '#73c48f' },
  pad: { name: 'Pad', color: '#f09a6a' },
  other: { name: 'Unstuck', color: '#ef6b6b' },
}

export function applySuggestion(project: Project, suggestion: Suggestion): { trackId: string | null; clipId: string | null } {
  const bar = Math.max(1, quartersPerBar(project.timeSignature))
  const start = Math.max(0, suggestion.startBeat)
  const end = start + Math.max(1, suggestion.bars) * bar
  const arrangement = suggestion.arrangement
  if (arrangement?.dropRoles?.length) {
    for (const role of arrangement.dropRoles) muteRole(project, role, start, end)
  }
  if (arrangement?.dropPitches?.length) mutePitches(project, arrangement.dropPitches, start, end)
  if (arrangement?.replaceDrums) clearDrums(project, start, end)
  if (affectsDrums(arrangement)) trimPatterns(project, start, end)
  if (suggestion.kind === 'harmonize') muteStacks(trackFor(project, 'chords'), start, end)

  let trackId: string | null = null
  let clipId: string | null = null
  for (const part of suggestion.parts) {
    if (part.write === false || !part.notes.length) continue
    const track = trackFor(project, part.role)
    const placed = placeNotes(track, start, part.notes, suggestion.line || suggestion.title)
    trackId = track.id
    if (placed) clipId = placed
  }
  if (suggestion.modulation) {
    const scale = normalizeScale(project.scale)
    project.scale = {
      ...scale,
      root: ((suggestion.modulation.key % 12) + 12) % 12,
      scale: (suggestion.modulation.scale || scaleForMode(suggestion.modulation.mode)) as ScaleId,
    }
  }
  if (!trackId && arrangement?.dropRoles?.includes('drums')) {
    const drums = project.tracks.find((track) => track.type === 'midi' && roleOf(track) === 'drums')
    trackId = drums?.id ?? null
  }
  return { trackId, clipId }
}

function affectsDrums(arrangement: ArrangementOp | undefined): boolean {
  if (!arrangement) return false
  return !!arrangement.replaceDrums || !!arrangement.dropRoles?.includes('drums') || !!arrangement.dropPitches?.length
}

function trackFor(project: Project, role: PartRole): Track {
  const want: TrackRole = role === 'fill' ? 'drums' : role
  const existing = project.tracks.find((track) => track.type === 'midi' && roleOf(track) === want)
  if (existing) return existing
  const meta = META[want]
  const track = makeTrack({ name: meta.name, type: 'midi', color: meta.color, input: 'none' })
  project.tracks.push(track)
  return track
}

function placeNotes(track: Track, absoluteStart: number, notes: SuggestionNote[], name: string): string | null {
  const end = absoluteStart + notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0)
  const clip = track.midiClips.find((item) => overlaps(item, absoluteStart, end))
  if (clip) {
    for (const note of notes) clip.notes.push(toNote(note, note.startBeat + absoluteStart - clip.startBeat))
    const relEnd = end - clip.startBeat
    if (relEnd > clip.durationBeats) clip.durationBeats = relEnd
    return clip.id
  }
  const created: MidiClip = {
    id: uid('midi'),
    name,
    startBeat: absoluteStart,
    durationBeats: Math.max(0.25, end - absoluteStart),
    notes: notes.map((note) => toNote(note, note.startBeat)),
  }
  track.midiClips.push(created)
  return created.id
}

function overlaps(clip: MidiClip, start: number, end: number): boolean {
  if (clip.slotOnly) return false
  return clip.startBeat < end - 1e-4 && clip.startBeat + clip.durationBeats > start + 1e-4
}

function toNote(note: SuggestionNote, startBeat: number): MidiNote {
  return {
    id: uid('note'),
    pitch: Math.round(note.pitch),
    startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
  }
}

function forNotes(track: Track, start: number, end: number, visit: (note: MidiNote) => void) {
  for (const clip of track.midiClips) {
    if (clip.slotOnly) continue
    for (const note of clip.notes) {
      const abs = clip.startBeat + note.startBeat
      if (abs >= start - 1e-4 && abs < end - 1e-4) visit(note)
    }
  }
}

function muteRole(project: Project, role: TrackRole, start: number, end: number) {
  for (const track of project.tracks) {
    if (track.type !== 'midi' || roleOf(track) !== role) continue
    forNotes(track, start, end, (note) => {
      note.muted = true
    })
  }
}

function mutePitches(project: Project, pitches: number[], start: number, end: number) {
  const want = new Set(pitches)
  for (const track of project.tracks) {
    if (track.type !== 'midi' || roleOf(track) !== 'drums') continue
    forNotes(track, start, end, (note) => {
      if (want.has(note.pitch)) note.muted = true
    })
  }
}

function clearDrums(project: Project, start: number, end: number) {
  for (const track of project.tracks) {
    if (track.type !== 'midi' || roleOf(track) !== 'drums') continue
    for (const clip of track.midiClips) {
      if (clip.slotOnly) continue
      clip.notes = clip.notes.filter((note) => {
        const abs = clip.startBeat + note.startBeat
        return abs < start - 1e-4 || abs >= end - 1e-4
      })
    }
    track.midiClips = track.midiClips.filter((clip) => clip.slotOnly || clip.notes.length > 0)
  }
}

function muteStacks(track: Track, start: number, end: number) {
  for (const clip of track.midiClips) {
    if (clip.slotOnly) continue
    const groups = new Map<number, MidiNote[]>()
    for (const note of clip.notes) {
      const abs = clip.startBeat + note.startBeat
      if (abs < start - 1e-4 || abs >= end - 1e-4) continue
      const bucket = Math.round(note.startBeat * 16) / 16
      const list = groups.get(bucket) ?? []
      list.push(note)
      groups.set(bucket, list)
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      for (const note of group) note.muted = true
    }
  }
}

function trimPatterns(project: Project, start: number, end: number) {
  if (!project.patternClips?.length) return
  const next = []
  for (const clip of project.patternClips) {
    const clipEnd = clip.startBeat + clip.lengthBeats
    if (clipEnd <= start + 1e-4 || clip.startBeat >= end - 1e-4) {
      next.push(clip)
      continue
    }
    if (clip.startBeat < start - 1e-4) next.push({ ...clip, lengthBeats: start - clip.startBeat })
    if (clipEnd > end + 1e-4) next.push({ ...clip, id: uid('pat'), startBeat: end, lengthBeats: clipEnd - end })
  }
  project.patternClips = next
}
