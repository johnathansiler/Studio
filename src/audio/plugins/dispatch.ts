/** One processor per core plugin. Kind selects the folded algorithm. */

import { createDynamicEq, createGlue, createImager, createMasterEq, createMasterMeter, createMaxim, createMultiband, createBrick, createClip, createDither, createTape as createMasterTape } from '../master/process'
import { createAmp } from './amp'
import { descriptor, FACTORY, defaultParams } from './catalog'
import { createChorus, createDoubler, createSaturator } from './color'
import { createDeesser, createGate, createLimiter, createCompressor } from './dynamics'
import { type CoreId } from './ids'
import { createSum, createTape } from './models/color'
import { createBus, createFet, createOpto, createVari } from './models/dynamics'
import { createChannel, createFocus, createPassive, createPre, createProp } from './models/eqs'
import { createBbd, createConv, createDigital, createEcho, createEnsemble, createHall, createPhase, createPlate, createRotor } from './models/space'
import eqModule from './eq'
import { createPitch } from './pitch'
import { createSampler } from './sampler'
import { createDelay, createReverb } from './space'
import { createTune } from './tune'
import type { BlockContext, PluginModule, Processor } from './types'

const ampDefaults = defaultParams('amp')

function createSynthVoice(sampleRate: number): Processor & { note: (pitch: number, vel: number) => void } {
  let pitch = 60
  let vel = 0
  let env = 0
  let phase = 0
  return {
    latencySamples: 0,
    reset() {
      vel = 0
      env = 0
      phase = 0
    },
    note(next, level) {
      pitch = Math.max(0, Math.min(127, next))
      vel = Math.max(0, Math.min(1, level))
    },
    process(input, output) {
      const n = output[0]?.length ?? 0
      const step = (2 * Math.PI * 440 * 2 ** ((pitch - 69) / 12)) / sampleRate
      for (let i = 0; i < n; i++) {
        const dryAt = (channel: number) => input[Math.min(channel, input.length - 1)]?.[i] ?? 0
        if (vel <= 0 && env <= 1e-5) {
          env = 0
          for (let c = 0; c < output.length; c++) output[c][i] = dryAt(c)
          continue
        }
        env += (vel - env) * (vel > env ? 0.25 : 0.04)
        if (env < 1e-5) env = 0
        const sample = env > 0 ? Math.sin(phase) * env * 0.35 : 0
        phase += step
        if (phase > Math.PI * 2) phase -= Math.PI * 2
        for (let c = 0; c < output.length; c++) output[c][i] = dryAt(c) + sample
      }
    },
  }
}

function passthrough(): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      const n = input[0]?.length ?? output[0]?.length ?? 0
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)]
        const dest = output[c]
        if (!dest) continue
        if (src && src !== dest) dest.set(src.subarray(0, n))
      }
    },
  }
}

function hold(sampleRate: number, factory: (rate: number) => Processor) {
  let proc: Processor | null = null
  return () => (proc ??= factory(sampleRate))
}

function series(
  chain: Processor[],
  input: Float32Array[],
  output: Float32Array[],
  params: Record<string, number>,
  ctx: BlockContext,
  pool?: Float32Array[][],
) {
  if (!chain.length) {
    passthrough().process(input, output, params, ctx)
    return
  }
  let current = input
  for (let i = 0; i < chain.length; i++) {
    const last = i === chain.length - 1
    let dest: Float32Array[]
    if (last) dest = output
    else if (pool) dest = stageBuffer(pool, i, output)
    else dest = output.map((channel) => new Float32Array(channel.length))
    chain[i].process(current, dest, params, ctx)
    current = dest
  }
}

const PREPARED_BLOCKS = [128, 256, 512, 1024, 2048]

function preparedPair() {
  const full = [new Float32Array(2048), new Float32Array(2048)]
  const views = new Map<number, Float32Array[]>()
  for (let i = 0; i < PREPARED_BLOCKS.length; i++) {
    const n = PREPARED_BLOCKS[i]
    views.set(n, [full[0].subarray(0, n), full[1].subarray(0, n)])
  }
  return (frames: number) => {
    const n = Math.max(1, frames | 0)
    const hit = views.get(n)
    if (hit) return hit
    if (n > full[0].length) {
      full[0] = new Float32Array(n)
      full[1] = new Float32Array(n)
    }
    const view = [full[0].subarray(0, n), full[1].subarray(0, n)]
    views.set(n, view)
    return view
  }
}

