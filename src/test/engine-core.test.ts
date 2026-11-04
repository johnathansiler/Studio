import { describe, expect, it } from 'vitest'
import { EMPTY_MIDI } from '../audio/core/contract'
import { compensateGraph, sumLatency } from '../audio/core/latency'
import { consumeMeter, createMeterBus, readMeter, writeMeter } from '../audio/core/meter'
import { createNativePlugin, manifestFor, pluginManifests } from '../audio/core/registry'
import { audioStateOf, planRecovery, sessionAfter } from '../audio/core/session'
import { BlockSmoother, ParamSmoother } from '../audio/core/smooth'
import { prepareAccurate, processSampleAccurate } from '../audio/automationRender'
import { prepareChainPool, processChain, type ChainSlot } from '../audio/plugins/chain'
import { defaultParams, latencyOf } from '../audio/plugins/catalog'
import { create as createEq } from '../audio/plugins/eq'
import { createProcessor } from '../audio/plugins/createAll'
import { glideValue } from '../audio/paramCurve'
import { MASTER } from '../audio/routing'
import { holdMeter, type MeterHold } from '../ui/levels'
import type { Processor } from '../audio/plugins/types'

const rate = 48000

function tone(frames = 128) {
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.4
    left[i] = sample
    right[i] = sample * 0.5
  }
  return [left, right]
}

function maxDiff(a: Float32Array, b: Float32Array) {
  let max = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs((a[i] || 0) - (b[i] || 0)))
  return max
}

describe('portable plugin contract', () => {
  it('publishes JSON manifests for tune, the step sequencer, and Beat Machine', () => {
    const manifests = pluginManifests()
    expect(JSON.parse(JSON.stringify(manifests)).length).toBe(manifests.length)
    const tune = manifestFor('tune')
    expect(tune?.category).toBe('insert')
    expect(tune?.layout.controls.some((control) => control.key === 'retune')).toBe(true)
    const steps = manifestFor('steps')
    expect(steps?.category).toBe('sequencer')
    expect(steps?.module).toBe('steps')
    const sampler = manifestFor('sampler')
    expect(sampler?.category).toBe('instrument')
    expect(sampler?.modes).toContain('Beat Machine')
  })

  it('round-trips parameters and state without changing a settled EQ block', () => {
    const plugin = createNativePlugin('eq', rate)
    const direct = createProcessor('eq', rate)
    expect(plugin && direct).toBeTruthy()
    if (!plugin || !direct) return
    expect(plugin.getNumParameters()).toBe(plugin.layout().controls.length)
    const gain = plugin.layout().controls.find((control) => control.key === 'midG')
    expect(gain).toBeTruthy()
    plugin.setParameter(gain!.paramId, 3)
    expect(plugin.getParameter(gain!.paramId)).toBe(3)
    const bytes = plugin.getState()
    plugin.setParameter(gain!.paramId, 0)
    plugin.setState(bytes)
    expect(plugin.getParameter(gain!.paramId)).toBe(3)
    plugin.setState(plugin.getState())
    const input = tone()
    const adapted = tone()
    const plain = [new Float32Array(input[0].length), new Float32Array(input[0].length)]
    plugin.processBlock({ channels: adapted, numChannels: 2, numSamples: adapted[0].length }, EMPTY_MIDI)
    direct.process(input, plain, { ...defaultParams('eq'), midG: 3 }, {
      sampleRate: rate,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      quality: 'full',
    })
    expect(maxDiff(adapted[0], plain[0])).toBeLessThan(1e-5)
    expect(maxDiff(adapted[1], plain[1])).toBeLessThan(1e-5)
  })

  it('keeps the step sequencer silent in the insert chain and the beat machine transparent', () => {
    const steps = createNativePlugin('steps', rate)!
    expect(steps.getLatencyInSamples()).toBe(0)
    steps.setParameter(0, 1)
    const saved = steps.getState()
    steps.setParameter(0, 0)
    steps.setState(saved)
    expect(steps.getParameter(0)).toBe(1)
    const audio = tone(32)
    const before = audio[0][0]
    steps.processBlock({ channels: audio, numChannels: 2, numSamples: 32 }, EMPTY_MIDI)
    expect(audio[0][0]).toBe(before)

    const beat = createNativePlugin('sampler', rate)!
    const kind = beat.layout().controls.find((control) => control.key === 'kind')!
    beat.setParameter(kind.paramId, 1)
    beat.setState(beat.getState())
    const hit = new Float32Array(64)
    const right = new Float32Array(64)
    hit[0] = 0.8
    beat.processBlock({ channels: [hit, right], numChannels: 2, numSamples: 64 }, EMPTY_MIDI)
    expect(hit[0]).toBeCloseTo(0.8, 5)
  })

  it('delivers a MIDI note to the synth and reports limiter latency', () => {
    const synth = createNativePlugin('synth', rate)!
    const audio = [new Float32Array(128), new Float32Array(128)]
    synth.processBlock({
      channels: audio,
      numChannels: 2,
      numSamples: 128,
    }, {
      events: [{ sampleOffset: 0, status: 0x90, data1: 60, data2: 100 }],
      numEvents: 1,
    })
    let energy = 0
    for (let i = 0; i < audio[0].length; i++) energy += Math.abs(audio[0][i])
    expect(energy).toBeGreaterThan(0.1)

    const limiter = createNativePlugin('limiter', rate)!
    expect(limiter.getLatencyInSamples()).toBe(latencyOf('limiter', defaultParams('limiter'), rate, true, true))
    const kind = limiter.layout().controls.find((control) => control.key === 'kind')!
    const look = limiter.layout().controls.find((control) => control.key === 'lookahead')!
    limiter.setParameter(kind.paramId, 1)
    limiter.setParameter(look.paramId, 5)
    expect(limiter.getLatencyInSamples()).toBe(Math.round((5 / 1000) * rate))
  })
})

