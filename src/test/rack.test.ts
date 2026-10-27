import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import {
  allocateVoice,
  applyMod,
  audioCycle,
  cloneRack,
  defaultRack,
  makeDevice,
  nextArp,
  zoneFor,
  type VoiceRef,
} from '../model/rack'
import { RackRuntime, renderNotes } from '../audio/rack/dsp'
import { createEmptyProject } from '../model/types'

function rms(channel: Float32Array) {
  let sum = 0
  for (const sample of channel) sum += sample * sample
  return Math.sqrt(sum / channel.length)
}

function finite(channels: Float32Array[]) {
  for (const channel of channels) {
    for (const sample of channel) {
      expect(Number.isFinite(sample)).toBe(true)
      expect(Math.abs(sample)).toBeLessThanOrEqual(1.5)
    }
  }
}

describe('rack', () => {
  it('steals the oldest voice at the polyphony limit', () => {
    const voices: VoiceRef[] = []
    allocateVoice(voices, 60, 2)
    allocateVoice(voices, 64, 2)
    allocateVoice(voices, 67, 2)
    expect(voices).toHaveLength(2)
    expect(voices.map((voice) => voice.note).sort()).toEqual([64, 67])
    expect(voices.every((voice) => voice.active)).toBe(true)
  })

  it('picks the closest sampler zone and ignores the other range', () => {
    const low = { id: 'a', bufferId: 'low', root: 48, lo: 0, hi: 59, loopStart: 0, loopEnd: 1, tune: 0 }
    const high = { id: 'b', bufferId: 'high', root: 72, lo: 60, hi: 96, loopStart: 0, loopEnd: 1, tune: 0 }
    expect(zoneFor([low, high], 50)?.bufferId).toBe('low')
    expect(zoneFor([low, high], 72)?.bufferId).toBe('high')
    expect(zoneFor([low, high], 100)).toBeNull()
  })

  it('applies a modulation cable across the parameter range', () => {
    expect(applyMod(200, 1, 1, 40, 8000)).toBe(8000)
    expect(applyMod(200, 0, 1, 40, 8000)).toBe(200)
    expect(applyMod(1000, -1, 1, 40, 8000)).toBe(40)
  })

  it('rejects an audio feedback loop and still renders', () => {
    const a = makeDevice('delay')
    const b = makeDevice('reverb')
    const cables = [
      { id: '1', from: a.id, fromPort: 'audio', to: b.id, toPort: 'audio', amount: 1 },
      { id: '2', from: b.id, fromPort: 'audio', to: a.id, toPort: 'audio', amount: 1 },
    ]
    expect(audioCycle(cables)).toBe(true)
    const rack = { devices: [makeDevice('sub'), a, b], cables, polyphony: 4 }
    const runtime = new RackRuntime(48000)
    runtime.note(60, 0.8, 4)
    finite(runtime.render(rack, 256, 120, 'full', new Map()))
  })

  it('makes a sound from the default subtractive patch with no cables', () => {
    const rack = defaultRack()
    const runtime = new RackRuntime(48000)
    runtime.note(69, 0.9, 8)
    const silent = rms(runtime.render(rack, 64, 120, 'full', new Map())[0])
    const sounding = rms(runtime.render(rack, 4000, 120, 'full', new Map())[0])
    expect(silent).toBeGreaterThan(0.001)
    expect(sounding).toBeGreaterThan(0.02)
  })

  it('changes the tone when a sequencer cable opens the filter', () => {
    const sub = makeDevice('sub')
    sub.params.cutoff = 180
    sub.params.famt = 0
    const seq = makeDevice('seq')
    for (let i = 0; i < 8; i++) seq.params[`s${i}`] = 1
    const open = {
      devices: [seq, sub],
      cables: [{ id: 'c', from: seq.id, fromPort: 'cv', to: sub.id, toPort: 'cutoff', amount: 1 }],
      polyphony: 2,
    }
    const closed = { devices: [seq, { ...sub, params: { ...sub.params } }], cables: [], polyphony: 2 }
    const run = (rack: typeof open) => {
      const runtime = new RackRuntime(48000)
      runtime.note(69, 0.8, 2)
      return runtime.render(rack, 2000, 120, 'full', new Map())[0]
    }
    let diff = 0
    const a = run(open)
    const b = run(closed)
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]))
    expect(diff).toBeGreaterThan(0.02)
    finite([a, b])
  })

  it('walks an arp up the held chord', () => {
    expect(nextArp([67, 60, 64], 0, 0, 1)).toBe(60)
    expect(nextArp([67, 60, 64], 1, 0, 1)).toBe(64)
    expect(nextArp([67, 60, 64], 2, 0, 1)).toBe(67)
    expect(nextArp([60, 64], 1, 1, 1)).toBe(60)
  })

  it('triggers a drum on the programmed step and stays finite', () => {
    const drum = makeDevice('drum')
    drum.pattern = Array(16).fill(0)
    drum.pattern[0] = 1
    const rack = { devices: [drum], cables: [], polyphony: 1 }
    const hit = new RackRuntime(48000).render(rack, 800, 120, 'full', new Map())[0]
    drum.pattern[0] = 0
    const rest = new RackRuntime(48000).render(rack, 800, 120, 'full', new Map())[0]
    expect(rms(hit)).toBeGreaterThan(rms(rest))
    finite([hit])
  })

  it('loops a sampler zone instead of running off the buffer', () => {
    const sampler = makeDevice('sampler')
    const data = new Float32Array(100)
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * i) / 25)
    sampler.zones = [{ id: 'z', bufferId: 'buf', root: 60, lo: 0, hi: 127, loopStart: 0, loopEnd: 1, tune: 0 }]
    sampler.params.loop = 1
    sampler.params.attack = 1
    sampler.params.sustain = 1
    const runtime = new RackRuntime(48000)
    runtime.note(60, 1, 2)
    const rendered = runtime.render({ devices: [sampler], cables: [], polyphony: 2 }, 3000, 120, 'full', new Map([['buf', { sampleRate: 48000, channels: [data] }]]))
    expect(rms(rendered[0])).toBeGreaterThan(0.02)
    finite(rendered)
  })

  it('matches a block render to the same notes rendered in smaller blocks', () => {
    const rack = defaultRack()
    const whole = new RackRuntime(48000)
    whole.note(60, 0.7, rack.polyphony)
    const full = whole.render(rack, 256, 120, 'full', new Map())[0]
    const part = new RackRuntime(48000)
    part.note(60, 0.7, rack.polyphony)
    const joined = new Float32Array(256)
    joined.set(part.render(rack, 128, 120, 'full', new Map())[0], 0)
    joined.set(part.render(rack, 128, 120, 'full', new Map())[0], 128)
    let diff = 0
    for (let i = 0; i < joined.length; i++) diff = Math.max(diff, Math.abs(joined[i] - full[i]))
    expect(diff).toBeLessThan(1e-4)
    finite(renderNotes(rack, [{ sample: 0, pitch: 60, vel: 0.7 }, { sample: 200, pitch: 60, vel: 0 }], 48000, 120, 400))
  })

  it('saves a combinator patch and reloads it onto the track', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addDevice(track.id, 'delay')
    store.saveRackPatch(track.id, 'Stack')
    const before = track.rack!.devices.map((device) => device.kind)
    store.removeDevice(track.id, track.rack!.devices[1].id)
    store.loadRackPatch(track.id, 'Stack')
    expect(store.track(track.id)!.rack!.devices.map((device) => device.kind)).toEqual(before)
    const copy = cloneRack(track.rack!)
    expect(copy.devices[0].id).not.toBe(track.rack!.devices[0].id)
    expect(JSON.parse(JSON.stringify(store.project)).rackPatches[0].name).toBe('Stack')
  })

  it('keeps every device finite on a note and on silence', () => {
    for (const kind of ['sub', 'fm', 'wave', 'sampler', 'drum', 'eq', 'comp', 'delay', 'reverb', 'chorus', 'dist', 'filter'] as const) {
      const device = makeDevice(kind)
      const runtime = new RackRuntime(44100)
      if (kind === 'sub' || kind === 'fm' || kind === 'sampler') runtime.note(57, 0.6, 4)
      const rendered = runtime.render({ devices: [device], cables: [], polyphony: 4 }, 512, 100, 'eco', new Map())
      finite(rendered)
    }
  })
})
