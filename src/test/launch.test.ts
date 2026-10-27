import { describe, expect, it } from 'vitest'
import {
  applyTransportLaunch,
  dueFollow,
  followTarget,
  overdubNotes,
  quantizeSample,
  recordedLength,
  retrigger,
  sceneClip,
  renderTempoWarp,
  warpRate,
} from '../model/launch'
import { preferStretchCache, renderStretch, renderStretchBlocks } from '../audio/stretch/engine'
import { yinPitch } from '../audio/stretch/voice'
import { beatsToSamples } from '../model/time'
import { createEmptyProject, makeTrack, type MidiClip } from '../model/types'
import { ProjectStore } from '../state/store'

const sig = { numerator: 4, denominator: 4 }

describe('clip launch', () => {
  it('quantizes to the next grid line and keeps an exact line', () => {
    expect(quantizeSample(1000, '1bar', 48000, 120, sig)).toBe(96000)
    expect(quantizeSample(96000, '1bar', 48000, 120, sig)).toBe(96000)
    expect(quantizeSample(1000, 'none', 48000, 120, sig)).toBe(1000)
    expect(quantizeSample(24001, '1/4', 48000, 120, sig)).toBe(48000)
    expect(quantizeSample(1, '1/16', 48000, 120, sig)).toBe(6000)
    expect(quantizeSample(6000, '1/16', 48000, 120, sig)).toBe(6000)
    expect(quantizeSample(1000, '2bar', 48000, 120, sig)).toBe(192000)
    expect(quantizeSample(1000, '4bar', 48000, 120, sig)).toBe(384000)
  })

  it('picks follow targets inside the scene grid', () => {
    expect(followTarget('next', 0, 8)).toBe(1)
    expect(followTarget('prev', 0, 8)).toBe(7)
    expect(followTarget('stop', 3, 8)).toBe('stop')
    expect(followTarget('none', 3, 8)).toBe(null)
    expect(followTarget('any', 3, 8, () => 5)).toBe(5)
    const other = followTarget('other', 0, 8, () => 0)
    expect(other).toBe(1)
    expect(other).not.toBe(0)
  })

  it('fires a follow action once the beat boundary is reached', () => {
    const boundary = beatsToSamples(4, 48000, 120)
    expect(dueFollow(0, 4, boundary - 1, 48000, 120)).toBe(false)
    expect(dueFollow(0, 4, boundary, 48000, 120)).toBe(true)
    expect(dueFollow(0, 0, boundary, 48000, 120)).toBe(false)
  })

  it('warps audio so the beat length follows the tempo', () => {
    expect(warpRate(48000, 2, 48000, 120, true)).toBe(1)
    expect(warpRate(48000, 2, 48000, 60, true)).toBe(0.5)
    expect(warpRate(48000, 2, 48000, 60, false)).toBe(1)
    expect(warpRate(48000, undefined, 48000, 60, true)).toBe(1)
    const rate = 48000
    const sine = new Float32Array(rate)
    for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / rate)
    const stretched = renderTempoWarp([sine], 0, sine.length, rate, 60, 2)
    expect(Math.abs(stretched[0].length - rate * 2)).toBeLessThan(rate * 0.001)
    const start = Math.floor(stretched[0].length * 0.35)
    const hz = yinPitch(stretched[0].subarray(start, start + 4096), rate, 220, 880).hz
    expect(Math.abs(1200 * Math.log2(hz / 440))).toBeLessThan(8)
    const same = renderTempoWarp([sine], 0, sine.length, rate, 120, 2)
    expect(same[0].length).toBe(sine.length)
    expect(same[0][100]).toBeCloseTo(sine[100])
    const once = renderStretch([sine.subarray(0, 8000)], rate, { ratio: 2, mode: 'tonal' })
    const blocks = renderStretchBlocks([sine.subarray(0, 8000)], rate, { ratio: 2, mode: 'tonal' }, 192)
    expect(blocks[0].length).toBe(once[0].length)
    let err = 0
    for (let i = 0; i < once[0].length; i++) err = Math.max(err, Math.abs((once[0][i] || 0) - (blocks[0][i] || 0)))
    expect(err).toBeLessThan(1e-5)
    expect(preferStretchCache(true, 1)).toBe(true)
    expect(preferStretchCache(false, 1)).toBe(false)
  })

  it('retriggers, holds legato, and toggles', () => {
    expect(retrigger('toggle', false, false)).toBe('start')
    expect(retrigger('toggle', true, false)).toBe('stop')
    expect(retrigger('trigger', true, false)).toBe('start')
    expect(retrigger('trigger', true, true)).toBe('hold')
    expect(retrigger('gate', false, false)).toBe('start')
    expect(retrigger('repeat', true, false)).toBe('start')
  })

  it('applies a host launch time without quantizing again', () => {
    const host = applyTransportLaunch(
      { launched: {}, at: {}, gen: {}, mode: 'arrangement' },
      { action: 'launch', trackId: 'keys', clipId: 'chords', timelineSample: 12345, gen: { keys: 2 } },
    )
    const guest = applyTransportLaunch(
      { launched: {}, at: {}, gen: {}, mode: 'arrangement' },
      { action: 'launch', trackId: 'keys', clipId: 'chords', timelineSample: 12345, gen: { keys: 2 } },
    )
    expect(guest.launched.keys).toBe('chords')
    expect(guest.at.keys).toBe(12345)
    expect(guest.at.keys).toBe(host.at.keys)
    expect(guest.gen.keys).toBe(2)
    expect(guest.mode).toBe('session')
    expect(quantizeSample(1000, '1bar', 48000, 120, sig)).not.toBe(12345)
  })

  it('syncs a scene, stop-all, and back on the same payload', () => {
    const scene = applyTransportLaunch(
      { launched: {}, at: {}, gen: {}, mode: 'arrangement' },
      {
        action: 'scene',
        timelineSample: 96000,
        slots: [
          { trackId: 'music', clipId: 'groove', timelineSample: 96000 },
          { trackId: 'keys', clipId: null },
        ],
        gen: { music: 1 },
      },
    )
    expect(scene.launched.music).toBe('groove')
    expect(scene.launched.keys).toBe(null)
    expect(scene.at.music).toBe(96000)
    expect(scene.at.keys).toBeUndefined()
    const stopped = applyTransportLaunch(scene, { action: 'stop-clips' })
    expect(stopped.launched).toEqual({})
    expect(stopped.mode).toBe('session')
    const back = applyTransportLaunch(scene, { action: 'back' })
    expect(back.mode).toBe('arrangement')
    expect(back.launched).toEqual({})
  })

  it('keeps existing MIDI notes when overdubbing', () => {
    const clip: MidiClip = {
      id: 'm',
      name: 'Keys',
      startBeat: 0,
      durationBeats: 4,
      notes: [{ id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }],
    }
    const next = overdubNotes(clip, [{ pitch: 64, startBeat: 1, durationBeats: 1, velocity: 0.5 }])
    expect(next.notes).toHaveLength(2)
    expect(next.notes[0].id).toBe('n1')
    expect(next.notes[1].pitch).toBe(64)
    expect(clip.notes).toHaveLength(1)
  })

  it('trims a fixed recording and keeps an open one', () => {
    expect(recordedLength(200000, 1, 48000, 120, sig)).toBe(96000)
    expect(recordedLength(50000, 1, 48000, 120, sig)).toBe(50000)
    expect(recordedLength(200000, 0, 48000, 120, sig)).toBe(200000)
  })

  it('resolves scene slots ahead of the arrangement list', () => {
    const track = makeTrack({ name: 'Music', type: 'audio' })
    track.clips = [
      { id: 'arr', name: 'Arrange', bufferId: 'b', startSample: 0, offsetSamples: 0, durationSamples: 10, fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'demo' },
      { id: 'slot', name: 'Slot', bufferId: 'b', startSample: 0, offsetSamples: 0, durationSamples: 10, fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'local', slotOnly: true },
    ]
    expect(sceneClip(track, 0)?.id).toBe('arr')
    track.audioSlots = ['slot', null]
    expect(sceneClip(track, 0)?.id).toBe('slot')
    expect(sceneClip(track, 1)).toBe(null)
  })
})

