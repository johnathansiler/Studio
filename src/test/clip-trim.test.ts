import { describe, expect, it } from 'vitest'
import { renderArrangement } from '../audio/bounce'
import { renderClipChannels } from '../audio/stretch/engine'
import { trimAudioClip } from '../model/clips'
import { createEmptyProject, makeTrack, type AudioClip, type MidiClip } from '../model/types'
import { snapSample } from '../model/time'
import { snapSampleToMap } from '../model/tempoMap'
import { ProjectStore } from '../state/store'

const rate = 48000

function take(length: number, markAt: number): Float32Array {
  const channel = new Float32Array(length)
  channel[markAt] = 1
  return channel
}

function audioClip(id: string, bufferId: string, length: number, patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    name: id,
    bufferId,
    startSample: 0,
    offsetSamples: 0,
    durationSamples: length,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'local',
    ...patch,
  }
}

describe('clip edge trim', () => {
  it('keeps audio in place, stays inside the recording, and undoes', () => {
    const length = rate * 2
    const mark = 30000
    const channel = take(length, mark)
    const project = createEmptyProject(rate)
    project.snap = false
    project.masterVolume = 1
    project.masterPlugins = []
    project.tracks = [makeTrack({
      id: 'vocal',
      name: 'Vocal',
      type: 'audio',
      volume: 1,
      pan: 0,
      input: 'none',
      clips: [audioClip('take', 'buf', length)],
    })]
    const store = new ProjectStore(project, new Map([['buf', { id: 'buf', name: 'take', sampleRate: rate, channels: [channel] }]]))
    store.project.snap = false
    store.project.masterVolume = 1
    store.project.masterPlugins = []

    store.trimClip('vocal', 'take', 'start', 40)
    const started = store.project.tracks[0].clips[0]
    expect(started.startSample).toBe(40)
    expect(started.offsetSamples).toBe(40)
    expect(started.durationSamples).toBe(length - 40)
    const hq = renderClipChannels([channel], started, store.project, 'hq')
    expect(hq[0][mark - 40]).toBe(1)
    expect(hq[0][0]).toBe(0)
    expect(store.sync.peek().some((op) => op.p.includes('clips'))).toBe(true)
    store.undo()
    expect(store.project.tracks[0].clips[0].offsetSamples).toBe(0)
    expect(store.project.tracks[0].clips[0].durationSamples).toBe(length)

    store.trimClip('vocal', 'take', 'start', 40)
    store.trimClip('vocal', 'take', 'end', 80)
    const shortened = store.project.tracks[0].clips[0]
    expect(shortened.durationSamples).toBe(40)
    expect(shortened.offsetSamples).toBe(40)
    expect(shortened.offsetSamples + shortened.durationSamples).toBeLessThanOrEqual(length)

    store.trimClip('vocal', 'take', 'end', length * 4)
    const capped = store.project.tracks[0].clips[0]
    expect(capped.startSample).toBe(40)
    expect(capped.durationSamples).toBe(length - 40)
    expect(capped.offsetSamples + capped.durationSamples).toBe(length)

    store.trimClip('vocal', 'take', 'start', -5000)
    const parked = store.project.tracks[0].clips[0]
    expect(parked.startSample).toBeGreaterThanOrEqual(0)
    expect(parked.offsetSamples).toBeGreaterThanOrEqual(0)
  })

  it('snaps both edges to the tempo map and trims a linked group by that map', async () => {
    const length = rate * 8
    const mark = 30000
    const channel = take(length, mark)
    const project = createEmptyProject(rate)
    project.snap = true
    project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]
    project.masterVolume = 1
    project.masterPlugins = []
    project.tracks = [
      makeTrack({ id: 'a', name: 'A', type: 'audio', volume: 1, pan: 0, input: 'none', clips: [audioClip('c1', 'buf', length)] }),
      makeTrack({ id: 'b', name: 'B', type: 'audio', volume: 1, pan: 0, input: 'none', clips: [audioClip('c2', 'buf', length)] }),
    ]
    const store = new ProjectStore(project, new Map([['buf', { id: 'buf', name: 'take', sampleRate: rate, channels: [channel, channel] }]]))
    store.project.snap = true
    store.project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]
    store.project.masterVolume = 1
    store.assignMixGroup('a', 'new')
    const groupId = store.project.mixGroups?.[0]?.id
    expect(groupId).toBeTruthy()
    store.assignMixGroup('b', groupId!)

    const requested = 50000
    const mapped = snapSampleToMap(requested, store.project)
    expect(mapped).not.toBe(snapSample(requested, rate, store.project.tempo, true))
    store.trimClip('a', 'c1', 'end', requested)
    const endA = store.project.tracks.find((track) => track.id === 'a')!.clips[0]
    const endB = store.project.tracks.find((track) => track.id === 'b')!.clips[0]
    expect(endA.durationSamples).toBe(mapped)
    expect(endB.durationSamples).toBe(mapped)
    expect(endA.durationSamples).toBeLessThan(length)

    store.trimClip('a', 'c1', 'start', 25000)
    const startA = store.project.tracks.find((track) => track.id === 'a')!.clips[0]
    const startB = store.project.tracks.find((track) => track.id === 'b')!.clips[0]
    const snappedStart = snapSampleToMap(25000, store.project)
    expect(startA.startSample).toBe(snappedStart)
    expect(startA.offsetSamples).toBe(snappedStart)
    expect(startB.startSample).toBe(snappedStart)
    expect(startB.offsetSamples).toBe(snappedStart)
    expect(startA.startSample + (mark - startA.offsetSamples)).toBe(mark)

    store.project.masterPlugins = []
    const offline = await renderArrangement(store.project, store.buffers, 0, mark + 8, false)
    let peak = 0
    let peakAt = -1
    for (let i = 0; i < offline[0].length; i++) {
      if (Math.abs(offline[0][i]) > peak) {
        peak = Math.abs(offline[0][i])
        peakAt = i
      }
    }
    expect(peakAt).toBe(mark)
    expect(Math.abs(offline[0][Math.max(0, snappedStart - 1)])).toBeLessThan(0.0001)
  })

  it('trims linked MIDI clips on the same grid and can be undone', () => {
    const midi = (id: string): MidiClip => ({
      id,
      name: id,
      startBeat: 0,
      durationBeats: 8,
      notes: [{ id: `${id}-n`, pitch: 60, startBeat: 2, durationBeats: 1, velocity: 0.8 }],
    })
    const project = createEmptyProject(rate)
    project.snap = true
    project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]
    project.tracks = [
      makeTrack({ id: 'a', name: 'A', type: 'midi', input: 'none', midiClips: [midi('m1')] }),
      makeTrack({ id: 'b', name: 'B', type: 'midi', input: 'none', midiClips: [midi('m2')] }),
    ]
    const store = new ProjectStore(project)
    store.project.snap = true
    store.project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]
    store.assignMixGroup('a', 'new')
    const groupId = store.project.mixGroups?.[0]?.id
    expect(groupId).toBeTruthy()
    store.assignMixGroup('b', groupId!)

    store.resizeMidiClip('a', 'm1', 'end', 4.2, false)
    const clip = (id: string, trackId: string) => store.project.tracks.find((track) => track.id === trackId)!.midiClips.find((item) => item.id === id)!
    expect(clip('m1', 'a').durationBeats).toBeCloseTo(4, 2)
    expect(clip('m2', 'b').durationBeats).toBeCloseTo(4, 2)

    store.resizeMidiClip('a', 'm1', 'start', 1.2, false)
    expect(clip('m1', 'a').startBeat).toBeCloseTo(1, 2)
    expect(clip('m1', 'a').notes[0].startBeat).toBeCloseTo(1, 2)
    expect(clip('m2', 'b').startBeat).toBeCloseTo(1, 2)
    expect(clip('m1', 'a').startBeat + clip('m1', 'a').notes[0].startBeat).toBeCloseTo(2, 2)

    store.undo()
    expect(clip('m1', 'a').startBeat).toBe(0)
    expect(clip('m1', 'a').notes[0].startBeat).toBe(2)
  })

  it('refuses a start earlier than the recording or before the timeline', () => {
    const clip = audioClip('c', 'b', 500, { startSample: 1000, offsetSamples: 100 })
    const earlier = trimAudioClip(clip, 'start', 0, 10000)
    expect(earlier.startSample).toBe(900)
    expect(earlier.offsetSamples).toBe(0)
    const negative = trimAudioClip({ ...clip, startSample: 20, offsetSamples: 0 }, 'start', -40, 10000)
    expect(negative.startSample).toBe(20)
    const extended = trimAudioClip(clip, 'end', 999999, 400)
    expect(extended.offsetSamples + extended.durationSamples).toBeLessThanOrEqual(400)
    expect(extended.durationSamples).toBeGreaterThan(0)
  })
})
