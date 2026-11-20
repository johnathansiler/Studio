/**
 * A variation keeps the clip's key, length, and motif, then dresses it.
 * Subtle moves a few notes. Medium answers the phrase. Bold rebuilds the line
 * and, from the second variation on, adds a fill. The source clip is not edited.
 */

import { documentFromClip } from '../audio/wave/edit'
import { hashSeed, mulberry32, roundBeat } from '../generators/rng'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { quartersPerBar } from '../model/time'
import { clonePattern, type BeatPattern, type PatternClip } from '../model/steps'
import { uid, type AudioClip, type MidiClip, type Project, type WaveEdit, type WaveRegion } from '../model/types'
import { readClip } from '../unstuck/read'
import { fitsScale, nearestInScale } from './scaleFit'
import type { PartNote, VaryAmount } from './types'

const VAR_NAME = /^(.*) \(var (\d+)\)$/

export interface VaryOptions {
  amount: VaryAmount
  seed: number
  /** Replace the latest variation instead of adding another. */
  reroll?: boolean
  audioId?: string | null
  midiId?: string | null
  patternId?: string | null
}

export function variationBase(name: string) {
  return name.match(VAR_NAME)?.[1] ?? name
}

export function variationIndex(name: string) {
  const match = name.match(VAR_NAME)
  return match ? Number(match[2]) : 0
}

export function variationName(name: string, index: number) {
  return `${variationBase(name)} (var ${index})`
}

/** How many notes do not match, counting pitch and sixteenth-note position. */
export function noteDelta(left: PartNote[], right: PartNote[]) {
  const keyOf = (note: PartNote) => `${note.pitch}:${Math.round(note.startBeat * 4)}`
  const pool = right.map(keyOf)
  const used = new Set<number>()
  let same = 0
  for (const note of left) {
    const key = keyOf(note)
    const at = pool.findIndex((item, index) => item === key && !used.has(index))
    if (at >= 0) {
      used.add(at)
      same += 1
    }
  }
  return left.length + right.length - same * 2
}

export function varyNotes(input: {
  notes: PartNote[]
  role: string
  amount: VaryAmount
  seed: number
  generation: number
  key: number
  scaleId: string
  lengthBeats: number
}): PartNote[] {
  const length = Math.max(0.25, input.lengthBeats)
  if (!input.notes.length) return []
  const source = input.notes.map(copyNote).sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  let next: PartNote[]
  if (input.role === 'drums') next = varyDrums(source, input.amount, input.generation, input.seed, length)
  else if (input.role === 'chords' || input.role === 'pad') next = varyChords(source, input.amount, input.generation, input.seed, input.key, input.scaleId, length)
  else if (input.role === 'bass') next = varyBass(source, input.amount, input.generation, input.seed, input.key, input.scaleId, length)
  else next = varyMelody(source, input.amount, input.generation, input.seed, input.key, input.scaleId, length)
  return fitLength(next, length, input.role !== 'drums', input.scaleId, input.key)
}

