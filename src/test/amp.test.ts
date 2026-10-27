import { describe, expect, it } from 'vitest'
import { createAmp } from '../audio/plugins/amp'
import { renderGraph } from '../audio/renderGraph'
import {
  AMP_PRESETS,
} from '../model/ampPresets'
import { defaultParams } from '../audio/plugins/catalog'
import {
  cabinetIr,
  chainHasLoop,
  convolve,
  describePitch,
  midiHz,
  reorderSlots,
  slotOrder,
  tunePitch,
} from '../audio/plugins/ampDsp'
import type { Processor } from '../audio/plugins/types'

const rate = 48000

function ctx(quality: 'full' | 'eco' = 'full') {
  return {
    sampleRate: rate,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality,
  }
}

function base(over: Record<string, number> = {}) {
  const params = defaultParams('amp')
  for (let i = 0; i < 8; i++) params[`s${i}`] = 0
  params.gain = 0
  params.master = 1
  params.cab = 1
  params.blend = 0
  params.axis = 0
  params.distance = 0
  params.bass = 0.5
  params.mid = 0.5
  params.treble = 0.5
  params.presence = 0.5
  params.bright = 0
  return { ...params, ...over }
}

function render(params: Record<string, number>, input: Float32Array, quality: 'full' | 'eco' = 'full') {
  const proc = createAmp(rate)
  const left = new Float32Array(input.length)
  const right = new Float32Array(input.length)
  proc.process([input, Float32Array.from(input)], [left, right], params, ctx(quality))
  return { left, right, proc }
}

