import { describe, expect, it } from 'vitest'
import { detectBpm } from '../audio/stretch/engine'
import { createSection, deleteSectionContents, duplicateSectionContents, moveSectionContents } from '../model/sections'
import { adaptProjectTempo, conformStretchPatch } from '../model/smartTempo'
import {
  arrangementEndSample,
  beatSpanSamples,
  clickAccent,
  clickAtOrAfter,
  formatMapBars,
  gridMarks,
  musicalAt,
  nextClickAfter,
  projectSampleBeat,
  samplesAtBeat,
  snapSampleToMap,
  tempoAtBeat,
} from '../model/tempoMap'
import { beatsToSamples, formatBarsBeats, projectEndSample, snapSample } from '../model/time'
import { createEmptyProject, uid, type AudioClip, type MidiClip } from '../model/types'
import { selectSectionAt, selectSections, selectSongParts, selectTempoMap } from '../state/select'
import { ProjectStore } from '../state/store'

const rate = 48000

function midi(startBeat: number, id = uid('midi')): MidiClip {
  return { id, name: 'Keys', startBeat, durationBeats: 4, notes: [] }
}

describe('tempo map', () => {
  it('matches a steady tempo and a step change', () => {
    expect(samplesAtBeat(4, rate, 120, [])).toBeCloseTo(beatsToSamples(4, rate, 120), 4)
    expect(samplesAtBeat(2, rate, 120, [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }])).toBeCloseTo(72000, 3)
  })

  it('glides through a ramp and lands the next beat at the new tempo', () => {
    const map = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60, ramp: true }]
    expect(samplesAtBeat(1, rate, 120, map)).toBeCloseTo(rate * Math.log(2), 3)
    expect(samplesAtBeat(2, rate, 120, map)).toBeCloseTo(rate * Math.log(2) + rate, 3)
    expect(tempoAtBeat(0.5, 120, map)).toBeCloseTo(90, 4)
  })

  it('inverts beats and samples, including across a ramp', () => {
    const map = [{ beat: 0, bpm: 100 }, { beat: 4, bpm: 140, ramp: true }, { beat: 8, bpm: 90 }]
    for (const beat of [0, 0.25, 1, 3.5, 4, 6, 8, 12]) {
      const sample = samplesAtBeat(beat, rate, 100, map)
      expect(projectSampleBeat({ tempo: 100, tempoMap: map, automation: [], sampleRate: rate }, sample)).toBeCloseTo(beat, 4)
    }
  })

  it('keeps the bar grid and the click on the meter', () => {
    const project = createEmptyProject(rate)
    expect(formatMapBars(project, 0)).toBe('1.1.000')
    expect(formatMapBars(project, 24000)).toBe(formatBarsBeats(24000, rate, 120, project.timeSignature))
    expect(formatMapBars(project, 96000)).toBe('2.1.000')
    expect(clickAtOrAfter(project, 0)).toBeCloseTo(0, 3)
    expect(nextClickAfter(project, 0)).toBeCloseTo(24000, 2)
    expect(clickAccent(project, 0)).toBe(true)
    expect(clickAccent(project, 24000)).toBe(false)
    expect(clickAccent(project, 96000)).toBe(true)
    project.timeSignature = { numerator: 6, denominator: 8 }
    expect(musicalAt(project, 0).beat).toBe(1)
    expect(nextClickAfter(project, 0)).toBeCloseTo(12000, 2)
    expect(clickAccent(project, 72000)).toBe(true)
    const marks = gridMarks(project, 3)
    expect(marks.filter((mark) => mark.downbeat).map((mark) => mark.beat)).toEqual([0, 3])
  })

  it('snaps and ends the arrangement the same way when the map is flat', () => {
    const project = createEmptyProject(rate)
    expect(snapSampleToMap(20000, project)).toBe(snapSample(20000, rate, 120, true))
    expect(arrangementEndSample(project)).toBe(projectEndSample(project.tracks, rate, project.tempo))
    project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]
    const span = beatSpanSamples(project, 0.5, 1)
    expect(span.duration).toBeGreaterThan(beatsToSamples(1, rate, 120))
  })

  it('follows a meter change on the next bar', () => {
    const project = createEmptyProject(rate)
    project.meterMap = [{ beat: 4, numerator: 3, denominator: 4 }]
    const downs = gridMarks(project, 8).filter((mark) => mark.downbeat).map((mark) => mark.beat)
    expect(downs).toEqual([0, 4, 7])
  })
})