export function varyBeatPattern(pattern: BeatPattern, amount: VaryAmount, seed: number, generation: number): BeatPattern {
  const copy = structuredClone(pattern)
  const rng = mulberry32(hashSeed(seed, generation, 6))
  const steps = Math.max(1, copy.steps)
  for (const channel of copy.channels) {
    const width = Math.min(steps, channel.steps || steps, channel.cells.length)
    if (channel.kind === 'hat' || channel.kind === 'openhat') {
      for (let index = 0; index < width; index++) {
        const cell = channel.cells[index]
        if (amount === 'subtle' && index % 4 === 2 && !cell.on) {
          channel.cells[index] = { ...cell, on: true, velocity: 0.35 }
        }
        if (amount !== 'subtle' && index % 2 === 1) {
          channel.cells[index] = { ...cell, on: amount === 'bold' ? rng() > 0.25 : !cell.on, velocity: cell.on ? 0.48 : 0.62 }
        }
      }
    }
    if (channel.kind === 'kick' && amount !== 'subtle') {
      const at = amount === 'bold' ? 3 : 7
      if (at < width) {
        const cell = channel.cells[at]
        channel.cells[at] = { ...cell, on: !cell.on, velocity: 0.72 }
      }
    }
    if (channel.kind === 'snare' || channel.kind === 'clap') {
      for (let index = 0; index < width; index++) {
        const cell = channel.cells[index]
        if (amount !== 'bold' && index % 4 === 3 && !cell.on) {
          channel.cells[index] = { ...cell, on: true, velocity: 0.28 }
        }
      }
      if (amount === 'bold' || generation >= 2) {
        const from = Math.max(0, width - (amount === 'bold' ? 4 : 2))
        for (let index = from; index < width; index++) {
          const cell = channel.cells[index]
          channel.cells[index] = { ...cell, on: true, velocity: 0.45 + (index - from) * 0.1 }
        }
      }
    }
    if (channel.kind === 'perc' && amount === 'subtle') {
      const at = width > 6 ? 6 : width - 1
      const cell = channel.cells[at]
      if (cell) channel.cells[at] = { ...cell, on: !cell.on, velocity: 0.4 }
    }
  }
  return copy
}

/** Slice rearrangement. Vocal takes are chopped only: no reverse, and the file stays put. */
export function varyAudioEdit(clip: AudioClip, sourceLength: number, amount: VaryAmount, seed: number, generation: number, vocal: boolean): WaveEdit {
  const doc = documentFromClip(clip, sourceLength)
  const pieces = flatten(doc)
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const slices = amount === 'bold' ? 8 : 4
  const cut = slicePieces(pieces, slices)
  const rng = mulberry32(hashSeed(seed, generation, 8))
  let arranged = cut.map((piece) => ({ ...piece }))
  const swapAt = Math.min(arranged.length - 2, Math.floor(rng() * Math.max(1, arranged.length - 1)))
  if (arranged.length >= 2) {
    const right = Math.min(arranged.length - 1, Math.max(1, swapAt + 1))
    const hold = arranged[swapAt]
    arranged[swapAt] = arranged[right]
    arranged[right] = hold
  }
  if (!vocal && (amount !== 'subtle' || generation >= 2) && arranged.length) {
    const last = arranged[arranged.length - 1]
    arranged[arranged.length - 1] = { ...last, reverse: true }
  }
  if (amount === 'bold' && !vocal && arranged.length >= 4) {
    const half = arranged.slice(0, Math.floor(arranged.length / 2))
    arranged = half.flatMap((piece) => [{ ...piece, reverse: false }, { ...piece, reverse: false }])
  }
  if ((amount !== 'subtle' || generation >= 2) && arranged.length >= 2) {
    const tail = arranged[arranged.length - 1]
    arranged[arranged.length - 1] = { ...arranged[arranged.length - 2], reverse: vocal ? false : arranged[arranged.length - 2].reverse, length: tail.length }
  }
  const regions = arranged.map((piece, index) => region(piece, index)).filter((piece) => piece.length > 0)
  const body = regions.reduce((sum, piece) => sum + piece.length, 0)
  if (body < total && regions.length) regions[regions.length - 1].length += total - body
  if (body > total && regions.length) regions[regions.length - 1].length = Math.max(1, regions[regions.length - 1].length - (body - total))
  return {
    ...doc,
    regions,
    fadeIn: doc.fadeIn,
    fadeOut: doc.fadeOut,
  }
}

export function applyProjectVariation(project: Project, options: VaryOptions): { audioIds: string[]; midiIds: string[]; patternIds: string[] } | { error: string } {
  if (options.patternId) return varyPatternClip(project, options.patternId, options)
  if (options.midiId) return varyMidiClip(project, options.midiId, options)
  if (options.audioId) return varyAudioClip(project, options.audioId, options)
  return { error: 'Select a clip first.' }
}

