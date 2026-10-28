import { describe, expect, it } from 'vitest'
import { clipLoopSamples, slotPhase, stopPlan } from '../model/sessionSlots'
import { collabBadgeOn, collabPanelVisible } from '../ui/collabTab'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { beatsToSamples } from '../model/time'

const sig = { numerator: 4, denominator: 4 }

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
