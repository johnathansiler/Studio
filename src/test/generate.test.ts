import { describe, expect, it } from 'vitest'
import { DRUM_PADS } from '../model/drums'
import {
  GENERATOR_KINDS,
  GENERATOR_STYLES,
  contextFromScale,
  generate,
  type GeneratorScale,
  type GeneratedNote,
} from '../model/generate'
import { SCALES, scaleById } from '../model/scale'
import { ProjectStore } from '../state/store'
import { createEmptyProject } from '../model/types'

const DRUMS = new Set(DRUM_PADS.map((pad) => pad.pitch))

function onGrid(beat: number) {
  return Math.abs(beat * 4 - Math.round(beat * 4)) < 1e-6
}

function inKey(pitch: number, scale: GeneratorScale) {
  const rel = ((Math.round(pitch) - scale.key) % 12 + 12) % 12
  return scale.intervals.some((interval) => interval === rel)
}

function expectClip(notes: GeneratedNote[], scale: GeneratorScale, total: number, drums: boolean) {
  expect(notes.length).toBeGreaterThan(0)
  for (const note of notes) {
    expect(onGrid(note.startBeat)).toBe(true)
    expect(onGrid(note.durationBeats)).toBe(true)
    expect(note.startBeat).toBeGreaterThanOrEqual(0)
    expect(note.durationBeats).toBeGreaterThan(0)
    expect(note.startBeat + note.durationBeats).toBeLessThanOrEqual(total + 1e-6)
    expect(note.velocity).toBeGreaterThan(0)
    expect(note.velocity).toBeLessThanOrEqual(1)
    expect(note.pitch).toBeGreaterThanOrEqual(0)
    expect(note.pitch).toBeLessThanOrEqual(127)
    if (drums) expect(DRUMS.has(note.pitch)).toBe(true)
    else expect(inKey(note.pitch, scale)).toBe(true)
  }
}

