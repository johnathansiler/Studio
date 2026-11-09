import { describe, expect, it } from 'vitest'
import { createCore } from '../audio/plugins/dispatch'
import { defaultParams } from '../audio/plugins/catalog'
import { controlText } from '../audio/plugins/readout'
import { BUS_ATTACKS, BUS_RATIOS, BUS_RELEASES, FET_RATIOS } from '../audio/plugins/models/analog'
import { PEDALS } from '../audio/plugins/ampDsp'
import { renderGraph, type GraphTrack } from '../audio/renderGraph'
import { processChain, type ChainSlot } from '../audio/plugins/chain'
import { ProjectStore } from '../state/store'
import { samplesPerQuarter } from '../model/time'
import type { CoreId } from '../audio/plugins/ids'
import {
  RATE,
  bandShare,
  burst,
  correlation,
  finite,
  harmonicRatio,
  impulse,
  levelDb,
  noise,
  peakAbs,
  peakIndex,
  renderProcessor,
  rms,
  sine,
  dominantHz,
  spectralCentroid,
  stereoBalance,
  tailSeconds,
  type RenderOptions,
} from '../../test/helpers/dsp-measure'

function hear(plugin: CoreId, patch: Record<string, number>, input: Float32Array[], options?: RenderOptions) {
  const processor = createCore(plugin, options?.sampleRate ?? RATE)
  const params = { ...defaultParams(plugin), ...patch }
  const left = input[0]
  const right = input[1] ?? left.slice()
  const audio = renderProcessor(processor, [left.slice(), right.slice()], params, options)
  expect(finite(audio[0]), plugin).toBe(true)
  expect(finite(audio[1] ?? audio[0]), plugin).toBe(true)
  return { audio, processor, params }
}

function mono(plugin: CoreId, patch: Record<string, number>, input: Float32Array, options?: RenderOptions) {
  return hear(plugin, patch, [input], options).audio[0]
}

const skip = Math.floor(RATE * 0.05)

describe('control readouts match the DSP steps', () => {
  it('prints bus, FET, and vari values in the units the processor uses', () => {
    FET_RATIOS.forEach((ratio, index) => {
      const text = controlText('compressor', 'fetRatio', index)
      expect(text).toBe(index === 4 ? 'All' : `${ratio}:1`)
    })
    BUS_RATIOS.forEach((ratio, index) => {
      expect(controlText('compressor', 'busRatio', index)).toBe(`${ratio}:1`)
    })
    BUS_ATTACKS.forEach((ms, index) => {
      expect(controlText('compressor', 'busAtk', index)).toBe(`${ms} ms`)
    })
    BUS_RELEASES.forEach((ms, index) => {
      const text = controlText('compressor', 'busRel', index)
      if (ms === 0) expect(text).toBe('Auto')
      else if (ms >= 1000) expect(text).toContain('s')
      else expect(text).toBe(`${ms} ms`)
    })
    expect(controlText('saturator', 'speed', 0)).toBe('7.5 ips')
    expect(controlText('saturator', 'speed', 2)).toBe('30 ips')
    expect(controlText('eq', 'preHp', 0)).toBe('Off')
    expect(controlText('eq', 'preHp', 3)).toBe('160 Hz')
    expect(controlText('amp', 'bass', 0.5)).toBe('0 dB')
    expect(controlText('amp', 'bass', 1)).toBe('+12 dB')
    expect(controlText('reverb', 'mix', 0)).toBe('0%')
    expect(controlText('reverb', 'mix', 1)).toBe('100%')
    expect(controlText('eq', 'pBoost', 0.5)).toBe('6 dB')
    expect(controlText('reverb', 'mode', 2)).toBe('Chamber')
    expect(controlText('limiter', 'shape', 2)).toBe('Shaped')
  })
})

