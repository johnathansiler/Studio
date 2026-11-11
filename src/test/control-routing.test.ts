import { describe, expect, it } from 'vitest'
import { graphPlugins } from '../audio/arrangeSources'
import { renderArrangement } from '../audio/bounce'
import { createProcessor, preloadWasmInserts } from '../audio/plugins/createAll'
import { CATALOG, createPlugin, defaultParams, descriptor } from '../audio/plugins/catalog'
import { createCore } from '../audio/plugins/dispatch'
import { processChain, type ChainSlot } from '../audio/plugins/chain'
import { WASM_INSERTS } from '../audio/wasm/codes'
import { loadDspWasmBytes } from '../audio/wasm/engine'
import { renderGraph, type GraphTrack } from '../audio/renderGraph'
import { renderLooped } from '../audio/sample/engine'
import { normalizePadKit } from '../model/padMachine'
import { migrateProject } from '../model/schema'
import { createEmptyProject, makeTrack, type AudioAsset } from '../model/types'
import { ProjectStore } from '../state/store'
import type { CoreId } from '../audio/plugins/ids'

const rate = 48000

function tone(length: number, freq = 220, amp = 0.5) {
  const data = new Float32Array(length)
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return data
}

function asset(id: string, channel: Float32Array): AudioAsset {
  return { id, name: id, sampleRate: rate, channels: [channel, channel.slice()] }
}

function rms(channel: Float32Array, from = 0, to = channel.length) {
  let sum = 0
  let n = 0
  for (let i = from; i < to && i < channel.length; i++) {
    const value = channel[i] || 0
    sum += value * value
    n += 1
  }
  return n ? Math.sqrt(sum / n) : 0
}

function correlate(a: ArrayLike<number>, b: ArrayLike<number>) {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    dot += x * y
    aa += x * x
    bb += y * y
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0
}

function block() {
  return {
    sampleRate: rate,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full' as const,
  }
}

function graph(tracks: GraphTrack[], masterVolume = 1) {
  return renderGraph({
    tracks,
    masterPlugins: [],
    masterVolume,
    sampleRate: rate,
    tempo: 120,
    length: tracks[0]?.buffer[0]?.length ?? 1,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    automation: [],
    create: (id) => createCore(id as CoreId, rate),
  })
}

function audioTrack(id: string, channel: Float32Array, extra: Partial<GraphTrack> = {}): GraphTrack {
  return {
    id,
    type: 'audio',
    input: 'none',
    buffer: [channel, channel.slice()],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    plugins: [],
    sends: [],
    output: null,
    groupId: null,
    ...extra,
  }
}