describe('sections', () => {
  it('moves, duplicates, and deletes a section with its contents', () => {
    const project = createEmptyProject(rate)
    const track = project.tracks[2]
    track.midiClips = [midi(0, 'inside'), midi(20, 'after')]
    const audio = project.tracks[1]
    const clip: AudioClip = {
      id: 'audio',
      name: 'Loop',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: 48000,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
    }
    audio.clips = [clip]
    project.tempoMap = [{ beat: 8, bpm: 90 }]
    const section = createSection(project, 0, 'chorus')
    project.sections = [section]
    expect(section.durationBeats).toBe(16)

    moveSectionContents(project, section.id, 4)
    expect(section.startBeat).toBe(4)
    expect(track.midiClips.find((item) => item.id === 'inside')?.startBeat).toBe(4)
    expect(track.midiClips.find((item) => item.id === 'after')?.startBeat).toBe(20)
    expect(clip.startSample).toBeCloseTo(beatsToSamples(4, rate, 120), 0)
    expect(project.tempoMap?.[0].beat).toBeCloseTo(12, 4)

    const copy = duplicateSectionContents(project, section.id)
    expect(copy?.startBeat).toBe(20)
    expect(track.midiClips.filter((item) => item.name === 'Keys').length).toBeGreaterThanOrEqual(3)
    const inside = track.midiClips.find((item) => item.id === 'inside')
    expect(inside?.startBeat).toBe(4)
    expect(audio.clips.length).toBe(2)

    deleteSectionContents(project, section.id)
    expect(project.sections?.some((item) => item.id === section.id)).toBe(false)
    expect(track.midiClips.some((item) => item.id === 'inside')).toBe(false)
    expect(selectSections(project).length).toBeGreaterThan(0)
  })

  it('moves a marker without taking the clips around it', () => {
    const project = createEmptyProject(rate)
    project.tracks[2].midiClips = [midi(2, 'stay')]
    const marker = createSection(project, 2, 'marker')
    project.sections = [marker]
    expect(marker.durationBeats).toBe(0)
    moveSectionContents(project, marker.id, 6)
    expect(marker.startBeat).toBe(6)
    expect(project.tracks[2].midiClips[0].startBeat).toBe(2)
    deleteSectionContents(project, marker.id)
    expect(project.sections).toEqual([])
    expect(project.tracks[2].midiClips).toHaveLength(1)
  })

  it('exposes sections from the shared project', () => {
    const project = createEmptyProject(rate)
    const verse = createSection(project, 0, 'verse')
    const chorus = createSection(project, 16, 'chorus')
    project.sections = [chorus, verse]
    expect(selectSongParts(project).map((section) => section.kind)).toEqual(['verse', 'chorus'])
    expect(selectSectionAt(project, 2)?.kind).toBe('verse')
    expect(selectSectionAt(project, 18)?.kind).toBe('chorus')
    expect(selectTempoMap(project)[0]).toMatchObject({ beat: 0, bpm: 120 })
  })
})

describe('smart tempo', () => {
  it('adapts the song or conforms the clip without changing pitch', () => {
    const clicks = new Float32Array(rate * 2)
    for (let beat = 0; beat < 4; beat++) clicks[Math.round(beat * rate * 0.6)] = 1
    expect(detectBpm(clicks, rate)).toBe(100)
    const project = createEmptyProject(rate)
    project.tempoMap = [{ beat: 0, bpm: 120 }]
    expect(adaptProjectTempo(project, 100)).toBe(100)
    expect(project.tempo).toBe(100)
    expect(project.tempoMap[0].bpm).toBe(100)
    expect(conformStretchPatch(100, 'tape')).toEqual({ sourceBpm: 100, followTempo: true, mode: 'pro' })
    expect(conformStretchPatch(100, 'voice').mode).toBe('voice')
  })

  it('offers the choice on the store and undoes a section edit', () => {
    const store = new ProjectStore(createEmptyProject(rate))
    store.project.snap = false
    const track = store.project.tracks[1]
    store.addAudioClip(track.id, {
      id: 'clip',
      name: 'Take',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: rate,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      stretch: {
        sourceSamples: rate,
        semitones: 0,
        cents: 0,
        mode: 'pro',
        followTempo: false,
        sourceBpm: 100,
        markers: [],
      },
    })
    expect(store.smartTempo?.bpm).toBe(100)
    store.conformClipTempo(track.id, 'clip')
    const fitted = store.project.tracks[1].clips[0]
    expect(fitted.stretch?.followTempo).toBe(true)
    expect(fitted.stretch?.mode).toBe('pro')
    expect(fitted.durationSamples).toBeLessThan(rate)
    store.undo()
    expect(store.project.tracks[1].clips[0].stretch?.followTempo).toBe(false)

    store.addSection('intro', 0)
    const id = store.sectionId
    expect(selectSections(store.project).some((section) => section.id === id)).toBe(true)
    store.addTempoPoint(8, 140, true)
    expect(store.project.tempoMap?.some((point) => point.bpm === 140 && point.ramp)).toBe(true)
    store.undo()
    expect(store.project.tempoMap ?? []).toEqual([])
    store.undo()
    expect(store.project.sections ?? []).toEqual([])
  })
})
