import { describe, expect, it } from 'vitest'
import { hitAt, soundingNotes, stepCount, stepIndexFor, swingShift } from '../model/drumLanes'
import { ROLL_HIGH, ROLL_LOW } from '../ui/PianoRoll'
import { chooseClef, keyFifths, layoutScore, midiAtPosition, scoreSvg, spellPitch, staffPosition } from '../model/score'
import { clearStep, nearestStep, placeStep, stepPlace, tieHeld } from '../model/stepEntry'
import { createEmptyProject, type MidiNote, type Project } from '../model/types'
import { selectMidiEditor } from '../state/select'
import { ProjectStore } from '../state/store'

function note(partial: Partial<MidiNote> & Pick<MidiNote, 'id' | 'pitch' | 'startBeat' | 'durationBeats'>): MidiNote {
  return { velocity: 0.8, ...partial }
}

function midiStore() {
  const store = new ProjectStore(createEmptyProject())
  const track = store.project.tracks.find((item) => item.type === 'midi')!
  store.addMidiClip(track.id, 0)
  const clip = track.midiClips[0]
  return { store, track, clip }
}

describe('step input', () => {
  it('enters a note, a chord, a rest, and a tie, then undoes them', () => {
    const { store, track, clip } = midiStore()
    store.setMidiEditor({ mode: 'step', step: 1, velocity: 0.7 })
    const read = () => store.project.tracks.find((item) => item.id === track.id)!.midiClips.find((item) => item.id === clip.id)!.notes
    store.enterSteps(track.id, clip.id, [{ pitch: 60 }, { pitch: 64 }])
    expect(read().map((item) => item.pitch).sort()).toEqual([60, 64])
    expect(read().every((item) => item.startBeat === 0 && item.durationBeats === 1)).toBe(true)
    expect(store.midiEditor().cursor).toBe(1)
    store.restStep(track.id, clip.id)
    expect(store.midiEditor().cursor).toBe(2)
    expect(read()).toHaveLength(2)
    store.enterSteps(track.id, clip.id, [{ pitch: 67 }])
    store.tieStep(track.id, clip.id)
    expect(read().find((item) => item.pitch === 67)!.durationBeats).toBe(2)
    expect(store.midiEditor().cursor).toBe(4)
    store.undo()
    expect(read().find((item) => item.pitch === 67)!.durationBeats).toBe(1)
    store.undo()
    expect(read().some((item) => item.pitch === 67)).toBe(false)
    store.stepBack()
    store.stepBack()
    expect(store.midiEditor().cursor).toBe(0)
    store.clearCursor(track.id, clip.id)
    expect(read()).toHaveLength(0)
  })

  it('ties the next played pitch and replaces a note on the same step', () => {
    const placed = placeStep([], 0, [{ pitch: 60, velocity: 0.5 }], 0.5, 0.8, false, () => 'a')
    const tied = placeStep(placed.notes, placed.cursor, [{ pitch: 60 }], 0.5, 0.8, true, () => 'b')
    expect(tied.notes).toHaveLength(1)
    expect(tied.notes[0].durationBeats).toBe(1)
    expect(tied.cursor).toBe(1)
    const again = placeStep(tied.notes, 0, [{ pitch: 60, velocity: 0.4 }], 0.25, 0.8, false, () => 'c')
    expect(again.notes).toHaveLength(1)
    expect(again.notes[0].id).toBe('a')
    expect(again.notes[0].durationBeats).toBe(0.25)
    expect(again.notes[0].velocity).toBe(0.4)
    expect(tieHeld([{ ...placed.notes[0], durationBeats: 0.5 }], 0.2, 0.5).tied).toBe(false)
    expect(clearStep(again.notes, 0, 0.25)).toHaveLength(0)
    expect(nearestStep(0.9)).toBe(1)
    expect(stepPlace(0, { numerator: 4, denominator: 4 })).toBe('1.1')
    expect(stepPlace(5, { numerator: 3, denominator: 4 })).toBe('2.3')
  })

  it('arms tie when nothing is waiting and keeps the editor on the project', () => {
    const { store, track, clip } = midiStore()
    store.tieStep(track.id, clip.id)
    expect(store.midiEditor().tie).toBe(true)
    expect(selectMidiEditor(store).editor.mode).toBe('roll')
    store.remoteFollow = true
    store.enterSteps(track.id, clip.id, [{ pitch: 62 }])
    expect(store.project.tracks.find((item) => item.id === track.id)!.midiClips[0].notes).toHaveLength(0)
  })
})

