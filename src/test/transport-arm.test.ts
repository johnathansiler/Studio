import { describe, expect, it } from 'vitest'
import { renderGraph, type GraphTrack } from '../audio/renderGraph'
import { collectRecordInputs } from '../midi/inputs'
import { createEmptyProject, makeTrack } from '../model/types'
import {
  applyLaneNotes,
  patternPlayBeat,
  patternToLaneNotes,
  patternToMidiNotes,
} from '../model/patternMidi'
import {
  armedRecordPlan,
  hasArmedRecord,
  homeSample,
  playOriginSample,
  playPress,
  recordPress,
  returnSample,
  stopPress,
} from '../model/transport'
import { ProjectStore } from '../state/store'

const rate = 48000

function tone(length: number, amp: number) {
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * amp
  return data
}

function rms(buffer: Float32Array) {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / Math.max(1, buffer.length))
}

function graphTrack(id: string, amp: number, patch: Partial<GraphTrack> = {}): GraphTrack {
  const buffer = tone(rate / 10, amp)
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

describe('transport', () => {
  const loop = { loopEnabled: true, loopStartSample: 48000, loopEndSample: 96000 }
  const free = { loopEnabled: false, loopStartSample: 0, loopEndSample: 192000 }

  it('starts play at the playhead, or the loop start when the playhead is outside', () => {
    expect(playOriginSample(free, 1200)).toBe(1200)
    expect(playOriginSample(loop, 50000)).toBe(50000)
    expect(playOriginSample(loop, 10)).toBe(48000)
    expect(playPress('stopped', free, 1200)).toEqual({ action: 'start', sample: 1200 })
    expect(playPress('playing', free, 1200)).toEqual({ action: 'pause' })
    expect(playPress('recording', free, 1200)).toEqual({ action: 'ignore' })
    expect(playPress('counting-in', free, 0)).toEqual({ action: 'ignore' })
  })

  it('stops once in place and returns home on the next stop', () => {
    expect(stopPress('playing', free, 8000)).toEqual({ action: 'halt' })
    expect(stopPress('recording', loop, 60000)).toEqual({ action: 'halt' })
    expect(stopPress('stopped', free, 8000)).toEqual({ action: 'home', sample: 0 })
    expect(stopPress('stopped', loop, 80000)).toEqual({ action: 'home', sample: 48000 })
    expect(stopPress('stopped', free, 0)).toEqual({ action: 'halt' })
    expect(homeSample(loop)).toBe(48000)
    expect(returnSample(free)).toBe(0)
    expect(returnSample(loop)).toBe(loop.loopStartSample)
  })

  it('records only armed tracks and refuses a take when nothing is armed', () => {
    const project = createEmptyProject()
    expect(project.tracks.every((track) => track.armed === false)).toBe(true)
    expect(hasArmedRecord(project.tracks)).toBe(false)
    expect(recordPress('stopped', project.tracks)).toBe('empty')
    expect(recordPress('recording', project.tracks)).toBe('stop')
    const vocal = project.tracks[0]
    vocal.armed = true
    expect(armedRecordPlan(project.tracks).audio).toEqual([vocal.id])
    expect(recordPress('stopped', project.tracks)).toBe('start')
    vocal.armed = false
    const keys = project.tracks.find((track) => track.type === 'midi')!
    keys.armed = true
    keys.input = 'midi'
    expect(armedRecordPlan(project.tracks).midi).toEqual([keys.id])
    expect(armedRecordPlan(project.tracks).audio).toEqual([])
  })
})

describe('record capture', () => {
  it('does not open the mic for an unarmed Vocal', async () => {
    const vocal = makeTrack({ name: 'Vocal', type: 'audio', armed: false, input: 'mic' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: false, input: 'midi' })
    let opened = 0
    const inputs = await collectRecordInputs({
      tracks: [vocal, keys],
      takeId: 'take',
      localStream: () => null,
      remoteStream: () => null,
      setLocalMic: () => undefined,
      openMic: async () => {
        opened += 1
        return { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream
      },
    })
    expect(inputs).toEqual([])
    expect(opened).toBe(0)
  })
})

describe('mute and solo graph', () => {
  it('silences a muted track and leaves only the soloed track', () => {
    const vocal = graphTrack('vocal', 0.5)
    const music = graphTrack('music', 0.5)
    const open = renderGraph({
      tracks: [vocal, music],
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: rate,
      tempo: 120,
      length: vocal.buffer[0].length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      offline: true,
      create: () => ({ latencySamples: 0, reset() {}, process(input: Float32Array[], output: Float32Array[]) { output[0].set(input[0]); output[1].set(input[1]) } }),
    })
    const muted = renderGraph({
      tracks: [{ ...vocal, mute: true }, music],
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: rate,
      tempo: 120,
      length: vocal.buffer[0].length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      offline: true,
      create: () => ({ latencySamples: 0, reset() {}, process(input: Float32Array[], output: Float32Array[]) { output[0].set(input[0]); output[1].set(input[1]) } }),
    })
    const solo = renderGraph({
      tracks: [vocal, { ...music, solo: true }],
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: rate,
      tempo: 120,
      length: vocal.buffer[0].length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      offline: true,
      create: () => ({ latencySamples: 0, reset() {}, process(input: Float32Array[], output: Float32Array[]) { output[0].set(input[0]); output[1].set(input[1]) } }),
    })
    expect(rms(muted.master[0])).toBeLessThan(rms(open.master[0]) * 0.7)
    expect(rms(solo.master[0])).toBeLessThan(rms(open.master[0]) * 0.7)
    expect(rms(solo.master[0])).toBeGreaterThan(0.05)
    const bus = renderGraph({
      tracks: [
        graphTrack('vocal', 0.4, { solo: true, output: 'bus' }),
        graphTrack('bus', 0, { type: 'bus' }),
        graphTrack('other', 0.8),
      ],
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: rate,
      tempo: 120,
      length: vocal.buffer[0].length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      offline: true,
      create: () => ({ latencySamples: 0, reset() {}, process(input: Float32Array[], output: Float32Array[]) { output[0].set(input[0]); output[1].set(input[1]) } }),
    })
    expect(rms(bus.master[0])).toBeGreaterThan(0.05)
    expect(rms(bus.master[0])).toBeLessThan(rms(open.master[0]))
  })
})

describe('pattern to song', () => {
  it('maps every step to a GM note with swing, velocity, and odd lengths', () => {
    const store = new ProjectStore()
    const pattern = store.activePattern()!
    pattern.steps = 7
    pattern.swing = 0.5
    const kick = pattern.channels[0]
    const snare = pattern.channels[1]
    for (const channel of pattern.channels) channel.cells = channel.cells.map((cell) => ({ ...cell, on: false }))
    kick.cells[1] = { ...kick.cells[1], on: true, velocity: 0.42, gate: 0.5, nudge: 0.02, pitch: 0, fine: 0, pan: -0.2 }
    snare.cells[4] = { ...snare.cells[4], on: true, velocity: 0.9, gate: 0.8, pitch: 2 }
    const notes = patternToLaneNotes(pattern)
    expect(notes.map((note) => note.pitch)).toEqual([kick.note, snare.note + 2])
    expect(notes[0].startBeat).toBeCloseTo(0.25 + 0.5 * 0.25 + 0.02)
    expect(notes[0].velocity).toBeCloseTo(0.42)
    expect(notes[0].soundVelocity).toBeCloseTo(0.42)
    expect(notes[1].step).toBe(4)
    expect(patternToMidiNotes(pattern).map((note) => [note.pitch, note.velocity])).toEqual([
      [notes[0].pitch, notes[0].soundVelocity],
      [notes[1].pitch, notes[1].soundVelocity],
    ])
    applyLaneNotes(pattern, notes)
    expect(pattern.channels[0].cells[1]).toMatchObject({ on: true, velocity: 0.42, gate: 0.5, nudge: 0.02, pan: -0.2 })
    expect(pattern.channels[1].cells[4].on).toBe(true)
    expect(pattern.channels[1].cells[4].pitch).toBe(2)
    expect(pattern.channels[0].cells[0].on).toBe(false)
    expect(patternPlayBeat(7 * 0.25 + 0.1, 7)).toBeCloseTo(0.1)
  })

  it('round-trips the starter grid through the roll map without losing hits', () => {
    const store = new ProjectStore()
    const pattern = store.activePattern()!
    const before = patternToLaneNotes(pattern)
    applyLaneNotes(pattern, before)
    expect(patternToLaneNotes(pattern)).toEqual(before)
  })

  it('places MIDI on a drum track and a pattern clip on Arrange, and both undo', () => {
    const store = new ProjectStore()
    const beat = 4.4
    const made = store.sendPatternToSong('midi', null, beat)
    expect(made).toBeTruthy()
    const track = store.project.tracks.find((item) => item.id === made!.trackId)!
    expect(track.instrument === 'drum-machine' || track.instrument === 'pads').toBe(true)
    const clip = track.midiClips.find((item) => item.id === made!.clipId)!
    expect(clip.startBeat).toBe(4)
    expect(clip.notes.map((note) => note.pitch)).toEqual(patternToMidiNotes(store.activePattern()!).map((note) => note.pitch))
    store.undo()
    expect(store.project.tracks.some((item) => item.midiClips.some((item) => item.id === clip.id))).toBe(false)

    store.placePattern(6.2)
    const placed = store.project.patternClips![0]
    expect(placed.startBeat).toBe(6)
    expect(placed.patternId).toBe(store.activePattern()!.id)
    store.placePattern(10)
    store.makePatternClipUnique(store.project.patternClips![1].id)
    expect(store.project.patternClips![0].patternId).not.toBe(store.project.patternClips![1].patternId)
    store.undo()
    expect(store.project.patternClips![0].patternId).toBe(store.project.patternClips![1].patternId)
  })
})
