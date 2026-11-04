import { describe, expect, it } from 'vitest'
import { BUFFER_HINTS, bufferHintOf, formatLatencyReadout, latencyHintOrder, readBufferHint, writeBufferHint } from '../audio/core/buffer'
import { compensateGraph, reportedLatency } from '../audio/core/latency'
import { createNativePlugin } from '../audio/core/registry'
import { BlockSmoother, ParamSmoother, SampleGlide, isSteppedParam, usesBlockValue } from '../audio/core/smooth'
import { prepareAccurate, processSampleAccurate } from '../audio/automationRender'
import { prepareChainPool, processChain, type ChainSlot } from '../audio/plugins/chain'
import { createHall } from '../audio/plugins/models/space'
import { createTune } from '../audio/plugins/tune'
import { createAmpState, prepareTuneWindows, tunePitch } from '../audio/plugins/ampDsp'
import { glideValue } from '../audio/paramCurve'
import { MASTER } from '../audio/routing'
import type { Processor } from '../audio/plugins/types'

const rate = 48000

function ctx(sampleTime = 0) {
  return {
    sampleRate: rate,
    tempo: 120,
    sampleTime,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11] as const,
    quality: 'full' as const,
  }
}

function silence(frames: number) {
  return [new Float32Array(frames), new Float32Array(frames)]
}

function maxAbs(buffer: Float32Array, start = 0, end = buffer.length) {
  let max = 0
  for (let i = start; i < end; i++) max = Math.max(max, Math.abs(buffer[i] || 0))
  return max
}

function delayProcessor(latency: number): Processor {
  const line = [new Float32Array(Math.max(1, latency)), new Float32Array(Math.max(1, latency))]
  let pos = 0
  return {
    latencySamples: latency,
    reset() {
      line[0].fill(0)
      line[1].fill(0)
      pos = 0
    },
    process(input, output) {
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < output.length; c++) {
          const dry = input[Math.min(c, input.length - 1)]?.[i] ?? 0
          const delayed = latency > 0 ? line[c][pos] : dry
          if (latency > 0) line[c][pos] = dry
          output[c][i] = delayed
        }
        if (latency > 0) pos = (pos + 1) % latency
      }
    },
  }
}

describe('stepped parameters', () => {
  it('jumps kind and other enums instead of gliding them', () => {
    expect(isSteppedParam('kind')).toBe(true)
    expect(isSteppedParam('mode')).toBe(true)
    expect(isSteppedParam('mix')).toBe(false)
    const host = new BlockSmoother()
    const first: Record<string, number> = {}
    host.apply('eq', { kind: 0, midG: 0 }, 128, rate, first, ['kind', 'midG'])
    const next: Record<string, number> = {}
    const second = host.apply('eq', { kind: 1, midG: 6 }, 128, rate, next, ['kind', 'midG'])
    expect(second.kind).toBe(1)
    expect(second.midG).toBeCloseTo(glideValue(0, 6, 128, rate), 6)
    expect(second.midG).toBeLessThan(6)

    const smoother = new ParamSmoother()
    smoother.prepare(2, rate)
    smoother.markStepped(0, true)
    smoother.snap(0, 0)
    smoother.snap(1, 0)
    smoother.setTarget(0, 2)
    smoother.setTarget(1, 1)
    expect(smoother.nextBlock(0, 128)).toBe(2)
    expect(smoother.nextSample(0)).toBe(2)
    expect(smoother.nextBlock(1, 128)).toBeGreaterThan(0)
    expect(smoother.nextBlock(1, 128)).toBeLessThan(1)
  })
})

