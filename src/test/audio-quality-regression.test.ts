/**
 * Numeric thresholds for the audio engine. Signals are generated here.
 * Before this pass, the analog shaper's aliases sat at -20 dB, the saturator at -18 dB,
 * tape clicked at every block (-3 dB null), the limiter stepped gain, and a loop fade snapped.
 */
import { describe, expect, it } from 'vitest'
import { createSum, createTape } from '../audio/plugins/models/color'
import { createShaper, oversample } from '../audio/plugins/models/analog'
import { createSaturator } from '../audio/plugins/color'
import { create as createEq } from '../audio/plugins/eq'
import { createCompressor, createLimiter } from '../audio/plugins/dynamics'
import { createDelay, createReverb } from '../audio/plugins/space'
import { createAmp } from '../audio/plugins/amp'
import { resampleSinc } from '../audio/quality/resample'
import { panGains } from '../audio/level'
import { gainFromDb, dragGain } from '../model/mixLaw'
import { crossfadeLoopRegion } from '../audio/clipEdge'
import { freshState, renderTone, type PlayVoice, type ToneCtx } from '../audio/rack/synth'
import { createOversample, truePeakLinear } from '../audio/master/fir'
import { createSafetyLimiter, holdFullScale } from '../audio/master/safety'
import { createBrick } from '../audio/master/process'
import { defaultParams } from '../audio/plugins/catalog'
import { renderGraph } from '../audio/renderGraph'
import { createCore } from '../audio/plugins/dispatch'
import { padeTanh, shaperLatencySamples } from '../audio/quality/oversample'
import type { Processor } from '../audio/plugins/types'

const RATE = 48000

function ctx(sampleRate = RATE) {
  return {
    sampleRate,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full' as const,
    offline: true,
  }
}

