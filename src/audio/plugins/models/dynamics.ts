import { descriptor, FACTORY } from '../catalog'
import type { PluginModule, Processor } from '../types'
import {
  BUS_ATTACKS,
  BUS_RELEASES,
  VARI_TIMES,
  VU_DBFS,
  applyFilters,
  coeff,
  clamp,
  copyFilter,
  createMeter,
  createShaper,
  dbToGain,
  designBiquad,
  fetReduction,
  gainToDb,
  oversample,
  sanitize,
  stepPick,
  trackVu,
  variReduction,
  vcaReduction,
  type Meter,
} from './analog'

function stereo(input: Float32Array[], index: number) {
  const left = input[0]?.[index] || 0
  const right = input[1]?.[index] ?? left
  return { left, right, peak: Math.max(Math.abs(left), Math.abs(right)) }
}

function write(output: Float32Array[], index: number, left: number, right: number) {
  if (output[0]) output[0][index] = sanitize(left)
  if (output[1]) output[1][index] = sanitize(right)
}

/** FET 1176-style: fixed ratios, very fast attack, program-dependent release, all-buttons crush. */
export function createFet(sampleRate: number): Processor {
  let env = 0
  const meter = createMeter()
  const shapers = [createShaper(4), createShaper(4)]
  return {
    latencySamples: 0,
    meter,
    reset() {
      env = 0
      meter.vu = -20
      meter.gr = 0
    },
    process(input, output, params, ctx) {
      const factor = ctx.quality === 'eco' ? 2 : 4
      if (shapers[0].factor !== factor) {
        shapers[0] = createShaper(factor)
        shapers[1] = createShaper(factor)
      }
      const inputDb = params.input ?? 0
      const outputDb = params.output ?? 0
      const inGain = dbToGain(inputDb)
      const outGain = dbToGain(outputDb)
      const attack = coeff(clamp(params.attack ?? 0.2, 0.02, 0.8), ctx.sampleRate)
      const n = input[0]?.length ?? 0
      const drive = Math.round(params.ratio ?? 0) >= 4 ? 0.45 : 0.12
      for (let i = 0; i < n; i++) {
        const sample = stereo(input, i)
        const left = sample.left * inGain
        const right = sample.right * inGain
        const detector = gainToDb(Math.max(Math.abs(left), Math.abs(right)))
        const target = fetReduction(detector - VU_DBFS, params.ratio ?? 0)
        const releaseMs = clamp(params.release ?? 300, 50, 1100) / (1 + Math.max(0, env) / 8)
        const rate = target > env ? attack : coeff(releaseMs, ctx.sampleRate)
        env += (target - env) * rate
        const reduced = dbToGain(-env)
        const coloredL = oversample(shapers[0], left * reduced, drive) * outGain
        const coloredR = oversample(shapers[1], right * reduced, drive) * outGain
        write(output, i, coloredL, coloredR)
        trackVu(meter, (coloredL + coloredR) * 0.5, ctx.sampleRate)
        meter.gr = env
      }
      void sampleRate
    },
  }
}

/** Opto leveler. The cell is two release memories: about 60 ms, then a multi-second tail. */
export function createOpto(sampleRate: number): Processor {
  let fast = 0
  let slow = 0
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      fast = 0
      slow = 0
      meter.vu = -20
      meter.gr = 0
    },
    process(input, output, params, ctx) {
      const reduction = clamp(params.peak ?? 0, 0, 1)
      const threshold = VU_DBFS + (1 - reduction) * 24
      const makeup = dbToGain(params.gain ?? 0)
      const attack = coeff(10, ctx.sampleRate)
      const releaseFast = coeff(60, ctx.sampleRate)
      const releaseSlow = coeff(5000, ctx.sampleRate)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const sample = stereo(input, i)
        const detector = gainToDb(sample.peak)
        const target = Math.max(0, detector - threshold) * 0.6
        const fastTarget = target * 0.7
        const slowTarget = target * 0.3
        fast += (fastTarget - fast) * (fastTarget > fast ? attack : releaseFast)
        slow += (slowTarget - slow) * (slowTarget > slow ? attack * 0.35 : releaseSlow)
        const gr = fast + slow
        const gain = dbToGain(-gr) * makeup
        write(output, i, sample.left * gain, sample.right * gain)
        trackVu(meter, ((sample.left + sample.right) * 0.5) * gain, ctx.sampleRate)
        meter.gr = gr
      }
      void sampleRate
    },
  }
}

/** VCA bus compressor. Ratios 2/4/10, stepped attack, auto release, sidechain high-pass. */
export function createBus(sampleRate: number): Processor {
  let env = 0
  const meter = createMeter()
  const side = [designBiquad('highpass', sampleRate, 80, 0.7), designBiquad('highpass', sampleRate, 80, 0.7)]
  let hpf = -1
  return {
    latencySamples: 0,
    meter,
    reset() {
      env = 0
      meter.vu = -20
      meter.gr = 0
      for (const filter of side) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    },
    process(input, output, params, ctx) {
      const freq = clamp(params.hpf ?? 80, 20, 400)
      if (freq !== hpf) {
        copyFilter(side[0], designBiquad('highpass', ctx.sampleRate, freq, 0.7))
        copyFilter(side[1], designBiquad('highpass', ctx.sampleRate, freq, 0.7))
        hpf = freq
      }
      const threshold = params.threshold ?? -10
      const makeup = dbToGain(params.makeup ?? 0)
      const attack = coeff(stepPick(params.attack ?? 2, BUS_ATTACKS), ctx.sampleRate)
      const releaseIndex = Math.round(params.release ?? 4)
      const auto = releaseIndex >= BUS_RELEASES.length - 1
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const sample = stereo(input, i)
        const left = applyFilters([side[0]], sample.left)
        const right = applyFilters([side[1]], sample.right)
        const detector = gainToDb(Math.max(Math.abs(left), Math.abs(right)))
        const target = vcaReduction(detector - threshold, params.ratio ?? 1)
        const releaseMs = auto ? 100 + env * 12 : stepPick(releaseIndex, BUS_RELEASES)
        const rate = target > env ? attack : coeff(Math.max(40, releaseMs), ctx.sampleRate)
        env += (target - env) * rate
        const gain = dbToGain(-env) * makeup
        write(output, i, sample.left * gain, sample.right * gain)
        trackVu(meter, ((sample.left + sample.right) * 0.5) * gain, ctx.sampleRate)
        meter.gr = env
      }
    },
  }
}

