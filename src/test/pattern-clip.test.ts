import { describe, expect, it } from 'vitest'
import { deletesSelection } from '../ui/clipKeys'
import { ProjectStore } from '../state/store'
import { createEmptyProject } from '../model/types'
import { normalizeBeats, renderPattern, starterPattern } from '../model/steps'
import { PATTERN_HOLD_MS, PATTERN_HOLD_SLOP, patternHoldOpensMenu, patternMenuPoint } from '../ui/touchEdit'

describe('new arrangement', () => {
  it('starts empty and still keeps the default pattern in the rack', () => {
    const fresh = normalizeBeats(undefined, undefined)
    expect(fresh.patternClips).toEqual([])
    expect(fresh.beats.patterns.map((pattern) => pattern.name)).toEqual(['Pattern 1'])

    const store = new ProjectStore(createEmptyProject(48000))
    expect(store.project.patternClips).toEqual([])
    expect(store.activePattern()?.name).toBe('Pattern 1')
    expect(store.activePattern()?.channels.map((channel) => channel.name)).toEqual(['Kick', 'Snare', 'Clap', 'Hat', 'Perc'])
    for (const track of store.project.tracks) {
      expect(track.clips).toEqual([])
      expect(track.midiClips).toEqual([])
    }
  })
})

describe('saved automatic clip', () => {
  it('drops the undeletable factory clip and keeps a pattern the user changed', () => {
    const pattern = starterPattern()
    const rack = { activeId: pattern.id, patterns: [pattern] }
    const seeded = normalizeBeats(rack, [{ id: 'ghost', patternId: pattern.id, startBeat: 0, lengthBeats: 4, scene: null }])
    expect(seeded.patternClips).toEqual([])
    expect(seeded.beats.patterns[0].id).toBe(pattern.id)

    const edited = starterPattern()
    edited.channels[0].cells[1].on = true
    const kept = normalizeBeats(
      { activeId: edited.id, patterns: [edited] },
      [{ id: 'kept', patternId: edited.id, startBeat: 0, lengthBeats: 4, scene: null }],
    )
    expect(kept.patternClips.map((clip) => clip.id)).toEqual(['kept'])
    expect(kept.patternClips[0].placed).toBe(true)

    const store = new ProjectStore(createEmptyProject(48000))
    store.project.beats = { activeId: edited.id, patterns: [edited] }
    store.project.patternClips = [{ id: 'kept', patternId: edited.id, startBeat: 0, lengthBeats: 4, scene: null, placed: true }]
    const trackId = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.selectClip(trackId, 'kept', false, false)
    store.deleteSelectedClip()
    expect(store.project.patternClips).toEqual([])
    store.undo()
    expect(store.project.patternClips?.map((clip) => clip.id)).toEqual(['kept'])
  })

  it('keeps a clip the user edited, moved, trimmed, or placed, and drops only one untouched seed', () => {
    const seed = (id: string, patternId: string, startBeat = 0) => ({ id, patternId, startBeat, lengthBeats: 4, scene: null })
    const quiet = starterPattern()
    quiet.channels[0].cells[0].velocity = 0.2
    const velocity = normalizeBeats({ activeId: quiet.id, patterns: [quiet] }, [seed('vel', quiet.id)])
    expect(velocity.patternClips.map((clip) => clip.id)).toEqual(['vel'])

    const louder = starterPattern()
    louder.channels[3].volume = 0.4
    const level = normalizeBeats({ activeId: louder.id, patterns: [louder] }, [seed('level', louder.id)])
    expect(level.patternClips.map((clip) => clip.id)).toEqual(['level'])

    const sampled = starterPattern()
    sampled.channels[0].sampleId = 'kick'
    const sample = normalizeBeats({ activeId: sampled.id, patterns: [sampled] }, [seed('sample', sampled.id)])
    expect(sample.patternClips.map((clip) => clip.id)).toEqual(['sample'])

    const pattern = starterPattern()
    const rack = { activeId: pattern.id, patterns: [pattern] }
    const moved = normalizeBeats(rack, [seed('ghost', pattern.id), seed('mine', pattern.id, 8)])
    expect(moved.patternClips.map((clip) => clip.id)).toEqual(['mine'])
    expect(moved.patternClips[0].placed).toBe(true)

    const trimmed = normalizeBeats(rack, [{ ...seed('trim', pattern.id), offsetBeats: 1 }])
    expect(trimmed.patternClips.map((clip) => clip.id)).toEqual(['trim'])

    const slot = normalizeBeats(rack, [{ ...seed('slot', pattern.id), scene: 0 }])
    expect(slot.patternClips.map((clip) => clip.id)).toEqual(['slot'])

    const flagged = normalizeBeats(rack, [{ ...seed('user', pattern.id), placed: true }])
    expect(flagged.patternClips.map((clip) => clip.id)).toEqual(['user'])

    const stacked = normalizeBeats(rack, [seed('a', pattern.id), seed('b', pattern.id)])
    expect(stacked.patternClips.map((clip) => clip.id)).toEqual(['a', 'b'])
    expect(stacked.patternClips.every((clip) => clip.placed)).toBe(true)
  })

  it('keeps a clip the user placed, including one at the start, across reload', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    store.placePattern(0)
    store.placePattern(8)
    const saved = JSON.parse(JSON.stringify(store.project))
    const opened = new ProjectStore(saved)
    expect(opened.project.patternClips?.map((clip) => clip.startBeat)).toEqual([0, 8])
    expect(opened.activePattern()?.name).toBe('Pattern 1')
  })
})