describe('eq controls', () => {
  const air = noise(0.4, 0.2, 5)

  it('moves the high-pass and low-pass the way the frequency labels say', () => {
    const open = spectralCentroid(mono('eq', { kind: 0, hp: 20, lp: 20000 }, air), RATE, skip)
    const tightHp = spectralCentroid(mono('eq', { kind: 0, hp: 1000, lp: 20000 }, air), RATE, skip)
    const tightLp = spectralCentroid(mono('eq', { kind: 0, hp: 20, lp: 1000 }, air), RATE, skip)
    expect(tightHp).toBeGreaterThan(open + 200)
    expect(tightLp).toBeLessThan(open - 200)
  })

  it('raises low, mid, and high gain in the labeled band', () => {
    expect(bandShare(mono('eq', { kind: 0, lowG: 12, lowF: 120 }, air), 120)).toBeGreaterThan(bandShare(mono('eq', { kind: 0, lowG: -12, lowF: 120 }, air), 120))
    expect(bandShare(mono('eq', { kind: 0, midG: 12, midF: 1500, midQ: 2 }, air), 1500, RATE, 0.4)).toBeGreaterThan(bandShare(mono('eq', { kind: 0, midG: -12, midF: 1500, midQ: 2 }, air), 1500, RATE, 0.4))
    expect(bandShare(mono('eq', { kind: 0, highG: 12, highF: 8000 }, air), 8000)).toBeGreaterThan(bandShare(mono('eq', { kind: 0, highG: -12, highF: 8000 }, air), 8000))
  })

  it('moves each band frequency and Q', () => {
    const lowCorner = (lowF: number) => spectralCentroid(mono('eq', { kind: 0, lowG: 12, lowF, lowQ: 0.7 }, air), RATE, skip)
    expect(lowCorner(40)).toBeGreaterThan(lowCorner(800) + 20)
    const midCenter = (midF: number) => bandShare(mono('eq', { kind: 0, midG: 12, midF, midQ: 4 }, air), midF, RATE, 0.3)
    expect(midCenter(4000)).toBeGreaterThan(bandShare(mono('eq', { kind: 0, midG: 12, midF: 400, midQ: 4 }, air), 4000, RATE, 0.3))
    const narrow = bandShare(mono('eq', { kind: 0, midG: 12, midF: 1500, midQ: 8 }, air), 3000, RATE, 0.25)
    const wide = bandShare(mono('eq', { kind: 0, midG: 12, midF: 1500, midQ: 0.2 }, air), 3000, RATE, 0.25)
    expect(wide).toBeGreaterThan(narrow)
  })

  it('treats linear phase as a real delay and still boosts', () => {
    const click = impulse(0.2, 0.8)
    const minPhase = hear('eq', { kind: 6, phase: 0, midG: 6, midF: 1000 }, [click])
    const linear = hear('eq', { kind: 6, phase: 1, midG: 6, midF: 1000 }, [click])
    expect(peakIndex(linear.audio[0])).toBeGreaterThan(peakIndex(minPhase.audio[0]) + 64)
    const tone = sine(1000, 0.3, 0.15)
    const flat = levelDb(mono('eq', { kind: 6, phase: 0, midG: 0, midF: 1000 }, tone), skip)
    const boosted = levelDb(mono('eq', { kind: 6, phase: 0, midG: 10, midF: 1000, midQ: 1 }, tone), skip)
    expect(boosted).toBeGreaterThan(flat + 2)
  })

  it('maps passive boost, cut, air, and bandwidth onto the labeled shelves', () => {
    const boost = bandShare(mono('eq', { kind: 1, pLow: 2, pBoost: 1, pAtten: 0 }, air), 80)
    const flat = bandShare(mono('eq', { kind: 1, pLow: 2, pBoost: 0, pAtten: 0 }, air), 80)
    const cut = bandShare(mono('eq', { kind: 1, pLow: 2, pBoost: 0, pAtten: 1 }, air), 80)
    expect(boost).toBeGreaterThan(flat)
    expect(cut).toBeLessThan(flat)
    const airOn = bandShare(mono('eq', { kind: 1, pHigh: 4, pAir: 1, pWidth: 0.2 }, air), 8000)
    const airOff = bandShare(mono('eq', { kind: 1, pHigh: 4, pAir: 0 }, air), 8000)
    expect(airOn).toBeGreaterThan(airOff)
    const wide = mono('eq', { kind: 1, pHigh: 4, pAir: 1, pWidth: 1 }, air)
    const narrow = mono('eq', { kind: 1, pHigh: 4, pAir: 1, pWidth: 0 }, air)
    expect(correlation(wide, narrow, skip)).toBeLessThan(0.995)
    const cutLow = bandShare(mono('eq', { kind: 1, pCut: 1, pCutF: 0 }, air), 6000)
    const cutHigh = bandShare(mono('eq', { kind: 1, pCut: 1, pCutF: 2 }, air), 6000)
    expect(cutHigh).toBeGreaterThan(cutLow)
  })

  it('steps the preamp frequencies and adds drive harmonics', () => {
    const open = spectralCentroid(mono('eq', { kind: 2, preHp: 0, preLowG: 0 }, air), RATE, skip)
    const closed = spectralCentroid(mono('eq', { kind: 2, preHp: 4, preLowG: 0 }, air), RATE, skip)
    expect(closed).toBeGreaterThan(open + 80)
    const lowShelf = bandShare(mono('eq', { kind: 2, preLow: 0, preLowG: 12 }, air), 180)
    const highShelf = bandShare(mono('eq', { kind: 2, preLow: 3, preLowG: 12 }, air), 180)
    expect(highShelf).toBeGreaterThan(lowShelf)
    expect(bandShare(mono('eq', { kind: 2, preMid: 2, preMidG: 12 }, air), 1600, RATE, 0.4)).toBeGreaterThan(bandShare(mono('eq', { kind: 2, preMid: 2, preMidG: -12 }, air), 1600, RATE, 0.4))
    expect(bandShare(mono('eq', { kind: 2, preHigh: 1, preHighG: 12 }, air), 10000)).toBeGreaterThan(bandShare(mono('eq', { kind: 2, preHigh: 1, preHighG: -12 }, air), 10000))
    const tone = sine(180, 0.3, 0.4)
    const clean = harmonicRatio(mono('eq', { kind: 2, preDrive: 0 }, tone), 180, RATE, skip)
    const driven = harmonicRatio(mono('eq', { kind: 2, preDrive: 1 }, tone), 180, RATE, skip)
    expect(driven).toBeGreaterThan(clean + 0.02)
  })

  it('narrows the channel bells and tilts around the printed frequency', () => {
    const wide = mono('eq', { kind: 3, curve: 0, lmfF: 2, lmfG: 12 }, air)
    const narrow = mono('eq', { kind: 3, curve: 1, lmfF: 2, lmfG: 12 }, air)
    expect(bandShare(narrow, 800, RATE, 0.3)).toBeGreaterThan(bandShare(wide, 800, RATE, 0.3))
    expect(bandShare(mono('eq', { kind: 3, lfF: 1, lfG: 12 }, air), 110)).toBeGreaterThan(bandShare(mono('eq', { kind: 3, lfF: 1, lfG: -12 }, air), 110))
    expect(bandShare(mono('eq', { kind: 3, hmfF: 3, hmfG: 12 }, air), 6000, RATE, 0.4)).toBeGreaterThan(bandShare(mono('eq', { kind: 3, hmfF: 0, hmfG: 12 }, air), 6000, RATE, 0.4))
    expect(bandShare(mono('eq', { kind: 3, hfF: 3, hfG: 12 }, air), 12000)).toBeGreaterThan(bandShare(mono('eq', { kind: 3, hfF: 3, hfG: -12 }, air), 12000))
    const lowTilt = spectralCentroid(mono('eq', { kind: 4, tiltF: 0, tiltG: 12 }, air), RATE, skip)
    const highTilt = spectralCentroid(mono('eq', { kind: 4, tiltF: 10, tiltG: 12 }, air), RATE, skip)
    expect(highTilt).toBeGreaterThan(lowTilt + 30)
    expect(bandShare(mono('eq', { kind: 4, tiltF: 6, tiltG: 12 }, air), 1500, RATE, 0.5)).toBeGreaterThan(bandShare(mono('eq', { kind: 4, tiltF: 6, tiltG: -12 }, air), 1500, RATE, 0.5))
  })

  it('focuses a band, ducks it when dynamic, and delays linear mode', () => {
    const tone = sine(1000, 0.35, 0.2)
    const cut = levelDb(mono('eq', { kind: 5, f1: 1000, g1: -12, q1: 3, dynamic: 0, linear: 0 }, tone), skip)
    const dry = levelDb(tone, skip)
    expect(cut).toBeLessThan(dry - 3)
    const quiet = sine(1000, 0.4, 0.02)
    const loud = sine(1000, 0.4, 0.45)
    const patch = { kind: 5, f1: 1000, g1: 8, q1: 2, dynamic: 1, focusThresh: -18, linear: 0 }
    const quietGain = levelDb(mono('eq', patch, quiet), Math.floor(RATE * 0.12)) - levelDb(quiet, Math.floor(RATE * 0.12))
    const loudGain = levelDb(mono('eq', patch, loud), Math.floor(RATE * 0.12)) - levelDb(loud, Math.floor(RATE * 0.12))
    expect(loudGain).toBeLessThan(quietGain - 0.5)
    const linearPatch = { ...patch, linear: 1 }
    const quietLinear = levelDb(mono('eq', linearPatch, quiet), Math.floor(RATE * 0.18)) - levelDb(quiet, Math.floor(RATE * 0.18))
    const loudLinear = levelDb(mono('eq', linearPatch, loud), Math.floor(RATE * 0.18)) - levelDb(loud, Math.floor(RATE * 0.18))
    expect(loudLinear).toBeLessThan(quietLinear - 0.4)
    const linearOn = hear('eq', { kind: 5, linear: 1, g1: 0, f1: 1000 }, [sine(440, 0.2, 0.2)])
    const linearOff = hear('eq', { kind: 5, linear: 0, g1: 0, f1: 1000 }, [sine(440, 0.2, 0.2)])
    expect(linearOn.processor.latencySamples).toBeGreaterThan(linearOff.processor.latencySamples + 32)
  })

  it('moves the dynamic band, threshold, Q, attack, and release', () => {
    const tone = sine(3000, 0.4, 0.35)
    const onBand = levelDb(mono('eq', { kind: 7, dynF: 3000, dynG: -12, dynQ: 2, dynThresh: -40, dynA: 1, dynR: 20 }, tone), skip)
    const offBand = levelDb(mono('eq', { kind: 7, dynF: 200, dynG: -12, dynQ: 2, dynThresh: -40, dynA: 1, dynR: 20 }, tone), skip)
    expect(onBand).toBeLessThan(offBand - 1)
    const open = levelDb(mono('eq', { kind: 7, dynF: 3000, dynG: -12, dynThresh: 0, dynQ: 2 }, tone), skip)
    expect(onBand).toBeLessThan(open - 1)
    const click = burst(3000, 0.35, 0.02, 0.5, 0.05)
    const early = Math.floor(RATE * 0.03)
    const late = Math.floor(RATE * 0.08)
    const fast = levelDb(mono('eq', { kind: 7, dynF: 3000, dynG: -12, dynThresh: -24, dynQ: 2, dynA: 1, dynR: 30 }, click), early, late)
    const slow = levelDb(mono('eq', { kind: 7, dynF: 3000, dynG: -12, dynThresh: -24, dynQ: 2, dynA: 40, dynR: 30 }, click), early, late)
    expect(slow).toBeGreaterThan(fast + 0.3)
  })
})