describe('per-sample gain and automation', () => {
  it('ramps a wet change so a full-scale jump does not click', () => {
    const frames = 256
    const pool = prepareChainPool(1, 2, frames)
    const input = [new Float32Array(frames), new Float32Array(frames)]
    input[0].fill(1)
    input[1].fill(1)
    const make = (wet: number): ChainSlot => ({
      id: 'gain',
      pluginId: 'saturator',
      enabled: true,
      wet,
      params: {},
      failed: false,
      sidechain: '',
      processor: {
        latencySamples: 0,
        reset() {},
        process(_input, output) {
          const n = output[0]?.length ?? 0
          for (let c = 0; c < output.length; c++) for (let i = 0; i < n; i++) output[c][i] = 0
        },
      },
    })
    const first = silence(frames)
    processChain([make(0.2)], input, first, ctx(), undefined, pool, 1)
    expect(first[0][0]).toBeCloseTo(0.8, 4)
    const second = silence(frames)
    processChain([make(1)], input, second, ctx(), undefined, pool, 1)
    expect(second[0][0]).toBeGreaterThan(0.7)
    expect(second[0][0]).toBeLessThan(0.82)
    expect(second[0][frames - 1]).toBeLessThan(0.55)
    expect(second[0][frames - 1]).toBeGreaterThan(0.2)
    let peakStep = 0
    for (let i = 1; i < frames; i++) peakStep = Math.max(peakStep, Math.abs(second[0][i] - second[0][i - 1]))
    expect(peakStep).toBeLessThan(0.02)

    const glide = new SampleGlide()
    glide.prepare(rate)
    expect(glide.next(0.5)).toBeCloseTo(0.5, 6)
    const moved = glide.next(1)
    expect(moved).toBeGreaterThan(0.5)
    expect(moved).toBeLessThan(0.51)
  })

  it('follows a cheap automation lane per sample and keeps a look-ahead plugin on one block', () => {
    let cheapCalls = 0
    const cheap: ChainSlot = {
      id: 'gain',
      pluginId: 'saturator',
      enabled: true,
      wet: 1,
      params: { gain: 0 },
      failed: false,
      sidechain: '',
      processor: {
        latencySamples: 0,
        reset() {},
        process(input, output, params) {
          cheapCalls += 1
          output[0][0] = (input[0][0] || 0) * (params.gain ?? 0)
          output[1][0] = output[0][0]
        },
      },
    }
    const frames = 4
    const scratch = prepareAccurate(1, frames)
    scratch.paramKeys[0] = ['gain']
    const output = silence(frames)
    processSampleAccurate([cheap], [new Float32Array([1, 1, 1, 1]), new Float32Array(frames)], output, ctx(), [{
      id: 'lane',
      pluginId: 'gain',
      param: 'gain',
      points: [{ beat: 0, value: 0 }, { beat: 1, value: 1 }],
    }], undefined, (sample) => sample / 3, scratch)
    expect(cheapCalls).toBe(frames)
    expect(output[0][0]).toBeCloseTo(0, 5)
    expect(output[0][3]).toBeGreaterThan(output[0][1])

    let blockCalls = 0
    const look: ChainSlot = {
      id: 'limit',
      pluginId: 'limiter',
      enabled: true,
      wet: 1,
      params: { mix: 1 },
      failed: false,
      sidechain: '',
      processor: {
        latencySamples: 64,
        reset() {},
        process(input, output) {
          blockCalls += 1
          const n = input[0]?.length ?? 0
          expect(n).toBe(frames)
          for (let i = 0; i < n; i++) {
            output[0][i] = input[0][i] || 0
            output[1][i] = input[1]?.[i] || 0
          }
        },
      },
    }
    const limited = silence(frames)
    const blockScratch = prepareAccurate(1, frames)
    blockScratch.paramKeys[0] = ['mix']
    processSampleAccurate([look], [new Float32Array([1, 1, 1, 1]), new Float32Array(frames)], limited, ctx(), [{
      id: 'mix-lane',
      pluginId: 'limit',
      param: 'mix',
      points: [{ beat: 0, value: 0 }, { beat: 1, value: 1 }],
    }], undefined, (sample) => sample / 3, blockScratch)
    expect(blockCalls).toBe(1)
    expect(usesBlockValue('limiter', 64)).toBe(true)
    expect(usesBlockValue('saturator', 0)).toBe(false)
  })
})

