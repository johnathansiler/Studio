import { describe, expect, it } from 'vitest'
import { generateEnsemble } from '../ideas/ensemble'
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