describe('compressor, vocal, and saturator controls', () => {
  const tone = sine(220, 0.45, 0.45)

  it('compresses by threshold, ratio, knee, makeup, and mix', () => {
    const deep = levelDb(mono('compressor', { kind: 0, threshold: -40, ratio: 8, attack: 1, release: 40, knee: 0, makeup: 0, mix: 1 }, tone), skip)
    const open = levelDb(mono('compressor', { kind: 0, threshold: 0, ratio: 8, attack: 1, release: 40, knee: 0, makeup: 0, mix: 1 }, tone), skip)
    expect(deep).toBeLessThan(open - 3)
    const gentle = levelDb(mono('compressor', { kind: 0, threshold: -30, ratio: 1, attack: 1, release: 40, makeup: 0, mix: 1 }, tone), skip)
    const hard = levelDb(mono('compressor', { kind: 0, threshold: -30, ratio: 20, attack: 1, release: 40, makeup: 0, mix: 1 }, tone), skip)
    expect(hard).toBeLessThan(gentle - 2)
    const softKnee = levelDb(mono('compressor', { kind: 0, threshold: -12, ratio: 8, knee: 24, makeup: 0, mix: 1 }, sine(220, 0.4, 0.2)), skip)
    const hardKnee = levelDb(mono('compressor', { kind: 0, threshold: -12, ratio: 8, knee: 0, makeup: 0, mix: 1 }, sine(220, 0.4, 0.2)), skip)
    expect(softKnee).toBeLessThan(hardKnee)
    const quiet = sine(440, 0.3, 0.05)
    const plain = levelDb(mono('compressor', { kind: 0, threshold: 0, ratio: 1, makeup: 0, mix: 1 }, quiet), skip)
    const made = levelDb(mono('compressor', { kind: 0, threshold: 0, ratio: 1, makeup: 18, mix: 1 }, quiet), skip)
    expect(made - plain).toBeGreaterThan(16)
    const dry = mono('compressor', { kind: 0, threshold: -40, ratio: 12, mix: 0 }, tone)
    expect(correlation(dry, tone, skip)).toBeGreaterThan(0.99)
  })

  it('attack lets a transient through and release holds the quiet part down', () => {
    const hit = burst(180, 0.45, 0.03, 0.95, 0.12)
    const fast = peakAbs(mono('compressor', { kind: 0, threshold: -30, ratio: 10, attack: 0.1, release: 40, mix: 1 }, hit), 0, Math.floor(RATE * 0.02))
    const slow = peakAbs(mono('compressor', { kind: 0, threshold: -30, ratio: 10, attack: 80, release: 40, mix: 1 }, hit), 0, Math.floor(RATE * 0.02))
    expect(slow).toBeGreaterThan(fast)
    const from = Math.floor(RATE * 0.2)
    const short = levelDb(mono('compressor', { kind: 0, threshold: -24, ratio: 8, attack: 1, release: 5, mix: 1 }, hit), from)
    const held = levelDb(mono('compressor', { kind: 0, threshold: -24, ratio: 8, attack: 1, release: 400, mix: 1 }, hit), from)
    expect(held).toBeLessThan(short - 0.4)
  })

  it('follows the sidechain key instead of the program', () => {
    const program = sine(440, 0.4, 0.05)
    const key = sine(90, 0.4, 0.9)
    const ducked = levelDb(mono('compressor', { kind: 0, threshold: -36, ratio: 12, attack: 1, release: 30, mix: 1 }, program, { sidechain: key }), skip)
    const free = levelDb(mono('compressor', { kind: 0, threshold: -36, ratio: 12, attack: 1, release: 30, mix: 1 }, program), skip)
    expect(ducked).toBeLessThan(free - 2)
  })

  it('FET input, output, ratio, attack, and release match their labels', () => {
    const whisper = sine(440, 0.3, 0.01)
    const low = levelDb(mono('compressor', { kind: 1, fetIn: -12, fetOut: 0, fetRatio: 0 }, whisper), skip)
    const high = levelDb(mono('compressor', { kind: 1, fetIn: 12, fetOut: 0, fetRatio: 0 }, whisper), skip)
    expect(high).toBeGreaterThan(low + 8)
    const down = levelDb(mono('compressor', { kind: 1, fetIn: 0, fetOut: -12, fetRatio: 0 }, sine(440, 0.3, 0.1)), skip)
    const up = levelDb(mono('compressor', { kind: 1, fetIn: 0, fetOut: 12, fetRatio: 0 }, sine(440, 0.3, 0.1)), skip)
    expect(up - down).toBeGreaterThan(20)
    const four = levelDb(mono('compressor', { kind: 1, fetIn: 10, fetOut: 0, fetRatio: 0 }, tone), skip)
    const twenty = levelDb(mono('compressor', { kind: 1, fetIn: 10, fetOut: 0, fetRatio: 3 }, tone), skip)
    expect(twenty).toBeLessThan(four - 0.4)
    const all = mono('compressor', { kind: 1, fetIn: 16, fetOut: 0, fetRatio: 4 }, tone)
    const plain = mono('compressor', { kind: 1, fetIn: 16, fetOut: 0, fetRatio: 0 }, tone)
    expect(levelDb(all, skip)).toBeLessThan(levelDb(plain, skip) - 0.3)
    const hit = burst(200, 0.4, 0.01, 0.9, 0.1)
    const fast = peakAbs(mono('compressor', { kind: 1, fetIn: 12, fetRatio: 3, fetAtk: 0.02, fetRel: 80 }, hit), 0, Math.floor(RATE * 0.008))
    const slow = peakAbs(mono('compressor', { kind: 1, fetIn: 12, fetRatio: 3, fetAtk: 0.8, fetRel: 80 }, hit), 0, Math.floor(RATE * 0.008))
    expect(slow).toBeGreaterThan(fast * 0.98)
    const from = Math.floor(RATE * 0.15)
    const quick = levelDb(mono('compressor', { kind: 1, fetIn: 14, fetRatio: 3, fetAtk: 0.05, fetRel: 50 }, hit), from)
    const long = levelDb(mono('compressor', { kind: 1, fetIn: 14, fetRatio: 3, fetAtk: 0.05, fetRel: 1100 }, hit), from)
    expect(long).toBeLessThan(quick)
  })

  it('opto peak reduction and gain, and the bus steps, match the labels', () => {
    const light = levelDb(mono('compressor', { kind: 2, optoPeak: 0, optoGain: 0 }, tone), Math.floor(RATE * 0.15))
    const heavy = levelDb(mono('compressor', { kind: 2, optoPeak: 1, optoGain: 0 }, tone), Math.floor(RATE * 0.15))
    expect(heavy).toBeLessThan(light - 1)
    const made = levelDb(mono('compressor', { kind: 2, optoPeak: 0, optoGain: 12 }, sine(440, 0.3, 0.08)), skip)
    expect(made).toBeGreaterThan(levelDb(mono('compressor', { kind: 2, optoPeak: 0, optoGain: 0 }, sine(440, 0.3, 0.08)), skip) + 10)
    const bass = sine(70, 0.4, 0.5)
    const wideOpen = levelDb(mono('compressor', { kind: 3, busThresh: -30, busRatio: 2, busAtk: 0, busRel: 0, hpf: 300, busMakeup: 0 }, bass), skip)
    const grabbing = levelDb(mono('compressor', { kind: 3, busThresh: -30, busRatio: 2, busAtk: 0, busRel: 0, hpf: 20, busMakeup: 0 }, bass), skip)
    expect(wideOpen).toBeGreaterThan(grabbing)
    const two = levelDb(mono('compressor', { kind: 3, busThresh: -20, busRatio: 0, hpf: 20, busMakeup: 0 }, tone), skip)
    const ten = levelDb(mono('compressor', { kind: 3, busThresh: -20, busRatio: 2, hpf: 20, busMakeup: 0 }, tone), skip)
    expect(ten).toBeLessThan(two - 0.5)
    const lifted = levelDb(mono('compressor', { kind: 3, busThresh: 0, busRatio: 0, busMakeup: 12 }, sine(440, 0.25, 0.05)), skip)
    const unity = levelDb(mono('compressor', { kind: 3, busThresh: 0, busRatio: 0, busMakeup: 0 }, sine(440, 0.25, 0.05)), skip)
    expect(lifted - unity).toBeGreaterThan(10)
  })

  it('vari-mu time, input, output, and color, plus glue release mode', () => {
    const hit = burst(160, 0.6, 0.05, 0.9, 0.1)
    const from = Math.floor(RATE * 0.25)
    const fast = levelDb(mono('compressor', { kind: 4, variTime: 0, variIn: 12, variOut: 0, variColor: 0 }, hit), from)
    const slow = levelDb(mono('compressor', { kind: 4, variTime: 3, variIn: 12, variOut: 0, variColor: 0 }, hit), from)
    expect(slow).toBeLessThan(fast)
    expect(levelDb(mono('compressor', { kind: 4, variIn: 12, variOut: 0, variColor: 0 }, sine(300, 0.25, 0.1)), skip)).toBeGreaterThan(levelDb(mono('compressor', { kind: 4, variIn: -12, variOut: 0, variColor: 0 }, sine(300, 0.25, 0.1)), skip) + 10)
    expect(levelDb(mono('compressor', { kind: 4, variIn: 0, variOut: 10, variColor: 0 }, sine(300, 0.25, 0.08)), skip)).toBeGreaterThan(levelDb(mono('compressor', { kind: 4, variIn: 0, variOut: -10, variColor: 0 }, sine(300, 0.25, 0.08)), skip) + 15)
    const clean = harmonicRatio(mono('compressor', { kind: 4, variIn: 6, variColor: 0 }, tone), 220, RATE, skip)
    const colored = harmonicRatio(mono('compressor', { kind: 4, variIn: 6, variColor: 1 }, tone), 220, RATE, skip)
    expect(colored).toBeGreaterThan(clean)
    const glueFast = levelDb(mono('compressor', { kind: 5, threshold: -20, ratio: 6, attack: 1, release: 80, releaseMode: 0, makeup: 0, mix: 1 }, hit), from)
    const glueSlow = levelDb(mono('compressor', { kind: 5, threshold: -20, ratio: 6, attack: 1, release: 80, releaseMode: 2, makeup: 0, mix: 1 }, hit), from)
    expect(glueSlow).toBeLessThan(glueFast)
    const glueDry = mono('compressor', { kind: 5, threshold: -30, ratio: 8, mix: 0 }, tone)
    expect(correlation(glueDry, tone, skip)).toBeGreaterThan(0.99)
  })

  it('multiband crossovers and the shared compressor move the level', () => {
    const low = sine(100, 0.35, 0.4)
    const under = levelDb(mono('compressor', { kind: 6, bands: 4, x1: 400, threshold: -30, ratio: 8, attack: 1, release: 40, makeup: 0 }, low), skip)
    const over = levelDb(mono('compressor', { kind: 6, bands: 4, x1: 40, threshold: -30, ratio: 8, attack: 1, release: 40, makeup: 0 }, low), skip)
    expect(Math.abs(under - over)).toBeGreaterThan(0.2)
    const made = levelDb(mono('compressor', { kind: 6, threshold: 0, ratio: 1, makeup: 12 }, sine(440, 0.25, 0.05)), skip)
    const dry = levelDb(mono('compressor', { kind: 6, threshold: 0, ratio: 1, makeup: 0 }, sine(440, 0.25, 0.05)), skip)
    expect(made - dry).toBeGreaterThan(8)
  })

  it('de-ess and gate follow frequency, amount, threshold, ratio, and range', () => {
    const ess = sine(6500, 0.3, 0.3)
    const on = levelDb(mono('vocal', { kind: 1, freq: 6500, threshold: -40, amount: 1 }, ess), skip)
    const offFreq = levelDb(mono('vocal', { kind: 1, freq: 3000, threshold: -40, amount: 1 }, ess), skip)
    const offAmount = levelDb(mono('vocal', { kind: 1, freq: 6500, threshold: -40, amount: 0 }, ess), skip)
    expect(on).toBeLessThan(offFreq - 1)
    expect(on).toBeLessThan(offAmount - 1)
    const openThresh = levelDb(mono('vocal', { kind: 1, freq: 6500, threshold: 0, amount: 1 }, ess), skip)
    expect(on).toBeLessThan(openThresh - 1)
    const quiet = sine(200, 0.35, 0.02)
    const shut = levelDb(mono('vocal', { kind: 2, gate: -20, gateRatio: 8, range: 60, gateAtk: 0.5, gateRel: 20 }, quiet), Math.floor(RATE * 0.08))
    const open = levelDb(mono('vocal', { kind: 2, gate: -80, gateRatio: 1, range: 60 }, quiet), Math.floor(RATE * 0.08))
    expect(shut).toBeLessThan(open - 6)
    const shallow = levelDb(mono('vocal', { kind: 2, gate: -20, gateRatio: 8, range: 0, gateAtk: 0.5, gateRel: 10 }, quiet), Math.floor(RATE * 0.08))
    expect(shut).toBeLessThan(shallow - 4)
  })

  it('saturation drive, tone, mix, tape, clip, and amp tone controls', () => {
    const clean = harmonicRatio(mono('saturator', { kind: 0, drive: 0, tone: 12000, mix: 1 }, tone), 220, RATE, skip)
    const hot = harmonicRatio(mono('saturator', { kind: 0, drive: 1, tone: 12000, mix: 1 }, tone), 220, RATE, skip)
    expect(hot).toBeGreaterThan(clean + 0.05)
    const dark = spectralCentroid(mono('saturator', { kind: 0, drive: 0.8, tone: 800, mix: 1 }, noise(0.3, 0.3)), RATE, skip)
    const bright = spectralCentroid(mono('saturator', { kind: 0, drive: 0.8, tone: 12000, mix: 1 }, noise(0.3, 0.3)), RATE, skip)
    expect(bright).toBeGreaterThan(dark + 80)
    expect(correlation(mono('saturator', { kind: 0, drive: 1, mix: 0 }, tone), tone, skip)).toBeGreaterThan(0.99)
    const slowTape = spectralCentroid(mono('saturator', { kind: 1, drive: 0.2, speed: 0, bias: 0.2, wow: 0, bump: 0, hiss: 0 }, noise(0.35, 0.25)), RATE, skip)
    const fastTape = spectralCentroid(mono('saturator', { kind: 1, drive: 0.2, speed: 2, bias: 0.2, wow: 0, bump: 0, hiss: 0 }, noise(0.35, 0.25)), RATE, skip)
    expect(fastTape).toBeGreaterThan(slowTape)
    const biased = spectralCentroid(mono('saturator', { kind: 1, drive: 0.2, speed: 1, bias: 1, wow: 0, bump: 0, hiss: 0 }, noise(0.35, 0.25)), RATE, skip)
    const openBias = spectralCentroid(mono('saturator', { kind: 1, drive: 0.2, speed: 1, bias: 0, wow: 0, bump: 0, hiss: 0 }, noise(0.35, 0.25)), RATE, skip)
    expect(biased).toBeLessThan(openBias)
    const steady = mono('saturator', { kind: 1, drive: 0.3, wow: 0, hiss: 0, bump: 0 }, tone)
    const wowed = mono('saturator', { kind: 1, drive: 0.3, wow: 1, hiss: 0, bump: 0 }, tone)
    expect(correlation(steady, wowed, skip)).toBeLessThan(0.995)
    expect(bandShare(mono('saturator', { kind: 1, bump: 1, drive: 0.2, hiss: 0, wow: 0 }, noise(0.35, 0.2)), 60)).toBeGreaterThan(bandShare(mono('saturator', { kind: 1, bump: 0, drive: 0.2, hiss: 0, wow: 0 }, noise(0.35, 0.2)), 60))
    const hush = rms(mono('saturator', { kind: 1, hiss: 0, drive: 0, wow: 0, bump: 0 }, sine(440, 0.2, 0)))
    const hiss = rms(mono('saturator', { kind: 1, hiss: 1, drive: 0, wow: 0, bump: 0 }, sine(440, 0.2, 0)))
    expect(hiss).toBeGreaterThan(hush + 1e-5)
    const tube = harmonicRatio(mono('saturator', { kind: 2, drive: 0.8, tube: 1 }, tone), 220, RATE, skip)
    const solid = harmonicRatio(mono('saturator', { kind: 2, drive: 0.8, tube: 0 }, tone), 220, RATE, skip)
    expect(tube).not.toBeCloseTo(solid, 2)
    const oxideDry = mono('saturator', { kind: 3, drive: 1, color: 1, mix: 0 }, tone)
    expect(correlation(oxideDry, tone, skip)).toBeGreaterThan(0.98)
    const softClip = peakAbs(mono('saturator', { kind: 4, drive: 1, clipMode: 0, ceiling: -3 }, sine(180, 0.2, 0.9)))
    const hardClip = peakAbs(mono('saturator', { kind: 4, drive: 1, clipMode: 1, ceiling: -3 }, sine(180, 0.2, 0.9)))
    expect(hardClip).toBeLessThanOrEqual(softClip + 0.05)
    const lowCeil = peakAbs(mono('saturator', { kind: 4, drive: 1, clipMode: 1, ceiling: -6 }, sine(180, 0.2, 0.9)))
    const highCeil = peakAbs(mono('saturator', { kind: 4, drive: 1, clipMode: 1, ceiling: 0 }, sine(180, 0.2, 0.9)))
    expect(lowCeil).toBeLessThan(highCeil)
  })

  it('amp gain, tone stack, master, cab, and model change the sound', () => {
    const base = { kind: 5, cab: 0, master: 0.8, bass: 0.5, mid: 0.5, treble: 0.5, presence: 0.5 }
    expect(harmonicRatio(mono('saturator', { ...base, gain: 1 }, tone), 220, RATE, skip)).toBeGreaterThan(harmonicRatio(mono('saturator', { ...base, gain: 0.05 }, tone), 220, RATE, skip))
    const dark = spectralCentroid(mono('saturator', { ...base, gain: 0.4, bass: 1, treble: 0 }, noise(0.3, 0.25)), RATE, skip)
    const bright = spectralCentroid(mono('saturator', { ...base, gain: 0.4, bass: 0, treble: 1, presence: 1 }, noise(0.3, 0.25)), RATE, skip)
    expect(bright).toBeGreaterThan(dark + 40)
    const quiet = levelDb(mono('saturator', { ...base, gain: 0.3, master: 0.1 }, tone), skip)
    const loud = levelDb(mono('saturator', { ...base, gain: 0.3, master: 1 }, tone), skip)
    expect(loud).toBeGreaterThan(quiet + 6)
    const bare = mono('saturator', { ...base, gain: 0.5, cab: 0 }, tone)
    const cab = mono('saturator', { ...base, gain: 0.5, cab: 1 }, tone)
    expect(correlation(bare, cab, skip)).toBeLessThan(0.99)
    const modelA = mono('saturator', { ...base, gain: 0.8, model: 0 }, tone)
    const modelB = mono('saturator', { ...base, gain: 0.8, model: 5 }, tone)
    expect(correlation(modelA, modelB, skip)).toBeLessThan(0.995)
    const dull = spectralCentroid(mono('saturator', { ...base, gain: 0.5, bright: 0 }, noise(0.3, 0.2)), RATE, skip)
    const brightSw = spectralCentroid(mono('saturator', { ...base, gain: 0.5, bright: 1 }, noise(0.3, 0.2)), RATE, skip)
    expect(brightSw).toBeGreaterThan(dull)
    const muted = rms(mono('saturator', { ...base, gain: 0.6, mute: 1 }, tone))
    expect(muted).toBeLessThan(1e-4)
  })

  it('each pedal except the tuner changes the tone, and removed knobs stay off the tuner', () => {
    const dry = sine(196, 0.9, 0.35)
    const bypass = mono('saturator', { kind: 5, gain: 0, cab: 0, master: 1, s0: 0 }, dry, { tempo: 200 })
    for (const id of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23]) {
      const played = mono('saturator', { kind: 5, gain: 0, cab: 0, master: 1, s0: id, a0: 1, b0: 0.85, z0: 0 }, dry, { tempo: 200 })
      const start = Math.floor(RATE * 0.35)
      const alike = correlation(bypass, played, start)
      const moved = Math.abs(levelDb(played, start) - levelDb(bypass, start))
      expect(alike < 0.995 || moved > 1, PEDALS[id]).toBe(true)
    }
    const tuner = mono('saturator', { kind: 5, gain: 0, cab: 0, master: 1, s0: 1, a0: 1, b0: 1 }, dry)
    expect(correlation(bypass, tuner, skip)).toBeGreaterThan(0.999)
  })
})