function renderBlocks(params: Record<string, number>, input: Float32Array, block: number) {
  const proc = createAmp(rate)
  const left = new Float32Array(input.length)
  const right = new Float32Array(input.length)
  for (let offset = 0; offset < input.length; offset += block) {
    const count = Math.min(block, input.length - offset)
    proc.process(
      [input.subarray(offset, offset + count), input.subarray(offset, offset + count)],
      [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
      params,
      ctx(),
    )
  }
  return left
}

function sine(freq: number, samples: number, amp = 0.2) {
  const data = new Float32Array(samples)
  for (let i = 0; i < samples; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return data
}

function mag(buffer: Float32Array, freq: number, start: number, end: number) {
  let real = 0
  let imag = 0
  for (let i = start; i < end; i++) {
    const w = (2 * Math.PI * freq * i) / rate
    real += buffer[i] * Math.cos(w)
    imag -= buffer[i] * Math.sin(w)
  }
  const n = end - start
  return Math.sqrt(real * real + imag * imag) / (n / 2)
}

function rms(buffer: Float32Array, start: number) {
  let sum = 0
  let count = 0
  for (let i = start; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i]
    count += 1
  }
  return Math.sqrt(sum / Math.max(1, count))
}

describe('amp board', () => {
  it('reads E1 through E6 within a cent, including a shifted A4', () => {
    const notes = [28, 40, 52, 64, 76, 88]
    for (const midi of notes) {
      for (const cents of [0, 0.6, -0.6]) {
        const hz = midiHz(midi, 440) * 2 ** (cents / 1200)
        const frame = sine(hz, 8192, 0.4)
        const read = tunePitch(frame, rate, 440)
        expect(read, `midi ${midi} ${cents}c`).not.toBeNull()
        expect(Math.abs((read?.midi ?? 0) - (midi + cents / 100))).toBeLessThan(0.01)
      }
    }
    const a4 = 432
    const read = tunePitch(sine(a4, 8192, 0.4), rate, a4)
    expect(Math.abs((read?.cents ?? 99))).toBeLessThan(1)
    expect(describePitch(450, 450)?.name).toBe('A4')
  })

  it('keeps the tuner readout while mute silences the output', () => {
    const frame = sine(midiHz(64), 8192, 0.3)
    const { left, proc } = render(base({ s0: 1, mute: 1, cab: 0 }), frame)
    expect(rms(left, 0)).toBeLessThan(1e-6)
    expect(Math.abs((proc.tuner?.cents ?? 99))).toBeLessThan(1)
    expect(proc.tuner?.note).toBe(64)
  })

  it('keeps high-gain harmonics from folding back', () => {
    const input = sine(7000, 24000, 0.25)
    const { left } = render(base({ model: 2, gain: 1, cab: 0, master: 0.3 }), input)
    const start = 19200
    const end = 24000
    const fund = mag(left, 7000, start, end)
    const alias = mag(left, 13000, start, end)
    expect(fund).toBeGreaterThan(0.01)
    expect(20 * Math.log10(alias / fund)).toBeLessThan(-70)
  })

  it('reproduces a cabinet impulse and a delayed impulse', () => {
    const ir = cabinetIr({ cab: 0, mic: 0, axis: 0, distance: 0, length: 512, sampleRate: rate })
    const impulse = new Float32Array(700)
    impulse[0] = 1
    const direct = convolve(impulse, ir)
    for (let i = 0; i < ir.length; i++) expect(Math.abs(direct[i] - ir[i])).toBeLessThan(1e-5)
    const delayed = new Float32Array(700)
    delayed[17] = 1
    const shifted = convolve(delayed, ir)
    for (let i = 0; i < ir.length; i++) expect(Math.abs(shifted[i + 17] - ir[i])).toBeLessThan(1e-5)

    const { left } = render(base({ cabA: 0, cab: 1, gain: 0, master: 1, blend: 0 }), impulse)
    for (let i = 0; i < ir.length; i++) expect(Math.abs(left[i] - ir[i])).toBeLessThan(1e-4)

    const on = cabinetIr({ cab: 2, mic: 0, axis: 0, distance: 0, length: 512, sampleRate: rate })
    const off = cabinetIr({ cab: 2, mic: 0, axis: 1, distance: 0.8, length: 512, sampleRate: rate })
    expect(mag(off, 3500, 0, 512)).toBeLessThan(mag(on, 3500, 0, 512) * 0.55)
  })

  it('stores pedal order and makes the gate hear the drive only when it comes first', () => {
    const quiet = sine(220, Math.floor(rate * 0.25), 0.002)
    const driveThenGate = base({ s0: 5, a0: 1, b0: 0.2, s1: 2, a1: 0.5, b1: 0, cab: 0, gain: 0, master: 1 })
    const swapped = reorderSlots(driveThenGate, 0, 1)
    expect(slotOrder(swapped).slice(0, 2)).toEqual([2, 5])
    const open = rms(render(driveThenGate, quiet).left, Math.floor(rate * 0.12))
    const closed = rms(render(swapped, quiet).left, Math.floor(rate * 0.12))
    expect(open).toBeGreaterThan(0.01)
    expect(closed).toBeLessThan(0.001)
    expect(open / Math.max(closed, 1e-8)).toBeGreaterThan(20)
  })

  it('matches a block render to one buffer, and the bounce to that render', () => {
    const input = sine(220, 4096, 0.2)
    const params = base({ model: 1, gain: 0.45, cab: 1, master: 0.7, blend: 0.25 })
    const whole = render(params, input).left
    const blocks = renderBlocks(params, input, 128)
    let worst = 0
    for (let i = 0; i < whole.length; i++) worst = Math.max(worst, Math.abs(whole[i] - blocks[i]))
    expect(worst).toBeLessThan(1e-5)

    const graph = renderGraph({
      tracks: [{
        id: 'gtr',
        type: 'audio',
        input: 'none',
        buffer: [input, input],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        plugins: [{
          id: 'fx',
          pluginId: 'amp',
          version: '1',
          enabled: true,
          wet: 1,
          params,
          sidechain: '',
        }],
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
      automation: [],
      quality: 'full',
      create: () => createAmp(rate) as Processor,
    })
    const law = Math.SQRT1_2
    let graphWorst = 0
    for (let i = 0; i < input.length; i++) graphWorst = Math.max(graphWorst, Math.abs(graph.master[0][i] - blocks[i] * law))
    expect(graphWorst).toBeLessThan(1e-4)
  })

  it('ships more than forty original rigs and can point a loop pedal at a loop insert', () => {
    expect(AMP_PRESETS.length).toBeGreaterThanOrEqual(42)
    const names = new Set(AMP_PRESETS.map((item) => item.name))
    expect(names.size).toBe(AMP_PRESETS.length)
    const banned = ['fender', 'marshall', 'vox', 'mesa', 'boss', 'strymon', 'bandlab', 'line 6', 'univibe']
    for (const name of names) {
      const lower = name.toLowerCase()
      for (const word of banned) expect(lower.includes(word)).toBe(false)
    }
    expect(chainHasLoop([{ pluginId: 'eq' }, { pluginId: 'loop' }])).toBe(true)
    expect(chainHasLoop([{ pluginId: 'amp' }])).toBe(false)
  })
})