function stageBuffer(pool: Float32Array[][], index: number, output: Float32Array[]) {
  const n = output[0]?.length ?? 0
  const channels = output.length
  let row = pool[index]
  if (!row || row.length < channels || row[0].length < n) {
    row = Array.from({ length: channels }, () => new Float32Array(Math.max(2048, n)))
    pool[index] = row
  }
  if (row[0].length === n) return row
  const key = n
  const cached = row as Float32Array[] & { views?: Map<number, Float32Array[]> }
  if (!cached.views) cached.views = new Map()
  const hit = cached.views.get(key)
  if (hit) return hit
  const view = row.map((buffer) => buffer.subarray(0, n))
  cached.views.set(key, view)
  return view
}

function preseedStages(pool: Float32Array[][], count: number) {
  for (let i = 0; i < PREPARED_BLOCKS.length; i++) {
    const n = PREPARED_BLOCKS[i]
    const fake = [new Float32Array(n), new Float32Array(n)]
    for (let s = 0; s < count; s++) stageBuffer(pool, s, fake)
  }
}

function wrap(sampleRate: number, pick: (kind: number) => Processor, map: (kind: number, params: Record<string, number>) => Record<string, number>, latency = 0): Processor {
  const meter = createMasterMeter(sampleRate)
  const scratch = preparedPair()
  const self: Processor = {
    latencySamples: latency,
    spectrum: meter.spectrum,
    meters: meter.meters,
    scope: meter.scope,
    reset() {
      pick(0).reset()
      meter.reset()
    },
    process(input, output, params, ctx) {
      const kind = Math.round(params.kind ?? 0)
      const child = pick(kind)
      child.process(input, output, map(kind, params), ctx)
      self.latencySamples = child.latencySamples || latency
      self.meter = child.meter
      self.tuner = child.tuner
      self.trace = child.trace
      if (child.spectrum) self.spectrum = child.spectrum
      const n = output[0]?.length ?? 0
      meter.process(output, scratch(n), {}, ctx)
      if (!child.spectrum) self.spectrum = meter.spectrum
      self.meters = meter.meters
      self.scope = meter.scope
    },
  }
  return self
}

function eqParams(kind: number, params: Record<string, number>): Record<string, number> {
  if (kind === 1) {
    return {
      lowF: params.pLow ?? 2,
      lowBoost: params.pBoost ?? 0,
      lowAtten: params.pAtten ?? 0,
      highF: params.pHigh ?? 4,
      highBoost: params.pAir ?? 0,
      highBw: params.pWidth ?? 0.5,
      highAtten: params.pCut ?? 0,
      highAttenF: params.pCutF ?? 1,
    }
  }
  if (kind === 2) {
    return {
      hp: params.preHp ?? 0,
      lowF: params.preLow ?? 2,
      lowG: params.preLowG ?? 0,
      midF: params.preMid ?? 2,
      midG: params.preMidG ?? 0,
      highF: params.preHigh ?? 0,
      highG: params.preHighG ?? 0,
      drive: params.preDrive ?? 0,
    }
  }
  if (kind === 4) return { freq: params.tiltF ?? 5, gain: params.tiltG ?? 0 }
  if (kind === 5) return { ...params, ms: 0, threshold: params.focusThresh ?? -18 }
  if (kind === 6) return { ...params, ms: 0, sLow: 0, sMid: 0, sHigh: 0, phase: params.phase ?? 1 }
  if (kind === 7) {
    return {
      freq: params.dynF ?? 3000,
      q: params.dynQ ?? 1.2,
      threshold: params.dynThresh ?? -24,
      gain: params.dynG ?? 0,
      attack: params.dynA ?? 10,
      release: params.dynR ?? 80,
    }
  }
  return params
}