function varyMidiClip(project: Project, clipId: string, options: VaryOptions): { audioIds: string[]; midiIds: string[]; patternIds: string[] } | { error: string } {
  const found = findMidi(project, clipId)
  if (!found) return { error: 'Select a clip first.' }
  const { track, clip } = found
  if (!clip.notes.length) return { error: 'That clip has no notes to vary.' }
  const picture = readClip(project, clip.id, Math.max(1, quartersPerBar(project.timeSignature)))
  const role = picture?.role ?? 'melody'
  const scaleId = project.scale?.library || project.scale?.scale || 'ionian'
  const key = project.scale?.root ?? 0
  const family = clipsNamed(track.midiClips, variationBase(clip.name))
  const rerollTarget = options.reroll ? latestVariation(family, clip) : null
  const origin = family.find((item) => variationIndex(item.name) === 0) ?? clip
  if (rerollTarget) {
    const generation = variationIndex(rerollTarget.name) || 1
    rerollTarget.notes = voiced(origin, role, options, generation, scaleId, key)
    rerollTarget.durationBeats = origin.durationBeats
    return { audioIds: [], midiIds: [rerollTarget.id], patternIds: [] }
  }
  const index = nextIndex(family)
  const made = voiced(clip, role, options, index, scaleId, key)
  const span = clip.durationBeats
  const start = nextFreeBeat(track.midiClips, clip.startBeat + span, span, quartersPerBar(project.timeSignature))
  const copy: MidiClip = {
    ...clip,
    id: uid('midi'),
    name: variationName(clip.name, index),
    startBeat: start,
    durationBeats: span,
    notes: made,
    takes: undefined,
    activeTakeId: undefined,
  }
  track.midiClips.push(copy)
  return { audioIds: [], midiIds: [copy.id], patternIds: [] }
}

function voiced(source: MidiClip, role: string, options: VaryOptions, generation: number, scaleId: string, key: number) {
  return varyNotes({
    notes: source.notes.map((note) => ({
      pitch: note.pitch,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      velocity: note.velocity,
      ...(note.fine ? { fine: note.fine } : {}),
      ...(note.slide ? { slide: true } : {}),
    })),
    role,
    amount: options.amount,
    seed: options.seed,
    generation,
    key,
    scaleId,
    lengthBeats: source.durationBeats,
  }).map((note) => ({
    id: uid('note'),
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
    ...(note.fine ? { fine: note.fine } : {}),
    ...(note.slide ? { slide: true } : {}),
  }))
}

function varyAudioClip(project: Project, clipId: string, options: VaryOptions): { audioIds: string[]; midiIds: string[]; patternIds: string[] } | { error: string } {
  const found = findAudio(project, clipId)
  if (!found) return { error: 'Select a clip first.' }
  const { track, clip } = found
  const vocal = track.kind === 'vocal' || clip.playback === 'recorded' || /vocal|vox/i.test(track.name)
  const family = clipsNamed(track.clips, variationBase(clip.name))
  const rerollTarget = options.reroll ? latestVariation(family, clip) : null
  const host = rerollTarget ?? null
  const origin = family.find((item) => variationIndex(item.name) === 0) ?? clip
  if (host) {
    const generation = variationIndex(host.name) || 1
    host.wave = varyAudioEdit(origin, sourceLength(origin), options.amount, options.seed, generation, vocal)
    host.durationSamples = origin.durationSamples
    host.bufferId = origin.bufferId
    if (vocal) delete host.folder
    return { audioIds: [host.id], midiIds: [], patternIds: [] }
  }
  const index = nextIndex(family)
  const copy = structuredClone(clip)
  copy.id = uid('clip')
  copy.name = variationName(clip.name, index)
  copy.wave = varyAudioEdit(clip, sourceLength(clip), options.amount, options.seed, index, vocal)
  copy.durationSamples = clip.durationSamples
  copy.bufferId = clip.bufferId
  if (vocal) delete copy.folder
  const span = Math.max(1, clip.durationSamples)
  copy.startSample = nextFreeSample(project, track.clips, clip.startSample + span, span)
  track.clips.push(copy)
  return { audioIds: [copy.id], midiIds: [], patternIds: [] }
}

