import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { editShortcut, notePasteBeat, stepPasteIndex } from '../model/editClipboard'
import { PhoneDock } from '../ui/phoneDock'
import { projectBeatSample } from '../model/tempoMap'
import { createEmptyProject, type ClipStretch, type MidiNote } from '../model/types'
import { ProjectStore } from '../state/store'

function audioTrack(store: ProjectStore) {
  return store.project.tracks.find((track) => track.type === 'audio')!
}

function musicTrack(store: ProjectStore) {
  return store.project.tracks.filter((track) => track.type === 'audio')[1]
}

function midiTrack(store: ProjectStore) {
  return store.project.tracks.find((track) => track.type === 'midi')!
}

function stretch(): ClipStretch {
  return {
    sourceSamples: 48000,
    semitones: 1,
    cents: -4,
    mode: 'tape',
    followTempo: true,
    sourceBpm: 90,
    tempoMode: 'half',
    lockBpm: null,
    markers: [{ id: 'mark', source: 12, target: 0.5 }],
  }
}

describe('edit shortcuts', () => {
  it('maps Ctrl and Cmd to copy, cut, paste, and duplicate', () => {
    expect(editShortcut({ key: 'c', metaKey: true })).toBe('copy')
    expect(editShortcut({ key: 'X', ctrlKey: true })).toBe('cut')
    expect(editShortcut({ key: 'v', metaKey: true })).toBe('paste')
    expect(editShortcut({ key: 'd', ctrlKey: true })).toBe('duplicate')
    expect(editShortcut({ key: 'd', metaKey: true, shiftKey: true })).toBeNull()
    expect(editShortcut({ key: 'v', ctrlKey: true, repeat: true })).toBeNull()
    expect(editShortcut({ key: 'c' })).toBeNull()
  })
})

