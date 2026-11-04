import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createNativePlugin } from '../audio/core/registry'
import { FACTORY, createPlugin, defaultParams, descriptor } from '../audio/plugins/catalog'
import { createCore } from '../audio/plugins/dispatch'
import { prepareChainPool, processChain, type ChainSlot } from '../audio/plugins/chain'
import { createProcessor, preloadWasmInserts } from '../audio/plugins/createAll'
import { loadModule } from '../audio/plugins/registry'
import { createNodePool } from '../audio/nodePool'
import { renderGraphParallel } from '../audio/parallelRender'
import { renderGraph } from '../audio/renderGraph'
import { create as createEq } from '../audio/plugins/eq'
import { glideValue } from '../audio/paramCurve'
import { DSP_WASM_BYTE_LENGTH } from '../audio/wasm/dspBytes'
import { loadDspWasmBytes, WasmEq } from '../audio/wasm/engine'
import { WasmInsert } from '../audio/wasm/insert'
import { wasmDspRequested } from '../audio/wasm/flag'
import { loadWasmEqWorklet } from '../audio/wasm/loader'

const TOLERANCE = 1e-6

beforeAll(async () => {
  await loadDspWasmBytes()
})

function sine(freq: number, frames: number, rate: number, amp: number) {
  const data = new Float32Array(frames)
  for (let i = 0; i < frames; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return data
}

function noise(frames: number, amp: number) {
  const data = new Float32Array(frames)
  let seed = 3
  for (let i = 0; i < frames; i++) {
    seed = (seed * 16807) % 2147483647
    data[i] = ((seed / 2147483647) * 2 - 1) * amp
  }
  return data
}

function context(sampleRate: number, sampleTime = 0) {
  return {
    sampleRate,
    tempo: 120,
    sampleTime,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'eco' as const,
  }
}

function renderTs(left: Float32Array, right: Float32Array, params: Record<string, number>, rate: number, block: number) {
  const eq = createEq(rate)
  eq.reset()
  const outL = new Float32Array(left.length)
  const outR = new Float32Array(right.length)
  for (let offset = 0; offset < left.length; offset += block) {
    const count = Math.min(block, left.length - offset)
    eq.process(
      [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
      [outL.subarray(offset, offset + count), outR.subarray(offset, offset + count)],
      params,
      context(rate, offset),
    )
  }
  return { outL, outR }
}

async function renderRust(left: Float32Array, right: Float32Array, params: Record<string, number>, rate: number, block: number) {
  const eq = await WasmEq.create()
  eq.prepare(rate, block)
  const layout = eq.layout()
  for (const control of layout.controls) {
    if (typeof params[control.key] === 'number') eq.setParameter(control.paramId, params[control.key])
  }
  eq.settle()
  const outL = new Float32Array(left.length)
  const outR = new Float32Array(right.length)
  for (let offset = 0; offset < left.length; offset += block) {
    const count = Math.min(block, left.length - offset)
    eq.processBlock(
      [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
      [outL.subarray(offset, offset + count), outR.subarray(offset, offset + count)],
    )
  }
  const latency = eq.latency()
  eq.destroy()
  return { outL, outR, latency }
}

function compare(name: string, ts: Float32Array, rust: Float32Array) {
  let max = 0
  let sum = 0
  for (let i = 0; i < ts.length; i++) {
    const delta = Math.abs((ts[i] || 0) - (rust[i] || 0))
    if (delta > max) max = delta
    sum += delta * delta
  }
  const rms = Math.sqrt(sum / ts.length)
  if (max >= TOLERANCE) console.log(`DSP_PARITY_FAIL ${name} maxAbs=${max} rms=${rms}`)
  expect(max, name).toBeLessThan(TOLERANCE)
  return { max, rms }
}

describe('rust EQ parity', () => {
  const scores: { name: string; max: number; rms: number }[] = []

  afterEach(() => {
    delete (globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }).__CUEHARBOR_WASM_DSP__
  })

  it('matches the TypeScript EQ on silence, sine, and noise', async () => {
    const cases: { name: string; rate: number; block: number; frames: number; params: Record<string, number>; left: Float32Array; right: Float32Array }[] = []
    const vocal = { ...defaultParams('eq'), hp: 90, lowF: 250, lowG: -1.5, midF: 3200, midG: 2.5, midQ: 1.1, highF: 10000, highG: 1.5, lp: 18000 }
    const air = { ...defaultParams('eq'), hp: 80, lowF: 200, lowG: -1, midF: 4500, midG: 1.5, midQ: 0.8, highF: 12000, highG: 4.5, highQ: 0.6, lp: 20000 }
    const pushed = { ...defaultParams('eq'), hp: 180, lp: 8000, lowF: 120, lowG: 6, lowQ: 0.9, midF: 1500, midG: 8, midQ: 2.2, highF: 7000, highG: -4, highQ: 1.3 }
    for (const rate of [48000, 44100]) {
      cases.push({
        name: `silence ${rate}`,
        rate,
        block: 128,
        frames: 256,
        params: defaultParams('eq'),
        left: new Float32Array(256),
        right: new Float32Array(256),
      })
    }
    cases.push({
      name: 'sine defaults',
      rate: 48000,
      block: 128,
      frames: 4800,
      params: defaultParams('eq'),
      left: sine(440, 4800, 48000, 0.4),
      right: sine(660, 4800, 48000, 0.25),
    })
    cases.push({
      name: 'sine vocal 64',
      rate: 48000,
      block: 64,
      frames: 4096,
      params: vocal,
      left: sine(220, 4096, 48000, 0.5),
      right: sine(330, 4096, 48000, 0.15),
    })
    cases.push({
      name: 'noise air',
      rate: 48000,
      block: 256,
      frames: 4096,
      params: air,
      left: noise(4096, 0.3),
      right: noise(4096, 0.12),
    })
    cases.push({
      name: 'pushed 44100',
      rate: 44100,
      block: 128,
      frames: 4096,
      params: pushed,
      left: sine(1000, 4096, 44100, 0.2),
      right: noise(4096, 0.2),
    })
    let worst = 0
    let worstRms = 0
    for (const item of cases) {
      const ts = renderTs(item.left, item.right, item.params, item.rate, item.block)
      const rust = await renderRust(item.left, item.right, item.params, item.rate, item.block)
      expect(rust.latency).toBe(0)
      const left = compare(`${item.name} left`, ts.outL, rust.outL)
      const right = compare(`${item.name} right`, ts.outR, rust.outR)
      const max = Math.max(left.max, right.max)
      const rms = Math.max(left.rms, right.rms)
      if (max > worst) worst = max
      if (rms > worstRms) worstRms = rms
      scores.push({ name: item.name, max, rms })
    }
    console.log(`DSP_PARITY maxAbs=${worst} rms=${worstRms} wasmBytes=${DSP_WASM_BYTE_LENGTH} tolerance=${TOLERANCE}`)
    for (const score of scores) console.log(`DSP_PARITY_CASE ${score.name} maxAbs=${score.max} rms=${score.rms}`)
    expect(worst).toBeLessThan(TOLERANCE)
  })

  it('glides a knob the same way as glideValue', async () => {
    const rate = 48000
    const block = 128
    const frames = block * 12
    const left = sine(440, frames, rate, 0.35)
    const right = sine(880, frames, rate, 0.2)
    const start: Record<string, number> = defaultParams('eq')
    const target: Record<string, number> = { ...start, midG: 6, lowF: 320 }
    const tsEq = createEq(rate)
    tsEq.reset()
    const rust = await WasmEq.create()
    rust.prepare(rate, block)
    const layout = rust.layout()
    for (const control of layout.controls) {
      if (target[control.key] !== start[control.key]) rust.setParameter(control.paramId, target[control.key])
    }
    const current = { ...start }
    const outTsL = new Float32Array(frames)
    const outTsR = new Float32Array(frames)
    const outRsL = new Float32Array(frames)
    const outRsR = new Float32Array(frames)
    let worst = 0
    for (let offset = 0; offset < frames; offset += block) {
      const count = Math.min(block, frames - offset)
      const params: Record<string, number> = {}
      for (const key of Object.keys(start)) {
        const next = glideValue(current[key], target[key], count, rate)
        current[key] = next
        params[key] = next
      }
      const glideCheck = rust.glide(start.midG, target.midG, count, rate)
      expect(Math.abs(glideCheck - glideValue(start.midG, target.midG, count, rate))).toBeLessThan(1e-12)
      tsEq.process(
        [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
        [outTsL.subarray(offset, offset + count), outTsR.subarray(offset, offset + count)],
        params,
        context(rate, offset),
      )
      rust.processBlock(
        [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
        [outRsL.subarray(offset, offset + count), outRsR.subarray(offset, offset + count)],
      )
    }
    worst = Math.max(compare('glide left', outTsL, outRsL).max, compare('glide right', outTsR, outRsR).max)
    console.log(`DSP_PARITY_GLIDE maxAbs=${worst}`)
    rust.destroy()
  })

  it('round-trips state with the TypeScript plugin and keeps the layout', async () => {
    const spec = descriptor('eq')
    expect(spec).toBeTruthy()
    const rust = await WasmEq.create()
    rust.prepare(48000, 128)
    const layout = rust.layout()
    expect(layout.id).toBe('eq')
    expect(layout.name).toBe(spec!.name)
    expect(layout.version).toBe(spec!.version)
    expect(layout.controls.length).toBe(spec!.params.length)
    for (let i = 0; i < spec!.params.length; i++) {
      const control = layout.controls[i]
      const param = spec!.params[i]
      expect(control.paramId).toBe(i)
      expect(control.key).toBe(param.id)
      expect(control.name).toBe(param.name)
      expect(control.min).toBe(param.min)
      expect(control.max).toBe(param.max)
      expect(control.defaultValue).toBe(param.default)
      expect(control.unit).toBe(param.unit)
      expect(control.automatable).toBe(param.automatable)
    }
    const native = createNativePlugin('eq', 48000)
    expect(native).toBeTruthy()
    const mid = native!.layout().controls.find((control) => control.key === 'midG')!
    const lowQ = native!.layout().controls.find((control) => control.key === 'lowQ')!
    native!.setParameter(mid.paramId, 4.5)
    native!.setParameter(lowQ.paramId, 1.4)
    const bytes = native!.getState()
    expect(rust.setState(bytes)).toBe(true)
    expect(rust.getParameter(mid.paramId)).toBeCloseTo(4.5, 6)
    expect(rust.getParameter(lowQ.paramId)).toBeCloseTo(1.4, 6)
    const back = rust.getState()
    native!.setParameter(mid.paramId, 0)
    native!.setState(back)
    expect(native!.getParameter(mid.paramId)).toBeCloseTo(4.5, 6)
    expect(native!.getParameter(lowQ.paramId)).toBeCloseTo(1.4, 6)
    const text = new TextDecoder().decode(bytes)
    const parsed = JSON.parse(text) as { v: number; params: Record<string, number> }
    expect(parsed.v).toBe(1)
    const held = { ...defaultParams('eq') }
    for (const control of layout.controls) held[control.key] = rust.getParameter(control.paramId)
    const left = sine(440, 1024, 48000, 0.3)
    const right = sine(550, 1024, 48000, 0.2)
    const ts = renderTs(left, right, held, 48000, 128)
    const outL = new Float32Array(left.length)
    const outR = new Float32Array(right.length)
    rust.processArrays([left, right], [outL, outR])
    compare('state left', ts.outL, outL)
    compare('state right', ts.outR, outR)
    expect(rust.latency()).toBe(0)
    rust.destroy()
  })

  it('runs the AudioWorklet processor class by default, and skips it for wasmDsp=0', async () => {
    const flagHost = globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }
    expect(wasmDspRequested()).toBe(true)
    expect(wasmDspRequested({ location: { search: '?wasmDsp=0' } } as typeof globalThis & { location?: { search?: string } })).toBe(false)
    expect(wasmDspRequested({ location: { search: '?wasmDsp=1' } } as typeof globalThis & { location?: { search?: string } })).toBe(true)
    flagHost.__CUEHARBOR_WASM_DSP__ = false
    expect(wasmDspRequested()).toBe(false)
    const blocked = {
      audioWorklet: {
        addModule: () => {
          throw new Error('worklet loaded while the flag was off')
        },
      },
    } as unknown as AudioContext
    expect(await loadWasmEqWorklet(blocked)).toBeNull()

    const registered: { name: string; ctor: new () => WorkletProcessor }[] = []
    class AudioWorkletProcessor {
      port = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage() {},
      }
    }
    const host = globalThis as {
      AudioWorkletProcessor?: typeof AudioWorkletProcessor
      registerProcessor?: (name: string, ctor: new () => WorkletProcessor) => void
      sampleRate?: number
    }
    host.AudioWorkletProcessor = AudioWorkletProcessor
    host.sampleRate = 48000
    host.registerProcessor = (name, ctor) => {
      registered.push({ name, ctor })
    }
    await import('../audio/wasm/eq.worklet.ts')
    expect(registered.map((item) => item.name)).toContain('cueharbor-wasm-eq')
    const processor = new registered[0].ctor()
    await processor.boot
    const frames = 256
    const inputL = sine(440, frames, 48000, 0.4)
    const inputR = sine(660, frames, 48000, 0.2)
    const outputL = new Float32Array(frames)
    const outputR = new Float32Array(frames)
    const ran = processor.process([[inputL, inputR]], [[outputL, outputR]], {})
    expect(ran).toBe(true)
    const ts = renderTs(inputL, inputR, defaultParams('eq'), 48000, 256)
    compare('worklet left', ts.outL, outputL)
    compare('worklet right', ts.outR, outputR)

    ;(globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }).__CUEHARBOR_WASM_DSP__ = true
    const added: string[] = []
    class FakeNode {
      constructor(_ctx: AudioContext, public name: string) {}
    }
    viStubAudioNode(FakeNode)
    const ctx = {
      audioWorklet: {
        addModule: async (url: string) => {
          added.push(String(url))
        },
      },
    } as unknown as AudioContext
    const node = await loadWasmEqWorklet(ctx)
    expect(added.length).toBe(1)
    expect((node as { name?: string } | null)?.name).toBe('cueharbor-wasm-eq')
  })
})

interface WorkletProcessor {
  boot: Promise<void>
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}

function viStubAudioNode(ctor: new (ctx: AudioContext, name: string) => { name: string }) {
  ;(globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = ctor
}

const INSERTS = ['tune', 'eq', 'compressor', 'vocal', 'saturator', 'reverb', 'delay', 'mod', 'limiter'] as const
const PARITY_LIMIT = 1e-5

function renderInsert(
  id: (typeof INSERTS)[number],
  left: Float32Array,
  right: Float32Array,
  params: Record<string, number>,
  rate: number,
  block: number,
  extra: { quality?: 'full' | 'eco'; offline?: boolean; note?: { pitch: number; vel: number } } = {},
) {
  const ts = createCore(id, rate) as ReturnType<typeof createCore> & { note?: (pitch: number, vel: number) => void }
  const rust = new WasmInsert(id, rate)
  ts.reset()
  rust.reset()
  if (extra.note) {
    ts.note?.(extra.note.pitch, extra.note.vel)
    rust.note(extra.note.pitch, extra.note.vel)
  }
  const tsL = new Float32Array(left.length)
  const tsR = new Float32Array(right.length)
  const rsL = new Float32Array(left.length)
  const rsR = new Float32Array(right.length)
  for (let offset = 0; offset < left.length; offset += block) {
    const count = Math.min(block, left.length - offset)
    const ctx = {
      ...context(rate, offset),
      quality: extra.quality ?? 'full' as const,
      offline: extra.offline ?? false,
    }
    ts.process(
      [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
      [tsL.subarray(offset, offset + count), tsR.subarray(offset, offset + count)],
      params,
      ctx,
    )
    rust.process(
      [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
      [rsL.subarray(offset, offset + count), rsR.subarray(offset, offset + count)],
      params,
      ctx,
    )
  }
  const score = Math.max(maxAbs(tsL, rsL), maxAbs(tsR, rsR))
  const latencyTs = ts.latencySamples || 0
  const latencyRs = rust.latencySamples || 0
  rust.destroy()
  return { score, latencyTs, latencyRs }
}

function maxAbs(a: Float32Array, b: Float32Array) {
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs((a[i] || 0) - (b[i] || 0))
    if (delta > max) max = delta
  }
  return max
}

describe('rust insert parity', () => {
  it('matches every ported insert across rates, blocks, presets, and glides', () => {
    const scores: { name: string; max: number }[] = []
    const rates = [48000, 44100]
    const blocks = [64, 128, 256]
    for (const id of INSERTS) {
      const presets = [{ name: 'defaults', params: {} }, ...(FACTORY[id] ?? []).map((preset) => ({ name: preset.name, params: preset.params }))]
      let worst = 0
      for (const preset of presets) {
        for (const rate of rates) {
          for (const block of blocks) {
            const frames = id === 'tune' || id === 'mod' ? 2048 : 1024
            const params = { ...defaultParams(id), ...preset.params }
            const left = sine(220, frames, rate, 0.35)
            const right = noise(frames, 0.2)
            const rendered = renderInsert(id, left, right, params, rate, block)
            if (rendered.score > worst) worst = rendered.score
            expect(rendered.latencyRs, `${id} ${preset.name} latency`).toBe(rendered.latencyTs)
            expect(rendered.score, `${id} ${preset.name} ${rate} ${block}`).toBeLessThan(PARITY_LIMIT)
          }
        }
      }
      scores.push({ name: id, max: worst })
    }
    const glide = glideInsert('compressor', 'threshold', -24)
    const drive = glideInsert('saturator', 'drive', 0.65)
    scores.push({ name: 'compressor glide', max: glide })
    scores.push({ name: 'saturator glide', max: drive })
    expect(glide).toBeLessThan(PARITY_LIMIT)
    expect(drive).toBeLessThan(PARITY_LIMIT)
    const synth = renderInsert('synth' as 'eq', sine(440, 1024, 48000, 0.05), sine(440, 1024, 48000, 0.05), {}, 48000, 128, { note: { pitch: 60, vel: 0.8 } })
    expect(synth.score).toBeLessThan(PARITY_LIMIT)
    scores.push({ name: 'synth', max: synth.score })
    console.log(`DSP_WASM_BYTES ${DSP_WASM_BYTE_LENGTH}`)
    for (const score of scores) console.log(`DSP_PARITY_PLUGIN ${score.name} maxAbs=${score.max}`)
  })

  it('runs the insert chain through WASM when the flag is on', async () => {
    const rate = 48000
    const frames = 2048
    const block = 128
    const left = sine(330, frames, rate, 0.4)
    const right = sine(440, frames, rate, 0.25)
    const plain = await renderChain(false, left, right, rate, block)
    const flagged = await renderChain(true, left, right, rate, block)
    const max = Math.max(maxAbs(plain.left, flagged.left), maxAbs(plain.right, flagged.right))
    console.log(`DSP_PARITY_CHAIN maxAbs=${max}`)
    expect(max).toBeLessThan(PARITY_LIMIT)
    expect(flagged.latency).toBe(plain.latency)
  })

  it('keeps the flagged chain when offline bounce runs on workers', async () => {
    const host = globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }
    host.__CUEHARBOR_WASM_DSP__ = true
    await preloadWasmInserts()
    await loadModule('eq')
    const rate = 48000
    const length = 256
    const tone = sine(330, length, rate, 0.4)
    const plugin = createPlugin('eq')
    plugin.params.midG = 4
    const opts = {
      tracks: [{
        id: 'vocal',
        type: 'audio',
        input: 'none',
        buffer: [tone, tone.slice()],
        volume: 1,
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
      length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      offline: true,
      create: (pluginId: string, sampleRate: number) => {
        const proc = createProcessor(pluginId, sampleRate)
        if (!proc) throw new Error(`Missing ${pluginId}`)
        expect(proc).toBeInstanceOf(WasmInsert)
        return proc
      },
    }
    const sequential = renderGraph(opts)
    const runner = createNodePool(1)
    try {
      const parallel = await renderGraphParallel(opts, runner)
      const max = Math.max(maxAbs(sequential.master[0], parallel.master[0]), maxAbs(sequential.master[1], parallel.master[1]))
      expect(max).toBeLessThan(PARITY_LIMIT)
    } finally {
      await runner.close()
      delete host.__CUEHARBOR_WASM_DSP__
    }
  })
})

function glideInsert(id: 'compressor' | 'saturator', key: string, target: number) {
  const rate = 48000
  const block = 128
  const frames = block * 8
  const left = sine(180, frames, rate, 0.5)
  const right = noise(frames, 0.15)
  const start = defaultParams(id)
  const goal = { ...start, [key]: target }
  const ts = createCore(id, rate)
  const rust = new WasmInsert(id, rate)
  ts.reset()
  rust.reset()
  const current = { ...start }
  const tsL = new Float32Array(frames)
  const tsR = new Float32Array(frames)
  const rsL = new Float32Array(frames)
  const rsR = new Float32Array(frames)
  let worst = 0
  for (let offset = 0; offset < frames; offset += block) {
    const count = Math.min(block, frames - offset)
    const params: Record<string, number> = {}
    for (const name of Object.keys(start)) {
      params[name] = glideValue(current[name], goal[name], count, rate)
      current[name] = params[name]
    }
    const ctx = { ...context(rate, offset), quality: 'full' as const, offline: false }
    ts.process([left.subarray(offset, offset + count), right.subarray(offset, offset + count)], [tsL.subarray(offset, offset + count), tsR.subarray(offset, offset + count)], params, ctx)
    rust.process([left.subarray(offset, offset + count), right.subarray(offset, offset + count)], [rsL.subarray(offset, offset + count), rsR.subarray(offset, offset + count)], params, ctx)
    worst = Math.max(worst, maxAbs(tsL.subarray(offset, offset + count), rsL.subarray(offset, offset + count)), maxAbs(tsR.subarray(offset, offset + count), rsR.subarray(offset, offset + count)))
  }
  rust.destroy()
  return worst
}

async function renderChain(flag: boolean, left: Float32Array, right: Float32Array, rate: number, block: number) {
  const host = globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }
  if (flag) {
    host.__CUEHARBOR_WASM_DSP__ = true
    await preloadWasmInserts()
  } else host.__CUEHARBOR_WASM_DSP__ = false
  const ids = ['eq', 'compressor', 'saturator', 'reverb', 'limiter']
  const params = [
    { ...defaultParams('eq'), midG: 3, midF: 1200 },
    { ...defaultParams('compressor'), threshold: -18, ratio: 4, makeup: 3, mix: 1 },
    { ...defaultParams('saturator'), drive: 0.35, mix: 0.8 },
    { ...defaultParams('reverb'), mix: 0.25, size: 0.5 },
    { ...defaultParams('limiter'), threshold: -6, ceiling: -1 },
  ]
  const slots: ChainSlot[] = ids.map((id, index) => ({
    id: `slot-${id}`,
    pluginId: id,
    enabled: true,
    wet: id === 'limiter' ? 0.5 : 1,
    params: params[index],
    failed: false,
    sidechain: '',
    processor: createProcessor(id, rate),
  }))
  if (flag) {
    for (const slot of slots) expect(slot.processor).toBeInstanceOf(WasmInsert)
  }
  const pool = prepareChainPool(slots.length, 2, block)
  const outL = new Float32Array(left.length)
  const outR = new Float32Array(right.length)
  let latency = 0
  for (let offset = 0; offset < left.length; offset += block) {
    const count = Math.min(block, left.length - offset)
    const result = processChain(
      slots,
      [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
      [outL.subarray(offset, offset + count), outR.subarray(offset, offset + count)],
      { ...context(rate, offset), quality: 'full', offline: false },
      undefined,
      pool,
    )
    latency = result.latency
  }
  delete host.__CUEHARBOR_WASM_DSP__
  return { left: outL, right: outR, latency }
}
