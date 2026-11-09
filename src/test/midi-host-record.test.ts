import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { planLive } from '../instruments/scaler/route'
import { MidiHost } from '../midi/host'
import { clearCapture } from '../midi/remember'
import type { MidiPortInfo } from '../midi/access'
import { createEmptyProject, makeTrack, type Project, type Track } from '../model/types'
import { ProjectStore } from '../state/store'

/**
 * Simulated MIDI bytes. No physical keyboard, interface, or Web MIDI port is attached.
 * The clock stamp is performance time 10000 aligned with AudioContext time 1 at beat 4.
 * At 120 BPM one second is two beats, so a timestamp of 10500 is beat 5.
 */
const STAMP = 10_000

const ports = vi.hoisted(() => {
  const messages: ((input: MidiPortInfo, data: Uint8Array, timeStamp: number) => void)[] = []
  const ends: ((input: MidiPortInfo) => void)[] = []
  return { messages, ends }
})

vi.mock('../midi/access', () => ({
  hardwareMidiAllowed: () => true,
  midiOutputs: () => [],
  onMidiMessage: (handler: (input: MidiPortInfo, data: Uint8Array, timeStamp: number) => void) => {
    ports.messages.push(handler)
    return () => {
      const index = ports.messages.indexOf(handler)
      if (index >= 0) ports.messages.splice(index, 1)
    }
  },
  onMidiPortEnd: (handler: (input: MidiPortInfo) => void) => {
    ports.ends.push(handler)
    return () => {
      const index = ports.ends.indexOf(handler)
      if (index >= 0) ports.ends.splice(index, 1)
    }
  },
}))

interface FakeEngine {
  status: 'stopped' | 'recording' | 'playing'
  sounded: string[]
  released: string[]
  timeline: number
  subscribe: (fn: () => void) => () => void
  emit: () => void
  playThrough: (id: string, pitch: number) => void
  releaseThrough: (id: string, pitch: number) => void
  playOrigin: () => { context: number; beat: number }
  outputStamp: () => { contextTime: number; performanceTime: number }
  clockCompensation: () => { outputLatency: number; baseLatency: number; calibrationSec: number }
  currentTimelineSample: () => number
  midiSink: ((bytes: number[], timeMs?: number) => void) | null
  midiOutChannel: number
}

function fakeEngine(): FakeEngine {
  const listeners = new Set<() => void>()
  const engine: FakeEngine = {
    status: 'stopped',
    sounded: [],
    released: [],
    timeline: 0,
    midiSink: null,
    midiOutChannel: 0,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emit() {
      for (const fn of listeners) fn()
    },
    playThrough(id, pitch) {
      engine.sounded.push(`${id}:${pitch}`)
    },
    releaseThrough(id, pitch) {
      engine.released.push(`${id}:${pitch}`)
    },
    playOrigin: () => ({ context: 1, beat: 4 }),
    outputStamp: () => ({ contextTime: 1, performanceTime: STAMP }),
    clockCompensation: () => ({ outputLatency: 0, baseLatency: 0, calibrationSec: 0 }),
    currentTimelineSample: () => engine.timeline,
  }
  return engine
}

function session(tracks: Track[]) {
  const project = createEmptyProject()
  project.tracks = tracks
  project.tempo = 120
  project.sampleRate = 48000
  project.quantizeBeats = 0
  const store = new ProjectStore(project)
  const engine = fakeEngine()
  const host = new MidiHost(store, engine as unknown as AudioEngine)
  host.start(false)
  return { store, engine, host, tracks: store.project.tracks }
}

function trackByName(store: ProjectStore, name: string) {
  const track = store.project.tracks.find((item) => item.name === name)
  if (!track) throw new Error(`missing ${name}`)
  return track
}

function send(port: string, bytes: number[], time: number) {
  const handler = ports.messages.at(-1)
  if (!handler) throw new Error('MIDI host is not listening')
  handler({ id: port, name: port }, Uint8Array.from(bytes), time)
}

function noteOn(port: string, pitch: number, velocity: number, time: number) {
  send(port, [0x90, pitch, velocity], time)
}

function noteOff(port: string, pitch: number, time: number) {
  send(port, [0x80, pitch, 0], time)
}

function arm(engine: FakeEngine) {
  engine.status = 'recording'
  engine.emit()
}

function finish(engine: FakeEngine) {
  engine.status = 'stopped'
  engine.emit()
}

function samplesAt(store: ProjectStore, beat: number) {
  return beat * (store.project.sampleRate * 60) / store.project.tempo
}

