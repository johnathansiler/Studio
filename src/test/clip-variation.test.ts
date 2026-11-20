import { describe, expect, it } from 'vitest'
import { generateEnsemble } from '../ideas/ensemble'
import { fitsScale } from '../ideas/scaleFit'
import { noteDelta, varyNotes } from '../ideas/variation'
import type { PartNote } from '../ideas/types'
import { starterPattern } from '../model/steps'
import { createEmptyProject, type MidiNote } from '../model/types'
import { ProjectStore } from '../state/store'

function line(): PartNote[] {
  const ensemble = generateEnsemble({
    key: 0,
    scaleId: 'ionian',
    tempo: 120,
    genre: 'pop',
    bars: 8,
    roles: ['melody'],
    complexity: 0.8,
    energy: 0.8,
    swing: 0,
    seed: 5,
  })
  return ensemble.parts[0].notes
}

function asPart(notes: MidiNote[]): PartNote[] {
  return notes.map((note) => ({
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
    ...(note.fine ? { fine: note.fine } : {}),
  }))
}

describe('clip variation', () => {
  it('stays in key, keeps the length, and moves further as the amount grows', () => {
    const source = line()
    expect(source.length).toBeGreaterThan(6)
    const length = 32
    const subtle = varyNotes({ notes: source, role: 'melody', amount: 'subtle', seed: 8, generation: 1, key: 0, scaleId: 'ionian', lengthBeats: length })
    const medium = varyNotes({ notes: source, role: 'melody', amount: 'medium', seed: 8, generation: 1, key: 0, scaleId: 'ionian', lengthBeats: length })
    const bold = varyNotes({ notes: source, role: 'melody', amount: 'bold', seed: 8, generation: 2, key: 0, scaleId: 'ionian', lengthBeats: length })
    for (const notes of [subtle, medium, bold]) {
      expect(notes.every((note) => fitsScale(note.pitch, note.fine, 'ionian', 0))).toBe(true)
      expect(notes.every((note) => note.startBeat >= 0 && note.startBeat + note.durationBeats <= length + 0.02)).toBe(true)
    }
    const subtleDelta = noteDelta(source, subtle)
    const mediumDelta = noteDelta(source, medium)
    const boldDelta = noteDelta(source, bold)
    expect(subtleDelta).toBeGreaterThan(0)
    expect(mediumDelta).toBeGreaterThan(subtleDelta)
    expect(boldDelta).toBeGreaterThan(mediumDelta)
    expect(varyNotes({ notes: source, role: 'melody', amount: 'medium', seed: 8, generation: 1, key: 0, scaleId: 'ionian', lengthBeats: length })).toEqual(medium)
    expect(varyNotes({ notes: source, role: 'melody', amount: 'medium', seed: 9, generation: 1, key: 0, scaleId: 'ionian', lengthBeats: length })).not.toEqual(medium)
  })

  it('leaves the original MIDI clip alone, names the next variation, and undoes it', () => {
    const store = new ProjectStore(createEmptyProject())
    const ensemble = generateEnsemble({
      key: 0,
      scaleId: 'ionian',
      tempo: 120,
      genre: 'pop',
      bars: 4,
      roles: ['melody'],
      complexity: 0.6,
      energy: 0.7,
      swing: 0,
      seed: 2,
    })
    store.addEnsemble(ensemble, 0)
    const track = store.project.tracks.find((item) => item.name === 'Melody')!
    const original = track.midiClips[0]
    const before = structuredClone(original.notes)
    expect(store.varyArrangeClip({ seed: 6, amount: 'medium' })).toBe(true)
    expect(track.midiClips).toHaveLength(2)
    expect(original.notes).toEqual(before)
    expect(track.midiClips[1].name).toBe(`${original.name} (var 1)`)
    expect(track.midiClips[1].durationBeats).toBe(original.durationBeats)
    expect(track.midiClips[1].startBeat).toBeGreaterThanOrEqual(original.startBeat + original.durationBeats - 0.01)
    expect(asPart(track.midiClips[1].notes).every((note) => fitsScale(note.pitch, note.fine, 'ionian', 0))).toBe(true)
    expect(store.varyArrangeClip({ seed: 6, amount: 'bold' })).toBe(true)
    expect(track.midiClips[2].name).toBe(`${original.name} (var 2)`)
    const secondId = track.midiClips[2].id
    const second = structuredClone(track.midiClips[2].notes)
    expect(store.varyArrangeClip({ reroll: true, seed: 15, amount: 'bold' })).toBe(true)
    expect(track.midiClips).toHaveLength(3)
    expect(track.midiClips[2].id).toBe(secondId)
    expect(track.midiClips[2].notes).not.toEqual(second)
    expect(original.notes).toEqual(before)
    store.undo()
    expect(track.midiClips).toHaveLength(3)
    expect(original.notes).toEqual(before)
    store.undo()
    store.undo()
    expect(track.midiClips).toHaveLength(1)
    expect(track.midiClips[0].notes).toEqual(before)
  })

  it('chops a loop without touching the file, and does not reverse a vocal take', () => {
    const store = new ProjectStore(createEmptyProject())
    const loop = store.project.tracks.find((track) => track.kind === 'loop')!
    store.drawRegion(loop.id, 0, 96000)
    const source = loop.clips[0]
    const buffer = source.bufferId
    const duration = source.durationSamples
    expect(store.varyArrangeClip({ seed: 4, amount: 'bold' })).toBe(true)
    expect(source.bufferId).toBe(buffer)
    expect(source.durationSamples).toBe(duration)
    expect(source.wave).toBeUndefined()
    const varied = loop.clips.find((clip) => clip.id !== source.id)!
    expect(varied.bufferId).toBe(buffer)
    expect(varied.durationSamples).toBe(duration)
    expect(varied.name).toContain('(var 1)')
    expect(varied.wave?.regions.length).toBeGreaterThan(1)
    const vocal = store.project.tracks.find((track) => track.kind === 'vocal')!
    store.drawRegion(vocal.id, 0, 48000)
    const take = vocal.clips[0]
    const takeNotes = structuredClone(take)
    expect(store.varyArrangeClip({ seed: 4, amount: 'bold' })).toBe(true)
    expect(take.bufferId).toBe(takeNotes.bufferId)
    expect(take.durationSamples).toBe(takeNotes.durationSamples)
    expect(take.wave).toBeUndefined()
    const chop = vocal.clips.find((clip) => clip.id !== take.id)!
    expect(chop.wave?.regions.every((region) => !region.reverse)).toBe(true)
    expect(chop.bufferId).toBe(take.bufferId)
    store.undo()
    expect(vocal.clips).toHaveLength(1)
    expect(vocal.clips[0].wave).toBeUndefined()
  })

  it('varies a Beat Machine pattern without editing the original cells', () => {
    const store = new ProjectStore(createEmptyProject())
    const pattern = starterPattern()
    store.project.beats = { activeId: pattern.id, patterns: [pattern] }
    store.placePattern(0)
    const before = pattern.channels.map((channel) => channel.cells.map((cell) => ({ on: cell.on, velocity: cell.velocity })))
    expect(store.varyArrangeClip({ seed: 3, amount: 'bold' })).toBe(true)
    expect(pattern.channels.map((channel) => channel.cells.map((cell) => ({ on: cell.on, velocity: cell.velocity })))).toEqual(before)
    expect(store.project.beats?.patterns).toHaveLength(2)
    expect(store.project.patternClips).toHaveLength(2)
    const copy = store.project.beats!.patterns[1]
    expect(copy.name).toContain('(var 1)')
    expect(copy.id).not.toBe(pattern.id)
    const changed = copy.channels.some((channel, index) => channel.cells.some((cell, step) => cell.on !== before[index][step].on || cell.velocity !== before[index][step].velocity))
    expect(changed).toBe(true)
    store.undo()
    expect(store.project.patternClips).toHaveLength(1)
    expect(store.project.beats?.patterns).toHaveLength(1)
  })
})
