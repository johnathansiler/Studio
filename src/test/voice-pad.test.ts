import { describe, expect, it } from 'vitest'
import { preloadWasmInserts } from '../audio/plugins/createAll'
import { SamplePool, SP1200, createSamplePool, type PitchMode } from '../audio/voices/engine'
import { renderMpcAudio } from '../instruments/mpc/render'
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

function render(pool: SamplePool, frames: number, notes: { offset: number; pad: number; velocity: number }[]) {
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

function arm(pool: SamplePool, mode: PitchMode, vintage = false) {
  const data = tone(8000)
  pool.load(1, data, 48000)
  for (let pad = 0; pad < 16; pad++) {
    const voice = pool.pad(pad)
    voice.setRegion(1, pad * 400, pad * 400 + 500)
    voice.setPitch(pad === 1 ? 7 : 0, pad === 1 ? 50 : 0, mode)
    voice.setReverse(pad === 2)
    voice.setHold(pad === 3)
    voice.setChokeGroup(pad < 2 ? 1 : 0)
    voice.setSwing(pad === 4 ? 20 : 0)
    voice.setFilter(pad === 5 ? 200 : 0, pad === 5 ? 4000 : 0)
    voice.setFade(16, 16)
    if (vintage && pad === 6) voice.setVintage({ ...SP1200, wow: 0.3, flutter: 0.2, noise: 0.04, crackle: 0.05, lowpass: 7000 })
  }
}

describe('pad voice pool', () => {
  it('lets sixteen pads play slices of one buffer, including reverse, hold, and swing', () => {
    const pool = new SamplePool(48000)
    arm(pool, 'vinyl')
    const left = render(pool, 256, [
      { offset: 0, pad: 0, velocity: 0.9 },
      { offset: 0, pad: 2, velocity: 0.9 },
      { offset: 0, pad: 4, velocity: 0.9 },
    ])
    expect(left.some((sample) => Math.abs(sample) > 0.01)).toBe(true)
    const early = left.slice(0, 20).reduce((sum, sample) => sum + Math.abs(sample), 0)
    const swung = new SamplePool(48000)
    arm(swung, 'vinyl')
    const late = render(swung, 256, [{ offset: 0, pad: 4, velocity: 0.9 }])
    const before = late.slice(0, 20).reduce((sum, sample) => sum + Math.abs(sample), 0)
    expect(before).toBe(0)
    expect(late.slice(20, 80).some((sample) => Math.abs(sample) > 0.001)).toBe(true)
    expect(early).toBeGreaterThan(0)
  })

  it('matches the Rust pool for vinyl, stretch, vintage, choke, and note repeat', async () => {
    await preloadWasmInserts()
    const cases: { name: string; mode: PitchMode; vintage: boolean; notes: { offset: number; pad: number; velocity: number }[] }[] = [
      { name: 'vinyl', mode: 'vinyl', vintage: false, notes: [{ offset: 0, pad: 0, velocity: 0.8 }, { offset: 32, pad: 1, velocity: 0.7 }] },
      { name: 'stretch', mode: 'stretch', vintage: false, notes: [{ offset: 0, pad: 1, velocity: 0.8 }] },
      { name: 'vintage', mode: 'vinyl', vintage: true, notes: [{ offset: 0, pad: 6, velocity: 1 }] },
      { name: 'choke', mode: 'vinyl', vintage: false, notes: [{ offset: 0, pad: 0, velocity: 0.9 }, { offset: 40, pad: 1, velocity: 0.9 }] },
      { name: 'repeat 1/16', mode: 'vinyl', vintage: false, notes: repeats(6000, 4) },
      { name: 'repeat 1/32', mode: 'vinyl', vintage: false, notes: repeats(3000, 4) },
    ]
    for (const item of cases) {
      const ts = new SamplePool(48000)
      const rust = createSamplePool(48000)
      arm(ts, item.mode, item.vintage)
      arm(rust, item.mode, item.vintage)
      const frames = item.name.startsWith('repeat') ? 14000 : 512
      const a = render(ts, frames, item.notes)
      const b = render(rust, frames, item.notes)
      const max = maxAbs(a, b)
      console.log(`PAD_PARITY ${item.name} maxAbs=${max}`)
      expect(max, item.name).toBeLessThan(1e-5)
    }
  })

  it('renders a Beat Machine kit through the same pool', async () => {
    await preloadWasmInserts()
    const kit = createKit()
    const pad = kit.banks[0][0]
    pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 2, bufferId: 'kick' }]
    const buffers = new Map([['kick', { sampleRate: 48000, samples: tone(960) }]])
    const notes = [0, 1, 2, 3].map((step) => ({ pitch: pad.pitch, startBeat: step * 0.25, durationBeats: 0.2, velocity: 0.85 }))
    const host = globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }
    host.__CUEHARBOR_WASM_DSP__ = false
    const ts = renderMpcAudio({ sampleRate: 48000, tempo: 120, notes, pads: [pad], buffers, output: 'audio' })
    delete host.__CUEHARBOR_WASM_DSP__
    const rust = renderMpcAudio({ sampleRate: 48000, tempo: 120, notes, pads: [pad], buffers, output: 'audio' })
    expect(ts.left.some((sample) => Math.abs(sample) > 0.01)).toBe(true)
    const max = maxAbs(ts.left, rust.left)
    console.log(`PAD_PARITY kit 1/16 maxAbs=${max}`)
    expect(max).toBeLessThan(1e-5)
    const thirty = [0, 1, 2, 3].map((step) => ({ pitch: pad.pitch, startBeat: step * 0.125, durationBeats: 0.1, velocity: 0.8 }))
    host.__CUEHARBOR_WASM_DSP__ = false
    const ts32 = renderMpcAudio({ sampleRate: 48000, tempo: 120, notes: thirty, pads: [pad], buffers, output: 'audio' })
    delete host.__CUEHARBOR_WASM_DSP__
    const rust32 = renderMpcAudio({ sampleRate: 48000, tempo: 120, notes: thirty, pads: [pad], buffers, output: 'audio' })
    expect(maxAbs(ts32.left, rust32.left)).toBeLessThan(1e-5)
  })
})

function repeats(step: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({ offset: index * step, pad: 0, velocity: 0.8 }))
}
