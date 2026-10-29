import { describe, expect, it } from 'vitest'
import { createPlugin, defaultParams } from '../audio/plugins/catalog'
import { create as createCompressor } from '../audio/plugins/compressor'
import { create as createGate } from '../audio/plugins/gate'
import { renderGraph, type GraphTrack } from '../audio/renderGraph'
import type { Processor } from '../audio/plugins/types'
import { audibleIds } from '../model/audible'
import { automationSchedule, curveAt, prepareCurve, rampEvents, valueAtSample, writeSegment } from '../model/automation'
import { arrangementDigest } from '../model/sessionSync'
import { projectBeatSample, projectSampleBeat, snapSampleToMap } from '../model/tempoMap'
import { samplesToBeats, snapSample } from '../model/time'
import { createEmptyProject, makeTrack, type AudioClip, type MidiClip } from '../model/types'
import { ProjectStore } from '../state/store'
import { automatedValue, lanePoints } from '../state/select'

const rate = 48000

function sine(freq: number, seconds: number, amp = 0.4) {
  const n = Math.floor(rate * seconds)
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return data
}

function rms(buffer: Float32Array) {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / Math.max(1, buffer.length))
}

function ctx(extra: Partial<Parameters<Processor['process']>[3]> = {}) {
  return {
    sampleRate: rate,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11] as readonly number[],
    quality: 'full' as const,
    offline: true,
    ...extra,
  }
}

function track(id: string, buffer: Float32Array, patch: Partial<GraphTrack> = {}): GraphTrack {
  return {
    id,
    type: 'audio',
    input: 'none',
    buffer: [buffer, buffer],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    plugins: [],
    sends: [],
    output: null,
    groupId: null,
    ...patch,
  }
}

function render(tracks: GraphTrack[], automation: GraphTrack extends never ? never : Parameters<typeof renderGraph>[0]['automation'] = []) {
  return renderGraph({
    tracks,
    masterPlugins: [],
    masterVolume: 1,
    sampleRate: rate,
    tempo: 120,
    length: tracks[0]?.buffer[0].length || 1,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    automation,
    offline: true,
    create: (id) => (id === 'compressor' ? createCompressor(rate) : createGate(rate)),
  })
}

function clip(id: string, start: number): AudioClip {
  return {
    id,
    name: id,
    bufferId: 'buf',
    startSample: start,
    offsetSamples: 0,
    durationSamples: 1000,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'local',
  }
}

function scheduledAt(events: { time: number; value: number }[], time: number) {
  if (!events.length || time <= events[0].time) return events[0]?.value ?? 0
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]
    const next = events[i]
    if (time <= next.time) {
      const span = next.time - prev.time || 1
      return prev.value + ((time - prev.time) / span) * (next.value - prev.value)
    }
  }
  return events[events.length - 1].value
}

