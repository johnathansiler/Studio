import { describe, expect, it } from 'vitest'
import { defaultParams } from '../audio/plugins/catalog'
import { createDeesser } from '../audio/plugins/dynamics'
import { createTune } from '../audio/plugins/tune'
import { tuneLatency } from '../audio/plugins/catalog'
import { yinPitch } from '../audio/plugins/psola'
import type { Processor } from '../audio/plugins/types'
import {
  FET_RATIOS,
  VARI_TIMES,
  VU_DBFS,
  cascadeDb,
  channelQ,
  fetReduction,
  oversampleBlock,
  passiveFilters,
  preFilters,
  propQ,
  tapeBumpHz,
  vcaReduction,
  variReduction,
} from '../audio/plugins/models/analog'
import { channelFilters, propFilters } from '../audio/plugins/models/eqs'
import { createBus, createFet, createOpto, createPeak, createVari } from '../audio/plugins/models/dynamics'
import { createChannel, createFocus, createPassive, createPre, createProp } from '../audio/plugins/models/eqs'
import { createSum, createTape } from '../audio/plugins/models/color'
import { createBbd, createConv, createDigital, createEcho, createEnsemble, createHall, createPhase, createPlate, createRotor } from '../audio/plugins/models/space'
import { moduleFor } from '../audio/plugins/models'

const rate = 48000

function sine(freq: number, seconds: number, amp = 0.2) {
  const data = new Float32Array(Math.floor(rate * seconds))
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return data
}

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

function render(processor: Processor, input: Float32Array, params: Record<string, number>, quality: 'full' | 'eco' = 'full') {
  const left = new Float32Array(input.length)
  const right = new Float32Array(input.length)
  processor.process([input, input], [left, right], params, ctx(quality))
  return left
}

function finite(buffer: Float32Array) {
  for (let i = 0; i < buffer.length; i++) if (!Number.isFinite(buffer[i])) return false
  return true
}

function rmsDb(buffer: Float32Array, start: number) {
  let sum = 0
  let count = 0
  for (let i = start; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i]
    count += 1
  }
  return 10 * Math.log10(sum / count)
}

function binPower(buffer: Float32Array, freq: number) {
  let real = 0
  let imag = 0
  const start = Math.floor(buffer.length * 0.4)
  for (let i = start; i < buffer.length; i++) {
    const w = (2 * Math.PI * freq * i) / rate
    real += buffer[i] * Math.cos(w)
    imag -= buffer[i] * Math.sin(w)
  }
  return real * real + imag * imag
}

