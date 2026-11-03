import { describe, expect, it } from 'vitest'
import { createCore } from '../audio/plugins/dispatch'
import { CORE_IDS, type CoreId } from '../audio/plugins/ids'
import { processChain } from '../audio/plugins/chain'
import { renderSamplerSpan } from '../audio/plugins/sampler'
import { renderGraph, type GraphTrack } from '../audio/renderGraph'
import { createPlugin } from '../audio/plugins/catalog'
import type { BlockContext } from '../audio/plugins/types'
import { padPitchForKey, REPEAT_CHOICES, stepRepeatRate } from '../instruments/mpc/model'
import { createEmptyProject, makeTrack } from '../model/types'
import { ProjectStore } from '../state/store'
import { playScalerLive } from '../instruments/scaler/live'
import { midiDestinations } from '../model/midiTools'
import type { Processor } from '../audio/plugins/types'

const rate = 48000

function tone(freq: number, seconds: number, amp = 0.45) {
  const n = Math.floor(rate * seconds)
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return data
}

function rms(data: Float32Array) {
  let sum = 0
  const start = Math.min(data.length, Math.floor(rate * 0.02))
  const count = Math.max(1, data.length - start)
  for (let i = start; i < data.length; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / count)
}

function energy(data: Float32Array) {
  return rms(data)
}

function context(): BlockContext {
  return {
    sampleRate: rate,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full',
    offline: true,
  }
}

function renderPlugin(id: CoreId, input: Float32Array, params: Record<string, number>, enabled: boolean) {
  const processor = createCore(id, rate)
  const output = [new Float32Array(input.length), new Float32Array(input.length)]
  const block = 128
  for (let offset = 0; offset < input.length; offset += block) {
    const count = Math.min(block, input.length - offset)
    const sliceIn = [input.subarray(offset, offset + count), input.subarray(offset, offset + count)]
    const sliceOut = [output[0].subarray(offset, offset + count), output[1].subarray(offset, offset + count)]
    processChain(
      [{ id: 'fx', pluginId: id, enabled, wet: 1, params, failed: false, sidechain: '', processor }],
      sliceIn,
      sliceOut,
      { ...context(), sampleTime: offset },
    )
  }
  return output[0]
}