/** Vari-mu. Wide knee, tube color, six published time constants. */
export function createVari(sampleRate: number): Processor {
  let fast = 0
  let slow = 0
  const meter = createMeter()
  const shapers = [createShaper(4), createShaper(4)]
  return {
    latencySamples: 0,
    meter,
    reset() {
      fast = 0
      slow = 0
      meter.vu = -20
      meter.gr = 0
    },
    process(input, output, params, ctx) {
      const factor = ctx.quality === 'eco' ? 2 : 4
      if (shapers[0].factor !== factor) {
        shapers[0] = createShaper(factor)
        shapers[1] = createShaper(factor)
      }
      const timing = stepPick(params.time ?? 0, VARI_TIMES)
      const attack = coeff(timing.attack, ctx.sampleRate)
      const release = coeff(timing.release, ctx.sampleRate)
      const slowRelease = coeff(timing.slow, ctx.sampleRate)
      const inputGain = dbToGain(params.input ?? 0)
      const outputGain = dbToGain(params.output ?? 0)
      const drive = clamp(params.color ?? 0.35, 0, 1)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const sample = stereo(input, i)
        const left = sample.left * inputGain
        const right = sample.right * inputGain
        const target = variReduction(gainToDb(sample.peak * inputGain) - VU_DBFS)
        const fastTarget = target * 0.65
        const slowTarget = target * 0.35
        fast += (fastTarget - fast) * (fastTarget > fast ? attack : release)
        slow += (slowTarget - slow) * (slowTarget > slow ? attack : slowRelease)
        const gr = fast + slow
        const gain = dbToGain(-gr)
        write(output, i, oversample(shapers[0], left * gain, drive) * outputGain, oversample(shapers[1], right * gain, drive) * outputGain)
        meter.gr = gr
        trackVu(meter, ((left + right) * 0.5) * gain, ctx.sampleRate)
      }
      void sampleRate
    },
  }
}

/** True-peak lookahead limiter. The ceiling is dBTP. */
export function createPeak(sampleRate: number): Processor {
  const look = 96
  const delay = [new Float32Array(look), new Float32Array(look)]
  let index = 0
  let gain = 1
  let prevL = 0
  let prevR = 0
  const meter = createMeter()
  return {
    latencySamples: look,
    meter,
    reset() {
      delay[0].fill(0)
      delay[1].fill(0)
      index = 0
      gain = 1
      prevL = 0
      prevR = 0
      meter.vu = -20
      meter.gr = 0
    },
    process(input, output, params, ctx) {
      const hops = ctx.quality === 'eco' ? 2 : 4
      const ceiling = dbToGain(params.ceiling ?? -1)
      const release = coeff(clamp(params.release ?? 80, 10, 500), ctx.sampleRate)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const sample = stereo(input, i)
        const slot = index % look
        const delayedL = delay[0][slot]
        const delayedR = delay[1][slot]
        delay[0][slot] = sample.left
        delay[1][slot] = sample.right
        const peak = Math.max(intersample(prevL, sample.left, hops), intersample(prevR, sample.right, hops))
        prevL = sample.left
        prevR = sample.right
        const needed = peak > ceiling ? ceiling / peak : 1
        gain += ((needed < gain ? needed : gain + (needed - gain) * release) - gain)
        const gr = gain < 0.999 ? -gainToDb(gain) : 0
        write(output, i, delayedL * gain, delayedR * gain)
        meter.gr = gr
        trackVu(meter, delayedL * gain, ctx.sampleRate)
        index += 1
      }
      void sampleRate
    },
  }
}

function intersample(a: number, b: number, hops: number) {
  let peak = Math.max(Math.abs(a), Math.abs(b))
  for (let k = 1; k < hops; k++) {
    const t = k / hops
    peak = Math.max(peak, Math.abs(a + (b - a) * t))
  }
  return peak
}

export function fetModule(): PluginModule {
  return { descriptor: descriptor('fet')!, presets: FACTORY.fet, create: createFet }
}
export function optoModule(): PluginModule {
  return { descriptor: descriptor('opto')!, presets: FACTORY.opto, create: createOpto }
}
export function busModule(): PluginModule {
  return { descriptor: descriptor('bus')!, presets: FACTORY.bus, create: createBus }
}
export function variModule(): PluginModule {
  return { descriptor: descriptor('vari')!, presets: FACTORY.vari, create: createVari }
}
export function peakModule(): PluginModule {
  return { descriptor: descriptor('peak')!, presets: FACTORY.peak, create: createPeak }
}

export function meterOf(processor: Processor): Meter {
  return processor.meter ?? { vu: -20, gr: 0 }
}