describe('reverb, delay, and mod controls', () => {
  const click = impulse(1.6, 0.9)
  const tone = sine(330, 0.5, 0.3)

  it('reverb size, decay, damp, mode, space, and mix', () => {
    const dry = mono('reverb', { kind: 0, mix: 0, size: 1, mode: 2 }, click)
    expect(correlation(dry, click)).toBeGreaterThan(0.99)
    const small = tailSeconds(mono('reverb', { kind: 0, mix: 1, size: 0.1, mode: 0, damp: 0.2 }, click))
    const large = tailSeconds(mono('reverb', { kind: 0, mix: 1, size: 1, mode: 2, damp: 0.2 }, click))
    expect(large).toBeGreaterThan(small)
    const short = tailSeconds(mono('reverb', { kind: 1, mix: 1, size: 0.4, decay: 0.2, damp: 0.2 }, click))
    const long = tailSeconds(mono('reverb', { kind: 1, mix: 1, size: 0.4, decay: 0.96, damp: 0.2 }, click))
    expect(long).toBeGreaterThan(short + 0.05)
    const dull = spectralCentroid(mono('reverb', { kind: 1, mix: 1, decay: 0.8, damp: 0.95, size: 0.6 }, click), RATE, Math.floor(RATE * 0.05))
    const bright = spectralCentroid(mono('reverb', { kind: 1, mix: 1, decay: 0.8, damp: 0, size: 0.6 }, click), RATE, Math.floor(RATE * 0.05))
    expect(bright).toBeGreaterThan(dull)
    const room = mono('reverb', { kind: 3, ir: 0, mix: 1 }, click)
    const plate = mono('reverb', { kind: 3, ir: 1, mix: 1 }, click)
    expect(correlation(room, plate, Math.floor(RATE * 0.02))).toBeLessThan(0.9)
    expect(correlation(mono('reverb', { kind: 3, ir: 0, mix: 0 }, click), click)).toBeGreaterThan(0.99)
  })

  it('delay time, sync, division, feedback, filter, ping, and mix', () => {
    const wet = (patch: Record<string, number>, seconds = 1.2) => mono('delay', { kind: 0, mix: 1, feedback: 0, pingpong: 0, filter: 12000, ...patch }, impulse(seconds, 1))
    expect(peakIndex(wet({ sync: 0, time: 250 }))).toBeGreaterThan(RATE * 0.2)
    expect(peakIndex(wet({ sync: 0, time: 250 }))).toBeLessThan(RATE * 0.3)
    const quarter = peakIndex(wet({ sync: 1, division: 1, time: 10 }, 1.4))
    expect(Math.abs(quarter - RATE * 0.5)).toBeLessThan(RATE * 0.03)
    const eighth = peakIndex(wet({ sync: 1, division: 0.125 }, 0.6))
    expect(eighth).toBeLessThan(quarter / 2)
    const once = wet({ sync: 0, time: 200, feedback: 0 }, 0.8)
    const repeats = wet({ sync: 0, time: 200, feedback: 0.8 }, 0.8)
    expect(tailSeconds(repeats)).toBeGreaterThan(tailSeconds(once) + 0.15)
    const dark = spectralCentroid(wet({ sync: 0, time: 160, feedback: 0.8, filter: 500 }, 1.2), RATE, Math.floor(RATE * 0.47))
    const bright = spectralCentroid(wet({ sync: 0, time: 160, feedback: 0.8, filter: 12000 }, 1.2), RATE, Math.floor(RATE * 0.47))
    expect(bright).toBeGreaterThan(dark)
    const leftOnly = impulse(0.8, 1)
    const straight = hear('delay', { kind: 0, sync: 0, time: 220, feedback: 0.4, mix: 1, pingpong: 0, filter: 8000 }, [leftOnly, new Float32Array(leftOnly.length)])
    const ping = hear('delay', { kind: 0, sync: 0, time: 220, feedback: 0.4, mix: 1, pingpong: 1, filter: 8000 }, [leftOnly, new Float32Array(leftOnly.length)])
    expect(correlation(straight.audio[1], ping.audio[1])).toBeLessThan(0.95)
    expect(correlation(mono('delay', { kind: 0, mix: 0, feedback: 0.5, time: 200 }, impulse(0.4, 1)), impulse(0.4, 1))).toBeGreaterThan(0.99)
  })

  it('echo, bucket, and digital delays honor time, wow, drive, and clock', () => {
    const at = (kind: number, time: number, extra: Record<string, number> = {}) =>
      peakIndex(mono('delay', { kind, time, feedback: 0, mix: 1, wow: 0, drive: 0, clock: 0, ...extra }, impulse(2.2, 1)))
    expect(Math.abs(at(1, 1800) - Math.round(RATE * 1.8))).toBeLessThan(RATE * 0.04)
    expect(Math.abs(at(2, 1500) - Math.round(RATE * 1.5))).toBeLessThan(RATE * 0.04)
    expect(Math.abs(at(3, 400) - Math.round(RATE * 0.4))).toBeLessThan(8)
    const steady = mono('delay', { kind: 1, time: 280, feedback: 0.3, wow: 0, drive: 0, mix: 1 }, tone)
    const wowed = mono('delay', { kind: 1, time: 280, feedback: 0.3, wow: 1, drive: 0, mix: 1 }, tone)
    expect(correlation(steady, wowed, skip)).toBeLessThan(0.995)
    const clean = harmonicRatio(mono('delay', { kind: 1, time: 160, feedback: 0.7, drive: 0, wow: 0, mix: 1 }, tone), 330, RATE, Math.floor(RATE * 0.34))
    const driven = harmonicRatio(mono('delay', { kind: 1, time: 160, feedback: 0.7, drive: 1, wow: 0, mix: 1 }, tone), 330, RATE, Math.floor(RATE * 0.34))
    expect(driven).toBeGreaterThan(clean)
    const dark = spectralCentroid(mono('delay', { kind: 2, time: 200, feedback: 0.65, clock: 1, mix: 1 }, impulse(1, 1)), RATE, Math.floor(RATE * 0.2))
    const open = spectralCentroid(mono('delay', { kind: 2, time: 200, feedback: 0.65, clock: 0, mix: 1 }, impulse(1, 1)), RATE, Math.floor(RATE * 0.2))
    expect(open).toBeGreaterThan(dark)
    const one = tailSeconds(mono('delay', { kind: 3, time: 180, feedback: 0, mix: 1 }, impulse(1, 1)))
    const many = tailSeconds(mono('delay', { kind: 3, time: 180, feedback: 0.85, mix: 1 }, impulse(1, 1)))
    expect(many).toBeGreaterThan(one + 0.2)
  })

  it('chorus, double, ensemble, phase, rotor, and pitch', () => {
    const dry = mono('mod', { kind: 0, rate: 0.4, depth: 0.8, mix: 0 }, tone)
    expect(correlation(dry, tone, skip)).toBeGreaterThan(0.99)
    const shallow = mono('mod', { kind: 0, rate: 1, depth: 0, mix: 1 }, tone)
    const deep = mono('mod', { kind: 0, rate: 1, depth: 1, mix: 1 }, tone)
    expect(correlation(shallow, deep, skip)).toBeLessThan(0.995)
    const slow = mono('mod', { kind: 0, rate: 0.05, depth: 1, mix: 1 }, tone)
    const fast = mono('mod', { kind: 0, rate: 4, depth: 1, mix: 1 }, tone)
    expect(correlation(slow, fast, skip)).toBeLessThan(0.99)
    const monoIn = sine(280, 0.4, 0.3)
    const narrow = hear('mod', { kind: 1, width: 0, delay: 18, depth: 0.4, mix: 1 }, [monoIn])
    const wide = hear('mod', { kind: 1, width: 1, delay: 22, depth: 0.6, mix: 1 }, [monoIn])
    expect(correlation(wide.audio[0], wide.audio[1], skip)).toBeLessThan(correlation(narrow.audio[0], narrow.audio[1], skip) - 0.02)
    const near = mono('mod', { kind: 1, width: 0.5, delay: 5, depth: 0.2, mix: 1 }, monoIn)
    const far = mono('mod', { kind: 1, width: 0.5, delay: 40, depth: 0.2, mix: 1 }, monoIn)
    expect(correlation(near, far, skip)).toBeLessThan(0.995)
    const ensemble = hear('mod', { kind: 2, rate: 0.3, depth: 0.6, mode: 0, mix: 1 }, [monoIn])
    const dimension = hear('mod', { kind: 2, rate: 0.3, depth: 0.6, mode: 1, mix: 1 }, [monoIn])
    expect(correlation(ensemble.audio[1], dimension.audio[1], skip)).toBeLessThan(0.995)
    const phaseDry = mono('mod', { kind: 3, rate: 0.4, depth: 0.7, feedback: 0.5, mix: 0 }, tone)
    expect(correlation(phaseDry, tone, skip)).toBeGreaterThan(0.99)
    const lowFb = mono('mod', { kind: 3, rate: 0.5, depth: 0.8, feedback: 0, mix: 1 }, tone)
    const highFb = mono('mod', { kind: 3, rate: 0.5, depth: 0.8, feedback: 0.9, mix: 1 }, tone)
    expect(correlation(lowFb, highFb, skip)).toBeLessThan(0.995)
    const rotorSlow = mono('mod', { kind: 4, speed: 0, mix: 1 }, tone)
    const rotorFast = mono('mod', { kind: 4, speed: 1, mix: 1 }, tone)
    expect(correlation(rotorSlow, rotorFast, skip)).toBeLessThan(0.98)
    const up = dominantHz(mono('mod', { kind: 5, semis: 7, harmonyMix: 0, mix: 1 }, sine(220, 0.8, 0.4)), RATE, Math.floor(RATE * 0.25))
    const down = dominantHz(mono('mod', { kind: 5, semis: -5, harmonyMix: 0, mix: 1 }, sine(220, 0.8, 0.4)), RATE, Math.floor(RATE * 0.25))
    expect(up).toBeGreaterThan(down * 1.4)
    expect(up).toBeGreaterThan(280)
    expect(down).toBeLessThan(200)
    const fifth = mono('mod', { kind: 5, semis: 0, harmony: 7, harmonyMix: 1, mix: 1 }, sine(220, 0.6, 0.4))
    const lead = mono('mod', { kind: 5, semis: 0, harmony: 0, harmonyMix: 0, mix: 1 }, sine(220, 0.6, 0.4))
    expect(correlation(fifth, lead, Math.floor(RATE * 0.12))).toBeLessThan(0.95)
    expect(correlation(mono('mod', { kind: 5, semis: 12, mix: 0 }, sine(220, 0.4, 0.3)), sine(220, 0.4, 0.3), skip)).toBeGreaterThan(0.99)
  })
})

