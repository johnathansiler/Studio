import { describe, expect, it } from 'vitest'
import { generateEnsemble } from '../ideas/ensemble'
import { generatorKey } from '../ui/PartsGenerator'
import { fitsScale } from '../ideas/scaleFit'
import type { Ensemble, PartRole } from '../ideas/types'
import { isDrumsPlugin } from '../audio/plugins/ids'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

const ROLES: PartRole[] = ['chords', 'bass', 'melody', 'drums']

function make(patch: Partial<Parameters<typeof generateEnsemble>[0]> = {}) {
  return generateEnsemble({
    key: 0,
    scaleId: 'aeolian',
    tempo: 90,
    genre: 'boom-bap',
    bars: 4,
    roles: ROLES,
    complexity: 0.7,
    energy: 0.8,
    swing: 0.2,
    seed: 4,
    ...patch,
  })
}

function inKey(ensemble: Ensemble) {
  for (const part of ensemble.parts) {
    if (part.role === 'drums') continue
    for (const note of part.notes) {
      if (note.passing) continue
      expect(fitsScale(note.pitch, note.fine, ensemble.scaleId, ensemble.key), `${part.role} ${note.pitch}`).toBe(true)
    }
  }
}

function bassFollows(ensemble: Ensemble) {
  const bass = ensemble.parts.find((part) => part.role === 'bass')
  expect(bass?.notes.length).toBeGreaterThan(0)
  let start = 0
  for (const chord of ensemble.chords) {
    const hits = bass!.notes.filter((note) => note.startBeat >= start - 0.02 && note.startBeat < start + Math.min(chord.beats, 1.2))
    expect(hits.length, `bass at ${start}`).toBeGreaterThan(0)
    const nearest = hits.reduce((best, note) => (Math.abs(note.startBeat - start) < Math.abs(best.startBeat - start) ? note : best))
    expect(nearest.pitch % 12).toBe((chord.root ?? 0) % 12)
    start += chord.beats
  }
}

