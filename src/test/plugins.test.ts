import { describe, expect, it } from 'vitest'
import { createPlugin, defaultParams, normalizeProject, tuneLatency } from '../audio/plugins/catalog'
import { processChain, type ChainSlot } from '../audio/plugins/chain'
import { loadModule, pluginIds } from '../audio/plugins/registry'
import { createTune } from '../audio/plugins/tune'
import { create as createEq } from '../audio/plugins/eq'
import { create as createCompressor } from '../audio/plugins/compressor'
import { create as createGate } from '../audio/plugins/gate'
import { create as createDeesser } from '../audio/plugins/deesser'
import { create as createLimiter } from '../audio/plugins/limiter'
import { createSaturator } from '../audio/plugins/color'
import { createChorus, createDoubler } from '../audio/plugins/color'
import { createDelay, createReverb } from '../audio/plugins/space'
import { createPitch } from '../audio/plugins/pitch'
import { yinPitch } from '../audio/plugins/psola'
import { renderGraph, type GraphTrack } from '../audio/renderGraph'
import { edgeDelays, findCycle, MASTER } from '../audio/routing'
import { createEmptyProject } from '../model/types'
import type { Processor } from '../audio/plugins/types'
import { ProjectStore } from '../state/store'

const rate = 48000

function sine(freq: number, seconds: number, sampleRate = rate, amp = 0.4) {
  const n = Math.floor(sampleRate * seconds)
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp
  return data
}

function noise(seconds: number, amp = 0.2) {
  const n = Math.floor(rate * seconds)
  const data = new Float32Array(n)
  let seed = 3
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647
    data[i] = ((seed / 2147483647) * 2 - 1) * amp
  }
  return data
}

function ctx(sampleRate = rate, extra: Partial<Parameters<Processor['process']>[3]> = {}) {
  return {
    sampleRate,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full' as const,
    ...extra,
  }
}