function graphTrack(id: string, amp: number, patch: Partial<GraphTrack> = {}): GraphTrack {
  const buffer = tone(220, 0.25, amp)
  return {
    id,
    type: 'audio',
    input: 'none',
    buffer: [buffer, buffer.slice()],
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

function render(tracks: GraphTrack[], masterVolume = 1) {
  return renderGraph({
    tracks,
    masterPlugins: [],
    masterVolume,
    sampleRate: rate,
    tempo: 120,
    length: tracks[0].buffer[0].length,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    automation: [],
    offline: true,
    create: (): Processor => ({
      latencySamples: 0,
      reset() {},
      process(input, output) {
        output[0].set(input[0])
        output[1].set(input[1] ?? input[0])
      },
    }),
  })
}

describe('note repeat rate order', () => {
  it('steps 1/4, 1/4T, 1/8, 1/8T, 1/16, 1/16T, 1/32, 1/32T', () => {
    expect(REPEAT_CHOICES.map((choice) => choice.short)).toEqual(['1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32', '1/32T'])
    let current = '1/4'
    const seen = [current]
    for (let i = 0; i < REPEAT_CHOICES.length - 1; i++) {
      current = stepRepeatRate(current, 1)
      seen.push(current)
    }
    expect(seen).toEqual(REPEAT_CHOICES.map((choice) => choice.id))
    expect(stepRepeatRate('1/32t', 1)).toBe('1/4')
    expect(stepRepeatRate('1/4', -1)).toBe('1/32t')
    expect(stepRepeatRate('nope', 1)).toBe('1/16t')
  })

  it('maps a keyboard note onto a pad pitch', () => {
    const bank = [{ pitch: 36 }, { pitch: 38 }, { pitch: 42 }]
    expect(padPitchForKey(bank, 36)).toBe(36)
    expect(padPitchForKey(bank, 42.2)).toBe(42)
    expect(padPitchForKey(bank, 40)).toBe(bank[(40 - 36) % 3].pitch)
    expect(padPitchForKey([], 64)).toBe(64)
  })
})

describe('mix signal', () => {
  it('sends every source through the fader, pan, mute, solo, send, and master', () => {
    const open = render([graphTrack('vocal', 0.5), graphTrack('music', 0.2)])
    const quiet = render([graphTrack('vocal', 0.5, { volume: 0.2 }), graphTrack('music', 0)])
    const muted = render([graphTrack('vocal', 0.5, { mute: true }), graphTrack('music', 0)])
    const solo = render([graphTrack('vocal', 0.5, { solo: true }), graphTrack('music', 0.5)])
    const panned = render([graphTrack('vocal', 0.5, { pan: -1 })])
    const master = render([graphTrack('vocal', 0.5)], 0.25)
    const sent = render([
      graphTrack('vocal', 0.4, { output: 'bus', sends: [{ id: 's', busId: 'verb', gain: 1, preFader: false, enabled: true }] }),
      graphTrack('verb', 0, { type: 'bus' }),
      graphTrack('bus', 0, { type: 'bus' }),
    ])
    expect(energy(open.master[0]) + energy(open.master[1])).toBeGreaterThan(0.05)
    expect(energy(quiet.master[0])).toBeLessThan(energy(open.master[0]) * 0.7)
    expect(energy(muted.master[0]) + energy(muted.master[1])).toBeLessThan(0.001)
    expect(energy(solo.master[0])).toBeGreaterThan(0.05)
    expect(energy(solo.master[0])).toBeLessThan(energy(open.master[0]))
    expect(energy(panned.master[0])).toBeGreaterThan(0.05)
    expect(energy(panned.master[1])).toBeLessThan(energy(panned.master[0]) * 0.05)
    expect(energy(master.master[0])).toBeLessThan(energy(render([graphTrack('vocal', 0.5)]).master[0]) * 0.6)
    expect(energy(sent.master[0]) + energy(sent.master[1])).toBeGreaterThan(0.02)
  })

  it('reads a volume lane on the offline mix', () => {
    const vocal = graphTrack('vocal', 0.5)
    const written = renderGraph({
      tracks: [vocal],
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: rate,
      tempo: 120,
      length: vocal.buffer[0].length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [{ id: 'lane', trackId: 'vocal', pluginId: '', param: 'volume', target: 'volume', points: [{ beat: 0, value: 0 }] }],
      offline: true,
      create: (): Processor => ({
      latencySamples: 0,
      reset() {},
      process(input, output) {
        output[0].set(input[0])
        output[1].set(input[1] ?? input[0])
      },
    }),
    })
    expect(energy(written.master[0]) + energy(written.master[1])).toBeLessThan(0.001)
  })
})

describe('core plugin inserts', () => {
  const shaped: { id: CoreId; params: Record<string, number>; input: Float32Array }[] = [
    { id: 'eq', params: { kind: 0, hp: 4000, lp: 20000, lowG: 0, midG: 0, highG: 0 }, input: tone(120, 0.2) },
    { id: 'compressor', params: { kind: 0, threshold: -30, ratio: 12, attack: 0.5, release: 40, knee: 0, makeup: 0, mix: 1 }, input: tone(220, 0.25, 0.8) },
    { id: 'vocal', params: { kind: 2, gate: -8, gateRatio: 20, gateAtk: 0.2, gateRel: 10, hold: 0, range: 80, amount: 0 }, input: tone(440, 0.2, 0.02) },
    { id: 'saturator', params: { kind: 0, drive: 1, tone: 2000, mix: 1 }, input: tone(220, 0.2, 0.7) },
    { id: 'reverb', params: { kind: 0, mode: 1, size: 0.8, decay: 0.8, damp: 0.2, mix: 1 }, input: tone(330, 0.3, 0.4) },
    { id: 'delay', params: { kind: 0, sync: 0, time: 40, feedback: 0.45, mix: 1, filter: 8000 }, input: tone(440, 0.25, 0.4) },
    { id: 'mod', params: { kind: 0, rate: 3, depth: 1, mix: 1 }, input: tone(440, 0.3, 0.4) },
    { id: 'tune', params: { amount: 1, transpose: 7, retune: 1, mode: 1 }, input: tone(220, 0.25, 0.4) },
    { id: 'limiter', params: { kind: 0, threshold: -18, release: 20, ceiling: -6 }, input: tone(220, 0.2, 0.9) },
  ]

  it('processes when enabled and passes audio when bypassed', () => {
    expect(CORE_IDS).toHaveLength(12)
    for (const item of shaped) {
      const wet = renderPlugin(item.id, item.input, item.params, true)
      const dry = renderPlugin(item.id, item.input, item.params, false)
      expect(energy(dry), `${item.id} bypass`).toBeGreaterThan(0.001)
      expect(Math.abs(energy(dry) - energy(item.input)), `${item.id} bypass level`).toBeLessThan(0.02)
      let delta = 0
      const n = Math.min(wet.length, item.input.length)
      const skip = Math.floor(rate * 0.05)
      for (let i = skip; i < n; i++) delta += Math.abs(wet[i] - item.input[i])
      const mean = delta / Math.max(1, n - skip)
      const dryLevel = energy(item.input)
      expect(mean / Math.max(1e-6, dryLevel), item.id).toBeGreaterThan(0.15)
    }
  })

  it('lets the sampler and the synth add sound, and leaves scaler audio untouched', () => {
    const sample = tone(330, 0.2, 0.8)
    const plugin = createPlugin('sampler')
    plugin.sampler = { ...plugin.sampler!, bufferId: 'tone', root: 60 }
    const heard = renderSamplerSpan(plugin, sample, [{ time: 0, pitch: 60, vel: 0.9 }], rate, Math.floor(rate * 0.2))
    expect(energy(heard[0])).toBeGreaterThan(0.01)
    const bypassed = createPlugin('sampler')
    bypassed.enabled = false
    bypassed.sampler = plugin.sampler
    const silent = renderPlugin('sampler', new Float32Array(Math.floor(rate * 0.1)), { ...bypassed.params, kind: 0 }, false)
    expect(energy(silent)).toBeLessThan(0.0001)

    const synthIn = tone(110, 0.15, 0.2)
    const synth = createCore('synth', rate) as ReturnType<typeof createCore> & { note?: (pitch: number, vel: number) => void }
    synth.note?.(60, 1)
    const out = new Float32Array(synthIn.length)
    synth.process([synthIn, synthIn], [out, new Float32Array(synthIn.length)], {}, context())
    expect(energy(out)).toBeGreaterThan(energy(synthIn) * 1.2)

    const through = renderPlugin('scaler', synthIn, {}, true)
    expect(Math.abs(energy(through) - energy(synthIn))).toBeLessThan(0.01)
  })
})

describe('scaler output', () => {
  it('plays a forwarded scaler chord through the destination track', () => {
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.setTrackInstrument(keys.id, 'scaler')
    const before = new Set(store.project.tracks.map((track) => track.id))
    store.addTrack('midi')
    const destId = store.project.tracks.find((track) => !before.has(track.id))!.id
    store.setScaler(keys.id, { sound: 'forward', forwardTrackId: destId, output: 'audio' })
    const sounded: string[] = []
    playScalerLive(store.project, {
      playThrough(trackId, pitch) { sounded.push(`${trackId}:${pitch}`) },
    }, keys.id, 60, 0.8)
    expect(sounded.length).toBeGreaterThan(0)
    expect(sounded.every((item) => item.startsWith(`${destId}:`))).toBe(true)
  })
})

describe('selected instrument', () => {
  it('does not give MIDI playback to a track that is not selected', () => {
    const vocal = makeTrack({ name: 'Vocal', type: 'audio', armed: true, input: 'mic' })
    const keys = makeTrack({ name: 'Keys', type: 'midi', armed: true, input: 'midi:portA' })
    const drums = makeTrack({ name: 'Drums', type: 'midi', armed: true, input: 'midi' })
    expect(midiDestinations([vocal, keys, drums], 'portA', drums.id, true)).toEqual({
      play: [drums.id],
      record: [keys.id],
    })
    expect(midiDestinations([vocal, keys, drums], 'portA', vocal.id, false)).toEqual({ play: [], record: [] })
  })
})
