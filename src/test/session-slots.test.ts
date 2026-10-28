import { describe, expect, it } from 'vitest'
import { clipLoopSamples, clipLoops, handoffAfter, holdUntilGrid, sessionStartContext, slotDisplay, slotPhase, stopPlan } from '../model/sessionSlots'
import { collabBadgeOn, collabPanelVisible } from '../ui/collabTab'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { beatsToSamples } from '../model/time'

const sig = { numerator: 4, denominator: 4 }

describe('new sessions', () => {
  it('starts every track unarmed, including Vocal', () => {
    const project = createEmptyProject()
    expect(project.tracks.map((track) => track.name)).toEqual(['Vocal', 'Music', 'Keys'])
    expect(project.tracks.every((track) => track.armed === false)).toBe(true)
    expect(project.launchQuant).toBe('1bar')
  })
})

describe('session playback waits for the quantize line', () => {
  it('does not start a clip until the look-ahead reaches the bar', () => {
    const rate = 48000
    const bar = 96000
    const origin = 10
    const early = sessionStartContext({
      targetSample: bar,
      playOriginSample: 1000,
      playOriginCtx: origin,
      sampleRate: rate,
      nowCtx: origin,
      horizonSec: 0.35,
    })
    expect(early).toBeNull()
    const near = sessionStartContext({
      targetSample: bar,
      playOriginSample: 1000,
      playOriginCtx: origin,
      sampleRate: rate,
      nowCtx: origin + (bar - 1000) / rate - 0.1,
      horizonSec: 0.35,
    })
    expect(near).toBeCloseTo(origin + (bar - 1000) / rate, 5)
    const late = sessionStartContext({
      targetSample: 1000,
      playOriginSample: 4000,
      playOriginCtx: origin,
      sampleRate: rate,
      nowCtx: origin + 1,
      horizonSec: 0.35,
    })
    expect(late).toBeCloseTo(origin + 1.01, 5)
  })
})

describe('slot launch and stop quantization', () => {
  it('quantizes a launch to the next bar and cancels a clip that has not started', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    keys.midiClips = [
      { id: 'a', name: 'A', startBeat: 0, durationBeats: 4, notes: [], loop: true },
      { id: 'b', name: 'B', startBeat: 0, durationBeats: 4, notes: [], loop: true },
    ]
    store.launch(keys.id, 'a', 1000)
    expect(store.launchAt[keys.id]).toBe(96000)
    expect(store.launched[keys.id]).toBe('a')
    expect(slotPhase({
      hasClip: true,
      launched: true,
      now: 1000,
      launchAt: store.launchAt[keys.id],
      lengthSamples: 96000,
    }).phase).toBe('queued')

    store.launch(keys.id, 'a', 2000)
    expect(store.launched[keys.id]).toBeFalsy()
    expect(store.stopAt[keys.id]).toBeUndefined()
  })

  it('holds a playing clip until the quantized stop, then stops it', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    keys.midiClips = [{ id: 'a', name: 'A', startBeat: 0, durationBeats: 4, notes: [], loop: true }]
    store.launch(keys.id, 'a', 0)
    expect(store.launchAt[keys.id]).toBe(0)
    store.launch(keys.id, 'a', 1000)
    expect(store.launched[keys.id]).toBe('a')
    expect(store.stopAt[keys.id]).toBe(96000)
    expect(stopPlan({
      now: 1000,
      launchAt: 0,
      hasClip: true,
      quant: '1bar',
      sampleRate: 48000,
      tempo: 120,
      sig,
    })).toEqual({ when: 96000, immediate: false })
    const stopping = slotPhase({
      hasClip: true,
      launched: true,
      now: 1000,
      launchAt: 0,
      stopAt: 96000,
      lengthSamples: clipLoopSamples(keys.midiClips[0], 48000, 120),
    })
    expect(stopping.phase).toBe('stopping')
    expect(stopping.progress).toBeGreaterThan(0)
    expect(stopping.progress).toBeLessThan(1)
    store.tickSession(95999, true)
    expect(store.launched[keys.id]).toBe('a')
    store.tickSession(96000, true)
    expect(store.launched[keys.id]).toBeFalsy()
    expect(store.stopAt[keys.id]).toBeUndefined()
  })

  it('launches a whole scene on the next bar', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    const drums = store.project.tracks.find((track) => track.type === 'midi' && track.id !== keys.id) ?? keys
    keys.midiClips = [{ id: 'a', name: 'A', startBeat: 0, durationBeats: 4, notes: [], loop: true }]
    if (drums !== keys) drums.midiClips = [{ id: 'd', name: 'D', startBeat: 0, durationBeats: 4, notes: [], loop: true }]
    store.launchScene(0, 1000)
    expect(store.launchAt[keys.id]).toBe(96000)
    expect(store.launched[keys.id]).toBe('a')
    expect(store.pendingTransport?.action).toBe('scene')
    const slots = store.pendingTransport?.slots as { trackId: string; clipId: string | null; timelineSample?: number }[]
    expect(slots.find((slot) => slot.trackId === keys.id)?.timelineSample).toBe(96000)
    if (drums !== keys) expect(store.launched[drums.id]).toBe('d')
    store.launch(keys.id, 'a', beatsToSamples(4, 48000, 120) + 1000)
    store.tickSession(96000, true)
    expect(store.launched[keys.id]).toBe('a')
  })

  it('stop-all waits for the bar while the transport is rolling', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    keys.midiClips = [{ id: 'a', name: 'A', startBeat: 0, durationBeats: 4, notes: [], loop: true }]
    store.launch(keys.id, 'a', 0)
    store.stopSession(1000, true)
    expect(store.launched[keys.id]).toBe('a')
    expect(store.stopAt[keys.id]).toBe(96000)
    store.tickSession(96000, true)
    expect(store.launched[keys.id]).toBeFalsy()
  })
})

