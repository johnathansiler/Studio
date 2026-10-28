import { describe, expect, it } from 'vitest'
import { chordsFromNotes, followSource, generate, generatorInput, normalizeGenerator, STYLES, styleById } from '../generators'
import { loadScaleCatalog } from '../theory'
import type { GeneratorInput, GeneratorKind } from '../generators'
import { DRUM_PADS } from '../model/drums'
import { migrateProject } from '../model/schema'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { soundingCents } from '../generators/tune'

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const KINDS: GeneratorKind[] = ['chords', 'bass', 'melody', 'arp', 'rhythm', 'drums']

function input(patch: Partial<GeneratorInput> = {}): GeneratorInput {
  return {
    key: 0,
    scale: MAJOR,
    chords: [],
    tempo: 120,
    bars: 4,
    style: 'pop',
    seed: 7,
    variation: 0,
    beatsPerBar: 4,
    ...patch,
  }
}

describe('generators', () => {
  it('repeats a seed and changes when the seed or the variation changes', () => {
    const first = generate('melody', input())
    const again = generate('melody', input())
    expect(again.notes).toEqual(first.notes)
    expect(generate('melody', input({ seed: 8 })).notes).not.toEqual(first.notes)
    const varied = generate('melody', input({ variation: 1 }))
    expect(varied.notes).not.toEqual(first.notes)
    expect(generate('melody', input({ variation: 1 })).notes).toEqual(varied.notes)
  })

  it('keeps the chord roots when you vary, and still edits the voicing', () => {
    const base = generate('chords', input({ style: 'gospel', seed: 4, bars: 4 }))
    const varied = generate('chords', input({ style: 'gospel', seed: 4, bars: 4, variation: 2 }))
    expect(varied.chords.map((chord) => chord.root)).toEqual(base.chords.map((chord) => chord.root))
    expect(varied.notes).not.toEqual(base.notes)
    expect(base.notes.length).toBeGreaterThan(3)
    expect(base.label.length).toBeGreaterThan(0)
  })

  it('follows a provided progression for bass, melody, and arp', () => {
    const chords = [
      { pitches: [60, 64, 67], beats: 4, root: 0, symbol: 'C' },
      { pitches: [65, 69, 72], beats: 4, root: 5, symbol: 'F' },
    ]
    const bass = generate('bass', input({ chords, style: 'pop', bars: 2, seed: 3 }))
    expect(bass.notes.find((note) => note.startBeat === 0)?.pitch).toBe(36)
    expect(bass.notes.find((note) => note.startBeat === 4)?.pitch).toBe(41)
    const melody = generate('melody', input({ chords, style: 'pop', bars: 2, seed: 3 }))
    const allowed = new Set([0, 2, 4, 5, 7, 9, 11])
    expect(melody.notes.every((note) => allowed.has(((note.pitch % 12) + 12) % 12))).toBe(true)
    const arp = generate('arp', input({
      chords: [{ pitches: [60, 64, 67], beats: 2, root: 0 }],
      bars: 1,
      beatsPerBar: 2,
      seed: 1,
      options: { arpPattern: 'up', rate: 0.5, octaves: 2, gate: 0.5 },
    }))
    expect(arp.notes.map((note) => note.pitch)).toEqual([60, 64, 67, 72])
    expect(arp.notes.every((note) => note.durationBeats === 0.25)).toBe(true)
    const narrow = generate('arp', input({
      chords: [{ pitches: [60, 64, 67], beats: 2, root: 0 }],
      bars: 1,
      beatsPerBar: 2,
      options: { arpPattern: 'up', rate: 0.5, octaves: 1, gate: 0.8 },
    }))
    expect(new Set(narrow.notes.map((note) => note.pitch))).toEqual(new Set([60, 64, 67]))
  })

  it('passes through a passed progression so the next part matches', () => {
    const invented = generate('bass', input({ style: 'afrobeats', seed: 11, chords: [] }))
    const followed = generate('bass', input({ style: 'afrobeats', seed: 11, chords: invented.chords }))
    expect(followed.notes).toEqual(invented.notes)
    expect(followed.chords.map((chord) => chord.root)).toEqual(invented.chords.map((chord) => chord.root))
  })

  it('uses a scale-library maqam, including its quarter tones', async () => {
    await loadScaleCatalog()
    const store = new ProjectStore(createEmptyProject())
    store.setScale({ root: 0, library: 'maqam-bayati' })
    const part = generate('chords', generatorInput(store.project, { ...store.generatorState(), kind: 'chords', style: 'maqam', bars: 1, seed: 2 }, []))
    const deltas = part.notes.map((note) => ((soundingCents(note.pitch, note.fine) - soundingCents(60)) % 1200 + 1200) % 1200)
    expect(deltas).toContain(150)
    expect(part.notes.every((note) => note.pitch >= 0 && note.pitch <= 127)).toBe(true)
  })

  it('keeps maqam cent offsets on the sounded pitch', () => {
    const scale = [
      { semitones: 0, cents: 0 },
      { semitones: 1, cents: 50 },
      { semitones: 4, cents: 0 },
      { semitones: 5, cents: 0 },
      { semitones: 7, cents: 0 },
      { semitones: 8, cents: 50 },
      { semitones: 10, cents: 0 },
    ]
    const part = generate('chords', input({ style: 'maqam', scale, bars: 1, seed: 2 }))
    const deltas = part.notes.map((note) => ((soundingCents(note.pitch, note.fine) - soundingCents(60)) % 1200 + 1200) % 1200)
    expect(deltas).toContain(150)
  })

  it('writes a house four-on-the-floor and a swung boom-bap hat', () => {
    const house = generate('drums', input({ style: 'house', bars: 2, seed: 1 }))
    const kicks = house.notes.filter((note) => note.pitch === 36).map((note) => note.startBeat)
    expect(kicks).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    const three = generate('drums', input({ style: 'house', bars: 1, beatsPerBar: 3, seed: 1 }))
    expect(three.notes.filter((note) => note.pitch === 36).map((note) => note.startBeat)).toEqual([0, 1, 2])
    const boom = generate('drums', input({ style: 'boom-bap', bars: 1, seed: 5, variation: 0 }))
    const pop = generate('drums', input({ style: 'pop', bars: 1, seed: 5 }))
    expect(pop.notes.some((note) => note.pitch === 42 && note.startBeat === 0.5)).toBe(true)
    expect(boom.notes.some((note) => note.pitch === 42 && note.startBeat > 0.55 && note.startBeat < 0.72)).toBe(true)
    const pads = new Set(DRUM_PADS.map((pad) => pad.pitch))
    expect(house.notes.every((note) => pads.has(note.pitch))).toBe(true)
  })

  it('covers every style and part with notes inside the phrase', () => {
    expect(STYLES.length).toBeGreaterThanOrEqual(18)
    for (const style of STYLES) {
      expect(style.blurb.length).toBeGreaterThan(8)
      expect(style.drums.kick).toHaveLength(16)
      for (const kind of KINDS) {
        const part = generate(kind, input({ style: style.id, bars: 4, seed: 19 }))
        expect(part.notes.length, `${style.id} ${kind}`).toBeGreaterThan(0)
        for (const note of part.notes) {
          expect(note.pitch).toBeGreaterThanOrEqual(0)
          expect(note.pitch).toBeLessThanOrEqual(127)
          expect(note.startBeat).toBeGreaterThanOrEqual(0)
          expect(note.startBeat).toBeLessThan(16)
          expect(note.durationBeats).toBeGreaterThan(0)
          expect(note.velocity).toBeGreaterThanOrEqual(0.05)
          expect(note.velocity).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('strum patterns stay on the chord tones', () => {
    const part = generate('rhythm', input({
      style: 'reggae',
      bars: 1,
      beatsPerBar: 4,
      chords: [{ pitches: [60, 64, 67], beats: 4, root: 0 }],
      options: { strum: 'skank' },
    }))
    expect(part.notes.length).toBeGreaterThan(3)
    expect(part.notes.every((note) => [60, 64, 67].includes(note.pitch))).toBe(true)
    expect(part.notes.some((note) => note.startBeat === 0.5)).toBe(true)
  })

  it('drops editable MIDI on the part track or a new track and keeps it after refresh', () => {
    const store = new ProjectStore(createEmptyProject())
    store.setScale({ root: 0, scale: 'aeolian' })
    const part = generate('bass', generatorInput(store.project, store.generatorState(), []))
    store.insertGenerated(part, 'part')
    const bass = store.project.tracks.find((track) => track.name === 'Bass')
    expect(bass?.type).toBe('midi')
    expect(bass?.midiClips[0].notes.length).toBe(part.notes.length)
    expect(bass?.midiClips[0].notes[0].id).toBeTruthy()
    store.insertGenerated(part, 'new')
    expect(store.project.tracks.filter((track) => track.name.startsWith('Bass')).length).toBe(2)
    store.undo()
    expect(store.project.tracks.filter((track) => track.name.startsWith('Bass')).length).toBe(1)
    store.setGenerator({ style: 'trap', seed: 42, variation: 3, kind: 'drums' })
    const opened = new ProjectStore(migrateProject(JSON.parse(JSON.stringify(store.project))))
    expect(opened.generatorState()).toMatchObject({ style: 'trap', seed: 42, variation: 3, kind: 'drums' })
    const drums = generate('drums', generatorInput(opened.project, opened.generatorState(), followSource(opened.project).chords))
    opened.insertGenerated(drums, 'part')
    const kit = opened.project.tracks.find((track) => track.name === 'Drums')
    expect(kit?.instrument).toBe('drum-machine')
    expect(kit?.midiClips[0].notes.some((note) => note.pitch === 36)).toBe(true)
  })

  it('reads a chord track back into the progression the bass follows', () => {
    const chords = chordsFromNotes([
      { pitch: 60, startBeat: 0, durationBeats: 3.9 },
      { pitch: 64, startBeat: 0.02, durationBeats: 3.8 },
      { pitch: 67, startBeat: 0.04, durationBeats: 3.7 },
      { pitch: 65, startBeat: 4, durationBeats: 3.9 },
      { pitch: 69, startBeat: 4.02, durationBeats: 3.8 },
      { pitch: 72, startBeat: 4.04, durationBeats: 3.7 },
    ])
    expect(chords).toHaveLength(2)
    expect(chords[0].beats).toBeCloseTo(4, 5)
    expect(chords[0].root).toBe(0)
    expect(chords[1].root).toBe(5)
    const store = new ProjectStore(createEmptyProject())
    store.insertIdea('axis', 0)
    const source = followSource(store.project)
    expect(source.source).toBe('track')
    expect(source.chords.length).toBeGreaterThan(1)
    expect(styleById('missing').id).toBe('pop')
    const heard = generate('chords', input({ style: 'rnb', seed: 6 }))
    expect(normalizeGenerator({ chords: heard.chords }).chords).toEqual(heard.chords)
  })
})
