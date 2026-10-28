import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { createEmptyProject } from '../model/types'
import { normalizeBeats, renderPattern, starterPattern } from '../model/steps'
import { PATTERN_HOLD_MS, PATTERN_HOLD_SLOP, patternHoldOpensMenu } from '../ui/touchEdit'

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
})

describe('phone pattern menu', () => {
  it('opens after a still press and stays closed while the clip is dragged', () => {
    expect(patternHoldOpensMenu(true, PATTERN_HOLD_MS, 0)).toBe(true)
    expect(patternHoldOpensMenu(true, PATTERN_HOLD_MS, PATTERN_HOLD_SLOP)).toBe(true)
    expect(patternHoldOpensMenu(true, PATTERN_HOLD_MS - 1, 0)).toBe(false)
    expect(patternHoldOpensMenu(true, PATTERN_HOLD_MS + 200, PATTERN_HOLD_SLOP + 1)).toBe(false)
    expect(patternHoldOpensMenu(false, PATTERN_HOLD_MS + 200, 0)).toBe(false)
  })
})