describe('arrange copy, cut, paste, and duplicate', () => {
  it('pastes a clip at the snapped playhead and keeps every clip setting', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = audioTrack(store)
    store.drawRegion(track.id, 0, 48000)
    const clip = track.clips[0]
    clip.gain = 0.42
    clip.fadeInSamples = 12
    clip.fadeOutSamples = 34
    clip.loop = true
    clip.durationBeats = 2
    clip.stretch = stretch()
    clip.hearing = {
      key: 'F# minor',
      root: 6,
      scale: 'aeolian',
      confidence: 0.81,
      alt: 'A major',
      altRoot: 9,
      altScale: 'ionian',
      altConfidence: 0.4,
      clearKey: true,
      bpm: 90,
      bpmConfidence: 0.7,
      cents: -4,
    }
    clip.wave = {
      origin: 0,
      head: 0,
      tailAt: 100,
      tail: 0,
      regions: [{ id: 'region', source: 0, length: 100, gain: 0.5 }],
      fadeIn: 8,
      fadeOut: 9,
      fadeInShape: 's',
      fadeOutShape: 'log',
      gainDb: -2,
      crossfade: 4,
    }
    expect(store.copyClips()).toBe(true)
    expect(store.canUndo).toBe(true)
    const undoBefore = store.canUndo
    store.copyClips()
    expect(store.canUndo).toBe(undoBefore)
    clip.stretch.markers[0].target = 3
    clip.gain = 0.1
    clip.hearing.key = 'C major'
    clip.hearing.confidence = 0.1
    const playhead = projectBeatSample(store.project, 1.3)
    expect(store.pasteClips(playhead)).toBe(true)
    const clips = audioTrack(store).clips
    expect(clips).toHaveLength(2)
    const pasted = clips[1]
    expect(pasted.id).not.toBe(clip.id)
    expect(pasted.bufferId).toBe(clip.bufferId)
    expect(pasted.startSample).toBe(projectBeatSample(store.project, 1))
    expect(pasted.gain).toBe(0.42)
    expect(pasted.fadeInSamples).toBe(12)
    expect(pasted.fadeOutSamples).toBe(34)
    expect(pasted.loop).toBe(true)
    expect(pasted.durationBeats).toBe(2)
    expect(pasted.hearing?.key).toBe('F# minor')
    expect(pasted.hearing?.confidence).toBe(0.81)
    expect(pasted.hearing?.bpm).toBe(90)
    expect(pasted.hearing).not.toBe(clip.hearing)
    expect(pasted.stretch?.tempoMode).toBe('half')
    expect(pasted.stretch?.markers[0].target).toBe(0.5)
    expect(pasted.stretch).not.toBe(clip.stretch)
    expect(pasted.stretch?.markers[0]).not.toBe(clip.stretch?.markers[0])
    expect(pasted.wave?.regions[0].gain).toBe(0.5)
    expect(pasted.wave).not.toBe(clip.wave)
    pasted.stretch!.markers[0].target = 9
    pasted.gain = 0.2
    pasted.hearing!.key = 'D major'
    pasted.hearing!.bpm = 140
    expect(clip.stretch?.markers[0].target).toBe(3)
    expect(clip.gain).toBe(0.1)
    expect(clip.hearing?.key).toBe('C major')
    expect(clip.hearing?.bpm).toBe(90)
    store.undo()
    expect(audioTrack(store).clips).toHaveLength(1)
    store.redo()
    expect(audioTrack(store).clips).toHaveLength(2)
    expect(audioTrack(store).clips[1].startSample).toBe(projectBeatSample(store.project, 1))
  })

  it('pastes on the playhead when snap is off, and on the selected track', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const vocal = audioTrack(store)
    const music = musicTrack(store)
    store.drawRegion(vocal.id, 0, 24000)
    store.copyClips()
    store.project.snap = false
    const playhead = projectBeatSample(store.project, 1.3)
    store.selectTrack(music.id)
    expect(store.pasteClips(playhead)).toBe(true)
    expect(music.clips).toHaveLength(1)
    expect(Math.abs(music.clips[0].startSample - playhead)).toBeLessThan(2)
    expect(vocal.clips).toHaveLength(1)
  })

  it('keeps multi-track selections on their own tracks, with the same gaps', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const vocal = audioTrack(store)
    const music = musicTrack(store)
    store.drawRegion(vocal.id, 0, 24000)
    store.drawRegion(music.id, 48000, 72000)
    store.selectRegion([vocal.clips[0].id, music.clips[0].id], [], vocal.id)
    store.copyClips()
    expect(store.pasteClips(projectBeatSample(store.project, 4))).toBe(true)
    expect(vocal.clips[0].startSample).toBe(0)
    expect(vocal.clips[1].startSample).toBe(projectBeatSample(store.project, 4))
    expect(music.clips[0].startSample).toBe(48000)
    expect(music.clips[1].startSample).toBeGreaterThan(vocal.clips[1].startSample)
    expect(new Set([...vocal.clips, ...music.clips].map((clip) => clip.id)).size).toBe(4)
  })

  it('refuses a paste onto the wrong kind of track and explains why', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const vocal = audioTrack(store)
    store.drawRegion(vocal.id, 0, 24000)
    store.copyClips()
    store.selectTrack(midiTrack(store).id)
    expect(store.clipPasteState()).toMatchObject({ visible: true, ready: false })
    const before = store.canUndo
    expect(store.pasteClips(0)).toBe(false)
    expect(store.toasts.at(-1)?.text).toBe('Select an audio track to paste this clip.')
    expect(vocal.clips).toHaveLength(1)
    expect(store.canUndo).toBe(before)
  })

  it('cuts and duplicates as one undo step, and the duplicate sits just after the selection', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = audioTrack(store)
    store.drawRegion(track.id, 0, 48000)
    const original = track.clips[0]
    store.duplicateArrangeClips()
    expect(track.clips).toHaveLength(2)
    expect(track.clips[1].startSample).toBe(original.startSample + original.durationSamples)
    expect(track.clips[1].name).toContain('copy')
    expect(track.clips[1].bufferId).toBe(original.bufferId)
    store.undo()
    expect(track.clips).toHaveLength(1)
    store.selectClip(track.id, track.clips[0].id, false, false)
    store.copyClips()
    store.cutClips()
    expect(track.clips).toHaveLength(0)
    store.undo()
    expect(track.clips).toHaveLength(1)
    store.redo()
    expect(track.clips).toHaveLength(0)
    store.pasteClips(projectBeatSample(store.project, 2))
    expect(track.clips).toHaveLength(1)
    expect(track.clips[0].startSample).toBe(projectBeatSample(store.project, 2))
  })

  it('pastes at the end of a long song, and a second paste may overlap without sharing settings', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = audioTrack(store)
    store.drawRegion(track.id, 0, 48000)
    const original = track.clips[0]
    original.gain = 0.7
    store.copyClips()
    const far = projectBeatSample(store.project, 64.2)
    expect(store.pasteClips(far)).toBe(true)
    expect(track.clips[1].startSample).toBe(projectBeatSample(store.project, 64))
    expect(store.pasteClips(far)).toBe(true)
    expect(track.clips).toHaveLength(3)
    expect(track.clips[2].startSample).toBe(track.clips[1].startSample)
    expect(track.clips[2].id).not.toBe(track.clips[1].id)
    track.clips[2].gain = 0.15
    expect(track.clips[1].gain).toBe(0.7)
    expect(original.gain).toBe(0.7)
    store.undo()
    expect(track.clips).toHaveLength(2)
  })

  it('keeps Paste on the phone row after Cut, and greys it on the wrong track', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = audioTrack(store)
    store.drawRegion(track.id, 0, 48000)
    store.cutClips()
    expect(track.clips).toHaveLength(0)
    expect(store.selectedClipId).toBeNull()
    const props = {
      store,
      place: 'arrange' as const,
      menuOpen: false,
      browseOpen: false,
      ideasOpen: false,
      onMenu() {},
      onBrowse() {},
      onIdeas() {},
      onMenuAction() {},
      onUndo() {},
      onRedo() {},
      canUndo: true,
      canRedo: false,
      playheadSample: () => 0,
    }
    const html = renderToStaticMarkup(createElement(PhoneDock, props))
    expect(html).toContain('data-phone-action="paste"')
    expect(html).toContain('data-phone-action="undo"')
    expect(html).not.toContain('phone-hit is-muted')
    store.selectTrack(midiTrack(store).id)
    const blocked = renderToStaticMarkup(createElement(PhoneDock, props))
    expect(blocked).toContain('phone-hit is-muted')
    expect(blocked).toContain('Select an audio track to paste this clip.')
  })

  it('duplicates a pattern clip just after itself', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    store.placePattern(4)
    store.placePatternClips([{ clipId: store.project.patternClips![0].id, startBeat: 8 }])
    store.resizePatternClip(store.project.patternClips![0].id, 'end', 14)
    store.resizePatternClip(store.project.patternClips![0].id, 'start', 9)
    store.duplicateSelection()
    expect(store.project.patternClips).toHaveLength(2)
    expect(store.project.patternClips![1].startBeat).toBe(14)
    expect(store.project.patternClips![1].id).not.toBe(store.project.patternClips![0].id)
  })
})