function compParams(kind: number, params: Record<string, number>): Record<string, number> {
  if (kind === 1) {
    return {
      input: params.fetIn ?? 0,
      output: params.fetOut ?? 0,
      ratio: params.fetRatio ?? 0,
      attack: params.fetAtk ?? 0.2,
      release: params.fetRel ?? 300,
    }
  }
  if (kind === 2) return { peak: params.optoPeak ?? 0.35, gain: params.optoGain ?? 6 }
  if (kind === 3) {
    return {
      threshold: params.busThresh ?? -8,
      ratio: params.busRatio ?? 1,
      attack: params.busAtk ?? 2,
      release: params.busRel ?? 4,
      hpf: params.hpf ?? 80,
      makeup: params.busMakeup ?? 0,
    }
  }
  if (kind === 4) {
    return {
      time: params.variTime ?? 1,
      input: params.variIn ?? 0,
      output: params.variOut ?? 0,
      color: params.variColor ?? 0.35,
    }
  }
  if (kind === 6) return { ...params, ms: 0 }
  return params
}

function satParams(kind: number, params: Record<string, number>): Record<string, number> {
  if (kind === 4) return { drive: params.drive ?? 0, mode: params.clipMode ?? 0, ceiling: params.ceiling ?? -0.3 }
  if (kind === 5) return { ...ampDefaults, ...params }
  return params
}

export function createCore(id: CoreId, sampleRate: number): Processor {
  if (id === 'tune') return createTune(sampleRate)
  if (id === 'scaler') return passthrough()
  if (id === 'synth') return createSynthVoice(sampleRate)
  if (id === 'eq') {
    const banks = [
      hold(sampleRate, (rate) => eqModule.create(rate)),
      hold(sampleRate, createPassive),
      hold(sampleRate, createPre),
      hold(sampleRate, createChannel),
      hold(sampleRate, createProp),
      hold(sampleRate, createFocus),
      hold(sampleRate, createMasterEq),
      hold(sampleRate, createDynamicEq),
    ]
    return wrap(sampleRate, (kind) => banks[Math.max(0, Math.min(7, kind))](), eqParams)
  }
  if (id === 'compressor') {
    const banks = [
      hold(sampleRate, createCompressor),
      hold(sampleRate, createFet),
      hold(sampleRate, createOpto),
      hold(sampleRate, createBus),
      hold(sampleRate, createVari),
      hold(sampleRate, createGlue),
      hold(sampleRate, createMultiband),
    ]
    return wrap(sampleRate, (kind) => banks[Math.max(0, Math.min(6, kind))](), compParams)
  }
  if (id === 'vocal') return createVocal(sampleRate)
  if (id === 'saturator') {
    const banks = [
      hold(sampleRate, createSaturator),
      hold(sampleRate, createTape),
      hold(sampleRate, createSum),
      hold(sampleRate, createMasterTape),
      hold(sampleRate, createClip),
      hold(sampleRate, createAmp),
    ]
    return wrap(sampleRate, (kind) => banks[Math.max(0, Math.min(5, kind))](), satParams)
  }
  if (id === 'reverb') {
    const banks = [
      hold(sampleRate, createReverb),
      hold(sampleRate, createPlate),
      hold(sampleRate, createHall),
      hold(sampleRate, createConv),
    ]
    return wrap(sampleRate, (kind) => banks[Math.max(0, Math.min(3, kind))](), (_kind, params) => params)
  }
  if (id === 'delay') {
    const banks = [
      hold(sampleRate, createDelay),
      hold(sampleRate, createEcho),
      hold(sampleRate, createBbd),
      hold(sampleRate, createDigital),
    ]
    return wrap(sampleRate, (kind) => banks[Math.max(0, Math.min(3, kind))](), (_kind, params) => params)
  }
  if (id === 'mod') {
    const banks = [
      hold(sampleRate, createChorus),
      hold(sampleRate, createDoubler),
      hold(sampleRate, createEnsemble),
      hold(sampleRate, createPhase),
      hold(sampleRate, createRotor),
      hold(sampleRate, createPitch),
    ]
    return wrap(sampleRate, (kind) => banks[Math.max(0, Math.min(5, kind))](), (_kind, params) => params, 0)
  }
  if (id === 'sampler') return createSamplerCore(sampleRate)
  return createMaster(sampleRate)
}