describe('one clip per track waits on the grid', () => {
  it('keeps the sounding clip until the next one starts', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    keys.midiClips = [
      { id: 'a', name: 'A', startBeat: 0, durationBeats: 4, notes: [], loop: true },
      { id: 'b', name: 'B', startBeat: 0, durationBeats: 4, notes: [], loop: true },
    ]
    keys.midiSlots = ['a', 'b']
    store.launch(keys.id, 'a', 0)
    store.launch(keys.id, 'b', 1000)
    expect(store.launched[keys.id]).toBe('b')
    expect(Object.values(store.launched).filter(Boolean)).toEqual(['b'])
    expect(store.handoff[keys.id]).toEqual({ clipId: 'a', at: 0 })
    expect(slotDisplay({
      clipId: 'a',
      launchedId: 'b',
      handoffId: 'a',
      handoffAt: 0,
      now: 1000,
      launchAt: 96000,
      lengthSamples: 96000,
    }).phase).toBe('playing')
    expect(slotDisplay({
      clipId: 'b',
      launchedId: 'b',
      handoffId: 'a',
      now: 1000,
      launchAt: 96000,
      lengthSamples: 96000,
    }).phase).toBe('queued')
    expect(holdUntilGrid({
      sounding: true,
      sameGeneration: false,
      nowCtx: 10,
      targetSample: 96000,
      playOriginSample: 0,
      playOriginCtx: 10,
      sampleRate: 48000,
    })).toBe(true)
    expect(holdUntilGrid({
      sounding: true,
      sameGeneration: true,
      nowCtx: 10,
      targetSample: 96000,
      playOriginSample: 0,
      playOriginCtx: 10,
      sampleRate: 48000,
    })).toBe(false)
    expect(clipLoops({})).toBe(true)
    expect(clipLoops({ loop: false })).toBe(false)
    expect(clipLoops({ loop: false, mode: 'repeat' })).toBe(true)
  })

  it('stops an empty scene slot on the bar instead of dropping the clip now', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    keys.midiClips = [{ id: 'a', name: 'A', startBeat: 0, durationBeats: 4, notes: [], loop: true }]
    keys.midiSlots = ['a', null]
    store.launch(keys.id, 'a', 0)
    store.launchScene(1, 1000)
    expect(store.launched[keys.id]).toBe('a')
    expect(store.stopAt[keys.id]).toBe(96000)
    store.tickSession(96000, true)
    expect(store.launched[keys.id]).toBeFalsy()
  })

  it('records notes into the armed slot instead of a new arrangement clip', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    store.prepareMidiSlot(keys.id, 2)
    store.armSlot(keys.id, 2)
    store.sessionRecordBeat = 8
    store.overdubSlot(keys.id, 2, [{ pitch: 67, startBeat: 8.5, durationBeats: 1, velocity: 0.8 }])
    const clip = keys.midiClips.find((item) => item.id === keys.midiSlots?.[2])
    expect(clip?.slotOnly).toBe(true)
    expect(clip?.notes.map((note) => note.pitch)).toEqual([67])
    expect(clip?.notes[0].startBeat).toBeCloseTo(0.5)
    expect(keys.midiClips.filter((item) => !item.slotOnly)).toHaveLength(0)
    const switched = handoffAfter(
      { launched: { keys: 'a' }, at: { keys: 0 } },
      { launched: { keys: 'b' }, at: { keys: 96000 } },
      1000,
    )
    expect(switched.keys).toEqual({ clipId: 'a', at: 0 })
  })
})

describe('collab tab visibility', () => {
  it('shows the collab panel only while that tab is active', () => {
    for (const tab of ['arrange', 'mix', 'beats', 'session'] as const) {
      expect(collabPanelVisible(tab)).toBe(false)
    }
    expect(collabPanelVisible('collab')).toBe(true)
    expect(collabBadgeOn({ tab: 'arrange', status: 'live', pendingInvite: false, waiting: 0 })).toBe(true)
    expect(collabBadgeOn({ tab: 'collab', status: 'live', pendingInvite: true, waiting: 2 })).toBe(false)
    expect(collabBadgeOn({ tab: 'session', status: 'idle', pendingInvite: true, waiting: 0 })).toBe(true)
    expect(collabBadgeOn({ tab: 'mix', status: 'idle', pendingInvite: false, waiting: 0 })).toBe(false)
  })
})