describe('automation follows the tempo map', () => {
  const spec = { trackId: 'a', target: 'volume' as const, param: 'volume', min: 0, max: 1.25 }

  function withMap(map: { beat: number; bpm: number; ramp?: boolean }[]) {
    const project = createEmptyProject(rate)
    project.tempo = 120
    project.snap = false
    project.tempoMap = map
    project.tracks = [makeTrack({ id: 'a', name: 'A', type: 'audio' })]
    const store = new ProjectStore(project)
    store.project.tempoMap = map
    store.project.snap = false
    return store
  }

  function writeAt(store: ProjectStore, beat: number, value: number) {
    const sample = Math.round(projectBeatSample(store.project, beat))
    store.setAutomationMode('latch')
    store.beginAutomationTouch()
    store.setAutomated(spec, value, true, sample)
    return sample
  }

  it('lands a write and a read on a tempo step', () => {
    const store = withMap([{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }])
    const sample = writeAt(store, 3, 0.42)
    expect(samplesToBeats(sample, rate, 120)).not.toBeCloseTo(3, 1)
    expect(lanePoints(store.project, spec)[0].beat).toBeCloseTo(3, 3)
    expect(automatedValue(store.project, spec, sample, 0)).toBeCloseTo(0.42)
    store.endAutomationTouch()
    const later = Math.round(projectBeatSample(store.project, 5))
    store.sustainAutomation(later)
    expect(lanePoints(store.project, spec).some((point) => Math.abs(point.beat - 5) < 0.02)).toBe(true)
    expect(automatedValue(store.project, spec, later, 0)).toBeCloseTo(0.42)
  })

  it('lands a write and a read on a tempo ramp', () => {
    const store = withMap([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60, ramp: true }])
    const sample = writeAt(store, 3, 0.7)
    expect(samplesToBeats(sample, rate, 120)).not.toBeCloseTo(3, 1)
    expect(lanePoints(store.project, spec)[0].beat).toBeCloseTo(3, 3)
    expect(automatedValue(store.project, spec, sample, 0)).toBeCloseTo(0.7)
  })

  it('places audio-clock breakpoints on the mapped sample of each beat', () => {
    const points = [{ beat: 0, value: 0 }, { beat: 4, value: 1 }]
    const maps = [
      [{ beat: 0, bpm: 120 }, { beat: 2, bpm: 60 }],
      [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60, ramp: true }],
    ]
    for (const map of maps) {
      const project = createEmptyProject(rate)
      project.tempo = 120
      project.tempoMap = map
      const beatSample = projectBeatSample(project, 4)
      const fixed = (4 * rate * 60) / 120
      expect(Math.abs(beatSample - fixed)).toBeGreaterThan(1000)
      const events = automationSchedule(points, 0, project, 0, 8, Math.ceil(beatSample))
      const last = events[events.length - 1]
      expect(last.time).toBeCloseTo(8 + beatSample / rate, 4)
      expect(last.value).toBeCloseTo(1, 4)
      expect(last.time).not.toBeCloseTo(8 + fixed / rate, 2)
      const mid = 8 + projectBeatSample(project, 2) / rate
      expect(scheduledAt(events, mid)).toBeCloseTo(0.5, 2)
    }
  })
})

describe('automation curves', () => {
  it('interpolates a lane at the sample', () => {
    const points = prepareCurve([{ beat: 0, value: 0 }, { beat: 1, value: 1 }])
    expect(curveAt(points, 0.5, 0)).toBeCloseTo(0.5)
    expect(valueAtSample(points, 12000, rate, 120, 0)).toBeCloseTo(0.5)
    expect(curveAt(points, 4, 0)).toBe(1)
  })

  it('schedules ramps on the audio clock', () => {
    const events = rampEvents([{ beat: 0, value: 0 }, { beat: 1, value: 1 }], 0, rate, 120, 0, 10, rate)
    expect(events[0]).toEqual({ time: 10, value: 0 })
    expect(events[1].time).toBeCloseTo(10.5)
    expect(events[1].value).toBe(1)
  })

  it('punches a span without erasing the later lane', () => {
    const next = writeSegment([{ beat: 0, value: 0 }, { beat: 4, value: 1 }], 1, 2, 0.25, 0.25)
    expect(curveAt(prepareCurve(next), 1.5, 0)).toBeCloseTo(0.25)
    expect(curveAt(prepareCurve(next), 3, 0)).toBeGreaterThan(0.4)
  })

  it('ramps volume inside a single render block', () => {
    const n = 200
    const tone = new Float32Array(n).fill(1)
    const endBeat = (199 / rate) * (120 / 60)
    const rendered = render([track('v', tone)], [
      { id: 'vol', pluginId: '', param: 'volume', trackId: 'v', target: 'volume', points: [{ beat: 0, value: 0 }, { beat: endBeat, value: 1 }] },
    ])
    const pan = Math.cos(Math.PI / 4)
    expect(Math.abs(rendered.master[0][0])).toBeLessThan(0.02)
    expect(rendered.master[0][100]).toBeCloseTo(pan * (100 / 199), 1)
  })
})

