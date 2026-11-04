import { afterEach, describe, expect, it } from 'vitest'
import { createNativePlugin } from '../audio/core/registry'
import { defaultParams, descriptor } from '../audio/plugins/catalog'
import { create as createEq } from '../audio/plugins/eq'
import { glideValue } from '../audio/paramCurve'
import { DSP_WASM_BYTE_LENGTH } from '../audio/wasm/dspBytes'
import { WasmEq } from '../audio/wasm/engine'
import { wasmDspRequested } from '../audio/wasm/flag'
import { loadWasmEqWorklet } from '../audio/wasm/loader'

const TOLERANCE = 1e-6

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

  it('runs the AudioWorklet processor class when the flag is on, and skips it when off', async () => {
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