describe('session store', () => {
  it('quantizes a launch and follows into the next scene once', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    keys.midiClips = [
      { id: 'a', name: 'A', startBeat: 0, durationBeats: 4, notes: [], follow: 'next', followBeats: 4 },
      { id: 'b', name: 'B', startBeat: 0, durationBeats: 4, notes: [], follow: 'next', followBeats: 4 },
    ]
    store.launch(keys.id, 'a', 1000)
    expect(store.launchAt[keys.id]).toBe(96000)
    expect(store.launched[keys.id]).toBe('a')
    store.tickFollow(96000)
    expect(store.launched[keys.id]).toBe('a')
    const boundary = 96000 + beatsToSamples(4, 48000, 120)
    store.tickFollow(boundary)
    expect(store.launched[keys.id]).toBe('b')
    expect(store.launchAt[keys.id]).toBe(boundary)
    store.tickFollow(boundary)
    expect(store.launched[keys.id]).toBe('b')
  })

  it('captures a launched clip onto the arrangement and keeps a midi overdub slot', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    keys.midiClips = [{ id: 'a', name: 'A', startBeat: 0, durationBeats: 4, notes: [{ id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 1 }], slotOnly: true }]
    store.launch(keys.id, 'a', 0)
    store.captureToArrangement()
    const printed = keys.midiClips.filter((clip) => !clip.slotOnly)
    expect(printed).toHaveLength(1)
    expect(printed[0].startBeat).toBe(0)
    expect(printed[0].notes[0].pitch).toBe(60)
    expect(printed[0].id).not.toBe('a')
    store.prepareMidiSlot(keys.id, 0)
    const slotId = keys.midiSlots?.[0]
    const slot = keys.midiClips.find((clip) => clip.id === slotId)
    expect(slot?.notes).toHaveLength(1)
    store.prepareMidiSlot(keys.id, 7)
    expect(keys.midiClips.find((clip) => clip.id === keys.midiSlots?.[7])?.notes).toEqual([])
    expect(slot?.notes).toHaveLength(1)
  })
})