describe('pattern clip edits', () => {
  it('selects, moves, trims, duplicates, and deletes, and each step undoes', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    store.placePattern(4)
    const id = store.project.patternClips![0].id
    expect(store.selectedPatternClipId).toBe(id)
    expect(store.project.patternClips![0].placed).toBe(true)

    store.placePatternClips([{ clipId: id, startBeat: 8.2 }])
    expect(store.project.patternClips![0].startBeat).toBe(8)
    store.resizePatternClip(id, 'end', 14)
    expect(store.project.patternClips![0].lengthBeats).toBe(6)
    store.resizePatternClip(id, 'start', 9)
    const clip = store.project.patternClips![0]
    expect(clip.startBeat).toBe(9)
    expect(clip.lengthBeats).toBe(5)
    expect(clip.offsetBeats).toBe(1)
    const kicks = renderPattern(store.activePattern()!, clip.offsetBeats!, clip.offsetBeats! + clip.lengthBeats).filter((hit) => hit.kind === 'kick')
    expect(kicks.map((hit) => clip.startBeat + hit.startBeat - clip.offsetBeats!)).toEqual([9, 10, 11, 12, 13])

    store.duplicateSelection()
    expect(store.project.patternClips).toHaveLength(2)
    expect(store.project.patternClips![1].startBeat).toBe(14)
    expect(store.project.patternClips![1].offsetBeats).toBe(1)
    store.deleteSelectedClip()
    expect(store.project.patternClips).toHaveLength(1)
    store.undo()
    expect(store.project.patternClips).toHaveLength(2)
    store.undo()
    expect(store.project.patternClips).toHaveLength(1)
    store.undo()
    expect(store.project.patternClips![0].startBeat).toBe(8)
    expect(store.project.patternClips![0].offsetBeats || 0).toBe(0)
  })

  it('deletes from the eraser, the Delete key, and a box selection', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const trackId = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.placePattern(4)
    const id = store.project.patternClips![0].id

    store.selectClip(trackId, id, false, false)
    store.deleteSelectedClip()
    expect(store.project.patternClips).toEqual([])
    store.undo()

    store.selectRegion([id], [], trackId)
    expect(store.selectedClipIds).toEqual([])
    expect(store.selectedPatternClipIds).toEqual([id])
    store.deleteSelectedClip()
    expect(store.project.patternClips).toEqual([])
    store.undo()
    expect(store.project.patternClips).toHaveLength(1)
  })

  it('deletes a pattern clip and a midi clip together, and undo restores both', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.placePattern(4)
    const patternId = store.project.patternClips![0].id
    store.addMidiClip(track.id, 2)
    const midiId = track.midiClips[0].id
    store.selectRegion([patternId], [midiId], track.id)
    store.deleteSelectedClip()
    expect(store.project.patternClips).toEqual([])
    expect(track.midiClips).toEqual([])
    store.undo()
    const restored = store.project.tracks.find((item) => item.id === track.id)!
    expect(store.project.patternClips?.map((clip) => clip.id)).toEqual([patternId])
    expect(restored.midiClips.map((clip) => clip.id)).toEqual([midiId])
  })
})

