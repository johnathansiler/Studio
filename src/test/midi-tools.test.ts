import { describe, expect, it } from 'vitest'
import { collectRecordInputs } from '../midi/inputs'
import {
  LiveCaptureBuffer,
  LiveMidiChain,
  applyMapped,
  applyMidiChain,
  bindingFromMessage,
  chainContext,
  clearMap,
  clockIntervalMs,
  defaultFx,
  describeMap,
  describeWrite,
  hidesHardwareMidi,
  midiClockBytes,
  midiDestinations,
  noteBytes,
  parseMidi,
  planAudioRoutes,
  planMidiRoutes,
  prepareClipNotes,
  slotFromNode,
  suggestRouting,
  tracksForPort,
  upsertMap,
  type ChainContext,
} from '../model/midiTools'
import { migrateProject } from '../model/schema'
import { createEmptyProject, makeTrack, type MidiNote } from '../model/types'
import { selectMidiMaps } from '../state/select'
import { ProjectStore } from '../state/store'

const ctx: ChainContext = { root: 0, scale: 'ionian', seed: 3 }

function note(pitch: number, start = 0, duration = 1, velocity = 0.8): MidiNote {
  return { id: `n${pitch}-${start}`, pitch, startBeat: start, durationBeats: duration, velocity }
}

describe('MIDI effects run before the instrument', () => {
  it('locks notes to the scale, then builds the chord', () => {
    const scale = defaultFx('scale', 'scale')
    const chord = defaultFx('chord', 'chord')
    const out = applyMidiChain([note(66)], [scale, chord], ctx)
    expect(out.map((item) => item.pitch)).toEqual([65, 69, 72])
  })

  it('walks a held chord up across octaves', () => {
    const arp = defaultFx('arp', 'arp')
    arp.params = { rate: 1, direction: 0, octaves: 2, gate: 0.5 }
    const out = applyMidiChain([note(60, 0, 3), note(64, 0, 3)], [arp], ctx)
    expect(out.map((item) => item.pitch)).toEqual([60, 64, 72])
    expect(out.every((item) => item.durationBeats === 0.5)).toBe(true)
  })

  it('repeats inside the note and shapes velocity', () => {
    const repeat = defaultFx('repeat', 'repeat')
    repeat.params = { rate: 0.5, gate: 0.5 }
    const curve = defaultFx('velocity', 'curve')
    curve.params = { curve: 2, amount: 1, floor: 0, ceiling: 1 }
    const repeated = applyMidiChain([note(60, 0, 1, 0.5)], [repeat], ctx)
    expect(repeated.map((item) => item.startBeat)).toEqual([0, 0.5])
    const shaped = applyMidiChain([note(60, 0, 1, 0.25)], [curve], ctx)
    expect(shaped[0].velocity).toBeCloseTo(0.0625)
    const soft = defaultFx('velocity', 'soft')
    soft.params = { curve: 1, amount: 1, floor: 0, ceiling: 1 }
    expect(applyMidiChain([note(60, 0, 1, 0.25)], [soft], ctx)[0].velocity).toBeCloseTo(0.5)
  })

  it('humanizes the same way every time and leaves the source notes alone', () => {
    const human = defaultFx('humanize', 'human')
    human.params = { time: 0.1, vel: 0.2 }
    const source = [note(60), note(67, 1)]
    const once = applyMidiChain(source, [human], ctx)
    const twice = applyMidiChain(source, [human], ctx)
    expect(once).toEqual(twice)
    expect(once[0].startBeat).not.toBe(source[0].startBeat)
    expect(source[0].startBeat).toBe(0)
    expect(once[0].startBeat).toBeGreaterThanOrEqual(0)
    expect(once[0].startBeat).toBeLessThanOrEqual(0.1)
  })

  it('plays an empty chain unchanged and drops muted notes', () => {
    const source = [note(62), { ...note(63), muted: true }]
    const out = applyMidiChain(source, [], ctx)
    expect(out.map((item) => item.pitch)).toEqual([62])
    expect(source[1].muted).toBe(true)
  })
})