describe('plugin parameter slots', () => {
  it('round-trips every Rust insert index and drops the next slot', async () => {
    const bytes = await loadDspWasmBytes()
    const module = new WebAssembly.Module(bytes)
    const instance = new WebAssembly.Instance(module)
    const exp = instance.exports as unknown as {
      ch_plug_create: (code: number) => number
      ch_plug_destroy: (ptr: number) => void
      ch_plug_prepare: (ptr: number, sampleRate: number, maxBlock: number) => void
      ch_plug_set_param: (ptr: number, id: number, value: number) => void
      ch_plug_get_param: (ptr: number, id: number) => number
    }
    for (const [id, code] of Object.entries(WASM_INSERTS)) {
      const spec = descriptor(id)
      expect(spec, id).toBeTruthy()
      const ptr = exp.ch_plug_create(code)
      exp.ch_plug_prepare(ptr, rate, 128)
      const count = spec!.params.length
      if (count > 0) {
        const marker = 0.25 + (count % 7) * 0.01
        exp.ch_plug_set_param(ptr, count - 1, marker)
        expect(exp.ch_plug_get_param(ptr, count - 1), `${id} last`).toBeCloseTo(marker, 5)
        exp.ch_plug_set_param(ptr, 0, Number.NaN)
        expect(exp.ch_plug_get_param(ptr, 0), `${id} nan`).toBe(0)
        exp.ch_plug_set_param(ptr, 0, Number.POSITIVE_INFINITY)
        expect(Number.isFinite(exp.ch_plug_get_param(ptr, 0)), `${id} inf`).toBe(true)
      }
      exp.ch_plug_set_param(ptr, count, 42)
      expect(exp.ch_plug_get_param(ptr, count), `${id} past end`).toBe(0)
      exp.ch_plug_destroy(ptr)
    }
  })

  it('keeps a Beat Machine insert from replacing the buffer', () => {
    const drums = createPlugin('pads')
    const eq = createPlugin('eq')
    const track = makeTrack({
      name: 'Beat',
      type: 'midi',
      instrument: 'pads',
      plugins: [drums, eq],
    })
    const chain = graphPlugins(track)
    expect(drums.params.kind).toBeGreaterThanOrEqual(1)
    expect(chain[0].enabled).toBe(false)
    expect(chain[1].enabled).toBe(true)
    expect(chain.map((plugin) => plugin.id)).toEqual([drums.id, eq.id])
    const sampler = createPlugin('sampler')
    const chromatic = graphPlugins(makeTrack({ name: 'Samp', type: 'midi', instrument: 'sampler', plugins: [sampler] }))
    expect(chromatic[0].enabled).toBe(false)
    const steps = graphPlugins(makeTrack({ name: 'Steps', type: 'midi', plugins: [createPlugin('steps'), eq] }))
    expect(steps[0].enabled).toBe(false)
    expect(steps[1].enabled).toBe(true)
  })

  it('copies audio through a Beat Machine insert instead of clearing it', async () => {
    ;(globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }).__CUEHARBOR_WASM_DSP__ = true
    await preloadWasmInserts()
    const proc = createProcessor('sampler', rate)
    expect(proc).toBeTruthy()
    const input = tone(256, 440, 0.4)
    const left = new Float32Array(input.length)
    const right = new Float32Array(input.length)
    proc!.process([input, input], [left, right], { ...defaultParams('sampler'), kind: 1 }, block())
    expect(left[40]).toBeCloseTo(input[40], 5)
    expect(right[40]).toBeCloseTo(input[40], 5)
    const wiped = new Float32Array(input.length)
    const wipedRight = new Float32Array(input.length)
    proc!.process([input, input], [wiped, wipedRight], { ...defaultParams('sampler'), kind: 0 }, block())
    expect(Math.abs(wiped[40] - input[40])).toBeGreaterThan(0.05)
    delete (globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }).__CUEHARBOR_WASM_DSP__
  })
})

