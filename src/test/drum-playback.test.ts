import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import {
  emptyPatternLoopSamples,
  patternHitTrack,
  rackPlayMode,
  scheduledPatternNotes,
  transportPatternClips,
} from '../model/channelRack'
import { clonePattern, isolatedCells, normalizeBeats, renderPattern, starterPattern } from '../model/steps'
import { ProjectStore } from '../state/store'
import { BeatView } from '../ui/BeatView'

describe('drum playback from the channel rack', () => {
  it('schedules the open pattern when Play is pressed from the drums view in an empty project', () => {
    const store = new ProjectStore()
    store.setView('beats')
    const pattern = store.activePattern()!
    const kick = pattern.channels[0]
    expect(pattern.channels.some((channel) => channel.cells.some((cell) => cell.on))).toBe(true)
    expect(kick.cells[1].on).toBe(false)
    store.setStep(kick.id, 1, true)

    expect(rackPlayMode(store.project)).toBe('pattern')
    expect(emptyPatternLoopSamples(store.project)).toBeGreaterThan(48000)
    const notes = scheduledPatternNotes(store.project)
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.some((note) => note.channelId === kick.id && Math.abs(note.startBeat - 0.25) < 1e-6)).toBe(true)
    expect(transportPatternClips(store.project, true).map((clip) => clip.patternId)).toEqual([pattern.id])

    store.project.loopEnabled = true
    store.project.loopStartSample = store.project.sampleRate * 20
    store.project.loopEndSample = store.project.sampleRate * 28
    expect(rackPlayMode(store.project)).toBe('pattern')
    expect(scheduledPatternNotes(store.project).some((note) => note.channelId === kick.id)).toBe(true)

    const html = renderToStaticMarkup(createElement(BeatView, { store, engine: { positionSamples: 0 } as AudioEngine }))
    expect(html).toContain('data-play-mode="pattern"')
    expect(html).toContain('>Pattern<')
    expect(html).toContain('>Song<')
  })

  it('plays the pattern on screen, not a different one, and stays quiet in song mode until a clip is placed', () => {
    const store = new ProjectStore()
    store.setView('beats')
    const original = store.activePattern()!
    store.cloneActivePattern()
    const active = store.activePattern()!
    expect(active.id).not.toBe(original.id)
    for (const channel of active.channels) channel.cells = channel.cells.map((cell) => ({ ...cell, on: false }))
    store.setStep(active.channels[0].id, 0, true)
    const notes = scheduledPatternNotes(store.project)
    expect(notes.map((note) => note.channelId)).toEqual([active.channels[0].id])

    store.setRackMode('song')
    expect(transportPatternClips(store.project, true)).toEqual([])
    expect(scheduledPatternNotes(store.project)).toEqual([])
    store.placePattern(0)
    expect(scheduledPatternNotes(store.project).length).toBeGreaterThan(0)
  })

  it('keeps a muted default instrument from silencing an unrouted drum hit', () => {
    const store = new ProjectStore()
    const pattern = store.activePattern()!
    const kick = pattern.channels[0]
    for (const track of store.project.tracks) {
      if (track.type === 'midi') track.mute = true
    }
    const hit = renderPattern(pattern, 0, 1).find((item) => item.channelId === kick.id)!
    expect(patternHitTrack(store.project, hit, {})).toBeNull()
    for (const track of store.project.tracks) track.mute = false
    store.project.tracks.find((track) => track.type === 'audio')!.solo = true
    expect(patternHitTrack(store.project, hit, {})).toBeNull()
    expect(hit.volume).toBeGreaterThan(0)
  })
})

