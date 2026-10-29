import { describe, expect, it } from 'vitest'
import { createEmptyProject, type AudioClip } from '../model/types'
import { gridPaint, MIN_LINE_PX } from '../model/gridLines'
import { moveFromPointer, positionReadout } from '../model/snapGrid'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { ProjectStore } from '../state/store'

describe('timeline grid lines', () => {
  it('spaces lines for 1/4, 1/16, triplets, and a bar', () => {
    const project = createEmptyProject()
    project.snap = true
    const px = 48
    project.snapDivision = '1/4'
    const quarter = gridPaint(project, px)
    expect(quarter.drawBeats).toBeCloseTo(1)
    expect(quarter.thinned).toBe(false)
    expect(quarter.lines.some((line) => line.role === 'bar' && line.beats === 4)).toBe(true)
    expect(quarter.drawBeats * px).toBeGreaterThanOrEqual(MIN_LINE_PX)

    project.snapDivision = '1/16'
    const sixteenth = gridPaint(project, px)
    expect(sixteenth.drawBeats).toBeCloseTo(0.25)
    expect(sixteenth.lines.some((line) => line.role === 'snap')).toBe(true)
    expect(sixteenth.lines.some((line) => line.role === 'beat')).toBe(true)

    project.snapDivision = '1/8T'
    const triplet = gridPaint(project, px)
    expect(triplet.drawBeats).toBeCloseTo(1 / 3)
    expect(triplet.thinned).toBe(false)

    project.snapDivision = 'bar'
    const bar = gridPaint(project, px)
    expect(bar.drawBeats).toBeCloseTo(4)
    expect(bar.lines.every((line) => line.role === 'bar')).toBe(true)
  })

  it('thins a dense grid without changing the snap value', () => {
    const project = createEmptyProject()
    project.snap = true
    project.snapDivision = '1/32'
    const tight = gridPaint(project, 32)
    expect(tight.snapBeats).toBeCloseTo(0.125)
    expect(tight.drawBeats).toBeGreaterThan(tight.snapBeats)
    expect(tight.drawBeats * 32).toBeGreaterThanOrEqual(MIN_LINE_PX)
    expect(tight.thinned).toBe(true)
    expect(tight.hint).toContain('1/32')
    expect(tight.hint.toLowerCase()).toContain('snapping still uses')
  })

  it('draws bars and beats when snap is off', () => {
    const project = createEmptyProject()
    project.snap = false
    project.snapDivision = '1/32'
    const paint = gridPaint(project, 40)
    expect(paint.snapBeats).toBe(0)
    expect(paint.drawBeats).toBeCloseTo(1)
    expect(paint.thinned).toBe(false)
    expect(paint.hint).toBe('')
    expect(paint.lines.map((line) => line.role).sort()).toEqual(['bar', 'beat'])
  })
})

describe('clip moves snap to the grid', () => {
  it('lands MIDI and audio clips on 1/4 and on the bar', () => {
    const store = new ProjectStore()
    store.project.snap = true
    store.setSnapDivision('1/4')
    const midiTrack = store.project.tracks.find((track) => track.type === 'midi')!
    store.addMidiClip(midiTrack.id, 0)
    const midi = () => store.project.tracks.find((track) => track.id === midiTrack.id)!.midiClips.at(-1)!
    expect(moveFromPointer(0, 0, 1.4, 1)).toBeCloseTo(1)
    expect(moveFromPointer(2, 2.1, 3.6, 1)).toBeCloseTo(4)
    expect(positionReadout(4, 4)).toBe('2.1')
    store.placeMidiClips([{ trackId: midiTrack.id, clipId: midi().id, startBeat: 1.4 }])
    expect(midi().startBeat).toBeCloseTo(1)
    store.placeMidiClips([{ trackId: midiTrack.id, clipId: midi().id, startBeat: moveFromPointer(0, 0.2, 2.7, 1) }])
    expect(midi().startBeat).toBeCloseTo(3)

    const audioTrack = store.project.tracks.find((track) => track.type === 'audio')!
    const audio: AudioClip = {
      id: 'drag-audio',
      name: 'Take',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: store.project.sampleRate,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'local',
    }
    audioTrack.clips.push(audio)
    const at = (beat: number) => projectBeatSample(store.project, beat)
    store.placeAudioClips([{ trackId: audioTrack.id, clipId: audio.id, startSample: at(1.6) }])
    expect(projectSampleBeat(store.project, audioTrack.clips[0].startSample)).toBeCloseTo(2)

    store.setSnapDivision('bar')
    store.placeMidiClips([{ trackId: midiTrack.id, clipId: midi().id, startBeat: 2.2 }])
    expect(midi().startBeat).toBeCloseTo(4)
    store.placeAudioClips([{ trackId: audioTrack.id, clipId: audio.id, startSample: at(5.1) }])
    expect(projectSampleBeat(store.project, audioTrack.clips[0].startSample)).toBeCloseTo(4)

    store.project.snap = false
    store.placeMidiClips([{ trackId: midiTrack.id, clipId: midi().id, startBeat: 1.37 }])
    expect(midi().startBeat).toBeCloseTo(1.37)
  })
})