describe('routing, persistence, and extremes', () => {
  it('prints Beat Machine pads through the insert that the live chain skips', async () => {
    const pcm = tone(Math.round(rate * 0.18), 220, 0.7)
    const kit = normalizePadKit(undefined)
    const pad = kit.banks.flat().find((item) => item.pitch === 36)!
    pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 0, bufferId: 'pad' }]
    pad.decay = 1
    pad.filter = 1
    pad.level = 1
    pad.pan = 0
    const pads = makeTrack({ id: 'pads', name: 'Pads', type: 'midi', volume: 1, pan: 0, input: 'none', instrument: 'pads', padKit: kit })
    pads.plugins = [createPlugin('pads')]
    pads.midiClips = [{
      id: 'p',
      name: 'pad',
      startBeat: 0,
      durationBeats: 1,
      notes: [{ id: 'n', pitch: 36, startBeat: 0, durationBeats: 0.5, velocity: 0.9 }],
    }]
    const song = createEmptyProject(rate, 'Pads')
    song.masterPlugins = []
    song.masterVolume = 1
    song.tracks = [pads]
    const bounced = await renderArrangement(song, new Map([['pad', asset('pad', pcm)]]), 0, pcm.length, false)
    const from = Math.round(rate * 0.008)
    const to = Math.round(rate * 0.03)
    expect(correlate(bounced[0].subarray(from, to), pcm.subarray(from, to))).toBeGreaterThan(0.85)
    const eq = createPlugin('eq')
    eq.params = { ...eq.params, midF: 220, midG: 12, midQ: 2 }
    pads.plugins = [createPlugin('pads'), eq]
    const colored = await renderArrangement(song, new Map([['pad', asset('pad', pcm)]]), 0, pcm.length, false)
    expect(Math.abs(rms(colored[0], from, to) - rms(bounced[0], from, to))).toBeGreaterThan(0.01)
  })

  it('keeps bypass, order, sends, and mute on the same route as the bounce', () => {
    const input = tone(Math.round(rate * 0.2), 1000, 0.35)
    const eq = createPlugin('eq')
    eq.params = { ...eq.params, midF: 1000, midG: 12, midQ: 1 }
    const open = graph([audioTrack('a', input, { plugins: [eq] })])
    const bypassed = graph([audioTrack('a', input, { plugins: [{ ...eq, enabled: false }] })])
    const dry = graph([audioTrack('a', input)])
    expect(Math.abs(rms(open.master[0]) - rms(dry.master[0]))).toBeGreaterThan(0.02)
    expect(Math.abs(rms(bypassed.master[0]) - rms(dry.master[0]))).toBeLessThan(0.002)

    const comp = createPlugin('compressor')
    const ordered = graphPlugins(makeTrack({ name: 'A', type: 'audio', plugins: [eq, comp] }))
    expect(ordered.map((plugin) => plugin.pluginId)).toEqual(['eq', 'compressor'])

    const muted = graph([
      audioTrack('a', input, { mute: true, sends: [{ id: 's', busId: 'bus', gain: 1, preFader: false, enabled: true }] }),
      audioTrack('bus', new Float32Array(input.length), { type: 'bus' }),
    ])
    const pre = graph([
      audioTrack('a', input, { mute: true, sends: [{ id: 's', busId: 'bus', gain: 1, preFader: true, enabled: true }] }),
      audioTrack('bus', new Float32Array(input.length), { type: 'bus' }),
    ])
    expect(rms(muted.master[0])).toBeLessThan(0.001)
    expect(rms(pre.master[0])).toBeGreaterThan(0.05)
    const solo = graph([
      audioTrack('a', input, { solo: true }),
      audioTrack('b', tone(input.length, 1000, 0.9)),
    ])
    const both = graph([
      audioTrack('a', input),
      audioTrack('b', tone(input.length, 1000, 0.9)),
    ])
    expect(rms(solo.master[0])).toBeLessThan(rms(both.master[0]) * 0.7)
  })

  it('persists knobs through undo and a save reload, and refuses non-finite values', () => {
    const store = new ProjectStore(createEmptyProject(rate))
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addPlugin(track.id, 'eq')
    store.addPlugin(track.id, 'compressor')
    const [eq, comp] = store.track(track.id)!.plugins
    store.updatePlugin(track.id, eq.id, { params: { midG: 6.5 } })
    expect(store.track(track.id)!.plugins[0].params.midG).toBeCloseTo(6.5)
    store.updatePlugin(track.id, eq.id, { params: { midG: Number.NaN, lowG: Number.POSITIVE_INFINITY }, wet: Number.NaN })
    expect(store.track(track.id)!.plugins[0].params.midG).toBeCloseTo(6.5)
    expect(store.track(track.id)!.plugins[0].params.lowG).toBe(0)
    expect(store.track(track.id)!.plugins[0].wet).toBe(1)
    store.setAutomated({ trackId: track.id, target: 'plugin', param: 'midG', pluginId: eq.id, min: -18, max: 12 }, Number.NaN, false, 0)
    expect(store.track(track.id)!.plugins[0].params.midG).toBe(-18)
    store.setAutomated({ trackId: track.id, target: 'volume', param: 'volume', min: 0, max: 1.25 }, Number.POSITIVE_INFINITY, false, 0)
    expect(store.track(track.id)!.volume).toBeCloseTo(1.25)
    store.undo()
    expect(store.track(track.id)!.volume).toBeCloseTo(track.volume)

    store.updatePlugin(track.id, eq.id, { params: { midG: 4 } })
    store.updatePlugin(track.id, eq.id, { enabled: false })
    expect(store.track(track.id)!.plugins[0].enabled).toBe(false)
    store.undo()
    expect(store.track(track.id)!.plugins[0].enabled).toBe(true)
    store.redo()
    expect(store.track(track.id)!.plugins[0].enabled).toBe(false)
    store.undo()

    const before = store.track(track.id)!.plugins.map((plugin) => plugin.id)
    store.movePlugin(track.id, comp.id, -1)
    expect(store.track(track.id)!.plugins.map((plugin) => plugin.id)).toEqual([comp.id, eq.id])
    store.undo()
    expect(store.track(track.id)!.plugins.map((plugin) => plugin.id)).toEqual(before)

    const bus = store.addTracks({ kind: 'bus', count: 1, instrument: 'none', input: 'line', channels: 2, armed: false })[0]
    store.addSend(track.id, bus)
    const send = store.track(track.id)!.sends[0]
    store.updateSend(track.id, send.id, { gain: 0.7, preFader: true })
    store.undo()
    expect(store.track(track.id)!.sends[0].preFader).toBe(false)
    store.redo()
    expect(store.track(track.id)!.sends[0].gain).toBeCloseTo(0.7)
    expect(store.track(track.id)!.sends[0].preFader).toBe(true)

    const saved = migrateProject(JSON.parse(JSON.stringify(store.project)))
    const again = saved.tracks.find((item) => item.id === track.id)!
    expect(again.plugins.find((plugin) => plugin.id === eq.id)?.params.midG).toBeCloseTo(4)
    expect(again.plugins.map((plugin) => plugin.pluginId)).toEqual(store.track(track.id)!.plugins.map((plugin) => plugin.pluginId))
    expect(again.sends[0].gain).toBeCloseTo(0.7)
    expect(again.sends[0].preFader).toBe(true)
    expect(again.plugins.every((plugin) => Object.values(plugin.params).every((value) => Number.isFinite(value)))).toBe(true)
  })

  it('stays finite at the ends of every catalog knob', () => {
    const input = tone(128, 440, 0.4)
    for (const spec of CATALOG) {
      const plugin = createPlugin(spec.id)
      const processor = createCore(spec.id as CoreId, rate)
      for (const edge of ['min', 'max'] as const) {
        const params = { ...plugin.params }
        for (const param of spec.params) params[param.id] = edge === 'min' ? param.min : param.max
        params.kind = plugin.params.kind ?? params.kind
        const slot: ChainSlot = {
          id: plugin.id,
          pluginId: plugin.pluginId,
          enabled: true,
          wet: 1,
          params,
          failed: false,
          sidechain: '',
          processor,
        }
        const left = new Float32Array(input.length)
        const right = new Float32Array(input.length)
        processChain([slot], [input, input], [left, right], block())
        expect(slot.failed, `${spec.id} ${edge}`).toBe(false)
        for (let i = 0; i < left.length; i++) {
          expect(Number.isFinite(left[i]), `${spec.id} ${edge}`).toBe(true)
          expect(Number.isFinite(right[i]), `${spec.id} ${edge}`).toBe(true)
        }
      }
    }
  })

  it('plays a one-shot region through its last sample and then stays quiet', () => {
    const channel = new Float32Array([0.2, 0.4, 0.6, 0.8, 0.1])
    const once = renderLooped(channel, 0, 5, 8, 0, 2)
    expect(Array.from(once.subarray(0, 5)).map((value) => Math.round(value * 10) / 10)).toEqual([0.2, 0.4, 0.6, 0.8, 0.1])
    expect(once[5]).toBe(0)
    expect(once[7]).toBe(0)
  })
})