function createVocal(sampleRate: number): Processor {
  const gate = createGate(sampleRate)
  const ess = createDeesser(sampleRate)
  const mid = preparedPair()
  return {
    latencySamples: 0,
    meter: ess.meter,
    reset() {
      gate.reset()
      ess.reset()
    },
    process(input, output, params, ctx) {
      const kind = Math.round(params.kind ?? 0)
      const n = input[0]?.length ?? 0
      const between = mid(n)
      const gateParams = {
        threshold: kind === 1 ? -80 : (params.gate ?? -80),
        ratio: kind === 1 ? 1 : (params.gateRatio ?? 1),
        attack: params.gateAtk ?? 5,
        release: params.gateRel ?? 80,
        hold: params.hold ?? 20,
        range: params.range ?? 40,
      }
      const essParams = {
        freq: params.freq ?? 6500,
        threshold: params.threshold ?? -18,
        amount: kind === 2 ? 0 : (params.amount ?? 0),
      }
      const gateOpen = gateParams.threshold <= -79 && gateParams.ratio <= 1.01
      const essOff = essParams.amount <= 0.0001
      if (gateOpen && essOff) {
        passthrough().process(input, output, params, ctx)
        return
      }
      if (gateOpen) {
        ess.process(input, output, essParams, ctx)
        return
      }
      if (essOff) {
        gate.process(input, output, gateParams, ctx)
        return
      }
      gate.process(input, between, gateParams, ctx)
      ess.process(between, output, essParams, ctx)
    },
  }
}

function createSamplerCore(sampleRate: number): Processor {
  const sampler = createSampler(sampleRate)
  const thru = passthrough()
  const self = sampler as Processor & {
    bind?: (plugin: unknown, asset: (id: string) => Float32Array | null) => void
    note?: (pitch: number, velocity: number) => void
  }
  return {
    latencySamples: 0,
    spectrum: sampler.spectrum,
    reset() {
      sampler.reset()
    },
    bind(plugin, asset) {
      self.bind?.(plugin, asset)
    },
    note(pitch, velocity) {
      self.note?.(pitch, velocity)
    },
    process(input, output, params, ctx) {
      if (Math.round(params.kind ?? 0) >= 1) {
        thru.process(input, output, params, ctx)
        return
      }
      sampler.process(input, output, params, ctx)
    },
  } as Processor & { bind: (plugin: unknown, asset: (id: string) => Float32Array | null) => void; note: (pitch: number, velocity: number) => void }
}

function createMaster(sampleRate: number): Processor {
  const clean = createLimiter(sampleRate)
  const brick = createBrick(sampleRate)
  const maxim = createMaxim(sampleRate)
  const image = createImager(sampleRate)
  const dither = createDither()
  const meter = createMasterMeter(sampleRate)
  const scratch = preparedPair()
  const stages: Float32Array[][] = []
  preseedStages(stages, 4)
  return {
    latencySamples: 64,
    spectrum: meter.spectrum,
    meters: meter.meters,
    scope: meter.scope,
    meter: clean.meter,
    reset() {
      clean.reset()
      brick.reset()
      maxim.reset()
      image.reset()
      dither.reset()
      meter.reset()
    },
    process(input, output, params, ctx) {
      const kind = Math.round(params.kind ?? 0)
      const chain: Processor[] = []
      const wide = Math.abs((params.width ?? 1) - 1) > 0.001
        || Math.abs((params.low ?? 1) - 1) > 0.001
        || Math.abs((params.high ?? 1) - 1) > 0.001
        || Math.abs((params.bass ?? 120) - 120) > 0.5
      if (wide) chain.push(image)
      if (kind === 2) chain.push(maxim)
      if (kind >= 1) chain.push(brick)
      else chain.push(clean)
      if ((params.bits ?? 24) < 23.5 || (params.shape ?? 0) > 0.05) chain.push(dither)
      series(chain, input, output, params, ctx, stages)
      const n = output[0]?.length ?? 0
      meter.process(output, scratch(n), {}, ctx)
      this.latencySamples = kind >= 1 ? brick.latencySamples : clean.latencySamples
      this.meter = kind >= 1 ? brick.meter : clean.meter
      this.spectrum = meter.spectrum
      this.meters = meter.meters
      this.scope = meter.scope
    },
  }
}

export function moduleFor(id: CoreId): PluginModule {
  const spec = descriptor(id)
  if (!spec) throw new Error(`Unknown plugin ${id}`)
  return {
    descriptor: spec,
    presets: FACTORY[id] ?? [],
    create: (sampleRate) => createCore(id, sampleRate),
  }
}