describe('timeline delete key', () => {
  const timeline = { tagName: 'DIV', isContentEditable: false }
  const field = { tagName: 'INPUT', isContentEditable: false }

  it('removes a selected pattern, audio, or MIDI clip, and leaves text fields alone', () => {
    expect(deletesSelection('Delete', timeline)).toBe(true)
    expect(deletesSelection('Backspace', timeline)).toBe(true)
    expect(deletesSelection('Delete', null)).toBe(true)
    expect(deletesSelection('Delete', field)).toBe(false)
    expect(deletesSelection('Backspace', { tagName: 'TEXTAREA', isContentEditable: false })).toBe(false)
    expect(deletesSelection('Backspace', { tagName: 'SELECT', isContentEditable: false })).toBe(false)
    expect(deletesSelection('Backspace', { tagName: 'DIV', isContentEditable: true })).toBe(false)
    expect(deletesSelection('Enter', timeline)).toBe(false)

    const store = new ProjectStore(createEmptyProject(48000))
    const audioId = store.project.tracks.find((track) => track.type === 'audio')!.id
    const midi = store.project.tracks.find((track) => track.type === 'midi')!
    const press = (key: string, target: { tagName: string; isContentEditable: boolean }) => {
      if (deletesSelection(key, target)) store.deleteSelectedClip()
    }

    store.placePattern(0)
    press('Delete', timeline)
    expect(store.project.patternClips).toEqual([])

    store.drawRegion(audioId, 0, 48000)
    press('Backspace', timeline)
    expect(store.project.tracks.find((track) => track.id === audioId)!.clips).toEqual([])

    store.addMidiClip(midi.id, 0)
    press('Delete', timeline)
    expect(store.project.tracks.find((track) => track.id === midi.id)!.midiClips).toEqual([])

    store.placePattern(4)
    press('Delete', field)
    press('Backspace', field)
    expect(store.project.patternClips).toHaveLength(1)
    press('Delete', timeline)
    expect(store.project.patternClips).toEqual([])
  })
})

describe('phone pattern menu', () => {
  it('opens after a still press and stays closed while the clip is dragged', () => {
    expect(patternHoldOpensMenu(true, PATTERN_HOLD_MS, 0)).toBe(true)
    expect(patternHoldOpensMenu(true, PATTERN_HOLD_MS, PATTERN_HOLD_SLOP)).toBe(true)
    expect(patternHoldOpensMenu(true, PATTERN_HOLD_MS - 1, 0)).toBe(false)
    expect(patternHoldOpensMenu(true, PATTERN_HOLD_MS + 200, PATTERN_HOLD_SLOP + 1)).toBe(false)
    expect(patternHoldOpensMenu(false, PATTERN_HOLD_MS + 200, 0)).toBe(false)
  })

  it('places the menu above the finger and inside the screen', () => {
    expect(patternMenuPoint(100, 400, 168, 56, 390, 800)).toEqual({ x: 100, y: 332 })
    expect(patternMenuPoint(300, 40, 168, 56, 390, 800)).toEqual({ x: 214, y: 52 })
    expect(patternMenuPoint(380, 780, 168, 56, 390, 844)).toEqual({ x: 214, y: 712 })
  })
})
