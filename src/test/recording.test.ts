import { describe, expect, it } from 'vitest'
import {
  addLane,
  applyMidiPass,
  channelConstraints,
  compPieces,
  createFolder,
  inputChannel,
  mediaChannelCount,
  punchWindow,
  quickPunch,
  recordOffsetSamples,
  renderComp,
  saveComp,
  sliceCapture,
  swipeComp,
} from '../model/comp'
import { arrangementDigest, referencedBufferIds } from '../model/sessionSync'
import { createEmptyProject, defaultRecord, type TakeLane } from '../model/types'
import { ProjectStore } from '../state/store'

function lane(id: string, bufferId: string, start = 0, duration = 1000): TakeLane {
  return { id, name: id, bufferId, offsetSamples: 0, startSample: start, durationSamples: duration, source: 'local' }
}

function constant(value: number, length: number) {
  return Float32Array.from({ length }, () => value)
}

describe('swipe comping', () => {
  it('splits a lane into comp segments and crossfades the boundary', () => {
    let folder = createFolder(lane('a', 'buf-a'))
    folder = addLane(folder, lane('b', 'buf-b'))
    folder = swipeComp(folder, 'b', 400, 700)
    const segments = folder.comps[0].segments
    expect(segments.map((segment) => segment.laneId)).toEqual(['a', 'b', 'a'])
    const pieces = compPieces(folder, 0, 0)
    const join = pieces.filter((piece) => piece.fadeInSamples === folder.crossfadeSamples || piece.fadeOutSamples === folder.crossfadeSamples)
    expect(join.length).toBeGreaterThan(0)
    const coverage = pieces.reduce((sum, piece) => sum + piece.durationSamples, 0)
    expect(coverage).toBeGreaterThanOrEqual(1000)
  })

  it('keeps saved comps when a later swipe edits the active one', () => {
    let folder = createFolder(lane('a', 'buf-a'))
    const original = folder.activeCompId
    folder = addLane(folder, lane('b', 'buf-b'))
    folder = saveComp(folder, 'Safe', 'safe')
    folder = swipeComp(folder, 'b', 0, 500)
    expect(folder.comps.find((comp) => comp.id === original)!.segments.every((segment) => segment.laneId === 'a')).toBe(true)
    expect(folder.activeCompId).toBe('safe')
    expect(folder.comps.find((comp) => comp.id === 'safe')!.segments.some((segment) => segment.laneId === 'b')).toBe(true)
  })

  it('renders a crossfade between two constant takes', () => {
    let folder = createFolder(lane('a', 'buf-a', 0, 100), 10)
    folder = addLane(folder, lane('b', 'buf-b', 0, 100))
    folder = swipeComp(folder, 'b', 50, 100)
    const audio = new Map<string, Float32Array[]>([
      ['buf-a', [constant(0, 100)]],
      ['buf-b', [constant(1, 100)]],
    ])
    const mixed = renderComp(folder, audio)[0]
    expect(mixed[20]).toBeCloseTo(0, 2)
    expect(mixed[80]).toBeCloseTo(1, 2)
    expect(mixed[50]).toBeGreaterThan(0.2)
    expect(mixed[50]).toBeLessThan(0.8)
  })
})

describe('loop, punch, and inputs', () => {
  it('stacks one take per cycle pass on the shared loop', () => {
    const slices = sliceCapture({
      captureStart: 1000,
      captureLength: 3000,
      compensation: 0,
      loopStart: 1000,
      loopEnd: 2000,
    })
    expect(slices).toHaveLength(3)
    expect(slices.every((slice) => slice.startSample === 1000 && slice.durationSamples === 1000)).toBe(true)
    expect(slices.map((slice) => slice.captureOffset)).toEqual([0, 1000, 2000])
  })

  it('trims to the punch window after shifting for monitor latency', () => {
    const slices = sliceCapture({
      captureStart: 500,
      captureLength: 4000,
      compensation: 100,
      punchFrom: 800,
      punchTo: 2000,
    })
    expect(slices).toEqual([{ startSample: 800, durationSamples: 1200, captureOffset: 400 }])
  })

  it('places punch playback before the record in by the pre-roll', () => {
    const settings = { ...defaultRecord(0), punchEnabled: true, punchIn: 48000, punchOut: 96000, preRoll: 1, postRoll: 1, rollUnit: 'bars' as const }
    const window = punchWindow(settings, 48000, 120, { numerator: 4, denominator: 4 })
    expect(window.recordFrom).toBe(48000)
    expect(window.playFrom).toBe(0)
    expect(window.stopAt).toBe(96000 + 48000 * 2)
  })

  it('quick punch sets the in point and a later out point', () => {
    const next = quickPunch(defaultRecord(0), 1000, 48000, 120, { numerator: 4, denominator: 4 }, false)
    expect(next.quick).toBe(true)
    expect(next.punchIn).toBe(1000)
    expect(next.punchOut).toBeGreaterThan(next.punchIn)
    const closed = quickPunch(next, 5000, 48000, 120, { numerator: 4, denominator: 4 }, true)
    expect(closed.punchOut).toBe(5000)
  })

  it('selects an interface channel per track and compensates latency', () => {
    expect(inputChannel('mic')).toBeNull()
    expect(inputChannel('mic:2')).toBe(2)
    expect(mediaChannelCount(['mic', 'mic:3'])).toBe(4)
    expect(channelConstraints(4).channelCount).toEqual({ ideal: 4 })
    expect(recordOffsetSamples(0.01, 0.02, 48000)).toBe(1440)
  })
})

describe('remote lanes and midi passes', () => {
  it('drops a guest take onto a lane at the shared clock position', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = store.project.tracks[0]
    store.addTakeLane(track.id, lane('local', 'buf-local', 0, 1000))
    store.addAsset({ id: 'guest', name: 'Guest', sampleRate: 48000, channels: [constant(0.2, 500)] })
    store.addTakeLane(track.id, { ...lane('guest', 'guest', 250, 500), peerId: 'peer', source: 'aligned-take' })
    const folder = track.clips.find((clip) => clip.folder)!.folder!
    expect(folder.lanes.map((item) => item.id)).toEqual(['local', 'guest'])
    expect(folder.lanes[1].startSample).toBe(250)
    expect(referencedBufferIds(store.project)).toEqual(expect.arrayContaining(['buf-local', 'guest']))
    const before = arrangementDigest(store.project)
    store.swipeTake(track.id, track.clips[0].id, 'guest', 250, 750)
    expect(arrangementDigest(store.project)).not.toBe(before)
  })

  it('merges a midi pass or keeps it as its own take', () => {
    const note = (pitch: number) => ({ id: `n${pitch}`, pitch, startBeat: 0, durationBeats: 1, velocity: 100 })
    const merged = applyMidiPass([note(60)], [note(64)], [], 'merge', 'Pass', 'p1')
    expect(merged.notes.map((item) => item.pitch)).toEqual([60, 64])
    const takes = applyMidiPass([note(60)], [note(67)], [], 'takes', 'Pass', 'p2')
    expect(takes.notes.map((item) => item.pitch)).toEqual([67])
    expect(takes.takes.map((take) => take.notes[0].pitch)).toEqual([60, 67])
  })
})