describe('MIDI learn', () => {
  it('maps a CC onto a fader and a note onto a toggle', () => {
    const slot = slotFromNode({ trackId: 'trk', range: true, className: 'pan' })
    expect(slot).toMatchObject({ target: 'track:trk:pan', min: -1, max: 1 })
    const volume = slotFromNode({ trackId: 'keys', range: true })!
    const cc = parseMidi([0xb0, 7, 127])!
    const entry = bindingFromMessage(volume, cc, 'map1')
    expect(describeMap(entry)).toBe('CC 7 · ch 1')
    expect(applyMapped(entry, cc, 0)).toBeCloseTo(1.25)
    expect(applyMapped(entry, { ...cc, value: 0 }, 0)).toBe(0)
    const mute = slotFromNode({ trackId: 'keys', text: 'M' })!
    const noteOn = parseMidi([0x90, 36, 100])!
    const toggle = bindingFromMessage(mute, noteOn, 'map2')
    expect(applyMapped(toggle, noteOn, 0)).toBe(1)
    expect(applyMapped(toggle, noteOn, 1)).toBe(0)
    expect(applyMapped(toggle, { ...noteOn, kind: 'note-off', value: 0 }, 1)).toBeNull()
    const maps = clearMap(upsertMap(upsertMap([], entry), { ...entry, id: 'map3', target: 'master:volume', number: 8 }), 'map3')
    expect(maps.map((item) => item.number)).toEqual([7])
    expect(describeWrite('track:keys:arm', 1)).toEqual({ kind: 'track', id: 'keys', key: 'armed', value: 1 })
  })

  it('keeps mappings on the project and undo removes them', () => {
    const store = new ProjectStore(createEmptyProject())
    store.armLearn({ target: 'master:volume', label: 'Master', min: 0, max: 1.25, toggle: false })
    expect(store.completeLearn({ kind: 'cc', channel: 1, number: 11, value: 64 })).toBe(true)
    expect(selectMidiMaps(store.project)[0].label).toBe('Master')
    store.applyMidiControl('master:volume', 0.4, true)
    expect(store.project.masterVolume).toBeCloseTo(0.4)
    store.undo()
    expect(store.project.masterVolume).toBeCloseTo(0.9)
    const saved = migrateProject(JSON.parse(JSON.stringify(store.project)))
    expect(saved.midiMaps?.[0].number).toBe(11)
    store.clearMidiMaps()
    expect(selectMidiMaps(store.project)).toEqual([])
  })
})