function savedNotes(store: ProjectStore, trackId: string) {
  return store.project.tracks
    .find((track) => track.id === trackId)?.midiClips
    .flatMap((clip) => clip.notes.map((note) => ({
      name: clip.name,
      start: clip.startBeat + note.startBeat,
      duration: note.durationBeats,
      pitch: note.pitch,
      velocity: note.velocity,
    }))) ?? []
}

let live: { host: MidiHost; engine: FakeEngine } | null = null

afterEach(() => {
  if (live) {
    live.engine.status = 'stopped'
    live.engine.emit()
    live.host.stop()
  }
  live = null
  clearCapture()
  ports.messages.length = 0
  ports.ends.length = 0
  vi.restoreAllMocks()
})

function open(tracks: Track[], selected: string) {
  live?.host.stop()
  const rig = session(tracks)
  live = rig
  rig.store.selectTrack(trackByName(rig.store, selected).id)
  return rig
}

describe('hardware MIDI record destinations', () => {
  it('sounds the selected drums and saves the take on the armed keys', () => {
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const rig = open([drums, keys], 'Drums')
    const drumId = trackByName(rig.store, 'Drums').id
    const keysId = trackByName(rig.store, 'Keys').id
    arm(rig.engine)
    noteOn('portA', 60, 100, STAMP)
    noteOff('portA', 60, STAMP + 500)
    rig.engine.timeline = samplesAt(rig.store, 8)
    finish(rig.engine)

    expect(rig.engine.sounded).toEqual([`${drumId}:60`])
    expect(rig.engine.released).toEqual([`${drumId}:60`])
    expect(savedNotes(rig.store, drumId)).toEqual([])
    const notes = savedNotes(rig.store, keysId)
    expect(notes).toEqual([{
      name: 'MIDI take',
      start: 4,
      duration: 1,
      pitch: 60,
      velocity: 100 / 127,
    }])
    expect(rig.store.project.tracks.find((track) => track.id === keysId)?.midiClips).toHaveLength(1)

    const saved = JSON.parse(JSON.stringify(rig.store.project)) as Project
    rig.store.undo()
    expect(savedNotes(rig.store, keysId)).toEqual([])
    const reopened = new ProjectStore(saved)
    expect(savedNotes(reopened, keysId)).toEqual(notes)
  })

  it('records the same track once, and a retrigger does not stack two copies', () => {
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const rig = open([keys], 'Keys')
    const keysId = trackByName(rig.store, 'Keys').id
    arm(rig.engine)
    noteOn('portA', 60, 100, STAMP)
    noteOn('portA', 60, 80, STAMP + 500)
    noteOff('portA', 60, STAMP + 1000)
    finish(rig.engine)

    expect(rig.engine.sounded).toEqual([`${keysId}:60`, `${keysId}:60`])
    expect(savedNotes(rig.store, keysId).map((note) => [note.pitch, note.start, note.duration])).toEqual([
      [60, 4, 1],
      [60, 5, 1],
    ])
    expect(rig.store.project.tracks.find((track) => track.id === keysId)?.midiClips).toHaveLength(1)
  })

  it('gives every armed track on the port its own notes and does not sound the unselected ones', () => {
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: false, input: 'midi' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const bass = makeTrack({ name: 'Bass', type: 'midi', armed: true, input: 'midi:portA' })
    const rig = open([drums, keys, bass], 'Drums')
    const drumId = trackByName(rig.store, 'Drums').id
    const keysId = trackByName(rig.store, 'Keys').id
    const bassId = trackByName(rig.store, 'Bass').id
    arm(rig.engine)
    noteOn('portA', 67, 90, STAMP)
    noteOff('portA', 67, STAMP + 500)
    finish(rig.engine)

    expect(rig.engine.sounded).toEqual([`${drumId}:67`])
    expect(rig.engine.released).toEqual([`${drumId}:67`])
    expect(savedNotes(rig.store, drumId)).toEqual([])
    for (const id of [keysId, bassId]) {
      expect(savedNotes(rig.store, id).map((note) => note.pitch)).toEqual([67])
      expect(rig.engine.sounded.some((item) => item.startsWith(`${id}:`))).toBe(false)
      expect(rig.engine.released.some((item) => item.startsWith(`${id}:`))).toBe(false)
    }
  })

  it('lets an exact port beat a generic midi input', () => {
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const bass = makeTrack({ name: 'Bass', type: 'midi', armed: true, input: 'midi' })
    const rig = open([drums, keys, bass], 'Drums')
    const drumId = trackByName(rig.store, 'Drums').id
    const keysId = trackByName(rig.store, 'Keys').id
    const bassId = trackByName(rig.store, 'Bass').id
    arm(rig.engine)
    noteOn('portA', 60, 100, STAMP)
    noteOff('portA', 60, STAMP + 500)
    noteOn('portB', 62, 100, STAMP)
    noteOff('portB', 62, STAMP + 500)
    finish(rig.engine)

    expect(rig.engine.sounded).toEqual([`${drumId}:60`, `${drumId}:62`])
    expect(savedNotes(rig.store, keysId).map((note) => note.pitch)).toEqual([60])
    expect(savedNotes(rig.store, bassId).map((note) => note.pitch)).toEqual([62])
    expect(savedNotes(rig.store, drumId).map((note) => note.pitch)).toEqual([62])
    expect(rig.engine.sounded.filter((item) => item.startsWith(`${drumId}:`))).toHaveLength(2)
  })

  it('ends one overlapping note and finishes the other when recording stops', () => {
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const rig = open([drums, keys], 'Drums')
    const drumId = trackByName(rig.store, 'Drums').id
    const keysId = trackByName(rig.store, 'Keys').id
    arm(rig.engine)
    noteOn('portA', 60, 100, STAMP)
    noteOn('portA', 64, 90, STAMP + 250)
    noteOff('portA', 60, STAMP + 500)
    expect(savedNotes(rig.store, keysId)).toEqual([])
    expect(rig.engine.released).toEqual([`${drumId}:60`])
    rig.engine.timeline = samplesAt(rig.store, 6)
    finish(rig.engine)

    expect(savedNotes(rig.store, keysId).map((note) => [note.pitch, note.start, note.duration])).toEqual([
      [60, 4, 1],
      [64, 4.5, 1.5],
    ])
    expect(rig.engine.released).toEqual([`${drumId}:60`, `${drumId}:64`])
    finish(rig.engine)
    noteOff('portA', 64, STAMP + 1000)
    expect(savedNotes(rig.store, keysId)).toHaveLength(2)
    expect(rig.store.project.tracks.find((track) => track.id === keysId)?.midiClips).toHaveLength(1)
  })

  it('releases a held note when recording stops and does not leave it open', () => {
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const rig = open([drums, keys], 'Drums')
    const drumId = trackByName(rig.store, 'Drums').id
    const keysId = trackByName(rig.store, 'Keys').id
    arm(rig.engine)
    noteOn('portA', 60, 110, STAMP)
    rig.engine.timeline = samplesAt(rig.store, 6)
    finish(rig.engine)

    expect(savedNotes(rig.store, keysId)).toEqual([{
      name: 'MIDI take',
      start: 4,
      duration: 2,
      pitch: 60,
      velocity: 110 / 127,
    }])
    expect(rig.engine.released).toEqual([`${drumId}:60`])
    noteOff('portA', 60, STAMP + 1500)
    finish(rig.engine)
    expect(savedNotes(rig.store, keysId)).toHaveLength(1)
  })

  it('ends notes from a disconnected port and keeps the other port until stop', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(STAMP)
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const bass = makeTrack({ name: 'Bass', type: 'midi', armed: true, input: 'midi' })
    const rig = open([drums, keys, bass], 'Drums')
    const drumId = trackByName(rig.store, 'Drums').id
    const keysId = trackByName(rig.store, 'Keys').id
    const bassId = trackByName(rig.store, 'Bass').id
    arm(rig.engine)
    noteOn('portA', 60, 100, STAMP)
    noteOn('portB', 62, 100, STAMP)
    now.mockReturnValue(STAMP + 500)
    ports.ends.at(-1)?.({ id: 'portA', name: 'portA' })
    expect(savedNotes(rig.store, keysId)).toEqual([])
    expect(rig.engine.released).toEqual([`${drumId}:60`])
    rig.engine.timeline = samplesAt(rig.store, 8)
    finish(rig.engine)

    expect(savedNotes(rig.store, keysId).map((note) => [note.pitch, note.start, note.duration])).toEqual([[60, 4, 1]])
    expect(savedNotes(rig.store, bassId).map((note) => [note.pitch, note.start, note.duration])).toEqual([[62, 4, 4]])
    expect(savedNotes(rig.store, drumId).map((note) => [note.pitch, note.start, note.duration])).toEqual([[62, 4, 4]])
    expect(rig.engine.sounded).toEqual([`${drumId}:60`, `${drumId}:62`])
    expect(rig.engine.released).toContain(`${drumId}:62`)
  })

  it('commits a held note when the listener stops and does not write it twice', () => {
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const rig = open([drums, keys], 'Drums')
    const drumId = trackByName(rig.store, 'Drums').id
    const keysId = trackByName(rig.store, 'Keys').id
    arm(rig.engine)
    noteOn('portA', 60, 100, STAMP)
    rig.engine.timeline = samplesAt(rig.store, 6)
    rig.host.stop()
    rig.host.stop()
    expect(savedNotes(rig.store, keysId).map((note) => [note.pitch, note.duration])).toEqual([[60, 2]])
    expect(savedNotes(rig.store, drumId)).toEqual([])
    expect(rig.engine.released).toEqual([`${drumId}:60`])
    expect(rig.engine.sounded).toEqual([`${drumId}:60`])
  })

  it('does not create a take when recording is off', () => {
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const rig = open([drums, keys], 'Drums')
    const drumId = trackByName(rig.store, 'Drums').id
    const keysId = trackByName(rig.store, 'Keys').id
    noteOn('portA', 60, 100, STAMP)
    noteOff('portA', 60, STAMP + 500)
    expect(rig.engine.sounded).toEqual([`${drumId}:60`])
    arm(rig.engine)
    finish(rig.engine)
    expect(savedNotes(rig.store, keysId)).toEqual([])
    expect(savedNotes(rig.store, drumId)).toEqual([])

    const quiet = makeTrack({ name: 'Drums', type: 'midi', armed: false, input: 'midi' })
    const idle = makeTrack({ name: 'Keys', type: 'midi', armed: false, input: 'midi:portA' })
    const second = open([quiet, idle], 'Drums')
    arm(second.engine)
    noteOn('portA', 64, 100, STAMP)
    noteOff('portA', 64, STAMP + 500)
    finish(second.engine)
    expect(second.engine.sounded).toEqual([`${trackByName(second.store, 'Drums').id}:64`])
    expect(savedNotes(second.store, trackByName(second.store, 'Keys').id)).toEqual([])
    expect(savedNotes(second.store, trackByName(second.store, 'Drums').id)).toEqual([])
  })

  it('stores a scaler transposition on the armed track without sounding that track', () => {
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const rig = open([drums, keys], 'Drums')
    const keysId = trackByName(rig.store, 'Keys').id
    const drumId = trackByName(rig.store, 'Drums').id
    rig.store.setTrackInstrument(keysId, 'synth')
    rig.store.setTrackInstrument(keysId, 'scaler')
    rig.store.setScaler(keysId, { keysLock: 'one-finger', output: 'audio', recordSource: 'output' })
    rig.store.selectTrack(drumId)
    const plan = planLive(rig.store.project, keysId, 60, 96 / 127)
    expect(plan?.record.length).toBeGreaterThan(1)

    arm(rig.engine)
    noteOn('portA', 60, 96, STAMP)
    noteOff('portA', 60, STAMP + 500)
    finish(rig.engine)

    expect(rig.engine.sounded).toEqual([`${drumId}:60`])
    const pitches = savedNotes(rig.store, keysId).map((note) => note.pitch)
    expect(pitches).toEqual([...(plan?.record ?? [])].sort((a, b) => a - b))
    expect(pitches.length).toBe(new Set(plan?.record).size)
    expect(rig.engine.sounded.some((item) => item.startsWith(`${keysId}:`))).toBe(false)
    expect(rig.engine.released.some((item) => item.startsWith(`${keysId}:`))).toBe(false)
  })

  it('keeps one scaler chord when the selected track is the armed track', () => {
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const rig = open([keys], 'Keys')
    const keysId = trackByName(rig.store, 'Keys').id
    rig.store.setTrackInstrument(keysId, 'synth')
    rig.store.setTrackInstrument(keysId, 'scaler')
    rig.store.setScaler(keysId, { keysLock: 'one-finger', output: 'audio', recordSource: 'output' })
    rig.store.selectTrack(keysId)
    const velocity = 96 / 127
    const plan = planLive(rig.store.project, keysId, 60, velocity)
    expect(plan && plan.play.length).toBeGreaterThan(1)

    arm(rig.engine)
    noteOn('portA', 60, 96, STAMP)
    noteOff('portA', 60, STAMP + 500)
    finish(rig.engine)

    expect(rig.engine.sounded).toEqual(plan?.play.map((note) => `${note.trackId}:${note.pitch}`))
    const recorded = [...new Set(plan?.record ?? [])].sort((a, b) => a - b)
    expect(savedNotes(rig.store, keysId).map((note) => note.pitch)).toEqual(recorded)
    expect(rig.store.project.tracks.find((track) => track.id === keysId)?.midiClips).toHaveLength(1)
  })
})
