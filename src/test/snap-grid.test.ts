import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import {
  activeGridBeats,
  ceilToGrid,
  clipEndForContent,
  edgeFromPointer,
  grownClipEnd,
  snapBeatToGrid,
  snapEditBeat,
} from '../model/snapGrid'
import { ProjectStore } from '../state/store'
import { patternToMidiNotes } from '../model/patternMidi'

describe('snap grid', () => {
  it('snaps to 1/16, 1/4, a bar, and stays free when snap is off', () => {
    const project = createEmptyProject()
    project.snapDivision = '1/16'
    expect(activeGridBeats(project)).toBeCloseTo(0.25)
    expect(snapBeatToGrid(1.3, 0.25)).toBeCloseTo(1.25)
    expect(ceilToGrid(1.3, 0.25)).toBeCloseTo(1.5)
    expect(ceilToGrid(1, 0.25)).toBeCloseTo(1)
    project.snapDivision = '1/4'
    expect(snapEditBeat(1.6, project)).toBeCloseTo(2)
    expect(ceilToGrid(1.1, 1)).toBeCloseTo(2)
    expect(ceilToGrid(2, 1)).toBeCloseTo(2)
    project.snapDivision = 'bar'
    expect(activeGridBeats(project)).toBeCloseTo(4)
    expect(ceilToGrid(4.2, 4)).toBeCloseTo(8)
    project.snap = false
    expect(activeGridBeats(project)).toBe(0)
    expect(clipEndForContent(1.2, project)).toBeCloseTo(4)
    expect(clipEndForContent(4, project)).toBeCloseTo(4)
    expect(grownClipEnd(8, 1.2, project)).toBe(8)
  })

  it('sizes an edge from the pointer, not a running delta', () => {
    const end = edgeFromPointer(0, 4, 5.2, 'end', 1)
    expect(end).toEqual({ start: 0, end: 5 })
    const start = edgeFromPointer(2, 6, 0.4, 'start', 1)
    expect(start.start).toBe(0)
    expect(start.end).toBe(6)
    const free = edgeFromPointer(0, 4, 1.2, 'end', 0)
    expect(free.end).toBeCloseTo(1.2, 1)
  })
})

describe('clip ends follow the snap grid', () => {
  it('rounds step input, a MIDI take, and a pattern sent to Arrange up to the grid', () => {
    const store = new ProjectStore()
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    const clip = () => store.project.tracks.find((item) => item.id === track.id)!.midiClips.at(-1)!
    store.setSnapDivision('1/16')
    clip().durationBeats = 0.1
    store.setMidiEditor({ step: 0.3, cursor: 0, velocity: 0.8 })
    store.enterSteps(track.id, clip().id, [{ pitch: 60 }])
    expect(clip().durationBeats).toBeGreaterThan(0.3 - 1e-6)
    expect(clip().durationBeats % 0.25).toBeCloseTo(0, 4)

    store.project.snap = false
    store.placeMidiTake(track.id, 0, [{ pitch: 62, startBeat: 0, durationBeats: 1.25, velocity: 0.8 }])
    expect(clip().durationBeats).toBeCloseTo(4)

    store.project.snap = true
    store.setSnapDivision('1/4')
    store.placeMidiTake(track.id, 0, [{ pitch: 64, startBeat: 0, durationBeats: 1.1, velocity: 0.8 }])
    expect(clip().durationBeats).toBeCloseTo(2)
    const kept = clip()
    kept.durationBeats = 8
    store.addNote(track.id, kept.id, { pitch: 67, startBeat: 0, durationBeats: 0.5, velocity: 0.8 })
    expect(kept.durationBeats).toBe(8)

    const pattern = store.activePattern()!
    for (const channel of pattern.channels) channel.cells = channel.cells.map((cell) => ({ ...cell, on: false }))
    pattern.channels[0].cells[0] = { ...pattern.channels[0].cells[0], on: true, velocity: 0.9 }
    pattern.channels[1].cells[4] = { ...pattern.channels[1].cells[4], on: true, velocity: 0.8 }
    const made = store.sendPatternToArrange(0)
    expect(made).toBeTruthy()
    const arranged = store.project.tracks.find((item) => item.id === made!.trackId)!.midiClips.find((item) => item.id === made!.clipId)!
    expect(arranged.notes.map((note) => note.pitch).sort()).toEqual(patternToMidiNotes(pattern).map((note) => note.pitch).sort())
    expect(arranged.notes.length).toBeGreaterThan(0)
    expect(arranged.durationBeats).toBeGreaterThanOrEqual(patternToMidiNotes(pattern).reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0) - 1e-6)
  })
})
