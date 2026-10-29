import { describe, expect, it } from 'vitest'
import { selectSounds } from '../state/select'
import { ProjectStore } from '../state/store'

describe('track selection', () => {
  it('targets the selected track for loading and does not arm it', () => {
    const store = new ProjectStore()
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    expect(vocal.armed).toBe(false)
    store.selectTrack(keys.id)
    expect(store.selectedTrackId).toBe(keys.id)
    expect(keys.armed).toBe(false)
    expect(selectSounds(store).instrumentId).toBe(keys.id)
    expect(selectSounds(store).instrumentName).toBe('Keys')
    store.selectTrack(vocal.id)
    expect(vocal.armed).toBe(false)
    expect(selectSounds(store).trackId).toBe(vocal.id)
    expect(selectSounds(store).trackName).toBe('Vocal')
    const before = store.project.tracks.map((track) => track.armed)
    store.addTrack('midi')
    const added = store.project.tracks.find((track) => track.id === store.selectedTrackId)!
    expect(added.type).toBe('midi')
    expect(added.armed).toBe(false)
    expect(store.project.tracks.filter((track) => before.includes(track.armed)).length).toBeGreaterThan(0)
  })
})