describe('parameter smoothing', () => {
  it('matches the block glide and moves one sample at a time', () => {
    const smoother = new ParamSmoother()
    smoother.prepare(1, rate)
    smoother.snap(0, 0)
    smoother.setTarget(0, 1)
    let block = 0
    for (let i = 0; i < 4; i++) {
      block = glideValue(block, 1, 128, rate)
      expect(smoother.nextBlock(0, 128)).toBeCloseTo(block, 12)
    }
    const perSample = new ParamSmoother()
    perSample.prepare(1, rate)
    perSample.snap(0, 0)
    perSample.setTarget(0, 1)
    const first = perSample.nextSample(0)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(0.01)
    let previous = first
    for (let i = 0; i < 2000; i++) previous = perSample.nextSample(0)
    expect(previous).toBeGreaterThan(0.9)
    expect(previous).toBeLessThanOrEqual(1)
  })

  it('snaps the first block and then glides, leaving a steady value untouched', () => {
    const host = new BlockSmoother()
    const into: Record<string, number> = {}
    const first = host.apply('eq', { gain: 0.2 }, 128, rate, into, ['gain'])
    expect(first.gain).toBeCloseTo(0.2, 12)
    const next: Record<string, number> = {}
    const second = host.apply('eq', { gain: 1 }, 128, rate, next, ['gain'])
    expect(second.gain).toBeCloseTo(glideValue(0.2, 1, 128, rate), 12)
    const mid = second.gain
    const held = host.apply('eq', { gain: 1 }, 128, rate, next, ['gain'])
    expect(held.gain).toBeCloseTo(glideValue(mid, 1, 128, rate), 12)
    const steady = new BlockSmoother()
    const box: Record<string, number> = {}
    steady.apply('a', { mix: 0.5 }, 128, rate, box, ['mix'])
    const again = steady.apply('a', { mix: 0.5 }, 128, rate, box, ['mix'])
    expect(again.mix).toBeCloseTo(0.5, 12)
  })
})