function varyPatternClip(project: Project, clipId: string, options: VaryOptions): { audioIds: string[]; midiIds: string[]; patternIds: string[] } | { error: string } {
  const clip = (project.patternClips ?? []).find((item) => item.id === clipId)
  const pattern = project.beats?.patterns.find((item) => item.id === clip?.patternId)
  if (!clip || !pattern) return { error: 'Select a clip first.' }
  const trackId = clip.trackId
  const siblings = (project.patternClips ?? []).filter((item) => item.trackId === trackId)
  const base = variationBase(pattern.name)
  const family = siblings.filter((item) => variationBase(patternName(project, item.patternId)) === base)
  const reroll = options.reroll ? latestPattern(project, family, clip) : null
  if (reroll) {
    const generation = variationIndex(patternName(project, reroll.patternId)) || 1
    const current = project.beats?.patterns.find((item) => item.id === reroll.patternId)
    if (current && current.id !== pattern.id) {
      const varied = varyBeatPattern(pattern, options.amount, options.seed, generation)
      current.channels = clonePattern(varied, current.name).channels
      current.swing = varied.swing
      return { audioIds: [], midiIds: [], patternIds: [reroll.id] }
    }
  }
  const index = nextIndex(family.map((item) => ({ name: patternName(project, item.patternId) })))
  const varied = varyBeatPattern(pattern, options.amount, options.seed, index)
  const fresh = clonePattern(varied, variationName(pattern.name, index))
  if (!project.beats) project.beats = { activeId: fresh.id, patterns: [] }
  project.beats.patterns.push(fresh)
  const start = nextFreeBeat(
    siblings.map((item) => ({ startBeat: item.startBeat, durationBeats: item.lengthBeats, name: patternName(project, item.patternId) })),
    clip.startBeat + clip.lengthBeats,
    clip.lengthBeats,
    quartersPerBar(project.timeSignature),
  )
  const copy = {
    id: uid('pcl'),
    patternId: fresh.id,
    startBeat: start,
    lengthBeats: clip.lengthBeats,
    scene: null,
    trackId: clip.trackId,
    placed: true,
    offsetBeats: 0,
  }
  project.patternClips = [...(project.patternClips ?? []), copy]
  return { audioIds: [], midiIds: [], patternIds: [copy.id] }
}

function patternName(project: Project, patternId: string) {
  return project.beats?.patterns.find((item) => item.id === patternId)?.name ?? ''
}

function varyMelody(notes: PartNote[], amount: VaryAmount, generation: number, seed: number, key: number, scaleId: string, length: number) {
  const count = changeCount(notes.length, amount)
  const sign = (seed + generation) % 2 === 0 ? 1 : -1
  const out = notes.map((note, index) => {
    if (index === 0 || index > count) return copyNote(note)
    const shifted = sign * (amount === 'subtle' ? 2 : amount === 'medium' ? 3 : 5)
    const moved = nearestInScale(note.pitch + shifted, scaleId, key)
    const push = amount === 'subtle' ? 0 : 0.25
    const start = push && index % 2 === 0 ? note.startBeat + push : note.startBeat
    return tone(note, moved, start, note.durationBeats)
  })
  if (amount !== 'subtle') {
    const last = notes[notes.length - 1]
    const answer = nearestInScale((notes[0]?.pitch ?? 67) + (amount === 'bold' ? 5 : 2), scaleId, key)
    out.push(tone(last, answer, Math.max(0, length - 1), 0.5))
  }
  if (generation >= 2 || amount === 'bold') out.push(...fillLine(notes, key, scaleId, length, amount === 'bold' ? 4 : 2))
  return out
}