describe('limiter, mixer, and tempo', () => {
  it('limiter ceiling, threshold, release, lookahead, width, mono, bits, and target', () => {
    const hot = sine(180, 0.4, 0.9)
    const low = peakAbs(mono('limiter', { kind: 1, ceiling: -6, release: 40, lookahead: 5, releaseMode: 1, bits: 24, shape: 0 }, hot))
    const high = peakAbs(mono('limiter', { kind: 1, ceiling: -0.1, release: 40, lookahead: 5, releaseMode: 1, bits: 24, shape: 0 }, hot))
    expect(low).toBeLessThan(high)
    expect(low).toBeLessThanOrEqual(10 ** (-6 / 20) + 0.05)
    const open = levelDb(mono('limiter', { kind: 0, threshold: 0, ceiling: -0.1, release: 40, width: 1, bass: 120, bits: 24, shape: 0 }, hot), skip)
    const held = levelDb(mono('limiter', { kind: 0, threshold: -18, ceiling: -0.1, release: 40, width: 1, bass: 120, bits: 24, shape: 0 }, hot), skip)
    expect(held).toBeLessThan(open - 1)
    const hit = burst(120, 0.5, 0.04, 1, 0.15)
    const from = Math.floor(RATE * 0.18)
    const quick = levelDb(mono('limiter', { kind: 0, threshold: -12, release: 5, ceiling: -1, bits: 24, shape: 0 }, hit), from)
    const slow = levelDb(mono('limiter', { kind: 0, threshold: -12, release: 300, ceiling: -1, bits: 24, shape: 0 }, hit), from)
    expect(slow).toBeLessThan(quick)
    const shortLook = hear('limiter', { kind: 1, ceiling: -1, lookahead: 1, release: 40, releaseMode: 1, bits: 24, shape: 0 }, [hot])
    const longLook = hear('limiter', { kind: 1, ceiling: -1, lookahead: 10, release: 40, releaseMode: 1, bits: 24, shape: 0 }, [hot])
    expect(longLook.processor.latencySamples).toBeGreaterThan(shortLook.processor.latencySamples + 50)
    const sideLow = sine(80, 0.3, 0.4)
    const wide = hear('limiter', { kind: 2, target: -14, ceiling: -1, width: 1.8, low: 1, high: 1, bass: 40, bits: 24, shape: 0 }, [sideLow, sideLow.map((sample) => -sample)])
    const monoBass = hear('limiter', { kind: 2, target: -14, ceiling: -1, width: 1.8, low: 1, high: 1, bass: 300, bits: 24, shape: 0 }, [sideLow, sideLow.map((sample) => -sample)])
    expect(rms(wide.audio[0])).toBeGreaterThan(rms(monoBass.audio[0]) + 0.01)
    const quiet = sine(440, 0.3, 0.02)
    const fine = hear('limiter', { kind: 0, threshold: 0, ceiling: 0, bits: 24, shape: 0, width: 1, release: 20 }, [quiet])
    const coarse = hear('limiter', { kind: 0, threshold: 0, ceiling: 0, bits: 16, shape: 1, width: 1, release: 20 }, [quiet])
    const lag = fine.processor.latencySamples
    let err24 = 0
    let err16 = 0
    for (let i = skip; i < quiet.length - lag - 8; i++) {
      err24 += (fine.audio[0][i + lag] - quiet[i]) ** 2
      err16 += (coarse.audio[0][i + lag] - quiet[i]) ** 2
    }
    expect(err16).toBeGreaterThan(err24 * 4 + 1e-8)
    const flat = mono('limiter', { kind: 0, bits: 16, shape: 0, threshold: 0, ceiling: 0, width: 1 }, sine(40, 0.4, 0))
    const shaped = mono('limiter', { kind: 0, bits: 16, shape: 2, threshold: 0, ceiling: 0, width: 1 }, sine(40, 0.4, 0))
    expect(spectralCentroid(shaped)).toBeGreaterThan(spectralCentroid(flat) + 80)
    const loudnessLow = levelDb(mono('limiter', { kind: 2, target: -24, ceiling: -1, release: 40, lookahead: 2, bits: 24, shape: 0, width: 1 }, hot), Math.floor(RATE * 0.2))
    const loudnessHigh = levelDb(mono('limiter', { kind: 2, target: -8, ceiling: -1, release: 40, lookahead: 2, bits: 24, shape: 0, width: 1 }, hot), Math.floor(RATE * 0.2))
    expect(loudnessHigh).toBeGreaterThan(loudnessLow)
  })

  it('fader, pan, send, pre-fader, and master move the mix', () => {
    const tone = sine(440, 0.25, 0.4)
    const graph = (tracks: GraphTrack[], masterVolume = 1) => renderGraph({
      tracks,
      masterPlugins: [],
      masterVolume,
      sampleRate: RATE,
      tempo: 120,
      length: tone.length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      create: (id) => createCore(id as CoreId, RATE),
    })
    const full = graph([track('a', tone, { volume: 1, pan: 0 })])
    const half = graph([track('a', tone, { volume: 0.5, pan: 0 })])
    expect(levelDb(full.master[0], skip) - levelDb(half.master[0], skip)).toBeCloseTo(6.02, 0)
    const left = graph([track('a', tone, { pan: -1 })])
    const right = graph([track('a', tone, { pan: 1 })])
    expect(stereoBalance(left.master[0], left.master[1], skip)).toBeLessThan(-0.9)
    expect(stereoBalance(right.master[0], right.master[1], skip)).toBeGreaterThan(0.9)
    const masterDown = graph([track('a', tone)], 0.5)
    expect(levelDb(full.master[0], skip) - levelDb(masterDown.master[0], skip)).toBeCloseTo(6.02, 0)
    const sendOff = graph([
      track('a', tone, { volume: 1, sends: [{ id: 's', busId: 'bus', gain: 0, preFader: false, enabled: true }] }),
      track('bus', new Float32Array(tone.length), { type: 'bus', volume: 1 }),
    ])
    const sendOn = graph([
      track('a', tone, { volume: 1, sends: [{ id: 's', busId: 'bus', gain: 1, preFader: false, enabled: true }] }),
      track('bus', new Float32Array(tone.length), { type: 'bus', volume: 1 }),
    ])
    expect(levelDb(sendOn.master[0], skip)).toBeGreaterThan(levelDb(sendOff.master[0], skip) + 4)
    const pre = graph([
      track('a', tone, { volume: 0, sends: [{ id: 's', busId: 'bus', gain: 1, preFader: true, enabled: true }] }),
      track('bus', new Float32Array(tone.length), { type: 'bus', volume: 1 }),
    ])
    const post = graph([
      track('a', tone, { volume: 0, sends: [{ id: 's', busId: 'bus', gain: 1, preFader: false, enabled: true }] }),
      track('bus', new Float32Array(tone.length), { type: 'bus', volume: 1 }),
    ])
    expect(rms(pre.master[0], skip)).toBeGreaterThan(0.05)
    expect(rms(post.master[0], skip)).toBeLessThan(0.001)
  })

  it('wet mix at 0 is the dry signal, and tempo sets the musical clock', () => {
    const tone = sine(440, 0.2, 0.3)
    const slot: ChainSlot = {
      id: 'eq',
      pluginId: 'eq',
      enabled: true,
      wet: 0,
      params: { ...defaultParams('eq'), kind: 0, midG: 12, midF: 1000 },
      failed: false,
      sidechain: '',
      processor: createCore('eq', RATE),
    }
    const out = [new Float32Array(tone.length), new Float32Array(tone.length)]
    processChain([slot], [tone, tone.slice()], out, {
      sampleRate: RATE,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      quality: 'full',
    })
    expect(correlation(out[0], tone)).toBeGreaterThan(0.999)
    expect(samplesPerQuarter(RATE, 60)).toBe(RATE)
    expect(samplesPerQuarter(RATE, 120)).toBe(RATE / 2)
    const quarter = hear('delay', { kind: 0, sync: 1, division: 1, mix: 1, feedback: 0 }, [impulse(1.3, 1)], { tempo: 60 })
    expect(Math.abs(peakIndex(quarter.audio[0]) - RATE)).toBeLessThan(RATE * 0.04)
    const store = new ProjectStore()
    store.setTempo(96.2)
    expect(store.project.tempo).toBe(96.2)
    store.setTempo(400)
    expect(store.project.tempo).toBe(300)
    store.setTempo(10)
    expect(store.project.tempo).toBe(30)
  })
})

function track(id: string, buffer: Float32Array, extra: Partial<GraphTrack> = {}): GraphTrack {
  return {
    id,
    type: 'audio',
    input: 'none',
    buffer: [buffer.slice(), buffer.slice()],
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