describe('live capture and hardware output', () => {
  it('turns the recent phrase into a clip and ignores older playing', () => {
    const buffer = new LiveCaptureBuffer()
    buffer.noteOn('keys', 60, 0, 0.5)
    buffer.noteOff('keys', 60, 1)
    buffer.noteOn('keys', 64, 10, 0.9)
    const clip = buffer.clip('keys', 11, 4)
    expect(clip?.notes.map((item) => item.pitch)).toEqual([64])
    expect(clip?.startBeat).toBe(10)
    expect(clip?.notes[0].durationBeats).toBeGreaterThan(0.5)
    buffer.noteOff('keys', 64, 12)
    const closed = buffer.clip('keys', 12, 4)
    expect(closed?.notes[0].durationBeats).toBeCloseTo(2)
  })

  it('sends note and clock bytes', () => {
    expect(noteBytes(true, 1, 60, 100)).toEqual([0x91, 60, 100])
    expect(midiClockBytes('start')).toEqual([0xfa])
    expect(midiClockBytes('pulse')).toEqual([0xf8])
    expect(clockIntervalMs(120)).toBeCloseTo(60000 / 120 / 24)
  })

  it('steps a live arp without touching the clip', async () => {
    const arp = defaultFx('arp', 'live')
    arp.params = { rate: 0.5, direction: 0, octaves: 1, gate: 0.5 }
    let now = 0
    const events: { on: boolean; pitch: number }[] = []
    const pending: { at: number; fn: () => void; dead: boolean }[] = []
    const chain = new LiveMidiChain(
      (ms, fn) => {
        const item = { at: now + ms, fn, dead: false }
        pending.push(item)
        return () => {
          item.dead = true
        }
      },
      () => now,
      {
        on: (pitch) => events.push({ on: true, pitch }),
        off: (pitch) => events.push({ on: false, pitch }),
      },
    )
    chain.configure(() => [arp], () => ctx, () => 120)
    chain.noteOn(60, 0.8)
    chain.noteOn(64, 0.8)
    const flush = (ms: number) => {
      const until = now + ms
      for (;;) {
        const next = pending.filter((item) => !item.dead && item.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        next.dead = true
        now = next.at
        next.fn()
      }
      now = until
    }
    flush(500)
    chain.noteOff(60)
    chain.noteOff(64)
    const ons = events.filter((event) => event.on).map((event) => event.pitch)
    expect(ons[0]).toBe(60)
    expect(ons).toContain(64)
    expect(events.some((event) => !event.on)).toBe(true)
  })
})

describe('multi-input recording', () => {
  it('gives each armed input its own track', async () => {
    const vocal = makeTrack({ name: 'Vocal', type: 'audio', armed: true, input: 'mic:0' })
    const guitar = makeTrack({ name: 'Guitar', type: 'audio', armed: true, input: 'dev:abc:1' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    const idle = makeTrack({ name: 'Idle', type: 'audio', armed: false, input: 'mic:3' })
    const tracks = [vocal, guitar, keys, drums, idle]
    expect(planAudioRoutes(tracks).map((route) => route.trackId)).toEqual([vocal.id, guitar.id])
    expect(planMidiRoutes(tracks).map((route) => route.portId)).toEqual(['portA', null])
    expect(tracksForPort(tracks, 'portA').map((track) => track.id)).toEqual([keys.id])
    expect(tracksForPort(tracks, 'portB').map((track) => track.id)).toEqual([drums.id])
    expect(midiDestinations(tracks, 'portA', null, true).record).toEqual([keys.id])
    let opened = 0
    const inputs = await collectRecordInputs({
      tracks,
      takeId: 'take',
      localStream: () => null,
      remoteStream: () => null,
      setLocalMic: () => undefined,
      openMic: async () => {
        opened += 1
        return { getAudioTracks: () => [] } as unknown as MediaStream
      },
    })
    expect(opened).toBe(2)
    expect(inputs.map((input) => [input.key, input.channel])).toEqual([
      [vocal.id, 0],
      [guitar.id, 1],
    ])
    const routes = suggestRouting(tracks, [
      { id: 'default', label: 'Mic', kind: 'audio', channels: 2 },
      { id: 'keys-port', label: 'Keys', kind: 'midi' },
    ])
    expect(routes.map((route) => route.input)).toEqual(['mic:0', 'mic:1', 'midi:keys-port'])
  })

  it('prints a take onto the armed instrument and undoes it', () => {
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.addMidiFx(keys.id, 'chord')
    store.placeMidiTake(keys.id, 4, [{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.7 }], 'MIDI take')
    const clip = store.project.tracks.find((track) => track.id === keys.id)!.midiClips.at(-1)!
    expect(clip.startBeat).toBe(4)
    store.printMidiFx(keys.id, clip.id)
    const printed = store.project.tracks.find((track) => track.id === keys.id)!.midiClips.at(-1)!
    expect(printed.notes.map((item) => item.pitch)).toEqual([60, 64, 67])
    store.undo()
    const restored = store.project.tracks.find((track) => track.id === keys.id)!.midiClips.at(-1)!
    expect(restored.notes.map((item) => item.pitch)).toEqual([60])
    const project = createEmptyProject()
    project.tracks[2].midiFx = [defaultFx('scale', 's')]
    const chain = prepareClipNotes(project, project.tracks[2], {
      id: 'clip',
      name: 'Keys',
      startBeat: 0,
      durationBeats: 1,
      notes: [note(66)],
    })
    expect(chain[0].pitch).toBe(65)
    expect(project.tracks[2].midiClips).toEqual([])
  })
})

describe('iPhone hides hardware MIDI', () => {
  it('hides MIDI on iPhone and keeps it on iPad and Android', () => {
    expect(hidesHardwareMidi('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true)
    expect(hidesHardwareMidi('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)')).toBe(true)
    expect(hidesHardwareMidi('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(false)
    expect(hidesHardwareMidi('Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36')).toBe(false)
    expect(chainContext(createEmptyProject(), 'clip').scale).toBe('ionian')
  })
})
