import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { createEmptyProject } from '../model/types'
import { normalizeScale } from '../model/scale'
import { gridPitch } from '../model/padMachine'
import { fromKoma } from '../theory/catalog/world'
import {
  allScales,
  chordsInScale,
  degreeTone,
  detectScale,
  FAMILY_INFO,
  getScale,
  harmonize,
  loadScaleCatalog,
  lockedTone,
  movementCents,
  progressionsFor,
  realizeProgression,
  scaleIsMicrotonal,
  snapToScale,
  spellChord,
  suggestKey,
  voiceLead,
  voiceTones,
} from '../theory'

describe('theory library', () => {
  it('snaps built-in scales the same way as the piano-roll helper', () => {
    expect(snapToScale(61, 0, 0, 'ionian').midi).toBe(60)
    expect(snapToScale(66, 0, 0, 'ionian').midi).toBe(65)
    expect(snapToScale(64, 0, 0, 'ionian')).toMatchObject({ midi: 64, cents: 0 })
    expect(lockedTone(61, 0, { root: 0, scale: 'ionian' }).midi).toBe(60)
  })

  it('lands a quarter tone on Rast instead of the nearest semitone', async () => {
    await loadScaleCatalog()
    const third = snapToScale(64, 0, 0, 'maqam-rast')
    expect(third.cents).toBe(50)
    expect(third.midi).toBe(63)
    const scale = getScale('maqam-rast')
    expect(scale.cents.some((cents) => Math.abs(cents - 350) < 1)).toBe(true)
    expect(scaleIsMicrotonal({ root: 0, scale: 'ionian', library: 'maqam-rast' })).toBe(true)
  })

  it('harmonizes C major and finds suspended chords in the scale', () => {
    expect(harmonize(0, 'ionian', 3).map((chord) => chord.symbol)).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim'])
    expect(harmonize(0, 'ionian', 4).map((chord) => chord.symbol)).toEqual(['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7', 'Bm7b5'])
    const suspended = chordsInScale(0, 'ionian', ['sus']).filter((chord) => chord.degree === 0).map((chord) => chord.chordId)
    expect(suspended).toContain('sus4')
    expect(suspended).toContain('sus2')
    expect(spellChord(0, 'maj', 4, 4).symbol).toBe('C/E')
  })

  it('voice-leads and drop-2 a cadence', () => {
    const c = voiceTones([{ midi: 60, cents: 0 }, { midi: 64, cents: 0 }, { midi: 67, cents: 0 }])
    const far = voiceTones([{ midi: 65, cents: 0 }, { midi: 69, cents: 0 }, { midi: 72, cents: 0 }])
    const led = voiceLead([{ midi: 65, cents: 0 }, { midi: 69, cents: 0 }, { midi: 72, cents: 0 }], c)
    const cost = (tones: { midi: number; cents: number }[]) => movementCents(tones.map((tone) => tone.midi * 100 + tone.cents), c.map((tone) => tone.midi * 100))
    expect(cost(led)).toBeLessThan(cost(far))
    const drop = voiceTones(
      [0, 4, 7, 11].map((interval) => ({ midi: 60 + interval, cents: 0 })),
      { voicing: 'drop2' },
    )
    const midis = drop.map((tone) => tone.midi)
    expect(Math.max(...midis) - Math.min(...midis)).toBeGreaterThan(11)
    const shell = voiceTones(
      [0, 4, 7, 11].map((interval) => ({ midi: 60 + interval, cents: 0 })),
      { voicing: 'shell' },
    )
    expect(shell.map((tone) => tone.midi % 12).sort((a, b) => a - b)).toEqual([0, 4, 11])
  })

  it('keeps C major as Ionian even after the full catalog is loaded', async () => {
    await loadScaleCatalog()
    const notes = [60, 62, 64, 65, 67, 69, 71, 72].map((midi) => ({ midi, weight: 1 }))
    expect(detectScale(notes)[0]?.scaleId).toBe('ionian')
    expect(suggestKey(notes).library).toBe('')
    const minor = [57, 59, 60, 62, 64, 65, 67, 69].map((midi) => ({ midi, weight: midi === 57 ? 4 : 1 }))
    const found = suggestKey(minor)
    expect(found.root).toBe(9)
    expect(['aeolian', 'dorian', 'harmonicMinor', 'melodicMinor']).toContain(found.scale)
  })

  it('ships Western, jazz, raga, maqam, dastgah, and makam scales', async () => {
    await loadScaleCatalog()
    const scales = allScales()
    expect(scales.length).toBeGreaterThan(180)
    const families = new Set(scales.map((scale) => scale.family))
    for (const id of ['western', 'bebop', 'raga', 'maqam', 'dastgah', 'makam', 'japanese']) expect(families.has(id)).toBe(true)
    const known = new Set(FAMILY_INFO.map((family) => family.id))
    for (const scale of scales) {
      expect(known.has(scale.family)).toBe(true)
      expect(scale.description.length).toBeGreaterThan(8)
      expect(scale.cents[0]).toBe(0)
      for (let i = 1; i < scale.cents.length; i++) expect(scale.cents[i]).toBeGreaterThan(scale.cents[i - 1])
    }
    expect(scales.filter((scale) => scale.id.startsWith('mela-'))).toHaveLength(72)
    const rast = fromKoma([9, 8, 5, 9, 9, 8, 5])
    expect(rast[2]).toBeGreaterThan(370)
    expect(rast[2]).toBeLessThan(400)
    expect(getScale('makam-rast').cents[2]).toBeGreaterThan(370)
    const axis = realizeProgression(0, 'ionian', progressionsFor('ionian')[0], 4, 3)
    expect(axis.map((chord) => chord.symbol)).toEqual(['C', 'G', 'Am', 'F'])
  })

  it('locks the piano roll to a quarter tone and inserts a progression in one undo', async () => {
    await loadScaleCatalog()
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    const clipId = store.selectedMidiClipId!
    store.setScale({ root: 0, scale: 'ionian', library: 'maqam-rast', snap: true })
    store.addNote(track.id, clipId, { pitch: 64, startBeat: 0, durationBeats: 1, velocity: 0.8 })
    const notes = () => store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clipId)!.notes
    expect(notes()[0]?.pitch).toBe(63)
    expect(notes()[0]?.fine).toBe(50)
    const line = realizeProgression(0, 'ionian', progressionsFor('ionian')[0], 4, 3)
    store.setScale({ library: '', scale: 'ionian', snap: false })
    store.insertLibrary(line.flatMap((chord, index) => chord.tones.map((tone) => ({
      midi: tone.midi,
      cents: tone.cents,
      start: index * 4,
      duration: 4,
    }))), 'Axis')
    expect(notes().length).toBe(1 + 12)
    store.undo()
    expect(notes()).toHaveLength(1)
    const saved = normalizeScale(JSON.parse(JSON.stringify(store.project.scale)))
    expect(saved.library).toBe('')
    store.setScale({ library: 'maqam-bayati', root: 2, snap: true, voicing: 'drop2' })
    const again = normalizeScale(JSON.parse(JSON.stringify(store.project.scale)))
    expect(again.library).toBe('maqam-bayati')
    expect(again.root).toBe(2)
    expect(again.snap).toBe(true)
    expect(again.voicing).toBe('drop2')
  })

  it('places pad degrees on the same semitones as the existing grid', () => {
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 8; column++) {
        const grid = gridPitch(row, column, 0, 'ionian', 'fourths', true)
        const index = column + row * 3
        const tone = degreeTone(0, index, 'ionian')
        expect(tone.midi).toBe(grid.pitch)
        expect(tone.cents).toBe(0)
      }
    }
  })
})
