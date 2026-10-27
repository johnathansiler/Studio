import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { arrangementDigest } from '../model/sessionSync'
import { createEmptyProject, type MidiNote } from '../model/types'
import { chordStamp, humanizeNotes, paintNotes, quantizeNotes, snapBeat } from '../model/paint'
import { SCALES } from '../model/scale'
import {
  drumStepIndex,
  renderPattern,
  starterPattern,
  stepIndexAt,
  stepStart,
} from '../model/steps'

const ionian = SCALES.find((scale) => scale.id === 'ionian')!

function note(partial: Partial<MidiNote> & Pick<MidiNote, 'id' | 'pitch' | 'startBeat'>): MidiNote {
  return { durationBeats: 0.25, velocity: 0.8, ...partial }
}

describe('step timing', () => {
  it('delays odd sixteenths by the swing amount and keeps even steps on the grid', () => {
    expect(stepStart(0, 0.25, 0.5)).toBe(0)
    expect(stepStart(1, 0.25, 0.5)).toBeCloseTo(0.375)
    expect(stepStart(2, 0.25, 0.5)).toBeCloseTo(0.5)
    const beat = 24000
    expect(drumStepIndex(0, beat, 16, 0)).toBe(0)
    expect(drumStepIndex(beat / 4, beat, 16, 0)).toBe(1)
    expect(drumStepIndex(beat / 4, beat, 16, 0.5)).toBe(0)
    expect(drumStepIndex(beat * 0.4, beat, 16, 0.5)).toBe(1)
  })

  it('loops a shorter channel against the pattern as a polymeter', () => {
    expect(stepIndexAt(1, 3, 0.25, 0)).toBe(1)
    const pattern = starterPattern()
    const kick = pattern.channels[0]
    kick.steps = 3
    kick.cells.forEach((cell, index) => {
      cell.on = index === 0
    })
    const hits = renderPattern({ ...pattern, channels: [kick] }, 0, 2)
    expect(hits.map((hit) => hit.startBeat)).toEqual([0, 0.75, 1.5])
  })

  it('uses a channel swing instead of the pattern swing', () => {
    const pattern = starterPattern()
    pattern.swing = 0
    const kick = pattern.channels[0]
    kick.swing = 0.5
    kick.cells[1].on = true
    const hits = renderPattern({ ...pattern, channels: [kick] }, 0, 1)
    expect(hits.map((hit) => Number(hit.startBeat.toFixed(3)))).toEqual([0, 0.375])
  })
})

describe('pattern arrangement', () => {
  it('places a pattern clip and renders the kit on the arrangement', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const pattern = store.activePattern()!
    expect(pattern.channels.map((channel) => channel.name)).toEqual(['Kick', 'Snare', 'Clap', 'Hat', 'Perc'])
    store.placePattern(4)
    const clip = store.project.patternClips!.at(-1)!
    expect(clip.patternId).toBe(pattern.id)
    expect(clip.startBeat).toBe(4)
    expect(clip.lengthBeats).toBe(4)
    expect(clip.scene).toBeNull()
    const kicks = renderPattern(pattern, 0, clip.lengthBeats).filter((hit) => hit.kind === 'kick')
    expect(kicks.map((hit) => hit.startBeat)).toEqual([0, 1, 2, 3])
    expect(kicks.map((hit) => clip.startBeat + hit.startBeat)).toEqual([4, 5, 6, 7])
    const before = arrangementDigest(store.project)
    store.setStep(pattern.channels[0].id, 1, true)
    expect(arrangementDigest(store.project)).not.toBe(before)
  })

  it('bakes per-step pitch, pan, fine, and gate into the hit', () => {
    const pattern = starterPattern()
    const kick = pattern.channels[0]
    kick.volume = 1
    kick.pan = 0
    kick.cells[0] = { on: true, velocity: 1, pan: 0.2, pitch: 2, fine: 10, gate: 0.5 }
    const hit = renderPattern({ ...pattern, channels: [kick] }, 0, 1)[0]
    expect(hit.pitch).toBe(38)
    expect(hit.fine).toBe(10)
    expect(hit.pan).toBeCloseTo(0.2)
    expect(hit.velocity).toBe(1)
    expect(hit.durationBeats).toBeCloseTo(0.125)
  })
})