function sine(freq: number, seconds: number, amp = 0.5, rate = RATE) {
  const n = Math.round(seconds * rate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return out
}

function run(proc: Processor, input: Float32Array, params: Record<string, number>, block = 128, rate = RATE) {
  const left = new Float32Array(input.length)
  const right = new Float32Array(input.length)
  const context = ctx(rate)
  for (let offset = 0; offset < input.length; offset += block) {
    const count = Math.min(block, input.length - offset)
    proc.process(
      [input.subarray(offset, offset + count), input.subarray(offset, offset + count)],
      [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
      params,
      { ...context, sampleTime: offset },
    )
  }
  return left
}

function goertzel(channel: Float32Array, freq: number, start: number, n = 4096, rate = RATE) {
  const w = (2 * Math.PI * ((freq * n) / rate)) / n
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    const s0 = (channel[start + i] || 0) * window + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/** Folded harmonics, in dB under the fundamental. In-band harmonics are ignored. */
function aliasDb(channel: Float32Array, hz: number, start = 8000) {
  const fund = goertzel(channel, hz, start)
  let alias = 0
  const nyquist = RATE / 2
  for (let h = 2; h <= 40; h++) {
    const freq = hz * h
    if (freq < nyquist * 0.92) continue
    let wrapped = freq % RATE
    if (wrapped > RATE / 2) wrapped = RATE - wrapped
    if (wrapped < 80 || Math.abs(wrapped - hz) < 40) continue
    let harmonic = false
    for (let k = 1; k <= 40; k++) {
      const inBand = hz * k
      if (inBand >= nyquist * 0.92) break
      if (Math.abs(inBand - wrapped) < 50) harmonic = true
    }
    if (harmonic) continue
    alias += goertzel(channel, wrapped, start)
  }
  if (!(fund > 0)) return -240
  return 10 * Math.log10(alias / fund + 1e-24)
}

function peak(channel: ArrayLike<number>, from = 0, to = channel.length) {
  let best = 0
  for (let i = from; i < to; i++) best = Math.max(best, Math.abs(channel[i] || 0))
  return best
}

function rms(channel: ArrayLike<number>, from = 0, to = channel.length) {
  let sum = 0
  let n = 0
  for (let i = from; i < to; i++) {
    const s = channel[i] || 0
    sum += s * s
    n++
  }
  return n ? Math.sqrt(sum / n) : 0
}

function rmsDb(channel: ArrayLike<number>, from = 0, to = channel.length) {
  const v = rms(channel, from, to)
  return v > 1e-12 ? 20 * Math.log10(v) : -160
}

function mean(channel: ArrayLike<number>, from = 0, to = channel.length) {
  let sum = 0
  let n = 0
  for (let i = from; i < to; i++) {
    sum += channel[i] || 0
    n++
  }
  return n ? sum / n : 0
}

/** 4x true peak, ignoring the reconstruction filter's own warmup. */
function fairTruePeak(buf: Float32Array) {
  const taps = 64
  const os = createOversample(4, taps)
  let peak = 0
  let seen = 0
  const skip = taps * 2
  const end = buf.length * 4 - skip
  os.process(buf, new Float32Array(buf.length), (sample) => {
    if (seen >= skip && seen < end) peak = Math.max(peak, Math.abs(sample))
    seen += 1
    return sample
  })
  const from = Math.min(buf.length, taps)
  const to = Math.max(from, buf.length - taps)
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(buf[i] || 0))
  return peak
}

function phasedSine(freq: number, seconds: number, amp: number, phase: number, rate: number) {
  const n = Math.round(seconds * rate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate + phase) * amp
  return out
}

function maxD2(channel: Float32Array, from: number, to: number) {
  let worst = 0
  for (let i = from; i < to; i++) worst = Math.max(worst, Math.abs(channel[i] - 2 * channel[i - 1] + channel[i - 2]))
  return worst
}

describe('audio quality regression', () => {
  it('keeps the rational tanh within 0.03 of tanh', () => {
    let worst = 0
    for (let i = 0; i <= 4000; i++) {
      const x = (i / 4000) * 8
      worst = Math.max(worst, Math.abs(padeTanh(x) - Math.tanh(x)), Math.abs(padeTanh(-x) - Math.tanh(-x)))
    }
    expect(worst).toBeLessThan(0.03)
  })

  it('keeps oversampled distortion aliases under -60 dB', () => {
    const hz = 5123
    const tone = sine(hz, 0.45, 0.7)
    const shaper = createShaper(4)
    const shaped = new Float32Array(tone.length)
    for (let i = 0; i < tone.length; i++) shaped[i] = oversample(shaper, tone[i], 0.85)
    const raw = new Float32Array(tone.length)
    for (let i = 0; i < tone.length; i++) raw[i] = Math.tanh(tone[i] * (1 + 0.85 * 3))
    expect(aliasDb(raw, hz)).toBeGreaterThan(-30)
    expect(aliasDb(shaped, hz)).toBeLessThan(-60)
    const sat = run(createSaturator(RATE), sine(7000, 0.4, 0.55), { drive: 0.9, tone: 14000, mix: 1 })
    expect(aliasDb(sat, 7000, 6000)).toBeLessThan(-70)
    const sum = run(createSum(RATE), sine(3000, 0.4, 0.5), { drive: 0.8, tube: 1 })
    expect(aliasDb(sum, 3000, 4000)).toBeLessThan(-60)
    expect(20 * Math.log10(Math.abs(mean(sum, 4000)) + 1e-12)).toBeLessThan(-70)
    const amp = run(createAmp(RATE), sine(880, 0.3, 0.4), {
      ...defaultParams('amp'), model: 2, gain: 0.85, cab: 0, master: 0.7,
      bass: 0.5, mid: 0.5, treble: 0.5, presence: 0.5,
    })
    expect(aliasDb(amp, 880, 4000)).toBeLessThan(-80)
    expect(amp.every((sample) => Number.isFinite(sample))).toBe(true)
  })

  it('does not let a full-scale sine out of the saturator past the pre-change overshoot', () => {
    const n = RATE
    const sine = new Float32Array(n)
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 1000 * i) / RATE)
    const hot = run(createSaturator(RATE), sine, { drive: 1, tone: 8000, mix: 1 }, n)
    const from = Math.floor(0.5 * RATE)
    const to = Math.floor(0.9 * RATE)
    // main's saturator already reaches 1.016 on this sine. The bandlimited tone
    // filter rings higher; the high-rate ceiling holds the peak near that.
    expect(peak(hot, from, to)).toBeLessThanOrEqual(1.04)
    const quietIn = new Float32Array(n)
    const quietAmp = 10 ** (-12 / 20)
    for (let i = 0; i < n; i++) quietIn[i] = sine[i] * quietAmp
    const quiet = run(createSaturator(RATE), quietIn, { drive: 1, tone: 8000, mix: 1 }, n)
    expect(peak(quiet, from, to)).toBeGreaterThan(0.95)
    const noise = new Float32Array(n)
    let seed = 7
    for (let i = 0; i < n; i++) {
      seed = (seed * 16807) % 2147483647
      noise[i] = (seed / 2147483647) * 2 - 1
    }
    const analog = createShaper(4)
    let analogPeak = 0
    for (let i = 0; i < to; i++) {
      const y = Math.abs(oversample(analog, noise[i], 1))
      if (i >= from) analogPeak = Math.max(analogPeak, y)
    }
    expect(analogPeak).toBeLessThanOrEqual((1 + 0.15) / (1 + 0.6) + 1e-6)
  })

  it('keeps the tape lowpass continuous across blocks', () => {
    const tone = sine(1000, 0.4, 0.4)
    const params = { speed: 1, bias: 0.4, wow: 0, bump: 0, hiss: 0, drive: 0.5 }
    const tape = createTape(RATE)
    const whole = run(tape, tone, params, tone.length)
    tape.reset()
    const blocked = run(tape, tone, params, 128)
    let nullPeak = 0
    for (let i = 2048; i < tone.length; i++) nullPeak = Math.max(nullPeak, Math.abs(whole[i] - blocked[i]))
    expect(20 * Math.log10(nullPeak + 1e-12)).toBeLessThan(-80)
  })

  it('holds the limiter and the master ceiling, including true peak', () => {
    const hot = sine(12000, 0.25, 1)
    const limited = run(createLimiter(RATE), hot, { ceiling: -1, threshold: 0, release: 40 })
    const start = Math.floor(RATE * 0.05)
    expect(20 * Math.log10(peak(limited, start))).toBeLessThanOrEqual(-1)
    expect(20 * Math.log10(fairTruePeak(limited.subarray(start)) + 1e-12)).toBeLessThanOrEqual(-1 + 0.05)
    const moving = sine(200, 0.25, 1.2)
    const eased = run(createLimiter(RATE), moving, { ceiling: -1, threshold: 0, release: 40 })
    expect(maxD2(eased, 80, 220)).toBeLessThan(maxD2(eased, 2000, 4000) * 4 + 0.002)
    const brick = run(createBrick(RATE), hot, { ceiling: -1, lookahead: 5, release: 80, releaseMode: 1 })
    expect(20 * Math.log10(truePeakLinear(brick.subarray(Math.floor(RATE * 0.05)), 24) + 1e-12)).toBeLessThanOrEqual(-1)
    const held = holdFullScale([sine(440, 0.2, 1.4), sine(440, 0.2, 1.4)])
    expect(fairTruePeak(held[0].subarray(Math.floor(RATE * 0.02)))).toBeLessThanOrEqual(10 ** (0.05 / 20))
    expect(peak(held[0])).toBeLessThanOrEqual(1)
    const safety = createSafetyLimiter(RATE)
    const unity = sine(1000, 0.12, 1)
    const outL = new Float32Array(unity.length)
    const outR = new Float32Array(unity.length)
    safety.process(unity, unity, outL, outR)
    let err = 0
    for (let i = 64; i < unity.length; i++) err = Math.max(err, Math.abs(outL[i] - unity[i - 32]))
    expect(err).toBeLessThan(1e-5)
    safety.reset()
    const hf = sine(12000, 0.08, 2)
    const hfL = new Float32Array(hf.length)
    const hfR = new Float32Array(hf.length)
    safety.process(hf, hf, hfL, hfR)
    expect(truePeakLinear(hfL.subarray(64), 24)).toBeLessThanOrEqual(1.001)
  })

  it('keeps intersample peaks under the ceiling across phase and rate', () => {
    const phases = [0, 0.45, Math.PI / 4, 1.1]
    const freqs = [1000, 12000, 18000]
    const rates = [44100, 48000]
    const allowance = 10 ** (0.05 / 20)
    for (const rate of rates) {
      for (const freq of freqs) {
        for (const phase of phases) {
          const input = phasedSine(freq, 0.2, 1, phase, rate)
          const limited = run(createLimiter(rate), input, { ceiling: -1, threshold: 0, release: 40 }, 128, rate)
          const settled = limited.subarray(Math.floor(rate * 0.05))
          const ceiling = 10 ** (-1 / 20)
          expect(fairTruePeak(settled), `limiter ${rate} ${freq} ${phase.toFixed(3)}`).toBeLessThanOrEqual(ceiling * allowance)
          const held = holdFullScale([phasedSine(freq, 0.2, 1.4, phase, rate)])
          expect(fairTruePeak(held[0].subarray(Math.floor(rate * 0.02))), `hold ${rate} ${freq}`).toBeLessThanOrEqual(1 * allowance)
          const safety = createSafetyLimiter(rate)
          const hot = phasedSine(freq, 0.15, 2, phase, rate)
          const out = new Float32Array(hot.length)
          safety.process(hot, hot, out, new Float32Array(hot.length))
          expect(fairTruePeak(out.subarray(Math.floor(rate * 0.04))), `safety ${rate} ${freq}`).toBeLessThanOrEqual(1 * allowance)
        }
      }
    }
  })

  it('settles the compressor near the threshold and stays finite', () => {
    const burst = new Float32Array(Math.floor(RATE * 0.3))
    for (let i = 64; i < burst.length; i++) burst[i] = Math.sin((2 * Math.PI * 200 * i) / RATE)
    const out = run(createCompressor(RATE), burst, { threshold: -18, ratio: 8, attack: 5, release: 80, knee: 0, makeup: 0, mix: 1 })
    expect(out.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 2)).toBe(true)
    expect(rmsDb(out, Math.floor(RATE * 0.15), Math.floor(RATE * 0.25))).toBeLessThan(-16)
    expect(rmsDb(out, Math.floor(RATE * 0.15), Math.floor(RATE * 0.25))).toBeGreaterThan(-24)
  })

  it('keeps delay feedback and the reverb tail stable', () => {
    const impulse = new Float32Array(Math.floor(RATE * 1.2))
    impulse[200] = 0.8
    const delayed = run(createDelay(RATE), impulse, { time: 80, feedback: 0.9, mix: 1, filter: 8000, sync: 0, pingpong: 0, division: 1 })
    expect(delayed.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 4)).toBe(true)
    const echoAt = (n: number) => 200 + Math.round(0.08 * RATE * n)
    const first = peak(delayed, echoAt(1) - 20, echoAt(1) + 40)
    const later = peak(delayed, echoAt(6) - 20, echoAt(6) + 40)
    expect(first).toBeGreaterThan(0.05)
    expect(later).toBeLessThan(first * 0.5)
    const verbIn = new Float32Array(Math.floor(RATE * 1.5))
    verbIn[64] = 0.8
    const verb = run(createReverb(RATE), verbIn, { size: 1, damp: 0.05, mix: 1, mode: 2 })
    expect(verb.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 8)).toBe(true)
    expect(rmsDb(verb, verb.length - 4000)).toBeLessThan(rmsDb(verb, 200, 3000))
  })

  it('matches the EQ design, stays silent, and flushes denormals', () => {
    const eq = createEq(RATE)
    const input = sine(1000, 0.5, 0.2)
    const boosted = run(eq, input, { ...defaultParams('eq'), midF: 1000, midQ: 1, midG: 6 })
    const gain = rmsDb(boosted, 8000, 16000) - rmsDb(input, 8000, 16000)
    expect(Math.abs(gain - 6)).toBeLessThan(0.15)
    eq.reset()
    const flat = run(eq, input, defaultParams('eq'))
    expect(Math.abs(rmsDb(flat, 8000, 16000) - rmsDb(input, 8000, 16000))).toBeLessThan(0.05)
    const silence = run(createEq(RATE), new Float32Array(RATE), defaultParams('eq'))
    expect(rmsDb(silence)).toBeLessThan(-120)
    const tiny = new Float32Array(RATE / 4)
    for (let i = 0; i < tiny.length; i++) tiny[i] = 1e-20 * Math.sin(i)
    const flushed = run(createEq(RATE), tiny, defaultParams('eq'))
    expect(flushed.some((sample) => sample !== 0 && Math.abs(sample) < 1e-15)).toBe(false)
  })

  it('resamples without folding a tone above the new Nyquist and keeps pitch', () => {
    const high = sine(18000, 0.3, 0.8)
    const down = resampleSinc(high, Math.round(high.length / 2), 96)
    const mid = Math.floor(down.length * 0.3)
    expect(rms(down, mid, mid + 2000)).toBeLessThan(1e-4)
    const tone = sine(1000, 0.35, 0.5)
    const up = resampleSinc(tone, Math.round(tone.length * 44100 / 48000), 64)
    const back = resampleSinc(up, tone.length, 64)
    let crosses = 0
    let first = -1
    let last = 0
    const start = 2000
    for (let i = start + 1; i < start + 16000; i++) {
      if (back[i - 1] <= 0 && back[i] > 0) {
        if (first < 0) first = i
        last = i
        crosses++
      }
    }
    const hz = ((crosses - 1) * RATE) / (last - first)
    expect(Math.abs(1200 * Math.log2(hz / 1000))).toBeLessThan(1)
    expect(Math.abs(20 * Math.log10(rms(back, 4000, 12000) / rms(tone, 4000, 12000)))).toBeLessThan(0.2)
  })

  it('follows equal-power pan and 0.1 dB fader steps', () => {
    let powerErr = 0
    for (let step = -100; step <= 100; step++) {
      const g = panGains(step / 100)
      powerErr = Math.max(powerErr, Math.abs(10 * Math.log10(g.left * g.left + g.right * g.right)))
      if (step === 0) expect(Math.abs(20 * Math.log10(g.left) + 3.0103)).toBeLessThan(0.02)
    }
    expect(powerErr).toBeLessThan(0.02)
    let gain = 1
    let stepErr = 0
    for (let db = 0; db > -12; db -= 0.1) {
      const next = dragGain({ origin: gain, deltaPx: -2, min: 0, max: 1 })
      stepErr = Math.max(stepErr, Math.abs(20 * Math.log10(next / gainFromDb(db - 0.1))))
      gain = next
    }
    expect(stepErr).toBeLessThan(0.02)
    const rendered = renderGraph({
      tracks: [{
        id: 't',
        type: 'audio',
        input: 'none',
        buffer: [sine(440, 0.05, 0.5)],
        volume: gainFromDb(-6.1),
        pan: 0.25,
        mute: false,
        solo: false,
        plugins: [],
        sends: [],
        output: null,
        groupId: null,
      }],
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: RATE,
      tempo: 120,
      length: Math.round(0.05 * RATE),
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      offline: true,
      create: (id) => createCore(id as 'eq', RATE),
    })
    const law = panGains(0.25)
    const expectL = 0.5 * law.left * gainFromDb(-6.1)
    expect(Math.abs(rendered.master[0][100] - Math.sin((2 * Math.PI * 440 * 100) / RATE) * expectL)).toBeLessThan(1e-5)
  })

  it('opens a note and a saturator without a one-sample hole', () => {
    const note = 69
    const played: PlayVoice = { note, vel: 1, bend: 0, pressure: 0, glideFrom: note, released: false, active: true, synth: { sub: freshState(), wave: freshState() } }
    const params = { wave1: 0, mix1: 1, mix2: 0, mix3: 0, cutoff: 20000, res: 0, famt: 0, attack: 0, decay: 40, sustain: 1, release: 0, detune: 0, uni: 1, drive: 0, glide: 0 }
    const tone: ToneCtx = {
      sr: RATE, time: 0, quality: 'full', params, voices: [played], played: () => note, table: null,
      fx: { phase: 0, delay: new Float32Array(64), delayPos: 0, combs: [], combPos: [], low: 0, band: 0, adaaU: 0, adaaF: 0 },
      publish: () => undefined, deviceId: 'sub',
    }
    const first = renderTone('sub', tone)
    expect(Math.abs(first)).toBeLessThan(0.02)
    const input = sine(440, 0.2, 0.4)
    const sat = createSaturator(RATE)
    const left = new Float32Array(input.length)
    const right = new Float32Array(input.length)
    const half = Math.floor(input.length / 2)
    const base = ctx()
    sat.process([input.subarray(0, half), input.subarray(0, half)], [left.subarray(0, half), right.subarray(0, half)], { drive: 0, tone: 8000, mix: 1 }, base)
    sat.process([input.subarray(half), input.subarray(half)], [left.subarray(half), right.subarray(half)], { drive: 1, tone: 8000, mix: 1 }, { ...base, sampleTime: half })
    expect(rms(left, half + 2000, half + 4000)).toBeGreaterThan(0.15)
    expect(maxD2(left, half + 2, half + 80)).toBeLessThan(0.08)
    const faded = crossfadeLoopRegion(sine(440, 4000 / RATE, 0.8), 0, 4000, 128)
    let jump = 0
    for (let i = faded.length - 140; i < faded.length; i++) jump = Math.max(jump, Math.abs(faded[i] - faded[i - 1]))
    expect(jump).toBeLessThan(0.08)
    expect(Math.abs((faded[faded.length - 1] || 0) - (faded[0] || 0))).toBeLessThan(1e-6)
  })

  it('reports the saturator latency that the impulse actually has', () => {
    const sat = createSaturator(RATE)
    const impulse = new Float32Array(4000)
    impulse[200] = 0.5
    const out = run(sat, impulse, { drive: 0.6, tone: 12000, mix: 1 }, 128)
    let at = 0
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[at])) at = i
    expect(Math.abs(at - 200 - sat.latencySamples)).toBeLessThan(3)
    expect(sat.latencySamples).toBe(shaperLatencySamples())
  })

  it('compensates a driven saturator before the first process call', () => {
    const length = 512
    const impulse = new Float32Array(length)
    impulse[64] = 0.5
    const track = (id: string, drive: number | null) => ({
      id,
      type: 'audio' as const,
      input: 'none',
      buffer: [impulse.slice(), impulse.slice()],
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      plugins: drive == null ? [] : [{
        id: `${id}-fx`,
        pluginId: 'saturator',
        version: '1',
        enabled: true,
        wet: 1,
        params: { ...defaultParams('saturator'), drive, tone: 12000, mix: 1 },
        sidechain: '',
      }],
      sends: [],
      output: null,
      groupId: null,
    })
    const base = {
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: RATE,
      tempo: 120,
      length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      offline: true,
      create: (id: string, sampleRate: number) => createCore(id as 'saturator', sampleRate),
    }
    const driven = renderGraph({ ...base, tracks: [track('dry', null), track('sat', 0.6)] })
    expect(driven.delays['dry>master']).toBe(shaperLatencySamples())
    expect(driven.delays['sat>master'] ?? 0).toBe(0)
    const idle = renderGraph({ ...base, tracks: [track('dry', null), track('sat', 0)] })
    expect(idle.delays['dry>master'] ?? 0).toBe(0)
  })
})