function varyBass(notes: PartNote[], amount: VaryAmount, generation: number, seed: number, key: number, scaleId: string, length: number) {
  const sign = (seed + generation) % 2 === 0 ? 1 : -1
  const count = changeCount(notes.length, amount)
  const out = notes.map((note, index) => {
    const down = Math.abs(note.startBeat - Math.round(note.startBeat / 4) * 4) < 0.2 || index === 0
    if (down && amount !== 'bold') return copyNote(note)
    if (index > count && amount !== 'bold') return copyNote(note)
    if (down) {
      const jump = note.pitch < 48 ? note.pitch + 12 : note.pitch - 12
      return tone(note, nearestInScale(jump, scaleId, key), note.startBeat, note.durationBeats)
    }
    const push = amount === 'subtle' ? 0 : 0.25
    const passing = nearestInScale(note.pitch + sign * 2, scaleId, key)
    return tone(note, passing, note.startBeat + push, Math.max(0.12, note.durationBeats - push))
  })
  if (generation >= 2 || amount !== 'subtle') out.push(...fillLine(notes, key, scaleId, length, amount === 'bold' ? 3 : 1))
  return out
}

function varyChords(notes: PartNote[], amount: VaryAmount, generation: number, seed: number, key: number, scaleId: string, length: number) {
  const sign = (seed + generation) % 2 === 0 ? 1 : -1
  const groups = group(notes)
  const out: PartNote[] = []
  groups.forEach((chord, index) => {
    let voiced = chord.map(copyNote)
    const touch = amount === 'subtle' ? index === 1 : amount === 'medium' ? index % 2 === 1 : index > 0
    if (touch) voiced = invert(voiced, scaleId, key)
    if (touch && amount !== 'subtle') {
      const top = Math.max(...voiced.map((note) => note.pitch))
      const extra = nearestInScale(top + 3, scaleId, key)
      if (extra.pitch < 96) voiced.push(tone(voiced[0], extra, voiced[0].startBeat, voiced[0].durationBeats))
    }
    if (amount === 'bold' && index > 0 && index < groups.length - 1) {
      voiced = voiced.map((note) => tone(note, nearestInScale(note.pitch + sign * 2, scaleId, key), note.startBeat, note.durationBeats))
    }
    const push = amount !== 'subtle' && index === groups.length - 1 ? 0.5 : 0
    for (const note of voiced) {
      out.push({ ...note, startBeat: note.startBeat + push, durationBeats: Math.max(0.2, note.durationBeats - push) })
    }
  })
  if (generation >= 2) {
    const last = groups[groups.length - 1] ?? notes
    out.push(...last.map((note) => tone(note, nearestInScale(note.pitch, scaleId, key), Math.max(0, length - 0.5), 0.4)))
  }
  return out
}

function varyDrums(notes: PartNote[], amount: VaryAmount, generation: number, seed: number, length: number) {
  const ghost = 0.22 + ((seed + generation) % 5) * 0.03
  const out = notes.map(copyNote)
  for (const note of notes) {
    if ((note.pitch === 38 || note.pitch === 40) && note.startBeat >= 0.5) {
      const at = roundBeat(note.startBeat - 0.25)
      if (at >= 0) out.push({ pitch: 38, startBeat: at, durationBeats: 0.08, velocity: ghost })
    }
  }
  if (amount !== 'subtle') {
    for (const note of out) {
      if (note.pitch !== 42 && note.pitch !== 44) continue
      if (Math.round(note.startBeat * 4) % 2 === 0) continue
      note.startBeat = roundBeat(Math.min(length - 0.1, note.startBeat + 0.25))
    }
  }
  if (amount === 'bold') {
    const kick = out.find((note) => note.pitch === 36 && note.startBeat > 0.4)
    if (kick) kick.startBeat = roundBeat(kick.startBeat + 0.5)
    else out.push({ pitch: 36, startBeat: roundBeat(Math.min(length - 0.5, 1.5)), durationBeats: 0.2, velocity: 0.8 })
  }
  if (generation >= 2 || amount === 'bold') {
    const from = Math.max(0, length - 1)
    const step = amount === 'bold' ? 0.25 : 0.5
    for (let beat = from; beat < length - 0.05; beat += step) {
      out.push({ pitch: beat === from ? 42 : 38, startBeat: roundBeat(beat), durationBeats: 0.1, velocity: 0.4 + (beat - from) * 0.35 })
    }
  }
  return out
}