describe('plugin delay compensation', () => {
  it('nulls a half-wet latent plugin against the delayed dry and wet paths', () => {
    const latency = 32
    const frames = 128
    const input = silence(frames)
    input[0][0] = 1
    input[1][0] = 1
    const pool = prepareChainPool(1, 2, frames)
    const slot = (wet: number): ChainSlot => ({
      id: 'delay',
      pluginId: 'delay',
      enabled: true,
      wet,
      params: {},
      failed: false,
      sidechain: '',
      processor: delayProcessor(latency),
    })
    const full = silence(frames)
    const half = silence(frames)
    processChain([slot(1)], input, full, ctx(), undefined, pool, 1)
    const halfPool = prepareChainPool(1, 2, frames)
    processChain([slot(0.5)], input, half, ctx(), undefined, halfPool, 1)
    let error = 0
    for (let i = 0; i < frames; i++) error = Math.max(error, Math.abs(full[0][i] - half[0][i]))
    expect(error).toBeLessThan(1e-5)
    expect(full[0][latency]).toBeCloseTo(1, 5)
    expect(full[0][0]).toBe(0)
    expect(reportedLatency('limiter', { kind: 0, lookahead: 5 }, rate, true, 0, true)).toBeGreaterThan(0)
    expect(reportedLatency('eq', {}, rate, false, 80)).toBe(0)
    expect(reportedLatency('eq', {}, rate, true, 80)).toBe(80)
  })

  it('lines up track, send, and master branches from the reported latencies', () => {
    const latency = 40
    const delays = compensateGraph([
      { id: 'slow', dest: MASTER, sends: ['bus'], latency },
      { id: 'fast', dest: MASTER, sends: [], latency: 0 },
      { id: 'bus', dest: MASTER, sends: [], latency: 0 },
      { id: MASTER, dest: null, sends: [], latency: 0 },
    ])
    expect(delays.get('slow>master')).toBe(0)
    expect(delays.get('fast>master')).toBe(latency)
    expect(delays.get('slow>bus')).toBe(0)
    expect(delays.get('bus>master')).toBe(0)
    const frames = 96
    const impulse = new Float32Array(frames)
    impulse[0] = 1
    const delayed = (source: Float32Array, samples: number) => {
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        const at = i - samples
        if (at >= 0) out[i] = source[at]
      }
      return out
    }
    const slow = delayed(impulse, latency + (delays.get('slow>master') ?? 0))
    const fast = delayed(impulse, delays.get('fast>master') ?? 0)
    const send = delayed(delayed(impulse, latency), delays.get('bus>master') ?? 0)
    for (let i = 0; i < frames; i++) {
      expect(slow[i] - fast[i]).toBe(0)
      expect(slow[i] - send[i]).toBe(0)
    }
  })
})

describe('sample-offset notes', () => {
  it('starts a note on its sample and nulls against a note that began there', () => {
    const offset = 40
    const frames = 128
    const late = createNativePlugin('synth', rate)!
    const lateAudio = silence(frames)
    late.processBlock({ channels: lateAudio, numChannels: 2, numSamples: frames }, {
      events: [{ sampleOffset: offset, status: 0x90, data1: 60, data2: 100 }],
      numEvents: 1,
    })
    expect(maxAbs(lateAudio[0], 0, offset)).toBe(0)

    const early = createNativePlugin('synth', rate)!
    const remain = frames - offset
    const earlyAudio = silence(remain)
    early.processBlock({ channels: earlyAudio, numChannels: 2, numSamples: remain }, {
      events: [{ sampleOffset: 0, status: 0x90, data1: 60, data2: 100 }],
      numEvents: 1,
    })
    let error = 0
    for (let i = 0; i < remain; i++) error = Math.max(error, Math.abs(lateAudio[0][offset + i] - earlyAudio[0][i]))
    expect(error).toBeLessThan(1e-6)
    expect(maxAbs(earlyAudio[0])).toBeGreaterThan(0.01)

    const atStart = createNativePlugin('synth', rate)!
    const started = silence(frames)
    atStart.processBlock({ channels: started, numChannels: 2, numSamples: frames }, {
      events: [{ sampleOffset: 0, status: 0x90, data1: 60, data2: 100 }],
      numEvents: 1,
    })
    expect(maxAbs(started[0], 0, 8)).toBeGreaterThan(0)
  })
})

