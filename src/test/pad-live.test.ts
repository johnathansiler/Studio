import { describe, expect, it } from 'vitest'
import { preloadWasmInserts } from '../audio/plugins/createAll'
import { SamplePool, createSamplePool, swapWasmPool, type PitchMode } from '../audio/voices/engine'
import { PAD_LATENCY_SAMPLES, PadGraph, noteOffset } from '../audio/voices/live'
import { planPads, swingSamples, vintageStage } from '../audio/voices/program'
import { FACTORY_VINTAGE } from '../model/padChop'
import { createKit } from '../model/padMachine'

function tone(length: number, freq = 220) {
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / 48000) * 0.6
  return data
}

function maxAbs(a: Float32Array, b: Float32Array) {
  let max = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs((a[i] || 0) - (b[i] || 0)))
  return max
}

function render(pool: SamplePool | ReturnType<typeof createSamplePool>, frames: number, notes: { offset: number; pad: number; velocity: number }[]) {
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const block = 128
  for (let offset = 0; offset < frames; offset += block) {
    const count = Math.min(block, frames - offset)
    for (const note of notes) {
      if (note.offset >= offset && note.offset < offset + count) pool.note(note.offset - offset, note.pad, note.velocity)
    }
    pool.process(left.subarray(offset, offset + count), right.subarray(offset, offset + count))
  }
  return left
}

describe('live pad pool', () => {
  it('places a hit at the start of the block with no added delay', () => {
    expect(PAD_LATENCY_SAMPLES).toBe(0)
    expect(noteOffset(2, 2, 128, 48000)).toBe(0)
    expect(noteOffset(2 + 10 / 48000, 2, 128, 48000)).toBe(10)
    expect(noteOffset(2 + 128 / 48000, 2, 128, 48000)).toBeNull()
    expect(noteOffset(1.9, 2, 128, 48000)).toBe(0)
    const pool = new SamplePool(48000)
    const data = new Float32Array(128)
    data[0] = 1
    pool.load(1, data, 48000)
    const voice = pool.pad(0)
    voice.setRegion(1, 0, 128)
    voice.setFade(0, 0)
    voice.setSwing(0)
    voice.setPitch(0, 0, 'vinyl')
    pool.note(0, 0, 1)
    const left = new Float32Array(128)
    pool.process(left, new Float32Array(128))
    expect(Math.abs(left[0])).toBeGreaterThan(0.5)
    const graph = new PadGraph(48000, pool)
    expect(graph.latencySamples).toBe(0)
  })

  it('arms chop region, vintage, pitch, choke, hold, reverse, swing, and high-pass', () => {
    const kit = createKit()
    const pad = kit.banks[0][0]
    const data = tone(8000)
    pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 1, bufferId: 'loop' }]
    pad.region = { start: 0.25, end: 0.5, loop: false, loopStart: 0, loopEnd: 1, reverse: true }
    pad.tune = 0
    pad.tuneCents = 0
    pad.choke = 2
    pad.gate = 'hold'
    pad.swing = 75
    pad.highpass = 0
    pad.filter = 0.4
    pad.level = 0.8
    const plan = planPads({
      pads: [pad],
      buffers: [{ id: 'loop', samples: data, sampleRate: 48000 }],
      vintage: { macro: 1, table: FACTORY_VINTAGE[0].table, presetName: 'SP-1200' },
      chop: {
        bufferId: 'loop', name: 'Loop', mode: 'even', even: 8, sensitivity: 0.5, grid: 'quarter',
        tempoSource: 'project', sampleBpm: 120, sliceStart: 'start', markers: [], root: 0, modeName: 'minor',
        semitones: 3, cents: 10, pitchMode: 'stretch', highpass: 0.5,
      },
      sampleRate: 48000,
      tempo: 120,
    })
    const slot = plan.slots[0]
    expect(slot.start).toBe(2000)
    expect(slot.end).toBe(4000)
    expect(slot.reverse).toBe(true)
    expect(slot.hold).toBe(true)
    expect(slot.choke).toBe(2)
    expect(slot.mode).toBe('stretch')
    expect(slot.semis).toBeCloseTo(4)
    expect(slot.cents).toBeCloseTo(10)
    expect(slot.swing).toBe(swingSamples(75, 48000, 120))
    expect(slot.swing).toBe(3000)
    expect(slot.highpass).toBeGreaterThan(100)
    expect(slot.lowpass).toBeGreaterThan(80)
    expect(slot.vintage.bitDepth).toBeGreaterThan(0)
    expect(vintageStage({ wow: 0, crackle: 0, lowpass: 0, bits: 0, rate: 0 }).bitDepth).toBe(0)
  })

  it('matches the Rust pool and falls back when wasm is off or fails to load', async () => {
    await preloadWasmInserts()
    const data = tone(4000)
    const arm = (pool: SamplePool | ReturnType<typeof createSamplePool>, mode: PitchMode) => {
      pool.load(1, data, 48000)
      const pad = pool.pad(0)
      pad.setRegion(1, 100, 1800)
      pad.setFade(16, 16)
      pad.setPitch(mode === 'stretch' ? 5 : 0, 0, mode)
      pad.setReverse(false)
      pad.setHold(false)
      pad.setChokeGroup(0)
      pad.setSwing(0)
      pad.setFilter(0, 0)
      pad.setVintage({ bitDepth: 12, sampleRate: 26040, wow: 0.1, flutter: 0.05, noise: 0.02, crackle: 0.02, lowpass: 8000 })
    }
    const ts = new SamplePool(48000)
    const rust = createSamplePool(48000)
    arm(ts, 'vinyl')
    arm(rust, 'vinyl')
    const notes = [{ offset: 0, pad: 0, velocity: 0.8 }]
    expect(maxAbs(render(ts, 512, notes), render(rust, 512, notes))).toBeLessThan(1e-5)
    const stretchTs = new SamplePool(48000)
    const stretchRust = createSamplePool(48000)
    arm(stretchTs, 'stretch')
    arm(stretchRust, 'stretch')
    expect(maxAbs(render(stretchTs, 512, notes), render(stretchRust, 512, notes))).toBeLessThan(1e-5)
    const host = globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }
    host.__CUEHARBOR_WASM_DSP__ = false
    expect(createSamplePool(48000)).toBeInstanceOf(SamplePool)
    delete host.__CUEHARBOR_WASM_DSP__
    const restore = swapWasmPool(() => { throw new Error('load failed') })
    expect(createSamplePool(48000)).toBeInstanceOf(SamplePool)
    restore()
  })
})
