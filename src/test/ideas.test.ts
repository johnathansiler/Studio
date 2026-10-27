import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { createEmptyProject } from '../model/types'
import { NOTE_NAMES } from '../model/scale'
import {
  PROGRESSIONS,
  filterIdeas,
  progressionById,
  romanLine,
  spellProgression,
  spellSymbol,
  starterParts,
} from '../model/progressions'

function pcs(symbol: string, mode: 'major' | 'minor', root: number) {
  return spellSymbol(symbol, mode, root).pitches.map((pitch) => ((pitch % 12) + 12) % 12).sort((a, b) => a - b)
}

function triad(root: number, minor = false) {
  return [0, minor ? 3 : 4, 7].map((interval) => (root + interval) % 12).sort((a, b) => a - b)
}

describe('chord ideas', () => {
  it('transposes numerals into every key', () => {
    for (let root = 0; root < 12; root++) {
      expect(pcs('I', 'major', root)).toEqual(triad(root))
      expect(spellSymbol('I', 'major', root).name.startsWith(NOTE_NAMES[root])).toBe(true)
      expect(pcs('iv', 'major', root)).toEqual(triad((root + 5) % 12, true))
      expect(pcs('V/V', 'major', root)).toEqual(triad((root + 2) % 12))
      expect(pcs('V/vi', 'major', root)).toEqual(triad((root + 4) % 12))
      expect(pcs('bVII', 'major', root)).toEqual(triad((root + 10) % 12))
      expect(pcs('#iv°', 'major', root)).toEqual([0, 3, 6].map((interval) => (root + 6 + interval) % 12).sort((a, b) => a - b))
    }
  })

  it('spells borrowed, secondary, Andalusian, and twelve-bar patterns', () => {
    expect(pcs('i', 'minor', 9)).toEqual(triad(9, true))
    expect(pcs('VI', 'minor', 9)).toEqual(triad(5))
    expect(pcs('III', 'minor', 9)).toEqual(triad(0))
    expect(pcs('VII', 'minor', 9)).toEqual(triad(7))
    const andalusian = spellProgression(progressionById('andalusian')!.chords, 'minor', 9)
    expect(andalusian.map((chord) => chord.name)).toEqual(['Am', 'G', 'F', 'E'])
    expect(andalusian.map((chord) => chord.startBeat)).toEqual([0, 4, 8, 12])
    const blues = spellProgression(progressionById('blues12')!.chords, 'major', 0)
    expect(blues).toHaveLength(12)
    expect(blues[0].name).toBe('C')
    expect(blues[4].startBeat).toBe(16)
    expect(blues[4].name).toBe('F')
    expect(blues[8].name).toBe('G')
    expect(romanLine(progressionById('axis')!.chords)).toBe('I–V–vi–IV')
  })

  it('drops the idea onto the chord track with bass and drums on the beat', () => {
    const store = new ProjectStore(createEmptyProject())
    store.setScale({ root: 0, snap: true })
    store.insertIdea('axis', 0)
    expect(store.scaleState().idea).toBe('axis')
    const chords = store.project.tracks.find((track) => track.name === 'Chords')
    const bass = store.project.tracks.find((track) => track.name === 'Bass')
    const drums = store.project.tracks.find((track) => track.name === 'Drums')
    expect(chords?.midiClips[0].name).toBe('I–V–vi–IV')
    const notes = chords?.midiClips[0].notes ?? []
    expect(notes.some((note) => note.startBeat === 0 && note.pitch % 12 === 0)).toBe(true)
    expect(notes.some((note) => note.startBeat === 4)).toBe(true)
    expect(notes.every((note) => Number.isInteger(note.startBeat * 4))).toBe(true)
    expect(bass?.midiClips[0].notes[0]).toMatchObject({ startBeat: 0, pitch: 36 })
    expect((drums?.midiClips[0].notes.length ?? 0) > 8).toBe(true)
    const parts = starterParts(progressionById('axis')!, 0)
    expect(parts.spelled[2].name).toBe('Am')
    store.toggleFavorite('axis')
    expect(store.scaleState().favorites).toContain('axis')
    expect(filterIdeas('anthemic', 'pop', 'uplifting').some((item) => item.id === 'axis')).toBe(true)
    const genres = new Set(PROGRESSIONS.flatMap((item) => item.genres))
    for (const genre of ['pop', 'trap', 'r&b', 'gospel', 'lo-fi', 'edm', 'rock', 'country', 'jazz', 'cinematic', 'drill', 'afrobeats', 'reggaeton']) {
      expect(genres.has(genre)).toBe(true)
    }
    expect(PROGRESSIONS.length).toBeGreaterThanOrEqual(30)
  })
})
