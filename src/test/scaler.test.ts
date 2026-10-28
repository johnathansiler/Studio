import { describe, expect, it } from 'vitest'
import { notesFromSlots } from '../instruments/scaler/clips'
import { detectedScales, expressNotes, FIFTHS, modulationChords, moodOf, progressionMood } from '../instruments/scaler/face'
import { encodeScalerDrag, padPerformance, parseScalerDrag, performancesOn, routeScaler } from '../instruments/scaler/model'
import { defaultScaler } from '../instruments/scaler/types'
import { migrateProject } from '../model/schema'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import type { SamplerProgram } from '../audio/multisample/types'
import { chordsInScale, harmonize } from '../theory'
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
    expect(moodOf('C', 'lydian').score).toBeGreaterThan(moodOf('C', 'mixolydian').score)
    expect(moodOf('Csus2', 'ionian').score).toBeLessThan(major.score)
    const still = expressNotes([{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }], 0)
    const push = expressNotes([{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }], 2)
    expect(push[0].velocity).toBeGreaterThan(still[0].velocity)
    expect(push[0].durationBeats).toBeLessThan(still[0].durationBeats)
  })

  it('spells diatonic chords, borrowed chords, and a fifths pathway', () => {
    expect(harmonize(0, 'ionian', 3).map((chord) => chord.roman)).toEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'])
    expect(harmonize(0, 'ionian', 4).map((chord) => chord.roman)).toEqual(['IΔ', 'ii7', 'iii7', 'IVΔ', 'V7', 'vi7', 'vii°7'])
    expect(harmonize(5, 'lydian', 3).map((chord) => chord.symbol)).toEqual(['F', 'G', 'Am', 'Bdim', 'C', 'Dm', 'Em'])
    expect(harmonize(9, 'harmonicMinor', 3)[4]).toMatchObject({ symbol: 'E', roman: 'V' })
    expect(chordsInScale(0, 'ionian', ['sus']).find((chord) => chord.chordId === 'sus2' && chord.degree === 0)?.roman).toBe('I')
    expect(chordsInScale(0, 'ionian', ['add']).find((chord) => chord.chordId === 'add9' && chord.degree === 0)?.roman).toBe('I')
    const pathway = modulationChords('secondary', 0, 'ionian', 7)
    expect(pathway.map((step) => step.symbol)).toEqual(['Am', 'G', 'Em', 'C', 'D7', 'G', 'Am', 'Bm', 'C', 'D', 'Em', 'F#dim'])
    expect(pathway.find((step) => step.symbol === 'D7')?.adopt).toBe(false)
    expect(pathway.filter((step) => step.adopt).every((step) => step.root === 7)).toBe(true)
    const borrowed = modulationChords('parallel', 0, 'ionian')
    expect(borrowed.map((step) => step.symbol)).toEqual(['Cm', 'Ddim', 'D#', 'Fm', 'Gm', 'G#', 'A#'])
    expect(borrowed.every((step) => !step.adopt)).toBe(true)
    expect(modulationChords('mediant', 0, 'ionian').map((step) => step.symbol)).toEqual(['G#m', 'G#', 'Am', 'A', 'D#m', 'D#', 'Em', 'E'])
    for (let i = 0; i < FIFTHS.length; i++) expect((FIFTHS[i] + 7) % 12).toBe(FIFTHS[(i + 1) % FIFTHS.length])
  })

  it('keeps an inversion, a rest in the lane, and editable dragged MIDI', () => {
    const state = { ...defaultScaler(), inversion: 2, voiceLead: true, lastVoicing: [60, 64, 67], lastCents: [0, 0, 0] }
    const played = padPerformance(state, 0, 4)
    const bass = Math.min(...(played?.voiced ?? []).map((tone) => tone.midi))
    expect(bass % 12).toBe(7)
    const lane = notesFromSlots([
      { notes: [{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }] },
      null,
      { notes: [{ pitch: 64, startBeat: 0, durationBeats: 1, velocity: 0.8 }] },
    ], 4)
    expect(lane.map((note) => note.startBeat)).toEqual([0, 8])
    const raw = encodeScalerDrag({ trackId: 't', name: 'C', notes: lane })
    expect(parseScalerDrag(raw)?.notes[1]?.pitch).toBe(64)
    const found = detectedScales([60, 62, 64, 65, 67, 69, 71].map((midi) => ({ midi })), 0, 'ionian')
    expect(found[0]).toMatchObject({ root: 0, scaleId: 'ionian' })
  })

  it('is not its own view tab', () => {
    expect(VIEW_COPY.map((item) => item.id)).toEqual(['arrange', 'mix', 'beats', 'session', 'collab'])
  })
})