describe('sidechain', () => {
  it('ducks a compressor from another track in the offline mix', () => {
    const vocal = sine(220, 0.3, 0.4)
    const kick = new Float32Array(vocal.length)
    kick.set(sine(60, 0.12, 0.95), 0)
    const comp = createPlugin('compressor', 'Duck')
    comp.sidechain = 'kick'
    const ducked = render([
      track('vocal', vocal, { plugins: [comp] }),
      track('kick', kick, { mute: true }),
    ])
    const plain = render([
      track('vocal', vocal, { plugins: [{ ...comp, sidechain: '' }] }),
      track('kick', kick, { mute: true }),
    ])
    const early = rms(ducked.master[0].subarray(2000, 5000))
    const late = rms(ducked.master[0].subarray(vocal.length - 4000, vocal.length - 500))
    expect(early).toBeLessThan(late)
    expect(early).toBeLessThan(rms(plain.master[0].subarray(2000, 5000)))
  })

  it('opens a gate from a sidechain key', () => {
    const quiet = sine(440, 0.15, 0.02)
    const loud = sine(90, 0.15, 0.9)
    const params = { ...defaultParams('gate'), threshold: -24, ratio: 8, attack: 1, release: 20, hold: 5, range: 60 }
    const keyed = new Float32Array(quiet.length)
    const dry = new Float32Array(quiet.length)
    createGate(rate).process([quiet, quiet], [keyed, new Float32Array(quiet.length)], params, ctx({ sidechain: loud }))
    createGate(rate).process([quiet, quiet], [dry, new Float32Array(quiet.length)], params, ctx())
    expect(rms(keyed)).toBeGreaterThan(rms(dry) * 2)
  })

  it('offers a ducking preset', () => {
    const preset = createPlugin('compressor', 'Duck')
    expect(preset.params.ratio).toBeGreaterThan(6)
    expect(preset.params.attack).toBeLessThan(5)
  })
})