function fillLine(notes: PartNote[], key: number, scaleId: string, length: number, count: number): PartNote[] {
  const root = notes[0]?.pitch ?? 60
  const out: PartNote[] = []
  for (let index = 0; index < count; index++) {
    const at = Math.max(0, length - 1 + index * (1 / Math.max(1, count)))
    if (at >= length - 0.05) break
    const moved = nearestInScale(root + index * 2, scaleId, key)
    out.push({ pitch: moved.pitch, ...(moved.fine ? { fine: moved.fine } : {}), startBeat: roundBeat(at), durationBeats: 0.2, velocity: 0.55 })
  }
  return out
}

function changeCount(count: number, amount: VaryAmount) {
  if (count <= 1) return amount === 'subtle' ? 0 : 1
  if (amount === 'subtle') return Math.max(1, Math.round(count * 0.2))
  if (amount === 'medium') return Math.max(2, Math.round(count * 0.45))
  return Math.max(1, count - 1)
}

function tone(note: PartNote, moved: { pitch: number; fine?: number }, start: number, duration: number): PartNote {
  return {
    pitch: moved.pitch,
    ...(moved.fine ? { fine: moved.fine } : {}),
    startBeat: roundBeat(Math.max(0, start)),
    durationBeats: roundBeat(Math.max(0.08, duration)),
    velocity: note.velocity,
    ...(note.slide ? { slide: true } : {}),
  }
}

function fitLength(notes: PartNote[], length: number, tonal: boolean, scaleId: string, key: number) {
  return notes
    .map((note) => {
      const start = Math.max(0, Math.min(length - 0.08, note.startBeat))
      const duration = Math.max(0.08, Math.min(note.durationBeats, length - start))
      const pitched = tonal && !fitsScale(note.pitch, note.fine, scaleId, key) ? nearestInScale(note.pitch, scaleId, key) : { pitch: note.pitch, fine: note.fine }
      return {
        pitch: pitched.pitch,
        startBeat: roundBeat(start),
        durationBeats: roundBeat(duration),
        velocity: Math.max(0.05, Math.min(1, note.velocity)),
        ...(pitched.fine ? { fine: pitched.fine } : {}),
        ...(note.slide ? { slide: true } : {}),
      }
    })
    .filter((note) => note.startBeat < length - 0.02)
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
}

function invert(notes: PartNote[], scaleId: string, key: number) {
  if (notes.length < 2) return notes.map(copyNote)
  const low = notes.reduce((best, note) => (note.pitch < best.pitch ? note : best), notes[0])
  return notes.map((note) => {
    if (note !== low) return copyNote(note)
    return tone(note, nearestInScale(note.pitch + 12, scaleId, key), note.startBeat, note.durationBeats)
  })
}

function group(notes: PartNote[]) {
  const groups: PartNote[][] = []
  for (const note of [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)) {
    const last = groups[groups.length - 1]
    if (!last || note.startBeat - last[0].startBeat > 0.08) groups.push([note])
    else last.push(note)
  }
  return groups
}

function copyNote(note: PartNote): PartNote {
  return {
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
    ...(note.fine ? { fine: note.fine } : {}),
    ...(note.slide ? { slide: true } : {}),
  }
}

interface Piece { source: number; length: number; reverse: boolean }

function flatten(edit: WaveEdit): Piece[] {
  if (!edit.regions.length) return [{ source: 0, length: 1, reverse: false }]
  return edit.regions.map((region) => ({
    source: region.source,
    length: Math.max(1, region.length),
    reverse: region.reverse === true,
  }))
}