describe('latency compensation', () => {
  it('delays the faster branch by the slower plugin latency', () => {
    const limiter = createNativePlugin('limiter', rate)!
    const latency = limiter.getLatencyInSamples()
    expect(sumLatency([latency, 0, -4])).toBe(latency)
    const delays = compensateGraph([
      { id: 'slow', dest: MASTER, sends: [], latency },
      { id: 'fast', dest: MASTER, sends: [], latency: 0 },
      { id: MASTER, dest: null, sends: [], latency: 0 },
    ])
    expect(delays.get('slow>master')).toBe(0)
    expect(delays.get('fast>master')).toBe(latency)
  })

  it('matches a pooled chain to the allocating chain', () => {
    const frames = 128
    const input = tone(frames)
    const params = defaultParams('eq')
    const make = (): ChainSlot => ({
      id: 'eq',
      pluginId: 'eq',
      enabled: true,
      wet: 1,
      params,
      failed: false,
      sidechain: '',
      processor: createEq(rate),
    })
    const ctx = {
      sampleRate: rate,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11] as const,
      quality: 'full' as const,
    }
    const plainOut = [new Float32Array(frames), new Float32Array(frames)]
    const pooledOut = [new Float32Array(frames), new Float32Array(frames)]
    processChain([make()], input, plainOut, ctx)
    const pool = prepareChainPool(2, 2, frames)
    processChain([make()], input, pooledOut, ctx, undefined, pool, 1)
    expect(maxDiff(plainOut[0], pooledOut[0])).toBe(0)
    expect(maxDiff(plainOut[1], pooledOut[1])).toBe(0)
  })

  it('keeps sample-accurate automation when the scratch pool is used', () => {
    let calls = 0
    const processor: Processor = {
      latencySamples: 0,
      reset() {},
      process(input, output, params) {
        calls += 1
        output[0][0] = input[0][0] * (params.gain ?? 1)
        output[1][0] = output[0][0]
      },
    }
    const slot: ChainSlot = {
      id: 'gain',
      pluginId: 'eq',
      enabled: true,
      wet: 1,
      params: { gain: 0 },
      failed: false,
      sidechain: '',
      processor,
    }
    const frames = 4
    const input = [new Float32Array([1, 1, 1, 1]), new Float32Array(4)]
    const output = [new Float32Array(4), new Float32Array(4)]
    const scratch = prepareAccurate(1, frames)
    scratch.paramKeys[0] = ['gain']
    processSampleAccurate([slot], input, output, {
      sampleRate: rate,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      quality: 'full',
    }, [{
      id: 'lane',
      pluginId: 'gain',
      param: 'gain',
      points: [{ beat: 0, value: 0.25 }, { beat: 1, value: 0.25 }],
    }], undefined, () => 0.5, scratch)
    expect(calls).toBe(frames)
    expect(output[0][0]).toBeCloseTo(0.25, 6)
    expect(output[0][3]).toBeCloseTo(0.25, 6)
  })
})

describe('interruption recovery', () => {
  it('resumes a phone-call interruption and rebuilds a closed device without dropping the project', () => {
    expect(audioStateOf('interrupted')).toBe('interrupted')
    expect(planRecovery('interrupted', true)).toBe('resume')
    expect(planRecovery('suspended', true)).toBe('resume')
    expect(planRecovery('closed', true)).toBe('rebuild')
    expect(planRecovery('interrupted', false)).toBe('none')
    expect(planRecovery('running', true)).toBe('none')
    const kept = sessionAfter({
      playing: true,
      positionSamples: 48000,
      mode: 'arrangement',
      projectHeld: true,
    }, 'rebuild', true)
    expect(kept.projectHeld).toBe(true)
    expect(kept.positionSamples).toBe(48000)
    expect(kept.playing).toBe(true)
    expect(kept.mode).toBe('arrangement')
    const waiting = sessionAfter({
      playing: true,
      positionSamples: 100,
      mode: 'session',
      projectHeld: true,
    }, 'resume', false)
    expect(waiting.projectHeld).toBe(true)
    expect(waiting.positionSamples).toBe(100)
    expect(waiting.playing).toBe(false)
  })
})

describe('meter mailbox', () => {
  it('holds a one-block peak until the UI reads it', () => {
    const bus = createMeterBus(1, false)
    writeMeter(bus, 0, 0.9, 0.2)
    writeMeter(bus, 0, 0, 0)
    const held = readMeter(bus, 0)
    expect(held.peak).toBe(0)
    expect(held.hold).toBeCloseTo(0.9, 6)
    const seen = consumeMeter(bus, 0)
    expect(seen.hold).toBeCloseTo(0.9, 6)
    expect(readMeter(bus, 0).hold).toBe(0)
  })

  it('still holds a short drum hit on the mixer meter', () => {
    const hold: MeterHold = { value: 0, at: 0 }
    const painted = holdMeter(hold, 0.5, 1000)
    expect(painted).toBeGreaterThan(0.5)
    const later = holdMeter(hold, 0, 1100)
    expect(later).toBe(painted)
    expect(holdMeter(hold, 0, 1000 + 220 + 280)).toBe(0)
  })
})