describe('drum and clip selection', () => {
  it('selects one step, row, or clip until shift adds another', () => {
    const store = new ProjectStore()
    const [kick, snare] = store.activePattern()!.channels
    store.selectRackStep(kick.id, 0)
    store.selectRackStep(snare.id, 4)
    expect(store.selectedRackSteps).toEqual([{ channelId: snare.id, index: 4 }])
    expect(store.selectedRackChannels).toEqual([snare.id])
    store.selectRackStep(kick.id, 0, true)
    expect(store.selectedRackSteps).toEqual([
      { channelId: snare.id, index: 4 },
      { channelId: kick.id, index: 0 },
    ])
    store.selectRackChannel(kick.id)
    expect(store.selectedRackChannels).toEqual([kick.id])
    store.clearRackSelection()
    expect(store.selectedRackSteps).toEqual([])
    expect(store.selectedRackChannels).toEqual([])

    const trackId = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.placePattern(0)
    store.placePattern(8)
    const [first, second] = store.project.patternClips!
    store.selectClip(trackId, first.id, false, false)
    expect(store.selectedPatternClipIds).toEqual([first.id])
    store.selectClip(trackId, second.id, false, false, true)
    expect(store.selectedPatternClipIds).toEqual([first.id, second.id])

    store.armSlot(trackId, 0)
    store.armSlot(trackId, 1)
    expect(store.selectedSessionSlots).toEqual([{ trackId, scene: 1 }])
    store.armSlot(trackId, 0, true)
    expect(store.selectedSessionSlots).toEqual([
      { trackId, scene: 1 },
      { trackId, scene: 0 },
    ])
  })

  it('gives duplicated clips and patterns their own ids, and a shared step object does not edit the row', () => {
    const store = new ProjectStore()
    const original = store.activePattern()!
    store.cloneActivePattern()
    const copy = store.activePattern()!
    expect(copy.id).not.toBe(original.id)
    expect(new Set(store.project.beats!.patterns.map((pattern) => pattern.id)).size).toBe(2)
    expect(copy.channels[0].id).not.toBe(original.channels[0].id)
    const before = original.channels[0].cells[0].on
    store.setStep(copy.channels[0].id, 0, !before)
    expect(original.channels[0].cells[0].on).toBe(before)
    expect(copy.channels[0].cells[0]).not.toBe(original.channels[0].cells[0])

    store.placePattern(0)
    store.placePattern(4)
    const placed = store.project.patternClips!
    expect(new Set(placed.map((clip) => clip.id)).size).toBe(placed.length)
    store.selectClip(store.project.tracks.find((track) => track.type === 'midi')!.id, placed[0].id, false, false)
    store.duplicateSelection()
    const ids = store.project.patternClips!.map((clip) => clip.id)
    expect(new Set(ids).size).toBe(ids.length)

    const shared = { on: true, velocity: 0.8, pan: 0, pitch: 0, fine: 0, gate: 0.8 }
    const kick = store.activePattern()!.channels[0]
    kick.cells = Array.from({ length: 64 }, () => shared)
    store.setStep(kick.id, 3, false)
    expect(kick.cells[3].on).toBe(false)
    expect(kick.cells[0].on).toBe(true)
    expect(kick.cells[3]).not.toBe(kick.cells[0])

    const glued = starterPattern()
    glued.channels[0].cells = Array.from({ length: 64 }, () => shared)
    const normalized = normalizeBeats({ activeId: glued.id, patterns: [glued] }, [
      { id: 'same', patternId: glued.id, startBeat: 0, lengthBeats: 4, scene: null },
      { id: 'same', patternId: glued.id, startBeat: 4, lengthBeats: 4, scene: null },
    ])
    const cells = normalized.beats.patterns[0].channels[0].cells
    cells[0].on = false
    expect(cells[1].on).toBe(true)
    expect(new Set(normalized.patternClips.map((clip) => clip.id)).size).toBe(2)
    expect(isolatedCells([shared, shared])[0]).not.toBe(isolatedCells([shared, shared])[1])
  })

  it('makes one linked pattern clip unique without editing the others', () => {
    const store = new ProjectStore()
    store.placePattern(0)
    store.placePattern(8)
    const [first, second] = store.project.patternClips!
    expect(first.patternId).toBe(second.patternId)
    const originalId = first.patternId
    store.makePatternClipUnique(second.id)
    const clips = store.project.patternClips!
    expect(clips.find((clip) => clip.id === first.id)!.patternId).toBe(originalId)
    expect(clips.find((clip) => clip.id === second.id)!.patternId).not.toBe(originalId)
    const copy = store.activePattern()!
    const original = store.project.beats!.patterns.find((pattern) => pattern.id === originalId)!
    const on = original.channels[0].cells[0].on
    store.setStep(copy.channels[0].id, 0, !on)
    expect(original.channels[0].cells[0].on).toBe(on)
    expect(clonePattern(original, 'again').id).not.toBe(original.id)
  })

  it('changes one drum row level without grouping the others', () => {
    const store = new ProjectStore()
    const [kick, snare] = store.activePattern()!.channels
    const snareVolume = snare.volume
    store.setChannel(kick.id, { volume: 0.2, mute: true })
    const next = store.activePattern()!.channels
    expect(next[0].volume).toBeCloseTo(0.2)
    expect(next[0].mute).toBe(true)
    expect(next[1].volume).toBeCloseTo(snareVolume)
    expect(next[1].mute).toBe(false)
    expect(next[1].id).not.toBe(next[0].id)
  })
})
