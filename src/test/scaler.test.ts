import { describe, expect, it } from 'vitest'
import { padPerformance } from '../instruments/scaler/model'
import { migrateProject } from '../model/schema'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

describe('scaler instrument', () => {
  it('inserts Scaler on a track from the instrument slot', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.setTrackInstrument(id, 'scaler')
    const track = store.track(id)
    expect(track?.instrument).toBe('scaler')
    expect(track?.scaler?.group).toBe('triad')
    expect(store.scalerTrackId).toBe(id)
  })

  it('a chord pad produces notes', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.setTrackInstrument(id, 'scaler')
    const notes = store.scalerPadNotes(id, 0)
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((note) => note.pitch >= 0 && note.pitch <= 127 && note.durationBeats > 0)).toBe(true)
    const played = padPerformance(store.track(id)!.scaler!, 0, 4)
    expect(played?.notes.length).toBe(notes.length)
    expect(played?.symbol.startsWith('C')).toBe(true)
  })

  it('keeps Scaler state on the track through save and undo', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.setTrackInstrument(id, 'scaler')
    const other = store.addTracks({ kind: 'midi', count: 1, instrument: 'synth', input: 'mic', channels: 1, armed: false })[0]
    store.setScaler(id, { root: 2, scale: 'dorian', sound: 'forward', forwardTrackId: other, voicing: 'drop2' })
    const saved = new ProjectStore(migrateProject(JSON.parse(JSON.stringify(store.project))))
    expect(saved.track(id)?.instrument).toBe('scaler')
    expect(saved.track(id)?.scaler?.root).toBe(2)
    expect(saved.track(id)?.scaler?.scale).toBe('dorian')
    expect(saved.track(id)?.scaler?.sound).toBe('forward')
    expect(saved.track(id)?.scaler?.forwardTrackId).toBe(other)
    expect(saved.track(id)?.scaler?.voicing).toBe('drop2')
    store.undo()
    expect(store.track(id)?.scaler?.root).toBe(0)
    expect(store.track(id)?.scaler?.sound).toBe('synth')
  })

  it('sends a pad to arrange as a MIDI clip and records played chords', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.setTrackInstrument(id, 'scaler')
    const notes = store.scalerPadNotes(id, 0)
    store.writeScalerClip(id, notes, 4, 'C')
    const clip = store.track(id)?.midiClips.find((item) => item.name === 'C')
    expect(clip?.startBeat).toBe(4)
    expect(clip?.notes.length).toBe(notes.length)
    store.recordScalerChord(id, notes, 0)
    store.recordScalerChord(id, store.scalerPadNotes(id, 1), 4)
    const take = store.track(id)?.midiClips.find((item) => item.name === 'Scaler')
    expect(take?.notes.length).toBeGreaterThan(notes.length)
  })
})
