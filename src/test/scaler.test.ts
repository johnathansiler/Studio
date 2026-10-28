import { describe, expect, it } from 'vitest'
import { moodOf, progressionMood } from '../instruments/scaler/face'
import { padPerformance, performancesOn, routeScaler } from '../instruments/scaler/model'
import { migrateProject } from '../model/schema'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import type { SamplerProgram } from '../audio/multisample/types'
import { VIEW_COPY } from '../ui/chrome'

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

  it('keeps a loaded library on the Scaler track', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.setTrackInstrument(id, 'scaler')
    store.setLibrary(id, { id: 'piano', name: 'Piano', zones: [], samples: [] } as unknown as SamplerProgram)
    expect(store.track(id)?.instrument).toBe('scaler')
    expect(store.track(id)?.scaler?.sound).toBe('library')
    expect(store.track(id)?.library?.name).toBe('Piano')
  })

  it('forwards MIDI to another track once', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.setTrackInstrument(id, 'scaler')
    const other = store.addTracks({ kind: 'midi', count: 1, instrument: 'synth', input: 'mic', channels: 1, armed: false })[0]!
    store.setScaler(id, { sound: 'forward', forwardTrackId: other })
    store.writeScalerClip(id, store.scalerPadNotes(id, 0), 0, 'C')
    const routed = routeScaler(store.project, store.track(id)!)
    expect(routed.liveStripId).toBe(other)
    expect(routed.voice.instrument).not.toBe('scaler')
    expect(performancesOn(store.project, store.track(id)!).some((group) => group.owner.id === id)).toBe(false)
    expect(performancesOn(store.project, store.track(other)!).some((group) => group.owner.id === id && group.clips.length > 0)).toBe(true)
    store.setScaler(other, { sound: 'forward', forwardTrackId: id })
    const again = routeScaler(store.project, store.track(id)!)
    expect(again.voice.instrument).not.toBe('scaler')
    expect(again.liveStripId).toBe(other)
  })

  it('reads a major chord as brighter than a diminished one', () => {
    const major = moodOf('C', 'ionian')
    const dim = moodOf('Bdim', 'locrian')
    expect(major.score).toBeGreaterThan(dim.score)
    expect(major.word).toBe('Bright')
    expect(dim.word).toBe('Dark')
    const lift = progressionMood(['C', 'F', 'G', 'C'], 'ionian')
    const tense = progressionMood(['Am', 'Dm', 'E', 'Am'], 'aeolian')
    expect(lift.feel).toBe('Uplifting')
    expect(tense.score).toBeLessThan(lift.score)
  })

  it('is not its own view tab', () => {
    expect(VIEW_COPY.map((item) => item.id)).toEqual(['arrange', 'mix', 'beats', 'session', 'collab'])
  })
})
