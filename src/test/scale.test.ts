import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { createEmptyProject } from '../model/types'
import {
  detectKey,
  diatonicPads,
  movement,
  nameChord,
  patternNotes,
  snapPitch,
  voiceChord,
} from '../model/scale'

describe('scale helper', () => {
  it('snaps off-scale pitches onto the nearest scale tone', () => {
    expect(snapPitch(61, 0, 'ionian')).toBe(60)
    expect(snapPitch(66, 0, 'ionian')).toBe(65)
    expect(snapPitch(64, 0, 'ionian')).toBe(64)
    expect(snapPitch(63, 0, 'aeolian')).toBe(63)
  })

  it('detects C major from a C major melody', () => {
    const notes = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch) => ({ pitch, weight: 1 }))
    const found = detectKey(notes)
    expect(found.root).toBe(0)
    expect(found.scale).toBe('ionian')
  })

  it('detects A minor from a natural minor melody', () => {
    const notes = [57, 59, 60, 62, 64, 65, 67, 69].map((pitch) => ({ pitch, weight: pitch === 57 ? 4 : 1 }))
    const found = detectKey(notes)
    expect(found.root).toBe(9)
    expect(['aeolian', 'dorian', 'harmonicMinor', 'melodicMinor']).toContain(found.scale)
  })

  it('names triads, sevenths, and suspended chords', () => {
    expect(nameChord([60, 64, 67])).toBe('C')
    expect(nameChord([62, 65, 69])).toBe('Dm')
    expect(nameChord([60, 64, 67, 71])).toBe('Cmaj7')
    expect(nameChord([67, 71, 74, 77])).toBe('G7')
    expect(nameChord([60, 65, 67])).toBe('Csus4')
    expect(nameChord([71, 62, 65])).toBe('Bdim')
  })

  it('builds diatonic triads and sevenths in C', () => {
    expect(diatonicPads(0, 'ionian', 'triads').map((pad) => pad.label)).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim'])
    expect(diatonicPads(0, 'ionian', 'sevenths').map((pad) => pad.label)).toEqual(['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7', 'Bm7b5'])
    expect(diatonicPads(0, 'ionian', 'ninths')[0].label).toBe('Cmaj9')
    expect(diatonicPads(0, 'ionian', 'pop').map((pad) => pad.label)).toEqual(['C', 'G', 'Am', 'F'])
    expect(diatonicPads(0, 'ionian', 'secondary')[0].label).toBe('A7')
  })

  it('voice-leads a cadence closer than a raw jump', () => {
    const c = voiceChord([60, 64, 67])
    const far = voiceChord([65, 69, 72])
    const led = voiceChord([65, 69, 72], { voiceLead: true, previous: c })
    expect(movement(led, c)).toBeLessThan(movement(far, c))
    const drop = voiceChord([60, 64, 67, 71], { drop2: true })
    expect(Math.max(...drop) - Math.min(...drop)).toBeGreaterThan(11)
    expect(voiceChord([60, 64, 67], { octave: true })).toContain(72)
  })

  it('arpeggiates up across octaves and keeps humanize inside its bounds', () => {
    let seed = 1
    const rng = () => {
      seed = (seed * 16807) % 2147483647
      return (seed - 1) / 2147483646
    }
    const arp = patternNotes([60, 64, 67], { arp: 'up', rate: 0.5, gate: 0.5, octaves: 2, spanBeats: 2, rng })
    expect(arp.map((note) => note.pitch)).toEqual([60, 64, 67, 72])
    expect(arp.every((note) => note.durationBeats === 0.25)).toBe(true)
    const plain = patternNotes([60, 64, 67], { rhythm: 'block', spanBeats: 4, velocity: 0, timing: 0, rng: () => 0.5 })
    expect(plain).toHaveLength(3)
    expect(plain.every((note) => note.startBeat === 0)).toBe(true)
    const human = patternNotes([60], { rhythm: 'block', spanBeats: 1, timing: 0.05, velocity: 0.5, rng })
    expect(Math.abs(human[0].startBeat)).toBeLessThanOrEqual(0.05)
    expect(human[0].velocity).toBeGreaterThan(0.05)
    expect(human[0].velocity).toBeLessThanOrEqual(1)
  })

  it('inserts a chord in one undo step and keeps the key on the project', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    const clipId = store.selectedMidiClipId!
    store.setScale({ root: 0, scale: 'ionian', snap: true })
    store.insertPerformance(track.id, clipId, 4, [60, 64, 67])
    const clip = store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clipId)!
    expect(clip.notes.map((note) => note.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67])
    expect(store.project.scale?.root).toBe(0)
    store.undo()
    expect(store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clipId)!.notes).toHaveLength(0)
    store.redo()
    expect(store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clipId)!.notes).toHaveLength(3)
    store.addNote(track.id, clipId, { pitch: 61, startBeat: 0, durationBeats: 1, velocity: 0.8 })
    const notes = () => store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clipId)!.notes
    expect(notes().at(-1)?.pitch).toBe(60)
    store.setScale({ snap: false })
    store.addNote(track.id, clipId, { pitch: 61, startBeat: 2, durationBeats: 1, velocity: 0.8 })
    expect(notes().at(-1)?.pitch).toBe(61)
    store.setScale({ snap: true })
    expect(notes().at(-1)?.pitch).toBe(60)
    store.insertPerformance(track.id, clipId, 8, [63, 67, 70])
    expect(notes().some((note) => note.pitch % 12 === 3)).toBe(true)
  })
})
