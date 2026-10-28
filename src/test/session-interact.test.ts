import { describe, expect, it } from 'vitest'
import { sceneClip } from '../model/launch'
import {
  createsEmptyMidiClip,
  parseSessionDrag,
  planSessionDrop,
  shouldCountIn,
  slotGesture,
  slotLabels,
  targetFromAttrs,
} from '../model/sessionInteract'
import { createEmptyProject, type AudioClip } from '../model/types'
import { ProjectStore } from '../state/store'

function audio(id: string, name: string): AudioClip {
  return {
    id,
    name,
    bufferId: 'b',
    startSample: 0,
    offsetSamples: 0,
    durationSamples: 1000,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'import',
    slotOnly: true,
    loop: true,
  }
}

describe('session gestures', () => {
  it('selects the clip body, launches from the triangle, and stops from the square', () => {
    expect(slotGesture('body', 1)).toBe('select')
    expect(slotGesture('body', 2)).toBe('edit')
    expect(slotGesture('launch', 1)).toBe('launch')
    expect(slotGesture('launch', 2)).toBe('launch')
    expect(slotGesture('stop', 1)).toBe('stop')
    expect(slotGesture('stop', 2)).toBe('stop')
  })

  it('creates a midi clip only when an empty midi slot is double-clicked', () => {
    expect(createsEmptyMidiClip('midi', 'edit', false)).toBe(true)
    expect(createsEmptyMidiClip('midi', 'select', false)).toBe(false)
    expect(createsEmptyMidiClip('midi', 'edit', true)).toBe(false)
    expect(createsEmptyMidiClip('audio', 'edit', false)).toBe(false)
  })

  it('counts in for recording and transport play, not for a clip launch', () => {
    expect(shouldCountIn({ enabled: true, stopped: true, intent: 'record' })).toBe(true)
    expect(shouldCountIn({ enabled: true, stopped: true, intent: 'play' })).toBe(true)
    expect(shouldCountIn({ enabled: true, stopped: true, intent: 'session-launch' })).toBe(false)
    expect(shouldCountIn({ enabled: true, stopped: false, intent: 'record' })).toBe(false)
    expect(shouldCountIn({ enabled: false, stopped: true, intent: 'record' })).toBe(false)
  })
})

describe('session drops', () => {
  it('parses sounds, instruments, and clips', () => {
    expect(parseSessionDrag('cueharbor-sound:bongo')).toEqual({ kind: 'sound', id: 'bongo' })
    expect(parseSessionDrag('cueharbor-device:instrument:synth')).toEqual({ kind: 'device', device: 'instrument', id: 'synth' })
    expect(parseSessionDrag('cueharbor-device:audio:tune')).toEqual({ kind: 'device', device: 'audio', id: 'tune' })
    expect(parseSessionDrag('cueharbor-clip:vocal:clip1')).toEqual({ kind: 'clip', trackId: 'vocal', clipId: 'clip1' })
    expect(parseSessionDrag('hello')).toBeNull()
  })

  it('places a sound in the slot under the pointer and loads an instrument on the header', () => {
    const slot = targetFromAttrs({ slotTrack: 'vocal', slotScene: '0', trackType: 'audio' })
    expect(slot).toEqual({ kind: 'slot', trackId: 'vocal', scene: 0, trackType: 'audio' })
    expect(planSessionDrop({ kind: 'sound', id: 'bongo' }, slot!)).toEqual({
      action: 'place-sound',
      trackId: 'vocal',
      scene: 0,
      id: 'bongo',
    })
    const second = targetFromAttrs({ slotTrack: 'vocal', slotScene: '1', trackType: 'audio' })
    const placed = planSessionDrop({ kind: 'sound', id: 'bongo' }, second!)
    expect(placed).toMatchObject({ action: 'place-sound', scene: 1 })
    expect(planSessionDrop({ kind: 'sound', id: 'bongo' }, { kind: 'slot', trackId: 'keys', scene: 0, trackType: 'midi' })).toMatchObject({ action: 'reject' })
    const header = targetFromAttrs({ headTrack: 'keys', trackType: 'midi' })
    expect(planSessionDrop({ kind: 'device', device: 'instrument', id: 'synth' }, header!)).toEqual({
      action: 'load-instrument',
      trackId: 'keys',
      id: 'synth',
    })
    expect(planSessionDrop({ kind: 'device', device: 'instrument', id: 'synth' }, { kind: 'header', trackId: 'vocal', trackType: 'audio' })).toMatchObject({ action: 'reject' })
    expect(planSessionDrop({ kind: 'device', device: 'audio', id: 'tune' }, header!)).toEqual({
      action: 'add-audio-device',
      trackId: 'keys',
      id: 'tune',
    })
  })
})

describe('session slot labels and scene rows', () => {
  it('keeps the full name and numbers a duplicate', () => {
    const labels = slotLabels(['Bongo Martillo 112 BPM', 'Hat', 'Bongo Martillo 112 BPM', null])
    expect(labels[0]).toEqual({ text: 'Bongo Martillo 112 BPM', title: 'Bongo Martillo 112 BPM', badge: null })
    expect(labels[2]).toEqual({ text: 'Bongo Martillo 112 BPM', title: 'Bongo Martillo 112 BPM 2', badge: '2' })
    expect(labels[1].badge).toBeNull()
    expect(labels[3].text).toBe('')
  })

  it('scene 1 launches the first slot, not the second', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const vocal = store.project.tracks[0]
    store.placeInSlot(vocal.id, 0, audio('first', 'Bongo Martillo 112 BPM'))
    store.placeInSlot(vocal.id, 1, audio('second', 'Bongo Martillo 112 BPM'))
    expect(sceneClip(vocal, 0)?.id).toBe('first')
    expect(sceneClip(vocal, 1)?.id).toBe('second')
    store.launchScene(0, 0)
    expect(store.launched[vocal.id]).toBe('first')
    expect(store.launched[vocal.id]).not.toBe('second')
  })

  it('double-click creates a 1-bar midi clip in that slot and opens it', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    const vocal = store.project.tracks[0]
    expect(store.project.recordBars).toBe(4)
    store.createEmptyMidiSlot(vocal.id, 0)
    expect(vocal.midiClips).toHaveLength(0)
    store.createEmptyMidiSlot(keys.id, 0)
    const clip = keys.midiClips.find((item) => item.id === keys.midiSlots?.[0])
    expect(clip?.durationBeats).toBe(4)
    expect(clip?.notes).toEqual([])
    expect(clip?.slotOnly).toBe(true)
    expect(keys.midiSlots?.[1] ?? null).toBeFalsy()
    expect(store.sessionEdit).toEqual({ trackId: keys.id, scene: 0 })
    expect(store.selectedMidiClipId).toBe(clip?.id)
    store.launch(keys.id, clip!.id, 0)
    store.launch(keys.id, clip!.id, 1000, 'start')
    expect(store.launched[keys.id]).toBe(clip!.id)
    expect(store.stopAt[keys.id]).toBeUndefined()
  })
})
