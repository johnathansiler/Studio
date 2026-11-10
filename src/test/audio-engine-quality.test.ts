import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSafetyLimiter, holdFullScale, SAFETY_ATTACK, SAFETY_LOOK } from '../audio/master/safety'
import { truePeakDb } from '../audio/master/fir'
import { renderSaw } from '../audio/liveStage'
import { freshState, renderTone, type PlayVoice, type ToneCtx } from '../audio/rack/synth'
import { additiveSaw, partialsFor } from '../audio/quality/blep'
import { create as createEq } from '../audio/plugins/eq'
import { createChorus } from '../audio/plugins/color'
import { createDelay } from '../audio/plugins/space'
import { tickBiquad, designBiquad } from '../audio/plugins/dsp'
import { prepareChainPool, processChain, type ChainSlot } from '../audio/plugins/chain'
import { createCore } from '../audio/plugins/dispatch'
import { renderGraph } from '../audio/renderGraph'
import { fileDither } from '../audio/master/ditherPlan'
import { createDither } from '../audio/master/process'
import { encodeWav, decodeWavPCM } from '../model/wav'
import { createEmptyProject } from '../model/types'
import { createPlugin } from '../audio/plugins/catalog'

const RATE = 48000

function sine(freq: number, seconds: number, amp: number) {
  const n = Math.round(seconds * RATE)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / RATE) * amp
  return out
}

function powerAt(channel: Float32Array, freq: number, start: number, n = 4096) {
  let best = 0
  const bin = (freq * n) / RATE
  const k0 = Math.max(1, Math.floor(bin) - 2)
  const k1 = Math.min(n / 2 - 1, Math.ceil(bin) + 2)
  for (let k = k0; k <= k1; k++) {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
      const w = (2 * Math.PI * k * i) / n
      const sample = (channel[start + i] || 0) * window
      re += sample * Math.cos(w)
      im -= sample * Math.sin(w)
    }
    best = Math.max(best, re * re + im * im)
  }
  return best
}

function aliasHz(freq: number) {
  let wrapped = freq % RATE
  if (wrapped < 0) wrapped += RATE
  if (wrapped > RATE / 2) wrapped = RATE - wrapped
  return wrapped
}

/** Energy of harmonics that have folded under Nyquist, relative to the fundamental. */
function foldedDb(channel: Float32Array, hz: number, start = 6000) {
  const fund = powerAt(channel, hz, start)
  let alias = 0
  const nyquist = RATE / 2
  for (let h = 2; h <= 40; h++) {
    const freq = hz * h
    if (freq < nyquist) continue
    const folded = aliasHz(freq)
    if (folded < 70 || Math.abs(folded - hz) < 40) continue
    let harmonic = false
    for (let k = 1; k <= 40; k++) {
      const inBand = hz * k
      if (inBand >= nyquist) break
      if (Math.abs(inBand - folded) < 50) harmonic = true
    }
    if (harmonic) continue
    alias += powerAt(channel, folded, start)
  }
  if (!(fund > 0)) return -240
  return 20 * Math.log10(Math.sqrt(alias / fund) + 1e-12)
}

function peak(channel: ArrayLike<number>) {
  let best = 0
  for (let i = 0; i < channel.length; i++) best = Math.max(best, Math.abs(channel[i] || 0))
  return best
}

function maxJump(channel: ArrayLike<number>, from: number, to: number) {
  let jump = 0
  for (let i = from + 1; i < to; i++) jump = Math.max(jump, Math.abs((channel[i] || 0) - (channel[i - 1] || 0)))
  return jump
}

function blockCtx(sampleTime = 0) {
  return {
    sampleRate: RATE,
    tempo: 120,
    sampleTime,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full' as const,
    offline: true,
  }
}

function voice(note: number): PlayVoice {
  return { note, vel: 1, bend: 0, pressure: 0, glideFrom: note, released: false, active: true, synth: { sub: freshState(), wave: freshState() } }
}

function renderVoice(kind: 'sub' | 'wave', params: Record<string, number>, note: number, frames = 14000) {
  const played = voice(note)
  const tone: ToneCtx = {
    sr: RATE,
    time: 0,
    quality: 'full',
    params,
    voices: [played],
    played: () => note,
    table: null,
    fx: { phase: 0, delay: new Float32Array(2400), delayPos: 0, combs: [], combPos: [], low: 0, band: 0, adaaU: 0, adaaF: 0 },
    publish: () => undefined,
    deviceId: kind,
  }
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    tone.time = i
    out[i] = renderTone(kind, tone)
  }
  return out
}