describe('prepared plugin windows', () => {
  it('keeps reverb modes and tune analysis buffers that were built before process', () => {
    const hall = createHall(rate)
    const block = 128
    const heard = silence(block)
    const params = { mode: 1, size: 0.8, decay: 0.9, damp: 0.2, mix: 1 }
    let firstEcho = 0
    for (let i = 0; i < 12; i++) {
      const input = silence(block)
      if (i === 0) input[0][0] = 1
      hall.process(input, heard, params, ctx())
      firstEcho = Math.max(firstEcho, maxAbs(heard[0]))
    }
    expect(firstEcho).toBeGreaterThan(0.01)
    hall.process(silence(block), heard, { ...params, mode: 0 }, ctx())
    let kept = 0
    for (let i = 0; i < 12; i++) {
      hall.process(silence(block), heard, params, ctx())
      kept = Math.max(kept, maxAbs(heard[0]))
    }
    expect(kept).toBeGreaterThan(0.01)

    const tune = createTune(rate)
    const trace = tune.trace
    const vocal = silence(256)
    for (let i = 0; i < vocal[0].length; i++) vocal[0][i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.4
    vocal[1].set(vocal[0])
    tune.process(vocal, silence(256), { amount: 0.8, retune: 1, minHz: 80, maxHz: 800 }, ctx())
    tune.process(vocal, silence(256), { amount: 0.8, retune: 1, minHz: 80, maxHz: 800 }, ctx())
    expect(tune.trace).toBe(trace)

    const windows = prepareTuneWindows(2048)
    const frame = new Float32Array(2048)
    for (let i = 0; i < frame.length; i++) frame[i] = Math.sin((2 * Math.PI * 220 * i) / rate)
    const first = tunePitch(frame, rate, 440, windows)
    const second = tunePitch(frame, rate, 440, windows)
    expect(first?.hz).toBeGreaterThan(150)
    expect(second?.hz).toBeCloseTo(first?.hz ?? 0, 1)
    const amp = createAmpState(rate)
    expect(amp.tuneWindows).toBe(amp.tuneWindows)
    expect(amp.tuneFrame.length).toBe(8192)
    expect(amp.tuneWindows.centered.length).toBeGreaterThanOrEqual(8192)
  })
})

describe('buffer hint', () => {
  it('names Lowest, Balanced, and Playback and formats the measured latency', () => {
    expect(BUFFER_HINTS.map((item) => item.label)).toEqual(['Lowest', 'Balanced', 'Playback'])
    expect(bufferHintOf('playback')).toBe('playback')
    expect(bufferHintOf('nope')).toBe('interactive')
    expect(latencyHintOrder('playback')[0]).toBe('playback')
    expect(latencyHintOrder('balanced')).toEqual(['balanced', 'interactive', 'playback'])
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
    }
    expect(readBufferHint(storage)).toBe('interactive')
    writeBufferHint('balanced', storage)
    expect(readBufferHint(storage)).toBe('balanced')
    expect(formatLatencyReadout(null, null)).toBe('Base not measured. Output not measured.')
    expect(formatLatencyReadout(12.04, 8)).toBe('Base 12.0 ms. Output 8.0 ms.')
  })
})