function slicePieces(pieces: Piece[], slices: number): Piece[] {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const size = Math.max(1, Math.floor(total / Math.max(1, slices)))
  const out: Piece[] = []
  let cursor = 0
  const at = (index: number) => {
    let walked = 0
    for (const piece of pieces) {
      if (index < walked + piece.length) {
        const local = index - walked
        return { source: piece.reverse ? piece.source + piece.length - 1 - local : piece.source + local, reverse: piece.reverse }
      }
      walked += piece.length
    }
    const last = pieces[pieces.length - 1]
    return { source: last.source, reverse: last.reverse }
  }
  while (cursor < total) {
    const length = Math.min(size, total - cursor)
    const head = at(cursor)
    out.push({ source: head.reverse ? head.source - length + 1 : head.source, length, reverse: head.reverse })
    cursor += length
    if (out.length > slices + 2) break
  }
  return out.filter((piece) => piece.length > 0)
}

function region(piece: Piece, index: number): WaveRegion {
  return {
    id: `var-${index}`,
    source: Math.max(0, Math.round(piece.source)),
    length: Math.max(1, Math.round(piece.length)),
    reverse: piece.reverse,
    gain: 1,
    silence: false,
  }
}

function sourceLength(clip: AudioClip) {
  return Math.max(1, clip.offsetSamples + clip.durationSamples, clip.stretch?.sourceSamples ?? 0)
}

function findMidi(project: Project, id: string) {
  for (const track of project.tracks) {
    const clip = track.midiClips.find((item) => item.id === id)
    if (clip) return { track, clip }
  }
  return null
}

function findAudio(project: Project, id: string) {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === id)
    if (clip) return { track, clip }
  }
  return null
}

function clipsNamed<T extends { name: string }>(clips: T[], base: string) {
  return clips.filter((clip) => variationBase(clip.name) === base)
}

function latestVariation<T extends { name: string }>(family: T[], selected: T) {
  if (variationIndex(selected.name) > 0) return selected
  const vars = family.filter((clip) => variationIndex(clip.name) > 0)
  if (!vars.length) return null
  return vars.reduce((best, clip) => (variationIndex(clip.name) > variationIndex(best.name) ? clip : best))
}

function latestPattern(project: Project, family: PatternClip[], selected: PatternClip) {
  const selectedName = patternName(project, selected.patternId)
  if (variationIndex(selectedName) > 0) return selected
  const vars = family.filter((clip) => variationIndex(patternName(project, clip.patternId)) > 0)
  if (!vars.length) return null
  return vars.reduce((best, clip) => (variationIndex(patternName(project, clip.patternId)) > variationIndex(patternName(project, best.patternId)) ? clip : best))
}

function nextIndex(family: { name: string }[]) {
  return family.reduce((max, clip) => Math.max(max, variationIndex(clip.name)), 0) + 1
}

function nextFreeBeat(clips: { startBeat: number; durationBeats: number }[], after: number, length: number, barBeats: number) {
  const bar = Math.max(1, barBeats)
  let start = snapUp(after, bar)
  const ordered = [...clips].sort((a, b) => a.startBeat - b.startBeat)
  for (const clip of ordered) {
    const end = clip.startBeat + clip.durationBeats
    if (end <= start + 1e-4) continue
    if (clip.startBeat >= start + length - 1e-4) break
    start = snapUp(end, bar)
  }
  return start
}

function nextFreeSample(project: Project, clips: AudioClip[], after: number, length: number) {
  const bar = Math.max(1, quartersPerBar(project.timeSignature))
  let start = snapSampleUp(project, after, bar)
  const ordered = [...clips].sort((a, b) => a.startSample - b.startSample)
  for (const clip of ordered) {
    const end = clip.startSample + clip.durationSamples
    if (end <= start + 1) continue
    if (clip.startSample >= start + length - 1) break
    start = snapSampleUp(project, end, bar)
  }
  return start
}

function snapUp(beat: number, bar: number) {
  return Math.ceil((beat - 1e-6) / bar) * bar
}

function snapSampleUp(project: Project, sample: number, barBeats: number) {
  const beat = projectSampleBeat(project, Math.max(0, sample))
  return Math.max(0, Math.round(projectBeatSample(project, snapUp(beat, barBeats))))
}