describe('note and step clipboard', () => {
  it('copies notes deeply, pastes on the snapped playhead, and undoes in one step', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = midiTrack(store)
    store.addMidiClip(track.id, 0)
    const clip = track.midiClips[0]
    const locks = { cutoff: 0.4 }
    store.addPerformedNotes(track.id, clip.id, [
      { pitch: 60, startBeat: 0.1, durationBeats: 1, velocity: 0.8, locks },
      { pitch: 64, startBeat: 1.1, durationBeats: 0.5, velocity: 0.6 },
    ])
    store.selectNotes(clip.notes.map((note) => note.id))
    expect(store.copyNotes()).toBe(true)
    locks.cutoff = 0.9
    const at = projectBeatSample(store.project, 4.2)
    expect(store.pasteNotes(at)).toBe(true)
    expect(clip.notes).toHaveLength(4)
    const pasted = clip.notes.slice(2)
    expect(pasted[0].startBeat).toBeCloseTo(4)
    expect(pasted[1].startBeat).toBeCloseTo(5)
    expect(pasted[0].locks?.cutoff).toBe(0.4)
    expect(pasted[0].locks).not.toBe(clip.notes[0].locks)
    expect(new Set(clip.notes.map((note) => note.id)).size).toBe(4)
    store.undo()
    expect(clip.notes).toHaveLength(2)
    store.selectNotes(clip.notes.map((note) => note.id))
    store.duplicateOpenNotes()
    expect(clip.notes.length).toBeGreaterThan(2)
    const copy = clip.notes.at(-1) as MidiNote
    expect(copy.id).not.toBe(clip.notes[0].id)
    expect(copy.startBeat).toBeGreaterThan(clip.notes[0].startBeat)
    store.cutNotes()
    store.undo()
    expect(clip.notes.length).toBeGreaterThan(2)
  })

  it('pastes at the start of the visible bar when the playhead is off screen', () => {
    const store = new ProjectStore(createEmptyProject())
    expect(notePasteBeat({ playheadLocal: 6.2, visibleStart: 0, visibleEnd: 4, barBeats: 4, grid: 1 })).toBe(0)
    expect(notePasteBeat({ playheadLocal: 1.3, visibleStart: 0, visibleEnd: 8, barBeats: 4, grid: 1 })).toBe(1)
    expect(notePasteBeat({ playheadLocal: null, visibleStart: 6, visibleEnd: 10, barBeats: 4, grid: 0.5 })).toBe(4)
    expect(stepPasteIndex(1.3, 16, store.project)).toBe(4)
    expect(stepPasteIndex(5.3, 16, store.project)).toBe(4)
    expect(stepPasteIndex(4, 16, store.project)).toBe(0)
    expect(stepPasteIndex(3.9, 16, store.project)).toBe(0)
    store.project.snap = false
    expect(stepPasteIndex(1.3, 16, store.project)).toBe(5)
    expect(stepPasteIndex(5.3, 16, store.project)).toBe(5)
  })

  it('copies steps without sharing cells, and duplicate lands just after the selection', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const pattern = store.activePattern()!
    const kick = pattern.channels[0]
    store.setStep(kick.id, 0, true)
    store.setStep(kick.id, 2, true)
    store.selectRackSteps([
      { channelId: kick.id, index: 0 },
      { channelId: kick.id, index: 2 },
    ])
    const velocity = kick.cells[0].velocity
    expect(store.copySteps()).toBe(true)
    kick.cells[0].velocity = 0.15
    expect(store.pasteSteps(projectBeatSample(store.project, 1))).toBe(true)
    expect(kick.cells[4].on).toBe(true)
    expect(kick.cells[6].on).toBe(true)
    expect(kick.cells[4].velocity).toBe(velocity)
    expect(kick.cells[4]).not.toBe(kick.cells[0])
    expect(kick.cells[0].velocity).toBe(0.15)
    store.undo()
    expect(store.pasteSteps(projectBeatSample(store.project, 5))).toBe(true)
    expect(kick.cells[4].on).toBe(true)
    expect(kick.cells[6].on).toBe(true)
    store.undo()
    store.selectRackSteps([
      { channelId: kick.id, index: 0 },
      { channelId: kick.id, index: 2 },
    ])
    expect(store.duplicateRackSteps()).toBe(true)
    expect(kick.cells[3].on).toBe(true)
    expect(kick.cells[5].on).toBe(true)
    expect(kick.cells[3]).not.toBe(kick.cells[0])
    store.undo()
    expect(kick.cells[3].on).toBe(false)
    store.selectRackSteps([{ channelId: kick.id, index: 0 }])
    store.cutSteps()
    expect(kick.cells[0].on).toBe(false)
    store.undo()
    expect(kick.cells[0].on).toBe(true)
  })
})