describe('style generators', () => {
  it('keeps every style and scale on the key and the 16th grid', () => {
    for (const scale of SCALES) {
      const roots = [0, 7]
      for (const root of roots) {
        const context = contextFromScale(root, scale.id)
        expect(context.intervals).toEqual([...scaleById(scale.id).intervals])
        expect(context.key).toBe(root)
        for (const style of GENERATOR_STYLES) {
          for (const kind of GENERATOR_KINDS) {
            const clip = generate({
              scale: context,
              style: style.id,
              kind: kind.id,
              tempo: 96 + root,
              beatsPerBar: 4,
              seed: root + 3,
            })
            expectClip(clip.notes, context, clip.bars * clip.beatsPerBar, kind.id === 'drums')
            expect(clip.track).toBe(kind.track)
          }
        }
      }
    }
    for (const root of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      for (const scaleId of ['ionian', 'aeolian', 'harmonicMinor', 'phrygianDominant'] as const) {
        const context = contextFromScale(root, scaleId)
        for (const kind of ['chords', 'bass', 'melody'] as const) {
          const clip = generate({ scale: context, style: root % 2 === 0 ? 'gospel' : 'drill', kind, tempo: 108, beatsPerBar: 4, seed: root + 1 })
          expectClip(clip.notes, context, clip.bars * clip.beatsPerBar, false)
        }
      }
    }
  }, 20000)

  it('follows a custom scale and snaps chord tones that leave the key', () => {
    const hijaz: GeneratorScale = { key: 2, intervals: [0, 1, 4, 5, 7, 8, 11], chords: [] }
    for (const kind of GENERATOR_KINDS) {
      if (kind.id === 'drums') continue
      const clip = generate({ scale: hijaz, style: 'cinematic', kind: kind.id, tempo: 72, beatsPerBar: 4, seed: 6 })
      expectClip(clip.notes, { ...hijaz, chords: [] }, clip.bars * clip.beatsPerBar, false)
    }
    const dominant: GeneratorScale = {
      key: 0,
      intervals: [0, 2, 4, 5, 7, 9, 11],
      chords: [{ label: 'C7', root: 0, intervals: [0, 4, 7, 10], degree: 0 }],
    }
    const chords = generate({ scale: dominant, style: 'pop', kind: 'chords', tempo: 110, beatsPerBar: 4, seed: 2 })
    const pcs = new Set(chords.notes.map((note) => note.pitch % 12))
    expect(pcs.has(10)).toBe(false)
    expect(pcs.has(0)).toBe(true)
    expect(pcs.has(4)).toBe(true)
    expect(pcs.has(7)).toBe(true)
    expectClip(chords.notes, dominant, chords.bars * chords.beatsPerBar, false)
  })

  it('re-rolls a new part and repeats a seed exactly', () => {
    const scale = contextFromScale(0, 'ionian')
    const base = { scale, style: 'pop' as const, kind: 'chords' as const, tempo: 120, beatsPerBar: 4 }
    const first = generate({ ...base, seed: 1 })
    expect(generate({ ...base, seed: 1 }).notes).toEqual(first.notes)
    const seen = new Set<string>()
    for (let seed = 1; seed <= 8; seed++) seen.add(JSON.stringify(generate({ ...base, seed }).notes))
    expect(seen.size).toBeGreaterThan(1)
    const known = ['C – G – Am – F', 'Am – F – C – G', 'C – Am – F – G', 'C – F – G – C']
    for (let seed = 1; seed <= 12; seed++) {
      const summary = generate({ ...base, seed }).summary
      expect(known).toContain(summary)
    }
  })

  it('lines the bass up with the chords and follows the bar and the tempo', () => {
    const scale = contextFromScale(0, 'aeolian')
    const shared = { scale, style: 'trap' as const, tempo: 140, beatsPerBar: 4, seed: 5 }
    const chords = generate({ ...shared, kind: 'chords' })
    const bass = generate({ ...shared, kind: 'bass' })
    for (let bar = 0; bar < chords.bars; bar++) {
      const start = bar * chords.beatsPerBar
      const end = start + chords.beatsPerBar
      const pcs = new Set(chords.notes.filter((note) => note.startBeat >= start && note.startBeat < end).map((note) => note.pitch % 12))
      const down = bass.notes.find((note) => note.startBeat === start)
      expect(down).toBeTruthy()
      expect(pcs.has(down!.pitch % 12)).toBe(true)
    }
    const waltz = generate({ scale: contextFromScale(5, 'dorian'), style: 'jazz', kind: 'melody', tempo: 100, beatsPerBar: 3, seed: 2 })
    expect(waltz.beatsPerBar).toBe(3)
    expectClip(waltz.notes, contextFromScale(5, 'dorian'), 12, false)
    const hats = (tempo: number) => generate({ scale, style: 'trap', kind: 'drums', tempo, beatsPerBar: 4, seed: 1 }).notes.filter((note) => note.pitch === 42)
    expect(hats(80).length).toBeGreaterThan(0)
    expect(hats(80).every((note) => onGrid(note.startBeat) && Math.abs(note.startBeat * 2 - Math.round(note.startBeat * 2)) < 1e-6)).toBe(true)
    expect(hats(140).some((note) => Math.round(note.startBeat * 4) % 2 === 1)).toBe(true)
    const opens = (tempo: number) => generate({ scale: contextFromScale(0, 'ionian'), style: 'house', kind: 'drums', tempo, beatsPerBar: 4, seed: 1 }).notes.filter((note) => note.pitch === 46).length
    expect(opens(160)).toBeLessThan(opens(120))
    const melody = (tempo: number) => generate({ scale: contextFromScale(0, 'ionian'), style: 'pop', kind: 'melody', tempo, beatsPerBar: 4, seed: 2 }).notes.length
    expect(melody(170)).toBeLessThanOrEqual(melody(90))
  })

  it('inserts an editable clip on the part track without moving the tempo', () => {
    const store = new ProjectStore(createEmptyProject())
    const tempo = store.project.tempo
    const scale = contextFromScale(0, 'ionian')
    store.setScale({ root: 0, scale: 'ionian' })
    const chords = generate({ scale, style: 'pop', kind: 'chords', tempo, beatsPerBar: 4, seed: 1 })
    store.insertGenerated(chords)
    expect(store.project.tempo).toBe(tempo)
    const track = store.project.tracks.find((item) => item.name === 'Chords')
    expect(track?.midiClips).toHaveLength(1)
    const clip = track!.midiClips[0]
    expect(clip.name).toBe(chords.name)
    expect(clip.notes.map((note) => note.pitch)).toEqual(chords.notes.map((note) => note.pitch))
    expectClip(clip.notes, scale, chords.bars * chords.beatsPerBar, false)
    const original = clip.notes[0].durationBeats
    store.updateNote(track!.id, clip.id, clip.notes[0].id, { durationBeats: 1 })
    expect(store.project.tracks.find((item) => item.id === track!.id)!.midiClips[0].notes[0].durationBeats).toBe(1)
    store.undo()
    expect(store.project.tracks.find((item) => item.id === track!.id)!.midiClips[0].notes[0].durationBeats).toBe(original)
    store.insertGenerated(chords)
    expect(store.project.tracks.find((item) => item.name === 'Chords')!.midiClips).toHaveLength(2)
    expect(store.project.tracks.find((item) => item.name === 'Chords')!.midiClips[1].startBeat).toBeGreaterThan(0)
    const drums = generate({ scale, style: 'drill', kind: 'drums', tempo, beatsPerBar: 4, seed: 3 })
    store.insertGenerated(drums)
    const kit = store.project.tracks.find((item) => item.name === 'Drums')
    expect(kit?.instrument).toBe('drum-machine')
    expectClip(kit!.midiClips[0].notes, scale, drums.bars * drums.beatsPerBar, true)
    store.undo()
    expect(store.project.tracks.some((item) => item.name === 'Drums')).toBe(false)
  })
})
