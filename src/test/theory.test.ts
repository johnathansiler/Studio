import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { createEmptyProject } from '../model/types'
import { SCALES, TUNER_SCALE_COUNT, voiceChord } from '../model/scale'
import {
  chordOnDegree,
  chords,
  chordsInKey,
  nameChord,
  scaleById,
  scales,
  snapToScale,
  spellChord,
  spellPitch,
  voiceNotes,
} from '../theory'

const CORE = ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian', 'harmonicMinor', 'melodicMinor', 'majorPentatonic', 'minorPentatonic', 'blues', 'wholeTone', 'dimHalfWhole', 'dimWholeHalf', 'hirajoshi', 'phrygianDominant', 'hungarianMinor', 'insen']

describe('theory library', () => {
  it('keeps the tuner scale order and ships a wide catalog', () => {
    expect(SCALES.slice(0, TUNER_SCALE_COUNT).map((scale) => scale.id)).toEqual(CORE)
    expect(scales().length).toBeGreaterThanOrEqual(70)
    expect(new Set(scales().map((scale) => scale.id)).size).toBe(scales().length)
    expect(chords().length).toBeGreaterThanOrEqual(40)
    for (const scale of scales()) {
      expect(scale.cents[0]).toBe(0)
      expect(scale.cents.at(-1)).toBeLessThan(1200)
      for (let index = 1; index < scale.cents.length; index++) expect(scale.cents[index]).toBeGreaterThan(scale.cents[index - 1])
    }
  })

  it('spells western chords and diatonic sets', () => {
    expect(spellChord(0, 'maj')?.name).toBe('C')
    expect(spellChord(0, 'maj7')?.name).toBe('Cmaj7')
    expect(spellChord(2, 'min')?.name).toBe('Dm')
    expect(spellChord(7, '7')?.name).toBe('G7')
    expect(chordsInKey(0, 'ionian', 'triads').map((chord) => chord.name)).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim'])
    expect(chordsInKey(0, 'ionian', 'sevenths').map((chord) => chord.name)).toEqual(['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7', 'Bm7b5'])
    expect(chordsInKey(0, 'ionian', 'ninths')[0].name).toBe('Cmaj9')
    expect(chordsInKey(0, 'ionian', 'sixths')[0].name).toBe('C6')
    expect(chordsInKey(2, 'dorian', 'triads').map((chord) => chord.name)).toEqual(['Dm', 'Em', 'F', 'G', 'Am', 'Bdim', 'C'])
    expect(chordOnDegree(0, 'ionian', 5, 'triads')?.name).toBe('G')
    expect(nameChord([60, 64, 67])).toBe('C')
  })

  it('builds maqam intervals, including quarter tones', () => {
    expect(scaleById('rast').cents).toEqual([0, 200, 350, 500, 700, 900, 1050])
    expect(scaleById('bayati').cents).toEqual([0, 150, 300, 500, 700, 800, 1000])
    expect(scaleById('hijaz').cents).toEqual([0, 100, 400, 500, 700, 800, 1000])
    expect(scaleById('saba').cents).toContain(150)
    expect(scaleById('saba').cents[1]).toBe(150)
    expect(scaleById('sikah').cents).toContain(150)
    expect(scaleById('sikah').cents).toContain(350)
    expect(scaleById('suznak').cents).toEqual([0, 200, 350, 500, 700, 800, 1100])
    expect(scales().filter((scale) => scale.family === 'maqam' && scale.microtonal).length).toBeGreaterThanOrEqual(12)
    const tonic = chordsInKey(0, 'rast', 'triads')[0]
    expect(tonic.intervals).toEqual([0, 350, 700])
    expect(tonic.name).toBe('C rast')
    expect(tonic.pitches[1]).toBeCloseTo(63.5, 5)
    expect(spellPitch(63.5)).toBe('Ed')
    expect(chordsInKey(0, 'rast', 'triads')[1].name).toBe('Dm')
    const bayati = chordsInKey(0, 'bayati', 'jins')[0]
    expect(bayati.intervals.slice(0, 4)).toEqual([0, 150, 300, 500])
    expect(bayati.name).toBe('C bayati')
  })

  it('snaps a chromatic pitch onto the maqam quarter tone', () => {
    const snapped = snapToScale(63, 0, 'rast')
    expect(snapped.pitch + snapped.cents / 100).toBeCloseTo(63.5, 5)
    expect(Math.abs(snapped.cents)).toBe(50)
    expect(snapToScale(60, 0, 'ionian')).toEqual({ pitch: 60, cents: 0 })
    expect(snapToScale(61, 0, 'ionian').pitch).toBe(60)
  })

  it('drop-voices and voice-leads from the shared voicing API', () => {
    const drop = voiceNotes([60, 64, 67, 71], { voicing: 'drop2' })
    expect(Math.max(...drop) - Math.min(...drop)).toBeGreaterThan(11)
    const shell = voiceNotes([60, 64, 67, 71], { shell: true })
    expect(shell).toEqual([60, 64, 71])
    const led = voiceChord([65, 69, 72], { voiceLead: true, previous: [60, 64, 67] })
    expect(led.every((pitch) => Number.isInteger(pitch))).toBe(true)
    const rast = voiceNotes(chordsInKey(0, 'rast', 'triads')[0].pitches, { inversion: 1 })
    expect(rast[0]).toBeCloseTo(63.5, 5)
  })

  it('writes a rast chord onto a clip with quarter-tone bend', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    const clipId = store.selectedMidiClipId!
    store.setScale({ root: 0, scale: 'rast', snap: false })
    const chord = chordsInKey(0, 'rast', 'triads')[0]
    store.insertPerformance(track.id, clipId, 0, chord.pitches)
    const notes = store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clipId)!.notes
    const sounding = notes.map((note) => note.pitch + (note.fine || 0) / 100).sort((a, b) => a - b)
    expect(sounding[0]).toBeCloseTo(60, 5)
    expect(sounding).toContainEqual(expect.closeTo(63.5, 5))
    expect(notes.some((note) => note.fine === 50 || note.fine === -50)).toBe(true)
  })
})
