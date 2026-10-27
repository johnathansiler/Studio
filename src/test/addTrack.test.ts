import { describe, expect, it } from 'vitest'
import { insertIndex, tracksFor } from '../model/addTrack'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { arrangementDigest } from '../model/sessionSync'

describe('add track', () => {
  it('inserts the chosen count after the selected track and undoes it', () => {
    const store = new ProjectStore(createEmptyProject())
    const selected = store.selectedTrackId!
    const before = arrangementDigest(store.project)
    const ids = store.addTracks({ kind: 'audio', count: 3, instrument: 'none', input: 'line', channels: 2, armed: true })
    expect(ids).toHaveLength(3)
    const at = store.project.tracks.findIndex((track) => track.id === selected)
    expect(store.project.tracks.slice(at + 1, at + 4).map((track) => track.id)).toEqual(ids)
    expect(insertIndex(store.project.tracks, selected)).toBe(at + 1)
    const added = ids.map((id) => store.project.tracks.find((track) => track.id === id)!)
    expect(added.map((track) => track.name)).toEqual(['Audio 1', 'Audio 2', 'Audio 3'])
    expect(new Set(added.map((track) => track.color)).size).toBe(3)
    expect(added.every((track) => track.input === 'line' && track.channels === 2 && track.armed)).toBe(true)
    expect(store.selectedTrackId).toBe(ids[0])
    expect(arrangementDigest(store.project)).not.toBe(before)
    store.undo()
    expect(store.project.tracks.some((track) => ids.includes(track.id))).toBe(false)
    expect(arrangementDigest(store.project)).toBe(before)
  })

  it('keeps a MIDI instrument and makes a drum track a drum machine', () => {
    const store = new ProjectStore(createEmptyProject())
    const midi = store.addTracks({ kind: 'midi', count: 1, instrument: 'sampler', input: 'mic', channels: 1, armed: true })
    const track = store.project.tracks.find((item) => item.id === midi[0])!
    expect(track.type).toBe('midi')
    expect(track.instrument).toBe('sampler')
    expect(track.name).toBe('Sampler 1')
    expect(track.armed).toBe(false)
    store.selectTrack(track.id)
    const drum = store.addTracks({ kind: 'drum', count: 1, instrument: 'none', input: 'mic', channels: 1, armed: false })
    const kit = store.project.tracks.find((item) => item.id === drum[0])!
    expect(kit.type).toBe('midi')
    expect(kit.instrument).toBe('drum-machine')
    expect(store.project.tracks.findIndex((item) => item.id === kit.id)).toBe(store.project.tracks.findIndex((item) => item.id === track.id) + 1)
  })

  it('clamps the count to eight', () => {
    const project = createEmptyProject()
    expect(tracksFor({ kind: 'bus', count: 20, instrument: 'none', input: 'mic', channels: 1, armed: false }, project.tracks)).toHaveLength(8)
    expect(tracksFor({ kind: 'bus', count: 0, instrument: 'none', input: 'mic', channels: 1, armed: false }, project.tracks)[0].name).toBe('Bus 1')
  })
})