describe('drum lanes', () => {
  it('edits hits, velocity, flam, roll, and swing without moving the grid', () => {
    const { store, track, clip } = midiStore()
    store.setMidiEditor({ mode: 'drums' })
    store.setDrumHit(track.id, clip.id, 36, 0, { on: true, velocity: 0.9 })
    store.setDrumHit(track.id, clip.id, 38, 1, { on: true, velocity: 0.6 })
    const snare = clip.notes.find((item) => item.pitch === 38)!
    store.setDrumHit(track.id, clip.id, 38, 1, { flam: true, roll: 4 })
    store.setClipSwing(track.id, clip.id, 0.5)
    expect(snare.startBeat).toBe(0.25)
    expect(snare.flam).toBe(true)
    expect(snare.roll).toBe(4)
    expect(clip.swing).toBe(0.5)
    const sounded = soundingNotes(clip)
    expect(sounded.length).toBe(1 + 5)
    const snareHits = sounded.filter((item) => item.pitch === 38)
    expect(snareHits).toHaveLength(5)
    expect(Math.min(...snareHits.map((item) => item.startBeat))).toBeCloseTo(0.25 + swingShift(0.25, 0.5) - 0.05)
    expect(soundingNotes({ notes: [note({ id: 'k', pitch: 36, startBeat: 0, durationBeats: 0.2 })] })).toHaveLength(1)
    store.setDrumHit(track.id, clip.id, 36, 0, { on: false })
    expect(clip.notes.some((item) => item.pitch === 36)).toBe(false)
    expect(stepCount(4)).toBe(16)
    expect(stepCount(16)).toBe(64)
  })
})

describe('score', () => {
  it('spells key, time, rests, and ties from the project', () => {
    expect(keyFifths(0, 'ionian')).toBe(0)
    expect(keyFifths(7, 'ionian')).toBe(1)
    expect(keyFifths(5, 'ionian')).toBe(-1)
    expect(keyFifths(9, 'aeolian')).toBe(0)
    expect(keyFifths(2, 'aeolian')).toBe(-1)
    expect(staffPosition(64, 0, 'treble').position).toBe(0)
    expect(staffPosition(60, 0, 'treble').position).toBe(-2)
    expect(staffPosition(67, 0, 'treble').position).toBe(2)
    expect(staffPosition(66, keyFifths(7, 'ionian'), 'treble').accidental).toBeNull()
    expect(staffPosition(65, keyFifths(7, 'ionian'), 'treble').accidental).toBe(0)
    expect(spellPitch(61, -1).printed).toBe(-1)
    expect(midiAtPosition(0, 0, 'treble')).toBe(64)
    expect(midiAtPosition(0, 0, 'bass')).toBe(43)
    expect(chooseClef([{ pitch: 48 }, { pitch: 72 }])).toBe('grand')

    const time = { numerator: 4, denominator: 4 }
    const notes = [
      note({ id: 'e', pitch: 64, startBeat: 0, durationBeats: 1 }),
      note({ id: 'g', pitch: 67, startBeat: 1, durationBeats: 1 }),
      note({ id: 'long', pitch: 72, startBeat: 2, durationBeats: 4 }),
    ]
    const layout = layoutScore(notes, time, 7, 'ionian', 8, 0)
    expect(layout.fifths).toBe(1)
    expect(layout.time).toEqual(time)
    expect(layout.clef).toBe('treble')
    const e = layout.glyphs.find((glyph) => glyph.noteId === 'e')!
    const g = layout.glyphs.find((glyph) => glyph.noteId === 'g')!
    expect(e.position).toBe(0)
    expect(g.position).toBe(2)
    expect(g.accidental).toBeNull()
    const tied = layout.glyphs.filter((glyph) => glyph.noteId === 'long')
    expect(tied.length).toBeGreaterThan(1)
    expect(tied[0].tieEnd).toBe(true)
    expect(tied[1].tieStart).toBe(true)
    expect(layout.glyphs.some((glyph) => glyph.wholeRest)).toBe(false)
    const empty = layoutScore([], { numerator: 3, denominator: 4 }, 0, 'ionian', 3, 0)
    expect(empty.barBeats).toBe(3)
    expect(empty.glyphs.some((glyph) => glyph.wholeRest)).toBe(true)
    const svg = scoreSvg(layout)
    expect(svg).toContain('data-note="e"')
    expect(svg).toContain('>4<')
    expect(svg).toContain('data-pitch="64"')
    expect(svg.length).toBeLessThan(200_000)
  })

  it('writes score edits through the store and the journal', () => {
    const host = new ProjectStore(createEmptyProject(48000, 'Score'))
    const guest = new ProjectStore(structuredClone(host.project) as Project)
    const track = host.project.tracks.find((item) => item.type === 'midi')!
    host.addMidiClip(track.id, 0)
    const clipId = host.selectedMidiClipId!
    host.setMidiEditor({ mode: 'score', scoreDuration: 1 })
    host.putScoreNote(track.id, clipId, 0, 64)
    host.editScoreNote(track.id, clipId, host.selectedNoteId!, { pitch: 65 })
    const ops = host.sync.drain()
    expect(ops.some((op) => op.p === 'midiEditor' || op.p.includes('notes'))).toBe(true)
    guest.applyRemoteOps(ops)
    const remoteTrack = guest.project.tracks.find((item) => item.id === track.id)!
    expect(guest.project.midiEditor?.mode).toBe('score')
    expect(remoteTrack.midiClips[0].notes.map((item) => item.pitch)).toEqual([65])
    expect(remoteTrack.midiClips[0].notes[0].durationBeats).toBe(1)
    host.removeScoreNote(track.id, clipId, host.selectedNoteId!)
    expect(host.project.tracks.find((item) => item.id === track.id)!.midiClips[0].notes).toHaveLength(0)
  })
})