describe('hardware models', () => {
  it('matches the published FET ratios and the 20–800 µs attack range', () => {
    expect(FET_RATIOS.slice(0, 4)).toEqual([4, 8, 12, 20])
    const over = 12
    for (const [index, ratio] of [4, 8, 12, 20].entries()) {
      const expected = over * (1 - 1 / ratio)
      expect(Math.abs(fetReduction(over, index) - expected)).toBeLessThan(0.4)
    }
    expect(fetReduction(over, 4)).toBeGreaterThan(fetReduction(over, 3))
    const amp = 10 ** ((VU_DBFS + over) / 20)
    const processor = createFet(rate)
    render(processor, sine(1000, 0.35, amp), { ...defaultParams('fet'), input: 0, output: 0, ratio: 0, attack: 0.02, release: 80 })
    expect(Math.abs((processor.meter?.gr ?? 0) - fetReduction(over, 0))).toBeLessThan(1.2)
  })

  it('keeps an opto tail after the fast release', () => {
    const processor = createOpto(rate)
    const loud = sine(200, 0.25, 0.5)
    render(processor, loud, { peak: 1, gain: 0 })
    const steady = processor.meter?.gr ?? 0
    expect(steady).toBeGreaterThan(2)
    render(processor, new Float32Array(Math.floor(rate * 0.2)), { peak: 1, gain: 0 })
    const later = processor.meter?.gr ?? 0
    expect(later).toBeGreaterThan(steady * 0.15)
    expect(later).toBeLessThan(steady * 0.7)
  })

  it('follows the VCA 2/4/10 static law within 1 dB', () => {
    expect(vcaReduction(12, 0)).toBeCloseTo(6, 5)
    expect(vcaReduction(12, 1)).toBeCloseTo(9, 5)
    expect(vcaReduction(12, 2)).toBeCloseTo(10.8, 5)
    const processor = createBus(rate)
    const amp = 10 ** (-6 / 20)
    render(processor, sine(1000, 0.3, amp), { ...defaultParams('bus'), threshold: -18, ratio: 1, attack: 0, release: 0, hpf: 20, makeup: 0 })
    expect(Math.abs((processor.meter?.gr ?? 0) - 9)).toBeLessThan(1)
  })

  it('uses the published vari-mu time chart', () => {
    expect(VARI_TIMES[0]).toMatchObject({ attack: 0.2, release: 300 })
    expect(VARI_TIMES[1].release).toBe(800)
    expect(VARI_TIMES[2]).toMatchObject({ attack: 0.4, release: 2000 })
    expect(VARI_TIMES[3]).toMatchObject({ attack: 0.8, release: 5000 })
    expect(VARI_TIMES[4].slow).toBeGreaterThan(VARI_TIMES[4].release)
    expect(variReduction(0)).toBeGreaterThan(0)
    expect(variReduction(-20)).toBe(0)
  })

  it('makes the passive low boost and atten sit at different corners', () => {
    const both = passiveFilters(rate, { lowF: 2, lowBoost: 1, lowAtten: 1, highBoost: 0, highAtten: 0 })
    const low = cascadeDb(both, 60, rate)
    const dip = cascadeDb(both, 180, rate)
    expect(low).toBeGreaterThan(2)
    expect(dip).toBeLessThan(low - 1)
  })

  it('steps the preamp shelf and adds even harmonics with drive', () => {
    const filters = preFilters(rate, { hp: 0, lowF: 2, lowG: 12, midG: 0, highG: 0 })
    expect(cascadeDb(filters, 30, rate)).toBeGreaterThan(10)
    const plain = render(createPre(rate), sine(200, 0.2, 0.2), { ...defaultParams('pre'), drive: 0 })
    const driven = render(createPre(rate), sine(200, 0.2, 0.2), { ...defaultParams('pre'), drive: 0.8 })
    expect(binPower(driven, 400) / binPower(driven, 200)).toBeGreaterThan(binPower(plain, 400) / Math.max(1e-12, binPower(plain, 200)))
  })

  it('narrows the brown channel curve and the proportional-Q peak', () => {
    expect(channelQ(1)).toBeGreaterThan(channelQ(0))
    const black = channelFilters(rate, { curve: 0, lmfF: 2, lmfG: 10, lfG: 0, hmfG: 0, hfG: 0 })
    const brown = channelFilters(rate, { curve: 1, lmfF: 2, lmfG: 10, lfG: 0, hmfG: 0, hfG: 0 })
    const center = 800
    expect(cascadeDb(brown, center * 2, rate)).toBeLessThan(cascadeDb(black, center * 2, rate) - 0.4)
    expect(propQ(12)).toBeGreaterThan(propQ(2))
    const wide = propFilters(rate, { freq: 6, gain: 2 })
    const narrow = propFilters(rate, { freq: 6, gain: 12 })
    const freq = 2500
    const wideOff = cascadeDb(wide, freq * 2, rate) - cascadeDb(wide, freq, rate)
    const narrowOff = cascadeDb(narrow, freq * 2, rate) - cascadeDb(narrow, freq, rate)
    expect(narrowOff).toBeLessThan(wideOff)
  })

  it('cuts a focus band, ducks it when dynamic, and keeps the other channel in side mode', () => {
    const params = { ...defaultParams('focus'), f1: 1000, g1: -12, q1: 4, dynamic: 0, linear: 0, ms: 0 }
    const cut = render(createFocus(rate), sine(1000, 0.2, 0.2), params)
    const dry = rmsDb(sine(1000, 0.2, 0.2), Math.floor(rate * 0.05))
    expect(rmsDb(cut, Math.floor(rate * 0.05))).toBeLessThan(dry - 6)
    const quiet = render(createFocus(rate), sine(1000, 0.25, 0.02), { ...params, dynamic: 1, threshold: -12, g1: 8 })
    const loud = render(createFocus(rate), sine(1000, 0.25, 0.4), { ...params, dynamic: 1, threshold: -12, g1: 8 })
    const quietGain = rmsDb(quiet, Math.floor(rate * 0.1)) - rmsDb(sine(1000, 0.25, 0.02), Math.floor(rate * 0.1))
    const loudGain = rmsDb(loud, Math.floor(rate * 0.1)) - rmsDb(sine(1000, 0.25, 0.4), Math.floor(rate * 0.1))
    expect(loudGain).toBeLessThan(quietGain - 1)
  })

  it('puts the tape head bump lower at the slow speed', () => {
    expect(tapeBumpHz(0)).toBeLessThan(tapeBumpHz(2))
    expect(tapeBumpHz(1)).toBeCloseTo(55, 3)
    const processor = createTape(rate)
    const quiet = render(processor, sine(1000, 0.1, 0.2), { ...defaultParams('tape'), wow: 0, hiss: 0, drive: 0 })
    expect(finite(quiet)).toBe(true)
  })

  it('adds more harmonics in tube summing than on the console curve', () => {
    const tone = sine(220, 0.2, 0.35)
    const console = render(createSum(rate), tone, { drive: 0.7, tube: 0 })
    const tube = render(createSum(rate), tone, { drive: 0.7, tube: 1 })
    const ratio = (buffer: Float32Array) => binPower(buffer, 440) / Math.max(1, binPower(buffer, 220))
    expect(ratio(tube)).toBeGreaterThan(ratio(console))
  })

  it('holds a true-peak ceiling and stays finite', () => {
    const hot = sine(12000, 0.15, 1)
    const limited = render(createPeak(rate), hot, { ceiling: -1, release: 40 })
    const start = 96
    let peak = 0
    for (let i = start; i < limited.length - 1; i++) {
      peak = Math.max(peak, Math.abs(limited[i]), Math.abs(limited[i] + (limited[i + 1] - limited[i]) * 0.5))
    }
    const db = 20 * Math.log10(peak)
    expect(db).toBeLessThan(-0.4)
    expect(finite(limited)).toBe(true)
  })

  it('keeps aliases of a shaped sine under -80 dB at 4x', () => {
    const tone = sine(5000, 0.2, 0.25)
    const shaped = oversampleBlock(tone, 4, (sample) => Math.tanh(sample * 2))
    const fundamental = binPower(shaped, 5000)
    const alias = binPower(shaped, 13000)
    expect(10 * Math.log10(alias / fundamental)).toBeLessThan(-80)
    expect(finite(shaped)).toBe(true)
  })

  it('reduces sibilance without taking the low fundamental', () => {
    const params = { freq: 6500, threshold: -30, amount: 1 }
    const low = render(createDeesser(rate), sine(200, 0.2, 0.3), params)
    const high = render(createDeesser(rate), sine(6500, 0.2, 0.3), params)
    const lowLoss = rmsDb(sine(200, 0.2, 0.3), 2000) - rmsDb(low, 2000)
    const highLoss = rmsDb(sine(6500, 0.2, 0.3), 2000) - rmsDb(high, 2000)
    expect(highLoss).toBeGreaterThan(lowLoss + 1)
  })

  it('leaves notes inside the flex window alone', () => {
    const input = sine(445, 0.45, 0.35)
    const base = { ...defaultParams('tune'), amount: 1, retune: 1, humanize: 0, mode: 0, minHz: 80, maxHz: 1000, transpose: 0, mask: 0, root: -1, scaleIndex: -1 }
    const hard = render(createTune(rate), input, { ...base, flex: 0 })
    const flexed = render(createTune(rate), input, { ...base, flex: 1 })
    const skip = tuneLatency(rate) + 4000
    const hardPitch = yinPitch(hard.subarray(skip, skip + 4096), rate, 80, 1000).hz
    const flexPitch = yinPitch(flexed.subarray(skip, skip + 4096), rate, 80, 1000).hz
    expect(Math.abs(1200 * Math.log2(hardPitch / 440))).toBeLessThan(20)
    expect(Math.abs(flexPitch - 445)).toBeLessThan(Math.abs(hardPitch - 445))
  })

  it('places a digital delay on the clock and stays finite everywhere', () => {
    const impulse = new Float32Array(Math.floor(rate * 0.4))
    impulse[0] = 0.8
    const delayed = render(createDigital(rate), impulse, { time: 100, feedback: 0, mix: 1 })
    let peakAt = 0
    for (let i = 1; i < delayed.length; i++) if (Math.abs(delayed[i]) > Math.abs(delayed[peakAt])) peakAt = i
    expect(Math.abs(peakAt - Math.round(0.1 * rate))).toBeLessThan(3)
    const noise = new Float32Array(Math.floor(rate * 0.05))
    for (let i = 0; i < noise.length; i++) noise[i] = ((i * 17) % 100) / 500
    const makers = [createFet, createOpto, createBus, createVari, createPassive, createPre, createChannel, createProp, createFocus, createTape, createSum, createPlate, createHall, createEcho, createBbd, createDigital, createEnsemble, createPhase, createRotor, createPeak]
    for (const make of makers) {
      const processor = make(rate)
      const id = processor === processor
      expect(finite(render(processor, noise, defaultParams(idName(make))))).toBe(true)
      void id
    }
    expect(finite(render(createConv(rate), noise, defaultParams('conv'), 'eco'))).toBe(true)
  })

  it('spends less time in eco mode than the full oversampled pass', () => {
    const input = sine(440, 0.12, 0.2)
    const fullStarted = performance.now()
    render(createFet(rate), input, defaultParams('fet'), 'full')
    render(createTape(rate), input, defaultParams('tape'), 'full')
    render(createPre(rate), input, defaultParams('pre'), 'full')
    const full = performance.now() - fullStarted
    const ecoStarted = performance.now()
    render(createFet(rate), input, defaultParams('fet'), 'eco')
    render(createTape(rate), input, defaultParams('tape'), 'eco')
    render(createPre(rate), input, defaultParams('pre'), 'eco')
    const eco = performance.now() - ecoStarted
    expect(full).toBeLessThan(800)
    expect(eco).toBeLessThan(full * 1.25)
    expect(moduleFor('fet').descriptor.name).toBe('FET')
    expect(moduleFor('plate').presets.some((preset) => preset.name === 'Vocal')).toBe(true)
  })
})

function idName(make: (sampleRate: number) => Processor) {
  const names: Record<string, string> = {
    createFet: 'fet',
    createOpto: 'opto',
    createBus: 'bus',
    createVari: 'vari',
    createPassive: 'passive',
    createPre: 'pre',
    createChannel: 'channel',
    createProp: 'prop',
    createFocus: 'focus',
    createTape: 'tape',
    createSum: 'sum',
    createPlate: 'plate',
    createHall: 'hall',
    createEcho: 'echo',
    createBbd: 'bbd',
    createDigital: 'digital',
    createEnsemble: 'ensemble',
    createPhase: 'phase',
    createRotor: 'rotor',
    createPeak: 'peak',
  }
  return names[make.name] ?? 'fet'
}