function naiveSaw(note: number, frames = 14000) {
  const hz = 440 * 2 ** ((note - 69) / 12)
  const out = new Float32Array(frames)
  let phase = 0
  for (let i = 0; i < frames; i++) {
    phase += hz / RATE
    phase -= Math.floor(phase)
    out[i] = (2 * phase - 1) * 0.22
  }
  return { out, hz }
}

describe('audio engine quality', () => {
  it('keeps high saws and the transport oscillator far below the naive alias floor', () => {
    const note = 96
    const hz = 440 * 2 ** ((note - 69) / 12)
    const naive = naiveSaw(note)
    const bandlimited = renderVoice('sub', {
      wave1: 0, mix1: 1, mix2: 0, mix3: 0, cutoff: 20000, res: 0, famt: 0,
      attack: 1, decay: 10, sustain: 1, release: 20, detune: 0, uni: 1, drive: 0, glide: 0,
    }, note)
    const naiveDb = foldedDb(naive.out, hz)
    const blepDb = foldedDb(bandlimited, hz)
    expect(naiveDb).toBeGreaterThan(-20)
    expect(blepDb).toBeLessThan(naiveDb - 20)
    expect(blepDb).toBeLessThan(-40)
    const transport = renderSaw(note, 0.07, RATE, 14000, 0)
    expect(foldedDb(transport, hz)).toBeLessThan(-40)
    const dt = hz / RATE
    expect(Math.abs(additiveSaw(0, partialsFor(dt)))).toBeLessThan(0.05)
  })

  it('drops wavetable harmonics that would fold at the top of the keyboard', () => {
    const note = 96
    const hz = 440 * 2 ** ((note - 69) / 12)
    const bright = renderVoice('wave', {
      table: 1, position: 0.99, warp: 0, uni: 1, cutoff: 20000, res: 0, attack: 1, sustain: 1,
    }, note)
    expect(foldedDb(bright, hz)).toBeLessThan(-36)
    expect(peak(bright)).toBeGreaterThan(0.02)
    expect(peak(bright)).toBeLessThan(1.2)
  })

  it('keeps a driven high saw from folding as hard as a raw tanh', () => {
    const note = 96
    const hz = 440 * 2 ** ((note - 69) / 12)
    const params = {
      wave1: 0, mix1: 1, mix2: 0, mix3: 0, cutoff: 20000, res: 0, famt: 0,
      attack: 1, sustain: 1, uni: 1, glide: 0,
    }
    const clean = renderVoice('sub', { ...params, drive: 0 }, note, 12000)
    const driven = renderVoice('sub', { ...params, drive: 1 }, note, 12000)
    const plain = new Float32Array(clean.length)
    for (let i = 0; i < clean.length; i++) plain[i] = Math.tanh((clean[i] / 0.22) * 7) * 0.22
    expect(foldedDb(driven, hz, 4000)).toBeLessThan(foldedDb(plain, hz, 4000) - 3)
    expect(driven.every((sample) => Number.isFinite(sample))).toBe(true)
    expect(peak(driven)).toBeLessThan(1.2)
  })

  it('holds a resonant filter finite and under the voice clamp', () => {
    const tone = renderVoice('sub', {
      wave1: 4, mix1: 1, mix2: 0, mix3: 0, cutoff: 12000, res: 0.92, famt: 0,
      attack: 1, sustain: 1, uni: 1, drive: 0,
    }, 90, 8000)
    expect(tone.every((sample) => Number.isFinite(sample))).toBe(true)
    expect(peak(tone)).toBeLessThan(1.5)
  })

  it('scales a hot mix to full scale without flattening the waveform', () => {
    const tone = sine(440, 0.25, 1)
    const tracks = Array.from({ length: 6 }, (_, index) => ({
      id: `t${index}`,
      type: 'audio',
      input: 'none',
      buffer: [Float32Array.from(tone, (_, i) => Math.sin((2 * Math.PI * (180 + index * 90) * i) / RATE))],
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      plugins: [],
      sends: [],
      output: null,
      groupId: null,
    }))
    const rendered = renderGraph({
      tracks,
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: RATE,
      tempo: 120,
      length: tone.length,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      automation: [],
      offline: true,
      create: (id) => createCore(id as 'eq', RATE),
    })
    expect(peak(rendered.master[0])).toBeGreaterThan(1)
    const guarded = holdFullScale(rendered.master)
    expect(peak(guarded[0])).toBeLessThanOrEqual(1)
    expect(truePeakDb(guarded)).toBeLessThanOrEqual(0.4)
    const quiet = sine(440, 0.2, 0.25)
    const held = holdFullScale([quiet, quiet])
    expect(held[0]).toBe(quiet)
    const hot = sine(100, 0.3, 1.8)
    const safe = holdFullScale([hot, hot])
    expect(peak(safe[0])).toBeLessThanOrEqual(1)
    expect(peak(safe[0])).toBeGreaterThan(0.9)
    const ratio = safe[0][2000] / hot[2000]
    let shape = 0
    for (let i = 1000; i < hot.length; i++) shape = Math.max(shape, Math.abs(safe[0][i] - hot[i] * ratio))
    expect(shape).toBeLessThan(1e-4)
  })

  it('limits overs in the live safety stage and leaves a legal sine untouched', () => {
    const limiter = createSafetyLimiter(RATE)
    const quiet = sine(440, 0.2, 0.4)
    const out = new Float32Array(quiet.length)
    const right = new Float32Array(quiet.length)
    limiter.process(quiet, quiet, out, right)
    let err = 0
    for (let i = SAFETY_LOOK; i < quiet.length; i++) err = Math.max(err, Math.abs(out[i] - quiet[i - SAFETY_LOOK]))
    expect(err).toBeLessThan(1e-6)
    const hot = sine(100, 0.4, 2)
    const limited = new Float32Array(hot.length)
    const limitedR = new Float32Array(hot.length)
    limiter.reset()
    limiter.process(hot, hot, limited, limitedR)
    const settled = limited.subarray(SAFETY_LOOK + SAFETY_ATTACK + 64)
    expect(peak(settled)).toBeLessThanOrEqual(1.001)
    expect(peak(settled)).toBeGreaterThan(0.9)
    expect(maxJump(limited, SAFETY_LOOK, SAFETY_LOOK + 80)).toBeLessThan(0.2)
    expect(readFileSync('public/worklets/safety.js', 'utf8')).toContain(`const LOOK = ${SAFETY_LOOK}`)
    expect(readFileSync('public/worklets/safety.js', 'utf8')).toContain(`const ATTACK = ${SAFETY_ATTACK}`)
    expect(readFileSync('public/worklets/safety.js', 'utf8')).not.toMatch(/import\s*\(/)
  })

  it('crossfades a bypass and a chorus mix instead of stepping', () => {
    const tone = sine(1000, 0.4, 0.4)
    const half = Math.floor(tone.length / 2)
    const eq = createEq(RATE)
    const slot: ChainSlot = {
      id: 'eq1',
      pluginId: 'eq',
      enabled: true,
      wet: 1,
      params: { hp: 20, lp: 20000, lowF: 200, lowQ: 0.7, lowG: 0, midF: 1000, midQ: 1, midG: 12, highF: 8000, highQ: 0.7, highG: 0, kind: 0 },
      failed: false,
      sidechain: '',
      processor: eq,
    }
    const pool = prepareChainPool(2, 2, half)
    const out = [new Float32Array(tone.length), new Float32Array(tone.length)]
    const left = tone.subarray(0, half)
    const rightIn = tone.subarray(0, half)
    processChain([slot], [left, rightIn], [out[0].subarray(0, half), out[1].subarray(0, half)], blockCtx(), undefined, pool)
    slot.enabled = false
    const rest = tone.subarray(half)
    processChain([slot], [rest, rest], [out[0].subarray(half), out[1].subarray(half)], blockCtx(half), undefined, pool)
    const slope = maxJump(out[0], half - 80, half - 1)
    expect(Math.abs(out[0][half] - out[0][half - 1])).toBeLessThan(slope * 3 + 0.04)
    expect(Math.abs(out[0][out[0].length - 1] - tone[tone.length - 1])).toBeLessThan(0.05)

    const chorus = createChorus(RATE)
    const steady = sine(730, 0.15, 0.5)
    const mixed = new Float32Array(steady.length)
    const block = 128
    const boundary = Math.floor(steady.length / 2)
    for (let offset = 0; offset < steady.length; offset += block) {
      const n = Math.min(block, steady.length - offset)
      const mix = offset < boundary ? 0 : 1
      chorus.process(
        [steady.subarray(offset, offset + n), steady.subarray(offset, offset + n)],
        [mixed.subarray(offset, offset + n), mixed.subarray(offset, offset + n)],
        { rate: 0.2, depth: 0.2, mix },
        blockCtx(offset),
      )
    }
    const chorusSlope = maxJump(mixed, boundary - 80, boundary - 1)
    const across = Math.abs(mixed[boundary] - mixed[boundary - 1])
    expect(across).toBeLessThan(chorusSlope * 4 + 0.03)
  })

  it('keeps delay feedback stable and flushes denormal filter state', () => {
    const delay = createDelay(RATE)
    const impulse = new Float32Array(RATE)
    impulse[64] = 1
    const out = new Float32Array(impulse.length)
    delay.process([impulse, impulse], [out, out], { time: 40, feedback: 0.9, mix: 1, filter: 8000, sync: 0, pingpong: 0, division: 0.25 }, blockCtx())
    expect(peak(out)).toBeLessThan(1.2)
    expect(out.every((sample) => Number.isFinite(sample))).toBe(true)
    const filter = designBiquad('lowpass', RATE, 1000, 0.7)
    filter.y1 = 1e-30
    filter.y2 = 1e-32
    const y = tickBiquad(filter, 0)
    expect(y).toBe(0)
    expect(filter.y1).toBe(0)
  })

  it('does not dither a second time when the limiter already quantized', () => {
    const project = createEmptyProject(RATE, 'Dither')
    const plugin = createPlugin('limiter', 'Transparent')
    plugin.params.bits = 16
    plugin.params.shape = 1
    project.masterPlugins = [plugin]
    expect(fileDither(project, 16, 'tpdf')).toBe('none')
    expect(fileDither(project, 24, 'tpdf')).toBe('none')
    const open = createEmptyProject(RATE, 'Open')
    expect(fileDither(open, 16, 'tpdf')).toBe('tpdf')
    const dither = createDither()
    const quiet = sine(440, 0.2, 0.05)
    const quantized = new Float32Array(quiet.length)
    const block = 128
    for (let offset = 0; offset < quiet.length; offset += block) {
      const n = Math.min(block, quiet.length - offset)
      dither.process(
        [quiet.subarray(offset, offset + n), quiet.subarray(offset, offset + n)],
        [quantized.subarray(offset, offset + n), quantized.subarray(offset, offset + n)],
        { bits: 16, shape: 1 },
        blockCtx(offset),
      )
    }
    const once = decodeWavPCM(encodeWav([quantized, quantized], RATE, { bits: 16, dither: fileDither(project, 16, 'tpdf') }))
    const twice = decodeWavPCM(encodeWav([quantized, quantized], RATE, { bits: 16, dither: 'tpdf' }))
    const rms = (channel: Float32Array, other: Float32Array) => {
      let sum = 0
      for (let i = 0; i < channel.length; i++) {
        const delta = channel[i] - other[i]
        sum += delta * delta
      }
      return Math.sqrt(sum / channel.length)
    }
    expect(rms(once.channels[0], quantized)).toBeLessThan(rms(twice.channels[0], quantized))
  })

  it('opens and closes the built-in sine without a click from a leftover phase', () => {
    const synth = createCore('synth', RATE) as ReturnType<typeof createCore> & { note: (pitch: number, vel: number) => void }
    const n = 8000
    const input = new Float32Array(n)
    const out = new Float32Array(n)
    synth.note(76, 1)
    synth.process([input.subarray(0, 4000), input.subarray(0, 4000)], [out.subarray(0, 4000), out.subarray(0, 4000)], {}, blockCtx())
    synth.note(76, 0)
    synth.process([input.subarray(4000, 7000), input.subarray(4000, 7000)], [out.subarray(4000, 7000), out.subarray(4000, 7000)], {}, blockCtx(4000))
    synth.note(81, 1)
    synth.process([input.subarray(7000, 8000), input.subarray(7000, 8000)], [out.subarray(7000, 8000), out.subarray(7000, 8000)], {}, blockCtx(7000))
    expect(maxJump(out, 6990, 7040)).toBeLessThan(0.02)
    expect(out.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 0.35 + 1e-4)).toBe(true)
  })
})