describe('recorded drum notes stay visible', () => {
  const kick = note({ id: 'kick', pitch: 36, startBeat: 0, durationBeats: 0.05 })
  const snare = note({ id: 'snare', pitch: 38, startBeat: 0.4636, durationBeats: 0.21 })

  it('keeps kick and snare inside the piano roll', () => {
    expect(ROLL_LOW).toBeLessThanOrEqual(24)
    expect(ROLL_HIGH).toBeGreaterThanOrEqual(84)
    expect(kick.pitch).toBeGreaterThanOrEqual(ROLL_LOW)
    expect(snare.pitch).toBeLessThanOrEqual(ROLL_HIGH)
    expect(48).toBeGreaterThan(kick.pitch)
  })

  it('shows an off-grid pad hit on the nearest sixteenth', () => {
    const notes = [kick, snare]
    expect(hitAt(notes, 36, 0)?.id).toBe('kick')
    expect(hitAt(notes, 38, 2)?.id).toBe('snare')
    expect(snare.startBeat).toBeCloseTo(0.4636)
    expect(hitAt(notes, 38, 1)).toBeUndefined()
    expect(hitAt(notes, 38, 0)).toBeUndefined()
  })

  it('gives an exact midpoint to the later sixteenth and does not move the note', () => {
    const mid = note({ id: 'mid', pitch: 36, startBeat: 0.125, durationBeats: 0.2 })
    const early = note({ id: 'early', pitch: 38, startBeat: 0.124, durationBeats: 0.2 })
    expect(stepIndexFor(0.125)).toBe(1)
    expect(stepIndexFor(0.124)).toBe(0)
    expect(stepIndexFor(0.375)).toBe(2)
    expect(hitAt([mid], 36, 1)?.id).toBe('mid')
    expect(hitAt([mid], 36, 0)).toBeUndefined()
    expect(hitAt([early], 38, 0)?.id).toBe('early')
    expect(hitAt([early], 38, 1)).toBeUndefined()
    const nearer = note({ id: 'grid', pitch: 36, startBeat: 0, durationBeats: 0.2 })
    const farther = note({ id: 'late', pitch: 36, startBeat: 0.1, durationBeats: 0.2 })
    expect(hitAt([farther, nearer], 36, 0)?.id).toBe('grid')
    expect(farther.startBeat).toBeCloseTo(0.1)
    expect(nearer.startBeat).toBeCloseTo(0)

    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    const clip = store.track(track.id)!.midiClips[0]
    clip.notes = [
      { ...farther },
      { ...nearer },
    ]
    store.selectNote(farther.id)
    store.setDrumHit(track.id, clip.id, 36, 0, { velocity: 0.4 })
    const edited = store.track(track.id)!.midiClips[0].notes
    expect(edited.find((item) => item.id === 'late')!.startBeat).toBeCloseTo(0.1)
    expect(edited.find((item) => item.id === 'late')!.velocity).toBeCloseTo(0.4)
    expect(edited.find((item) => item.id === 'grid')!.velocity).not.toBeCloseTo(0.4)
    store.setDrumHit(track.id, clip.id, 36, 0, { on: false })
    const left = store.track(track.id)!.midiClips[0].notes
    expect(left.map((item) => item.id)).toEqual(['grid'])
    expect(left[0].startBeat).toBeCloseTo(0)
  })
})
