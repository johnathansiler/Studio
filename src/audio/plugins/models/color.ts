import { descriptor, FACTORY } from '../catalog'
import { designBiquad, tickBiquad, type Biquad } from '../dsp'
import type { PluginModule, Processor } from '../types'
import {
  applyFilters,
  clamp,
  coeff,
  copyFilter,
  createMeter,
  createShaper,
  oversample,
  sanitize,
  tapeBumpHz,
  trackVu,
} from './analog'

function out(output: Float32Array[], index: number, left: number, right: number) {
  if (output[0]) output[0][index] = sanitize(left)
  if (output[1]) output[1][index] = sanitize(right)
}

/** Tape machine: speed, bias, wow, head bump, and a quiet hiss floor. */
export function createTape(sampleRate: number): Processor {
  const shapers = [createShaper(4), createShaper(4)]
  const bump = [designBiquad('peaking', sampleRate, 55, 0.8, 0), designBiquad('peaking', sampleRate, 55, 0.8, 0)]
  const hiss = [designBiquad('highpass', sampleRate, 2000, 0.7), designBiquad('lowpass', sampleRate, 8000, 0.7)]
  const delay = [new Float32Array(256), new Float32Array(256)]
  let write = 0
  let phase = 0
  let seed = 19
  let bumpKey = ''
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      delay[0].fill(0)
      delay[1].fill(0)
      write = 0
      phase = 0
      seed = 19
    },
    process(input, output, params, ctx) {
      const factor = ctx.quality === 'eco' ? 2 : 4
      if (shapers[0].factor !== factor) {
        shapers[0] = createShaper(factor)
        shapers[1] = createShaper(factor)
      }
      const speed = clamp(Math.round(params.speed ?? 1), 0, 2)
      const bumpHz = tapeBumpHz(speed)
      const bumpDb = clamp(params.bump ?? 0.5, 0, 1) * 6
      const key = `${speed}:${bumpDb}`
      if (key !== bumpKey) {
        copyFilter(bump[0], designBiquad('peaking', ctx.sampleRate, bumpHz, 0.9, bumpDb))
        copyFilter(bump[1], designBiquad('peaking', ctx.sampleRate, bumpHz, 0.9, bumpDb))
        bumpKey = key
      }
      const bias = clamp(params.bias ?? 0.4, 0, 1)
      const speeds = [7.5, 15, 30]
      const rolloff = 6000 * (speeds[speed] / 15) * (1.15 - bias * 0.5)
      const lowpass = [designBiquad('lowpass', ctx.sampleRate, rolloff, 0.7), designBiquad('lowpass', ctx.sampleRate, rolloff, 0.7)]
      const wow = clamp(params.wow ?? 0.2, 0, 1)
      const drive = 0.15 + clamp(params.drive ?? 0.35, 0, 1) * 0.7
      const hissLevel = ctx.quality === 'eco' ? 0 : clamp(params.hiss ?? 0.15, 0, 1) * 0.004
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const left = input[0]?.[i] || 0
        const right = input[1]?.[i] ?? left
        phase += (2 * Math.PI * (0.6 + wow * 2)) / ctx.sampleRate
        const flutter = Math.sin(phase) * wow * 8
        delay[0][write] = left
        delay[1][write] = right
        const readAt = write - 24 - flutter
        const coloredL = oversample(shapers[0], readDelay(delay[0], readAt), drive)
        const coloredR = oversample(shapers[1], readDelay(delay[1], readAt), drive)
        seed = (seed * 16807) % 2147483647
        const noise = ((seed / 2147483647) * 2 - 1) * hissLevel
        const hissed = tickBiquad(hiss[1], tickBiquad(hiss[0], noise))
        const bumpedL = tickBiquad(lowpass[0], tickBiquad(bump[0], coloredL)) + hissed
        const bumpedR = tickBiquad(lowpass[1], tickBiquad(bump[1], coloredR)) + hissed
        out(output, i, bumpedL, bumpedR)
        trackVu(meter, bumpedL, ctx.sampleRate)
        write = (write + 1) % delay[0].length
      }
    },
  }
}

function readDelay(line: Float32Array, at: number) {
  const length = line.length
  const wrapped = ((at % length) + length) % length
  const index = Math.floor(wrapped)
  const frac = wrapped - index
  const next = (index + 1) % length
  return line[index] * (1 - frac) + line[next] * frac
}

/** Console summing saturation, with a tube preamp mode. */
export function createSum(sampleRate: number): Processor {
  const shapers = [createShaper(4), createShaper(4)]
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      meter.vu = -20
      meter.gr = 0
    },
    process(input, output, params, ctx) {
      const factor = ctx.quality === 'eco' ? 2 : 4
      if (shapers[0].factor !== factor) {
        shapers[0] = createShaper(factor)
        shapers[1] = createShaper(factor)
      }
      const tube = (params.tube ?? 0) >= 0.5
      const drive = clamp(params.drive ?? 0.3, 0, 1) * (tube ? 1 : 0.55)
      const makeup = 1 / (1 + drive * 0.35)
      const n = input[0]?.length ?? 0
      const bend = (sample: number) => (tube ? sample + 0.45 * sample * sample : sample)
      for (let i = 0; i < n; i++) {
        const left = oversample(shapers[0], bend(input[0]?.[i] || 0), drive) * makeup
        const right = oversample(shapers[1], bend(input[1]?.[i] ?? input[0]?.[i] ?? 0), drive) * makeup
        out(output, i, left, right)
        trackVu(meter, left, ctx.sampleRate)
      }
      void sampleRate
    },
  }
}

export function tapeModule(): PluginModule {
  return { descriptor: descriptor('tape')!, presets: FACTORY.tape, create: createTape }
}
export function sumModule(): PluginModule {
  return { descriptor: descriptor('sum')!, presets: FACTORY.sum, create: createSum }
}

export { coeff, applyFilters, type Biquad }