describe('solo, mute, and link groups', () => {
  it('keeps a soloed track audible through its group and silences the rest', () => {
    const quiet = sine(440, 0.15, 0.25)
    const loud = sine(440, 0.15, 0.9)
    const rendered = render([
      track('a', quiet, { solo: true, groupId: 'g' }),
      track('b', loud),
      track('g', new Float32Array(quiet.length), { type: 'group' }),
    ])
    expect(rms(rendered.master[0])).toBeGreaterThan(0.04)
    expect(rms(rendered.master[0])).toBeLessThan(0.2)
  })

  it('leaves solo-safe returns up and lets mute win', () => {
    const tone = sine(330, 0.1, 0.5)
    const silence = new Float32Array(tone.length)
    const safe = render([
      track('lead', silence, { solo: true }),
      track('verb', tone, { soloSafe: true }),
    ])
    expect(rms(safe.master[0])).toBeGreaterThan(0.1)
    const muted = render([track('lead', tone, { solo: true, mute: true })])
    expect(rms(muted.master[0])).toBeLessThan(0.001)
    const ids = audibleIds([
      { id: 'a', mute: false, solo: true, groupId: 'g' },
      { id: 'g', mute: false, solo: false },
      { id: 'b', mute: false, solo: false },
    ])
    expect(ids.has('a')).toBe(true)
    expect(ids.has('g')).toBe(true)
    expect(ids.has('b')).toBe(false)
  })

  it('links faders, mutes, and overlapping edits', () => {
    const project = createEmptyProject()
    project.tracks = [
      makeTrack({ id: 'a', name: 'A', type: 'audio', clips: [clip('c1', 0)] }),
      makeTrack({ id: 'b', name: 'B', type: 'audio', volume: 0.4, clips: [clip('c2', 0)] }),
    ]
    const store = new ProjectStore(project)
    store.updateTrack('b', { volume: 0.4 })
    store.assignMixGroup('a', 'new')
    const group = store.project.mixGroups?.[0]
    expect(group).toBeTruthy()
    store.assignMixGroup('b', group!.id)
    store.updateTrack('a', { volume: 0.9 })
    expect(store.project.tracks.find((item) => item.id === 'b')?.volume).toBeCloseTo(0.5)
    store.toggleTrack('a', 'mute')
    expect(store.project.tracks.every((item) => item.mute)).toBe(true)
    store.moveClip('a', 'c1', 800)
    expect(store.project.tracks.find((item) => item.id === 'b')?.clips[0].startSample).toBe(800)
  })

  it('links a move and a split on the tempo map, not a fixed tempo', () => {
    const midi = (id: string): MidiClip => ({ id, name: id, startBeat: 0, durationBeats: 8, notes: [] })
    const project = createEmptyProject(rate)
    project.snap = true
    project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]
    project.tracks = [
      makeTrack({ id: 'a', name: 'A', type: 'audio', clips: [clip('c1', 0)], midiClips: [midi('m1')] }),
      makeTrack({ id: 'b', name: 'B', type: 'audio', clips: [clip('c2', 0)], midiClips: [midi('m2')] }),
    ]
    const store = new ProjectStore(project)
    store.project.snap = true
    store.project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]
    store.assignMixGroup('a', 'new')
    const groupId = store.project.mixGroups?.[0]?.id
    expect(groupId).toBeTruthy()
    store.assignMixGroup('b', groupId!)
    const target = 50000
    const mapped = snapSampleToMap(target, store.project)
    expect(mapped).not.toBe(snapSample(target, rate, store.project.tempo, true))
    store.placeAudioClips([{ trackId: 'a', clipId: 'c1', startSample: target }])
    expect(store.project.tracks.find((item) => item.id === 'a')?.clips[0].startSample).toBe(mapped)
    expect(store.project.tracks.find((item) => item.id === 'b')?.clips[0].startSample).toBe(mapped)
    const beat = projectSampleBeat(store.project, target)
    expect(beat).not.toBeCloseTo(samplesToBeats(target, rate, store.project.tempo))
    store.splitAt('a', 'm1', target)
    const right = (id: string) => store.project.tracks.find((item) => item.id === id)?.midiClips.find((item) => item.startBeat > 0)
    expect(right('a')?.startBeat).toBeCloseTo(beat)
    expect(right('b')?.startBeat).toBeCloseTo(beat)
  })

  it('writes latch and touch, and leaves read playback untouched', () => {
    const project = createEmptyProject()
    const store = new ProjectStore(project)
    const id = store.project.tracks[0].id
    const spec = { trackId: id, target: 'volume' as const, param: 'volume', min: 0, max: 1.25 }
    store.setAutomationMode('read')
    store.setAutomated(spec, 0.15, true, 0)
    expect(store.project.tracks[0].volume).toBeCloseTo(0.15)
    expect(lanePoints(store.project, spec)).toHaveLength(0)
    store.paintAutomation(spec, 0, 0.8)
    store.endDraft()
    const held = store.project.tracks[0].volume
    store.setAutomated(spec, 0.15, true, 0)
    expect(store.project.tracks[0].volume).toBe(held)
    expect(lanePoints(store.project, spec).length).toBeGreaterThan(0)
    store.undo()
    store.setAutomationMode('latch')
    store.beginAutomationTouch()
    store.setAutomated(spec, 0.2, true, 0)
    store.endAutomationTouch()
    store.sustainAutomation(24000)
    expect(valueAtSample(lanePoints(store.project, spec), 12000, rate, 120, 1)).toBeCloseTo(0.2)
    store.finishAutomationLatch()
    store.setAutomationMode('touch')
    store.beginAutomationTouch()
    store.setAutomated(spec, 0.55, true, 48000)
    store.endAutomationTouch()
    store.sustainAutomation(96000)
    const touch = lanePoints(store.project, spec)
    expect(touch.some((point) => Math.abs(point.beat - 2) < 0.05 && point.value === 0.55)).toBe(true)
    expect(touch.some((point) => point.beat > 3)).toBe(false)
    store.setAutomationMode('off')
    store.beginAutomationTouch()
    store.setAutomated(spec, 0.1, true, 96000)
    store.endAutomationTouch()
    expect(store.project.tracks[0].volume).toBeCloseTo(0.1)
    expect(lanePoints(store.project, spec).some((point) => point.value === 0.1)).toBe(false)
    const digest = arrangementDigest(store.project)
    store.updateTrack(id, { soloSafe: true })
    expect(arrangementDigest(store.project)).not.toBe(digest)
  })
})