describe('paint midi', () => {
  it('paints repeated notes across the drag and locks them to the scale', () => {
    const painted = paintNotes({
      fromBeat: 0,
      toBeat: 2,
      pitch: 60,
      grid: 0.25,
      length: 0.25,
      velocity: 0.8,
      scaleLock: false,
      root: 0,
      scale: 'ionian',
    })
    expect(painted).toHaveLength(8)
    expect(painted.map((item) => item.startBeat)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75])
    const locked = paintNotes({
      fromBeat: 0,
      toBeat: 0,
      pitch: 61,
      grid: 0.25,
      length: 0.25,
      velocity: 0.8,
      scaleLock: true,
      root: 0,
      scale: 'ionian',
    })
    expect(locked).toHaveLength(1)
    expect(locked[0].pitch).toBe(60)
    expect(snapBeat(0.3, 0)).toBeCloseTo(0.3)
  })

  it('stamps a scale triad from the painted pitch', () => {
    const chord = chordStamp({
      beat: 0,
      pitch: 60,
      length: 1,
      velocity: 0.8,
      grid: 0.25,
      root: 0,
      scale: 'ionian',
      intervals: ionian.intervals,
    })
    expect(chord.map((item) => item.pitch)).toEqual([60, 64, 67])
    const third = chordStamp({
      beat: 1,
      pitch: 64,
      length: 1,
      velocity: 0.8,
      grid: 1,
      root: 0,
      scale: 'ionian',
      intervals: ionian.intervals,
    })
    expect(third.map((item) => item.pitch)).toEqual([64, 67, 71])
  })

  it('quantizes to the grid and humanizes with the scaler nudge', () => {
    const notes = [note({ id: 'a', pitch: 60, startBeat: 0.2 })]
    expect(quantizeNotes(notes, 0.25)[0].startBeat).toBeCloseTo(0.25)
    expect(quantizeNotes(notes, 0)[0].startBeat).toBeCloseTo(0.2)
    const human = humanizeNotes(notes, 0.05, 0.5, () => 0)
    expect(human[0].startBeat).toBeCloseTo(0.15)
    expect(human[0].velocity).toBeCloseTo(0.4)
  })
})

describe('undo', () => {
  it('restores a toggled step and painted notes', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const kick = store.activePattern()!.channels[0]
    expect(kick.cells[1].on).toBe(false)
    store.setStep(kick.id, 1, true)
    store.setStep(kick.id, 2, true)
    store.endDraft()
    expect(store.activePattern()!.channels[0].cells[1].on).toBe(true)
    expect(store.activePattern()!.channels[0].cells[2].on).toBe(true)
    store.undo()
    expect(store.activePattern()!.channels[0].cells[1].on).toBe(false)
    expect(store.activePattern()!.channels[0].cells[2].on).toBe(false)

    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    const clip = store.project.tracks.find((item) => item.id === track.id)!.midiClips[0]
    const before = clip.notes.length
    store.replaceNotes(track.id, clip.id, [
      ...clip.notes,
      note({ id: 'painted', pitch: 60, startBeat: 0, durationBeats: 0.5, velocity: 0.7 }),
    ])
    expect(store.project.roll?.length).toBeCloseTo(0.5)
    expect(store.project.roll?.velocity).toBeCloseTo(0.7)
    const after = store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clip.id)!
    expect(after.notes).toHaveLength(before + 1)
    store.undo()
    const restored = store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clip.id)!
    expect(restored.notes).toHaveLength(before)
    store.redo()
    const redone = store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clip.id)!
    expect(redone.notes).toHaveLength(before + 1)
  })
})