function run(processor: Processor, input: Float32Array, params: Record<string, number>, sampleRate = rate, block = 0) {
  const left = new Float32Array(input.length)
  const rightIn = Float32Array.from(input)
  const right = new Float32Array(input.length)
  const context = ctx(sampleRate)
  if (!block) processor.process([input, rightIn], [left, right], params, context)
  else {
    for (let offset = 0; offset < input.length; offset += block) {
      const count = Math.min(block, input.length - offset)
      processor.process(
        [input.subarray(offset, offset + count), rightIn.subarray(offset, offset + count)],
        [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
        params,
        { ...context, sampleTime: offset },
      )
    }
  }
  return { left, right }
}

function finite(buffer: Float32Array, limit = 1.05) {
  for (let i = 0; i < buffer.length; i++) {
    if (!Number.isFinite(buffer[i])) return false
    if (Math.abs(buffer[i]) > limit) return false
  }
  return true
}

function cents(a: number, b: number) {
  return 1200 * Math.log2(a / b)
}

describe('routing', () => {
  it('rejects a bus cycle and a send cycle', () => {
    expect(findCycle([
      { id: 'a', dest: 'b', sends: [], latency: 0 },
      { id: 'b', dest: 'a', sends: [], latency: 0 },
    ])).toEqual(['a', 'b'])
    expect(findCycle([
      { id: 'a', dest: MASTER, sends: ['b'], latency: 0 },
      { id: 'b', dest: 'a', sends: [], latency: 0 },
    ])).not.toBeNull()
    expect(findCycle([
      { id: 'a', dest: 'bus', sends: ['verb'], latency: 0 },
      { id: 'bus', dest: MASTER, sends: [], latency: 0 },
      { id: 'verb', dest: MASTER, sends: [], latency: 0 },
    ])).toBeNull()
  })

  it('delays the faster track so both arrive together', () => {
    const delays = edgeDelays([
      { id: 'slow', dest: MASTER, sends: [], latency: 100 },
      { id: 'fast', dest: MASTER, sends: [], latency: 0 },
      { id: MASTER, dest: null, sends: [], latency: 0 },
    ])
    expect(delays.get('slow>master')).toBe(0)
    expect(delays.get('fast>master')).toBe(100)
    const nested = edgeDelays([
      { id: 'child', dest: 'bus', sends: [], latency: 10 },
      { id: 'bus', dest: MASTER, sends: [], latency: 20 },
      { id: 'dry', dest: MASTER, sends: [], latency: 0 },
      { id: MASTER, dest: null, sends: [], latency: 0 },
    ])
    expect(nested.get('child>bus')).toBe(0)
    expect(nested.get('dry>master')).toBe(30)
    expect(nested.get('bus>master')).toBe(0)
  })

  it('aligns an impulse with plugin delay compensation', () => {
    const delay = 32
    const length = 256
    const impulse = new Float32Array(length)
    impulse[0] = 0.5
    const make = (latency: number): Processor => ({
      latencySamples: latency,
      reset() {},
      process(input, output) {
        const line = new Float32Array(latency)
        let index = 0
        const n = input[0].length
        for (let i = 0; i < n; i++) {
          const sample = latency ? line[index % latency] : input[0][i]
          if (latency) line[index % latency] = input[0][i]
          index += 1
          output[0][i] = sample
          if (output[1]) output[1][i] = input[1]?.[i] ?? sample
        }
      },
    })
    // The processor above is stateful only within one process() call, so render in one block via a closure.
    const lines = new Map<string, { line: Float32Array; index: number }>()
    const create = (id: string): Processor => {
      const latency = id === 'slow' ? delay : 0
      lines.set(id, { line: new Float32Array(Math.max(1, latency)), index: 0 })
      return {
        latencySamples: latency,
        reset() {},
        process(input, output) {
          const state = lines.get(id)!
          const n = input[0].length
          for (let i = 0; i < n; i++) {
            const sample = latency ? state.line[state.index % latency] : input[0][i]
            if (latency) state.line[state.index % latency] = input[0][i]
            state.index += 1
            output[0][i] = sample
            if (output[1]) output[1][i] = sample
          }
        },
      }
    }
    const track = (id: string, pluginId: string): GraphTrack => ({
      id,
      type: 'audio',
      input: 'none',
      buffer: [impulse.slice(), impulse.slice()],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      plugins: [{ ...createPlugin('eq'), id: pluginId, pluginId, enabled: true, wet: 1, params: {}, sidechain: '' }],
      sends: [],
      output: null,
      groupId: null,
    })
    const rendered = renderGraph({
      tracks: [track('a', 'slow'), track('b', 'fast')],
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: rate,
      tempo: 120,
      length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      create: (id) => create(id),
    })
    const peak = (buffer: Float32Array) => buffer.indexOf(Math.max(...buffer))
    void make
    expect(Math.max(...rendered.master[0])).toBeGreaterThan(0.4)
    expect(rendered.delays['b>master']).toBe(delay)
    expect(peak(rendered.master[0])).toBe(delay)
  })
})

describe('plugin dsp', () => {
  const factories: [string, (sampleRate: number) => Processor, Record<string, number>][] = [
    ['eq', createEq, defaultParams('eq')],
    ['compressor', createCompressor, defaultParams('compressor')],
    ['gate', createGate, defaultParams('gate')],
    ['deesser', createDeesser, defaultParams('deesser')],
    ['limiter', createLimiter, defaultParams('limiter')],
    ['saturator', createSaturator, defaultParams('saturator')],
    ['doubler', createDoubler, defaultParams('doubler')],
    ['chorus', createChorus, defaultParams('chorus')],
    ['delay', createDelay, { ...defaultParams('delay'), mix: 0.35 }],
    ['reverb', createReverb, { ...defaultParams('reverb'), mix: 0.3, mode: 1 }],
    ['tune', createTune, { ...defaultParams('tune'), amount: 0 }],
    ['pitch', createPitch, { ...defaultParams('pitch'), mix: 0 }],
  ]

  it('keeps every plugin finite on a sine, noise, and silence', () => {
    const tone = sine(440, 0.2)
    const hash = noise(0.2)
    const quiet = new Float32Array(256)
    for (const [name, create, params] of factories) {
      for (const input of [tone, hash, quiet]) {
        const out = run(create(rate), input, params)
        expect(finite(out.left), name).toBe(true)
        expect(finite(out.right), name).toBe(true)
      }
      const other = run(create(44100), sine(440, 0.1, 44100), params, 44100)
      expect(finite(other.left), name).toBe(true)
    }
  })

  it('matches a full buffer to block-sized processing', () => {
    const input = sine(220, 0.25, rate, 0.3)
    const pairs: [Processor, Processor, Record<string, number>][] = [
      [createEq(rate), createEq(rate), defaultParams('eq')],
      [createCompressor(rate), createCompressor(rate), { ...defaultParams('compressor'), threshold: -18, ratio: 3, makeup: 2 }],
      [createReverb(rate), createReverb(rate), { ...defaultParams('reverb'), mix: 0.4, mode: 2, size: 0.5 }],
    ]
    for (const [whole, chunked, params] of pairs) {
      const a = run(whole, input, params)
      const b = run(chunked, input, params, rate, 128)
      let max = 0
      for (let i = 0; i < a.left.length; i++) max = Math.max(max, Math.abs(a.left[i] - b.left[i]))
      expect(max).toBeLessThan(1e-5)
    }
  })

  it('bypasses a plugin that throws and strips NaNs', () => {
    const input = sine(100, 0.05, rate, 0.2)
    const slots: ChainSlot[] = [
      {
        id: 'bad',
        pluginId: 'eq',
        enabled: true,
        wet: 1,
        params: {},
        failed: false,
        sidechain: '',
        processor: {
          latencySamples: 0,
          reset() {},
          process() {
            throw new Error('dsp')
          },
        },
      },
      {
        id: 'nan',
        pluginId: 'eq',
        enabled: true,
        wet: 1,
        params: {},
        failed: false,
        sidechain: '',
        processor: {
          latencySamples: 0,
          reset() {},
          process(into, output) {
            output[0][0] = Number.NaN
            output[0][1] = 1e-40
            for (let i = 2; i < into[0].length; i++) output[0][i] = into[0][i]
            if (output[1]) output[1].set(into[0])
          },
        },
      },
    ]
    const left = new Float32Array(input.length)
    const right = new Float32Array(input.length)
    processChain(slots, [input, input], [left, right], ctx())
    expect(slots[0].failed).toBe(true)
    expect(finite(left)).toBe(true)
    expect(left[1]).toBe(0)
    processChain(slots, [input, input], [left, right], ctx())
    expect(finite(left)).toBe(true)
  })

  it('pulls a detuned sine onto the nearest chromatic pitch', () => {
    const input = sine(445, 0.45, rate, 0.35)
    const params = { ...defaultParams('tune'), amount: 1, retune: 1, humanize: 0, mode: 0, minHz: 80, maxHz: 1000, transpose: 0, mask: 0, root: -1, scaleIndex: -1 }
    const out = run(createTune(rate), input, params, rate, 128)
    expect(finite(out.left)).toBe(true)
    const skip = tuneLatency(rate) + 4000
    const frame = out.left.subarray(skip, skip + 4096)
    const pitch = yinPitch(frame, rate, 80, 1000)
    expect(Math.abs(cents(pitch.hz, 440))).toBeLessThan(15)
  })

  it('keeps vibrato when asked and passes noise through', () => {
    const n = Math.floor(rate * 0.45)
    const vibrato = new Float32Array(n)
    let phase = 0
    for (let i = 0; i < n; i++) {
      const hz = 440 * 2 ** ((0.35 * Math.sin((2 * Math.PI * 5 * i) / rate)) / 12)
      vibrato[i] = Math.sin(phase) * 0.3
      phase += (2 * Math.PI * hz) / rate
    }
    const flat = { ...defaultParams('tune'), amount: 1, retune: 1, humanize: 0, mode: 0, minHz: 80, maxHz: 1000 }
    const human = { ...flat, humanize: 1, retune: 0.2 }
    const corrected = run(createTune(rate), vibrato, flat, rate, 256)
    const kept = run(createTune(rate), vibrato, human, rate, 256)
    expect(correlate(vibrato, kept.left, tuneLatency(rate))).toBeGreaterThan(correlate(vibrato, corrected.left, tuneLatency(rate)))
    const hash = noise(0.3, 0.15)
    const passed = run(createTune(rate), hash, flat, rate, 256)
    expect(finite(passed.left)).toBe(true)
    expect(correlate(hash, passed.left, tuneLatency(rate))).toBeGreaterThan(0.85)
  })

  it('moves a speech-like tone toward the scale without blowing up', () => {
    const n = Math.floor(rate * 0.4)
    const voice = new Float32Array(n)
    const f0 = 207
    for (let i = 0; i < n; i++) {
      let sample = 0
      for (let h = 1; h <= 10; h++) {
        const formant = h === 5 ? 1.4 : 1
        sample += (Math.sin((2 * Math.PI * f0 * h * i) / rate) / h) * formant
      }
      voice[i] = Math.tanh(sample * 0.4) * 0.35
    }
    const params = { ...defaultParams('tune'), amount: 1, retune: 1, humanize: 0, mode: 1, root: 0, scaleIndex: 0, minHz: 80, maxHz: 800 }
    const out = run(createTune(rate), voice, params, rate, 256)
    expect(finite(out.left, 1.2)).toBe(true)
    const skip = tuneLatency(rate) + 3000
    const before = yinPitch(voice.subarray(1000, 5000), rate, 80, 800).hz
    const after = yinPitch(out.left.subarray(skip, skip + 4096), rate, 80, 800).hz
    const scaleTones = [196, 220]
    const nearest = scaleTones.reduce((best, tone) => (Math.abs(cents(after, tone)) < Math.abs(cents(after, best)) ? tone : best))
    expect(Math.abs(cents(after, nearest))).toBeLessThan(30)
    expect(Math.abs(cents(before, nearest))).toBeGreaterThan(40)
  })

  it('sidechains the compressor from another buffer', () => {
    const tone = sine(220, 0.2, rate, 0.4)
    const duck = sine(40, 0.2, rate, 0.9)
    const processor = createCompressor(rate)
    const left = new Float32Array(tone.length)
    processor.process([tone, tone], [left, new Float32Array(tone.length)], { ...defaultParams('compressor'), threshold: -20, ratio: 8, attack: 1, release: 20, makeup: 0, mix: 1, knee: 0 }, ctx(rate, { sidechain: duck }))
    const plain = run(createCompressor(rate), tone, { ...defaultParams('compressor'), threshold: -20, ratio: 8, attack: 1, release: 20, makeup: 0, mix: 1, knee: 0 })
    expect(rms(left)).toBeLessThan(rms(plain.left))
  })
})

describe('mix graph', () => {
  it('renders the offline graph the same way as block processing', () => {
    const input = sine(330, 0.2, rate, 0.25)
    const plugin = createPlugin('eq')
    plugin.params.midG = 3
    plugin.params.midF = 1000
    const rendered = renderGraph({
      tracks: [{
        id: 'v',
        type: 'audio',
        input: 'none',
        buffer: [input, input],
        volume: 0.8,
        pan: 0,
        mute: false,
        solo: false,
        plugins: [plugin],
        sends: [],
        output: null,
        groupId: null,
      }],
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: rate,
      tempo: 120,
      length: input.length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [{ id: 'a', pluginId: plugin.id, param: 'midG', points: [{ beat: 0, value: 3 }, { beat: 4, value: 3 }] }],
      create: (id) => (id === 'eq' ? createEq(rate) : createGate(rate)),
    })
    const direct = run(createEq(rate), input, { ...plugin.params, midG: 3 }, rate, 128)
    let max = 0
    const center = Math.cos(Math.PI / 4) * 0.8
    let worst = 0
    for (let i = 0; i < input.length; i++) {
      const err = Math.abs(rendered.master[0][i] - direct.left[i] * center)
      if (err > max) {
        max = err
        worst = i
      }
    }
    expect(max, `at ${worst} render ${rendered.master[0][worst]} direct ${direct.left[worst]}`).toBeLessThan(1e-4)
    expect(Number.isFinite(rendered.lufs)).toBe(true)
    expect(Number.isFinite(rendered.truePeak)).toBe(true)
  })

  it('loads plugin modules lazily and leaves the limiter bypassed', async () => {
    expect(pluginIds()).toContain('tune')
    const eq = await loadModule('eq')
    const again = await loadModule('eq')
    expect(eq).toBe(again)
    expect(eq?.descriptor.id).toBe('eq')
    const project = normalizeProject(createEmptyProject())
    const limiter = project.masterPlugins.find((plugin) => plugin.pluginId === 'limiter')
    expect(limiter?.enabled).toBe(false)
    expect(project.tracks.every((track) => track.plugins.length === 0)).toBe(true)
    const legacy = createEmptyProject()
    legacy.masterPlugins = []
    legacy.tracks[0].inserts = [{ id: 'old', type: 'eq', enabled: true, params: { low: 1, mid: 2, midFreq: 900, high: 0 } }]
    normalizeProject(legacy)
    expect(legacy.tracks[0].inserts).toHaveLength(0)
    expect(legacy.tracks[0].plugins[0].pluginId).toBe('eq')
    expect(legacy.tracks[0].plugins[0].params.midG).toBe(2)
  })

  it('refuses a feedback send from the store', () => {
    const store = new ProjectStore(createEmptyProject())
    store.addTrack('bus')
    const bus = store.project.tracks.find((track) => track.type === 'bus')!
    store.addTrack('bus')
    const other = store.project.tracks.filter((track) => track.type === 'bus')[1]
    store.updateTrack(bus.id, { output: other.id })
    store.updateTrack(other.id, { output: bus.id })
    expect(store.project.tracks.find((track) => track.id === other.id)?.output).toBeNull()
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    store.addVocalChain(vocal.id)
    const names = store.track(vocal.id)!.plugins.map((plugin) => plugin.pluginId)
    expect(names).toEqual(['gate', 'eq', 'deesser', 'compressor', 'tune', 'saturator'])
    expect(store.track(vocal.id)!.sends.length).toBe(2)
    const saved = JSON.parse(JSON.stringify(store.project)) as typeof store.project
    expect(saved.tracks.find((track) => track.id === vocal.id)?.plugins).toHaveLength(6)
    expect(saved.masterPlugins.some((plugin) => plugin.pluginId === 'limiter' && !plugin.enabled)).toBe(true)
  })
})

function rms(buffer: Float32Array) {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / buffer.length)
}

function correlate(input: Float32Array, output: Float32Array, delay: number) {
  const n = Math.min(input.length - delay, output.length - delay, 8000)
  let dot = 0
  let a = 0
  let b = 0
  for (let i = 0; i < n; i++) {
    const x = input[i]
    const y = output[i + delay]
    dot += x * y
    a += x * x
    b += y * y
  }
  return dot / Math.sqrt(a * b || 1)
}

