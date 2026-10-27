import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { createEmptyProject } from '../model/types'

describe('piano open', () => {
  it('creates one 4-bar clip at the playhead bar and undoes it', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    expect(track.midiClips).toHaveLength(0)
    store.preparePianoClip(track.id, 5)
    expect(track.midiClips).toHaveLength(1)
    expect(track.midiClips[0].startBeat).toBe(4)
    expect(track.midiClips[0].durationBeats).toBe(16)
    expect(track.midiClips[0].notes).toHaveLength(0)
    expect(store.selectedMidiClipId).toBe(track.midiClips[0].id)
    store.preparePianoClip(track.id, 0)
    expect(track.midiClips).toHaveLength(1)
    store.undo()
    store.undo()
    const restored = store.project.tracks.find((item) => item.id === track.id)!
    expect(restored.midiClips).toHaveLength(0)
  })

  it('uses the time signature for four bars and keeps an existing clip', () => {
    const store = new ProjectStore(createEmptyProject())
    store.setTimeSignature(3, 4)
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.preparePianoClip(track.id, 0)
    expect(track.midiClips[0].durationBeats).toBe(12)
    const id = track.midiClips[0].id
    store.preparePianoClip(track.id, 20, id)
    expect(track.midiClips).toHaveLength(1)
    expect(store.selectedMidiClipId).toBe(id)
    expect(track.midiClips[0].startBeat).toBe(0)
  })

  it('selects a new instrument track at the top', () => {
    const store = new ProjectStore(createEmptyProject())
    const before = store.project.tracks.length
    store.addTrack('midi')
    expect(store.project.tracks).toHaveLength(before + 1)
    expect(store.project.tracks[0].type).toBe('midi')
    expect(store.project.tracks[0].id).toBe(store.selectedTrackId)
    expect(store.project.tracks[0].midiClips).toHaveLength(0)
  })
})
