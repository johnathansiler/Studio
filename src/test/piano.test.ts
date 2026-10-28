import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { createEmptyProject, type MidiNote } from '../model/types'
import { activeTool, setActiveTool, subscribeTools } from '../state/tools'
import {
  commitMidiNotes,
  duplicateNotes,
  moveNotes,
  notesInRect,
  paintVelocity,
  pencilNote,
  pinchZoom,
  resizeNote,
  splitNotes,
  withoutNotes,
} from '../ui/pianoEdit'

function midi(partial: Partial<MidiNote> & Pick<MidiNote, 'id' | 'pitch' | 'startBeat' | 'durationBeats'>): MidiNote {
  return { velocity: 0.8, ...partial }
}

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

  it('selects a new instrument track after the selected track', () => {
    const store = new ProjectStore(createEmptyProject())
    const before = store.project.tracks.length
    const selected = store.selectedTrackId
    store.addTrack('midi')
    expect(store.project.tracks).toHaveLength(before + 1)
    const added = store.project.tracks.find((track) => track.id === store.selectedTrackId)!
    expect(added.type).toBe('midi')
    expect(store.project.tracks[store.project.tracks.findIndex((track) => track.id === selected) + 1].id).toBe(added.id)
    expect(added.midiClips).toHaveLength(0)
  })
})

describe('piano roll edits', () => {
  it('draws, resizes, snaps a move, and undoes it', () => {
    const drawn = pencilNote(0.2, 1.2, 60.2, 0.25, 0.8, 'new')
    expect(drawn.startBeat).toBeCloseTo(0.25)
    expect(drawn.durationBeats).toBeCloseTo(1)
    expect(drawn.pitch).toBe(60)

    const held = midi({ id: 'a', pitch: 60, startBeat: 1, durationBeats: 2 })
    const end = resizeNote(held, 'end', 4.1, 0.25)
    expect(end.startBeat).toBe(1)
    expect(end.durationBeats).toBeCloseTo(3)
    const start = resizeNote(held, 'start', 1.6, 0.25)
    expect(start.startBeat).toBeCloseTo(1.5)
    expect(start.startBeat + start.durationBeats).toBeCloseTo(3)

    const chord = [midi({ id: 'low', pitch: 60, startBeat: 0, durationBeats: 1 }), midi({ id: 'high', pitch: 64, startBeat: 0.5, durationBeats: 1 })]
    const moved = moveNotes(chord, ['low', 'high'], 0.7, 2, 0.25)
    expect(moved.map((note) => note.startBeat)).toEqual([0.75, 1.25])
    expect(moved.map((note) => note.pitch)).toEqual([62, 66])
    expect(moveNotes([midi({ id: 'edge', pitch: 60, startBeat: 0.25, durationBeats: 1 })], ['edge'], -1, 0, 0.25)[0].startBeat).toBe(0)

    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.preparePianoClip(track.id, 0)
    const clipId = track.midiClips[0].id
    const read = () => store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clipId)!.notes
    read().splice(0, read().length, ...chord.map((note) => ({ ...note })))
    commitMidiNotes(store, track.id, clipId, moved)
    expect(read()[0].startBeat).toBeCloseTo(0.75)
    store.undo()
    expect(read().map((note) => note.startBeat)).toEqual([0, 0.5])
    store.redo()
    expect(read()[0].pitch).toBe(62)
  })

  it('box-selects, splits, erases, duplicates, and edits velocity', () => {
    const notes = [
      midi({ id: 'a', pitch: 60, startBeat: 0, durationBeats: 1 }),
      midi({ id: 'b', pitch: 62, startBeat: 2, durationBeats: 1 }),
    ]
    expect(notesInRect(notes, 0, 1.2, 59, 61)).toEqual(['a'])
    expect(splitNotes(notes, 'a', 0.5, 'a2')?.map((note) => [note.id, note.durationBeats])).toEqual([['a', 0.5], ['a2', 0.5], ['b', 1]])
    expect(splitNotes(notes, 'a', 0.01, 'x')).toBeNull()
    expect(withoutNotes(notes, ['b']).map((note) => note.id)).toEqual(['a'])
    const copied = duplicateNotes(notes, ['a'], 0.25, () => 'copy')
    expect(copied.copyIds).toEqual(['copy'])
    expect(copied.notes.find((note) => note.id === 'copy')?.startBeat).toBeCloseTo(1)
    expect(paintVelocity(notes, ['a'], 2)[0].velocity).toBe(1)
    expect(paintVelocity(notes, ['b'], -1)[1].velocity).toBe(0.05)
    expect(pinchZoom(70, 16, 2)).toEqual({ pxBeat: 140, row: 32 })
    expect(pinchZoom(200, 40, 4)).toEqual({ pxBeat: 220, row: 44 })
  })

  it('publishes the shared edit tool', () => {
    setActiveTool('select')
    const seen: string[] = []
    const stop = subscribeTools(() => seen.push(activeTool()))
    setActiveTool('pencil')
    setActiveTool('pencil')
    setActiveTool('erase')
    stop()
    setActiveTool('select')
    expect(seen).toEqual(['pencil', 'erase'])
    expect(activeTool()).toBe('select')
  })
})