describe('ideas part generator', () => {
  it('follows a set song key and falls back to the project scale', () => {
    expect(generatorKey({ root: 9, scale: 'aeolian', keySet: true })).toEqual({ key: 9, scaleId: 'aeolian', followsSong: true })
    expect(generatorKey({ root: 2, scale: 'dorian', library: 'maqam-hijaz', keySet: true })).toEqual({ key: 2, scaleId: 'maqam-hijaz', followsSong: true })
    expect(generatorKey({ root: 0, scale: 'ionian' })).toEqual({ key: 0, scaleId: 'ionian', followsSong: false })
    expect(generatorKey({ root: 5, scale: 'mixolydian' })).toEqual({ key: 5, scaleId: 'mixolydian', followsSong: false })
    expect(generatorKey(undefined)).toEqual({ key: 0, scaleId: 'ionian', followsSong: false })
  })

  it('keeps every tonal note in the scale, except flagged passing tones', () => {
    for (const genre of ['boom-bap', 'trap', 'lofi', 'rnb', 'house', 'drill', 'pop']) {
      for (const seed of [1, 4, 9]) {
        const ensemble = make({ genre, seed, key: seed % 12, scaleId: genre === 'pop' || genre === 'house' ? 'ionian' : 'aeolian', bars: 8 })
        inKey(ensemble)
        if (genre !== 'trap' && genre !== 'drill' && genre !== 'rnb') {
          expect(ensemble.parts.some((part) => part.notes.some((note) => note.passing))).toBe(false)
        }
      }
    }
  })

  it('locks the bass to each chord root', () => {
    for (const genre of ['boom-bap', 'trap', 'lofi', 'rnb', 'house', 'drill', 'pop']) {
      bassFollows(make({ genre, bars: 8, seed: 6, complexity: 0.4 }))
    }
  })

  it('repeats a seed exactly and changes when the seed changes', () => {
    const first = make({ seed: 11, bars: 8 })
    expect(generateEnsemble({ ...blank(first), seed: 11 })).toEqual(first)
    expect(generateEnsemble({ ...blank(first), seed: 12 })).not.toEqual(first)
  })

  it('rolls one part again and leaves a lock where it is', () => {
    const first = make({ seed: 3 })
    const bass = first.parts.find((part) => part.role === 'bass')!
    const chords = first.parts.find((part) => part.role === 'chords')!
    const rolled = make({ seed: 3, salts: { bass: 2 } })
    expect(rolled.parts.find((part) => part.role === 'bass')!.notes).not.toEqual(bass.notes)
    expect(rolled.parts.find((part) => part.role === 'chords')!.notes).toEqual(chords.notes)
    expect(rolled.chords).toEqual(first.chords)
    const locked = make({
      seed: 19,
      salts: { chords: 4, melody: 2 },
      locked: { bass: bass.notes },
      progression: first.chords,
    })
    expect(locked.parts.find((part) => part.role === 'bass')!.notes).toEqual(bass.notes)
    expect(locked.parts.find((part) => part.role === 'bass')!.locked).toBe(true)
    expect(locked.parts.find((part) => part.role === 'chords')!.notes).not.toEqual(chords.notes)
    bassFollows(rolled)
    inKey(locked)
  })

  it('keeps the line singable, the drums unstacked, and the swing control audible', () => {
    for (const genre of ['boom-bap', 'trap', 'lofi', 'rnb', 'house', 'drill', 'pop']) {
      const ensemble = make({ genre, bars: 8, seed: 8, key: 4, scaleId: 'dorian', energy: 0.2, swing: 0.4 })
      const melody = ensemble.parts.find((part) => part.role === 'melody')!
      const drums = ensemble.parts.find((part) => part.role === 'drums')!
      const bass = ensemble.parts.find((part) => part.role === 'bass')!
      for (let index = 1; index < melody.notes.length; index++) {
        expect(Math.abs(melody.notes[index].pitch - melody.notes[index - 1].pitch), genre).toBeLessThanOrEqual(12)
      }
      for (let index = 1; index < bass.notes.length; index++) {
        expect(Math.abs(bass.notes[index].pitch - bass.notes[index - 1].pitch), `${genre} bass`).toBeLessThanOrEqual(12)
        expect(bass.notes[index - 1].startBeat + bass.notes[index - 1].durationBeats).toBeLessThanOrEqual(bass.notes[index].startBeat + 0.03)
      }
      for (let index = 0; index < drums.notes.length; index++) {
        for (let next = index + 1; next < drums.notes.length; next++) {
          if (drums.notes[next].startBeat - drums.notes[index].startBeat > 0.05) break
          expect(drums.notes[next].pitch === drums.notes[index].pitch && Math.abs(drums.notes[next].startBeat - drums.notes[index].startBeat) < 0.04, genre).toBe(false)
        }
      }
      expect(drums.notes.every((note) => note.velocity >= 0.05 && note.velocity <= 1)).toBe(true)
    }
    const straight = make({ genre: 'boom-bap', swing: 0, bars: 2, seed: 2, roles: ['drums'] })
    const deep = make({ genre: 'boom-bap', swing: 1, bars: 2, seed: 2, roles: ['drums'] })
    const hats = (ensemble: Ensemble) => ensemble.parts[0].notes.filter((note) => note.pitch === 42).map((note) => note.startBeat)
    expect(hats(deep).some((beat, index) => Math.abs(beat - hats(straight)[index]) > 0.03)).toBe(true)
    expect(make({ genre: 'pop', swing: 0 }).clipSwing).toBe(0)
    expect(make({ genre: 'pop', swing: 1 }).clipSwing).toBeGreaterThan(0.4)
  })

  it('puts editable clips on Beat Machine, 808, and the selected track, and undoes them', () => {
    const store = new ProjectStore(createEmptyProject())
    store.setTempo(100)
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    keys.instrument = 'library'
    store.selectedTrackId = keys.id
    const ensemble = make({ genre: 'trap', tempo: 140, key: 9, scaleId: 'aeolian' })
    store.addEnsemble(ensemble, 0)
    expect(store.project.tempo).toBe(140)
    expect(store.project.scale?.root).toBe(9)
    expect(keys.instrument).toBe('library')
    expect(keys.midiClips.some((clip) => clip.notes.length > 0)).toBe(true)
    expect(keys.midiClips.some((clip) => /melody/i.test(clip.name))).toBe(true)
    expect(store.project.tracks.find((track) => track.name === 'Melody')).toBeUndefined()
    const drums = store.project.tracks.find((track) => track.name === 'Drums')
    const bass = store.project.tracks.find((track) => track.name === 'Bass')
    expect(drums?.instrument).toBe('pads')
    expect(drums?.plugins.some((plugin) => isDrumsPlugin(plugin))).toBe(true)
    expect(bass?.instrument).toBe('808')
    expect(drums?.midiClips[0].notes.length).toBeGreaterThan(4)
    const names = new Set(store.project.tracks.flatMap((track) => track.midiClips.map((clip) => clip.id)))
    store.undo()
    expect(store.project.tempo).toBe(100)
    expect(keys.instrument).toBe('library')
    expect(keys.midiClips).toHaveLength(0)
    expect(store.project.tracks.find((track) => track.name === 'Drums')).toBeUndefined()
    expect(store.project.tracks.flatMap((track) => track.midiClips.map((clip) => clip.id)).some((id) => names.has(id))).toBe(false)
  })
})

function blank(ensemble: Ensemble): Parameters<typeof generateEnsemble>[0] {
  return {
    key: ensemble.key,
    scaleId: ensemble.scaleId,
    tempo: ensemble.tempo,
    genre: ensemble.genre,
    bars: ensemble.bars,
    roles: ensemble.parts.map((part) => part.role),
    complexity: ensemble.complexity,
    energy: ensemble.energy,
    swing: ensemble.swing,
    seed: ensemble.seed,
  }
}
