import { descriptor, FACTORY } from '../catalog'
import { designBiquad, tickBiquad, type Biquad } from '../dsp'
import type { PluginModule, Processor } from '../types'
import { clamp, createMeter, createShaper, oversample, sanitize, trackVu } from './analog'

function out(output: Float32Array[], index: number, left: number, right: number) {
  if (output[0]) output[0][index] = sanitize(left)
  if (output[1]) output[1][index] = sanitize(right)
}

function mix(dry: number, wet: number, amount: number) {
  return dry * (1 - amount) + wet * amount
}

class Comb {
  private readonly line: Float32Array
  private index = 0
  private dampState = 0
  constructor(length: number) {
    this.line = new Float32Array(Math.max(2, length))
  }
  clear() {
    this.line.fill(0)
    this.index = 0
    this.dampState = 0
  }
  step(sample: number, feedback: number, damp: number) {
    const delayed = this.line[this.index]
    this.dampState = delayed * (1 - damp) + this.dampState * damp
    this.line[this.index] = sample + this.dampState * feedback
    this.index = (this.index + 1) % this.line.length
    return delayed
  }
}

function verb(sampleRate: number, scales: number[], decayDefault: number): Processor {
  const combs = scales.map((scale) => new Comb(Math.round(sampleRate * scale)))
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      for (const comb of combs) comb.clear()
    },
    process(input, output, params, ctx) {
      const size = clamp(params.size ?? 0.6, 0.15, 1)
      const decay = clamp(params.decay ?? decayDefault, 0.05, 0.98)
      const damp = clamp(params.damp ?? 0.4, 0, 0.95)
      const amount = clamp(params.mix ?? 0.25, 0, 1)
      const feedback = decay * (0.55 + size * 0.4)
      const n = input[0]?.length ?? 0
      const used = ctx.quality === 'eco' ? Math.max(2, combs.length - 2) : combs.length
      for (let i = 0; i < n; i++) {
        const left = input[0]?.[i] || 0
        const right = input[1]?.[i] ?? left
        let wetL = 0
        let wetR = 0
        for (let c = 0; c < used; c++) {
          const tap = combs[c].step((c % 2 === 0 ? left : right) * 0.2, feedback, damp)
          if (c % 2 === 0) wetL += tap
          else wetR += tap
        }
        out(output, i, mix(left, wetL / 2, amount), mix(right, wetR / 2, amount))
        trackVu(meter, output[0]?.[i] || 0, ctx.sampleRate)
      }
    },
  }
}

/** Plate. Short, bright, dense tails. */
export function createPlate(sampleRate: number): Processor {
  return verb(sampleRate, [0.021, 0.027, 0.033, 0.039, 0.044, 0.051], 0.72)
}

/** Algorithmic room, hall, and chamber. */
export function createHall(sampleRate: number): Processor {
  const rooms = [
    [0.018, 0.023, 0.029, 0.037],
    [0.031, 0.043, 0.057, 0.071, 0.083, 0.097],
    [0.024, 0.03, 0.038, 0.046, 0.055],
  ]
  let mode = -1
  let processor = verb(sampleRate, rooms[1], 0.8)
  return {
    latencySamples: 0,
    meter: processor.meter,
    reset() {
      processor.reset()
    },
    process(input, output, params, ctx) {
      const next = clamp(Math.round(params.mode ?? 1), 0, 2)
      if (next !== mode) {
        processor = verb(ctx.sampleRate, rooms[next], next === 1 ? 0.86 : 0.62)
        mode = next
        this.meter = processor.meter
      }
      processor.process(input, output, params, ctx)
    },
  }
}

function originalIr(kind: number, length: number) {
  const ir = new Float32Array(length)
  let seed = kind === 0 ? 29 : 73
  for (let i = 0; i < length; i++) {
    seed = (seed * 16807) % 2147483647
    const noise = (seed / 2147483647) * 2 - 1
    const t = i / length
    const body = kind === 0 ? Math.exp(-t * 8) : Math.exp(-t * 3.2)
    const tone = kind === 0 ? 1 : 0.65 + 0.35 * Math.sin(t * 48)
    ir[i] = noise * body * tone * 0.15
  }
  ir[0] = 0.4
  return ir
}

/** Convolution with a short original impulse. Eco uses the shorter tail. */
export function createConv(sampleRate: number): Processor {
  const full = [originalIr(0, 4096), originalIr(1, 4096)]
  const meter = createMeter()
  const history = [new Float32Array(4096), new Float32Array(4096)]
  let write = 0
  return {
    latencySamples: 0,
    meter,
    reset() {
      history[0].fill(0)
      history[1].fill(0)
      write = 0
    },
    process(input, output, params, ctx) {
      const kind = clamp(Math.round(params.ir ?? 0), 0, 1)
      const length = ctx.quality === 'eco' ? 512 : 2048
      const ir = full[kind]
      const amount = clamp(params.mix ?? 0.3, 0, 1)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const left = input[0]?.[i] || 0
        const right = input[1]?.[i] ?? left
        history[0][write] = left
        history[1][write] = right
        let wetL = 0
        let wetR = 0
        for (let tap = 0; tap < length; tap += ctx.quality === 'eco' ? 2 : 1) {
          const index = (write - tap + history[0].length) % history[0].length
          wetL += history[0][index] * ir[tap]
          wetR += history[1][index] * ir[tap]
        }
        out(output, i, mix(left, wetL, amount), mix(right, wetR, amount))
        trackVu(meter, output[0]?.[i] || 0, ctx.sampleRate)
        write = (write + 1) % history[0].length
      }
      void sampleRate
    },
  }
}

function delayLine(seconds: number, sampleRate: number) {
  return new Float32Array(Math.max(8, Math.round(seconds * sampleRate)))
}

/** Tape echo with wow and a saturated feedback path. */
export function createEcho(sampleRate: number): Processor {
  const line = [delayLine(1.2, sampleRate), delayLine(1.2, sampleRate)]
  const shaper = createShaper(2)
  let write = 0
  let phase = 0
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      line[0].fill(0)
      line[1].fill(0)
      write = 0
      phase = 0
    },
    process(input, output, params, ctx) {
      const time = clamp(params.time ?? 280, 20, 1000) / 1000
      const feedback = clamp(params.feedback ?? 0.35, 0, 0.9)
      const wow = clamp(params.wow ?? 0.25, 0, 1)
      const drive = clamp(params.drive ?? 0.3, 0, 1)
      const amount = clamp(params.mix ?? 0.3, 0, 1)
      const base = time * ctx.sampleRate
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        phase += (2 * Math.PI * 0.7) / ctx.sampleRate
        const read = write - base - Math.sin(phase) * wow * 12
        const echoL = readFrac(line[0], read)
        const echoR = readFrac(line[1], read)
        const left = input[0]?.[i] || 0
        const right = input[1]?.[i] ?? left
        const bent = oversample(shaper, (echoL + echoR) * 0.5, drive)
        line[0][write] = left + bent * feedback
        line[1][write] = right + bent * feedback
        out(output, i, mix(left, echoL, amount), mix(right, echoR, amount))
        write = (write + 1) % line[0].length
        trackVu(meter, output[0]?.[i] || 0, ctx.sampleRate)
      }
    },
  }
}

/** Bucket-brigade delay: short time and a clock lowpass in the loop. */
export function createBbd(sampleRate: number): Processor {
  const line = [delayLine(0.4, sampleRate), delayLine(0.4, sampleRate)]
  const tone = [designBiquad('lowpass', sampleRate, 3000, 0.7), designBiquad('lowpass', sampleRate, 3000, 0.7)]
  let write = 0
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      line[0].fill(0)
      line[1].fill(0)
      write = 0
      tone[0].x1 = tone[0].x2 = tone[0].y1 = tone[0].y2 = 0
      tone[1].x1 = tone[1].x2 = tone[1].y1 = tone[1].y2 = 0
    },
    process(input, output, params, ctx) {
      const time = clamp(params.time ?? 180, 10, 380) / 1000
      const feedback = clamp(params.feedback ?? 0.3, 0, 0.85)
      const clock = clamp(params.clock ?? 0.5, 0, 1)
      const cutoff = 1200 + (1 - clock) * 5000
      const amount = clamp(params.mix ?? 0.3, 0, 1)
      const filter = [designBiquad('lowpass', ctx.sampleRate, cutoff, 0.7), designBiquad('lowpass', ctx.sampleRate, cutoff, 0.7)]
      copyState(filter[0], tone[0])
      copyState(filter[1], tone[1])
      const delaySamples = time * ctx.sampleRate
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const echoL = tickBiquad(filter[0], readFrac(line[0], write - delaySamples))
        const echoR = tickBiquad(filter[1], readFrac(line[1], write - delaySamples))
        const left = input[0]?.[i] || 0
        const right = input[1]?.[i] ?? left
        line[0][write] = left + echoL * feedback
        line[1][write] = right + echoR * feedback
        out(output, i, mix(left, echoL, amount), mix(right, echoR, amount))
        write = (write + 1) % line[0].length
      }
      copyState(tone[0], filter[0])
      copyState(tone[1], filter[1])
      void sampleRate
    },
  }
}

function copyState(target: Biquad, source: Biquad) {
  target.x1 = source.x1
  target.x2 = source.x2
  target.y1 = source.y1
  target.y2 = source.y2
}

/** Clean digital delay. */
export function createDigital(sampleRate: number): Processor {
  const line = [delayLine(2, sampleRate), delayLine(2, sampleRate)]
  let write = 0
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      line[0].fill(0)
      line[1].fill(0)
      write = 0
    },
    process(input, output, params, ctx) {
      const time = clamp(params.time ?? 250, 1, 1800) / 1000
      const feedback = clamp(params.feedback ?? 0.3, 0, 0.95)
      const amount = clamp(params.mix ?? 0.3, 0, 1)
      const delaySamples = Math.round(time * ctx.sampleRate)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const echoL = readInt(line[0], write - delaySamples)
        const echoR = readInt(line[1], write - delaySamples)
        const left = input[0]?.[i] || 0
        const right = input[1]?.[i] ?? left
        line[0][write] = left + echoL * feedback
        line[1][write] = right + echoR * feedback
        out(output, i, mix(left, echoL, amount), mix(right, echoR, amount))
        write = (write + 1) % line[0].length
      }
      void sampleRate
    },
  }
}

/** Multi-voice chorus. Mode 0 is a rich ensemble, mode 1 is a wider dimension-style pair. */
export function createEnsemble(sampleRate: number): Processor {
  const line = [delayLine(0.05, sampleRate), delayLine(0.05, sampleRate)]
  let write = 0
  let phase = 0
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      line[0].fill(0)
      line[1].fill(0)
      write = 0
      phase = 0
    },
    process(input, output, params, ctx) {
      const rate = clamp(params.rate ?? 0.4, 0.05, 4)
      const depth = clamp(params.depth ?? 0.4, 0, 1)
      const wide = (params.mode ?? 0) >= 0.5
      const amount = clamp(params.mix ?? 0.4, 0, 1)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        phase += (2 * Math.PI * rate) / ctx.sampleRate
        const left = input[0]?.[i] || 0
        const right = input[1]?.[i] ?? left
        line[0][write] = left
        line[1][write] = right
        const a = readFrac(line[0], write - (220 + Math.sin(phase) * depth * 80))
        const b = readFrac(line[1], write - (280 + Math.sin(phase + 2.1) * depth * 90))
        const side = wide ? (a - b) * 0.8 : 0
        out(output, i, mix(left, a + side, amount), mix(right, b - side, amount))
        write = (write + 1) % line[0].length
      }
    },
  }
}

/** Four-stage phaser. */
export function createPhase(sampleRate: number): Processor {
  const stages = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }))
  let phase = 0
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      for (const stage of stages) stage.x = stage.y = 0
      phase = 0
    },
    process(input, output, params, ctx) {
      const rate = clamp(params.rate ?? 0.3, 0.02, 4)
      const depth = clamp(params.depth ?? 0.6, 0, 1)
      const feedback = clamp(params.feedback ?? 0.4, 0, 0.9)
      const amount = clamp(params.mix ?? 0.5, 0, 1)
      const count = ctx.quality === 'eco' ? 4 : 6
      const n = input[0]?.length ?? 0
      let fb = 0
      for (let i = 0; i < n; i++) {
        phase += (2 * Math.PI * rate) / ctx.sampleRate
        const lfo = 0.5 + 0.5 * Math.sin(phase)
        const a = 0.2 + lfo * depth * 0.75
        const left = input[0]?.[i] || 0
        const right = input[1]?.[i] ?? left
        let wet = left + fb * feedback
        for (let s = 0; s < count; s++) wet = allpass(wet, a, stages[s])
        fb = wet
        out(output, i, mix(left, wet, amount), mix(right, wet, amount))
      }
      void sampleRate
    },
  }
}

function allpass(x: number, a: number, state: { x: number; y: number }) {
  const y = -a * x + state.x + a * state.y
  state.x = x
  state.y = y
  return y
}

/** Rotary speaker: a slow drum and a faster horn, with a speed switch. */
export function createRotor(sampleRate: number): Processor {
  const horn = delayLine(0.03, sampleRate)
  const drum = delayLine(0.04, sampleRate)
  let write = 0
  let hornPhase = 0
  let drumPhase = 0
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      horn.fill(0)
      drum.fill(0)
      write = 0
      hornPhase = 0
      drumPhase = 0
    },
    process(input, output, params, ctx) {
      const fast = (params.speed ?? 0) >= 0.5
      const hornRate = fast ? 6.2 : 0.8
      const drumRate = fast ? 5.4 : 0.7
      const amount = clamp(params.mix ?? 0.7, 0, 1)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        hornPhase += (2 * Math.PI * hornRate) / ctx.sampleRate
        drumPhase += (2 * Math.PI * drumRate) / ctx.sampleRate
        const left = input[0]?.[i] || 0
        const right = input[1]?.[i] ?? left
        const mono = (left + right) * 0.5
        horn[write % horn.length] = mono
        drum[write % drum.length] = mono
        const hornTap = readFrac(horn, write - (180 + Math.sin(hornPhase) * 40))
        const drumTap = readFrac(drum, write - (240 + Math.sin(drumPhase) * 20))
        const hornAmp = 0.6 + 0.4 * Math.sin(hornPhase)
        const drumAmp = 0.75 + 0.25 * Math.sin(drumPhase)
        const wetL = hornTap * hornAmp + drumTap * drumAmp
        const wetR = hornTap * (1.2 - hornAmp) + drumTap * (1.1 - drumAmp * 0.5)
        out(output, i, mix(left, wetL, amount), mix(right, wetR, amount))
        write += 1
      }
    },
  }
}

function readFrac(line: Float32Array, at: number) {
  const length = line.length
  const wrapped = ((at % length) + length) % length
  const index = Math.floor(wrapped)
  const frac = wrapped - index
  return line[index] * (1 - frac) + line[(index + 1) % length] * frac
}

function readInt(line: Float32Array, at: number) {
  const length = line.length
  const index = ((Math.floor(at) % length) + length) % length
  return line[index]
}

export function plateModule(): PluginModule {
  return { descriptor: descriptor('plate')!, presets: FACTORY.plate, create: createPlate }
}
export function hallModule(): PluginModule {
  return { descriptor: descriptor('hall')!, presets: FACTORY.hall, create: createHall }
}
export function convModule(): PluginModule {
  return { descriptor: descriptor('conv')!, presets: FACTORY.conv, create: createConv }
}
export function echoModule(): PluginModule {
  return { descriptor: descriptor('echo')!, presets: FACTORY.echo, create: createEcho }
}
export function bbdModule(): PluginModule {
  return { descriptor: descriptor('bbd')!, presets: FACTORY.bbd, create: createBbd }
}
export function digitalModule(): PluginModule {
  return { descriptor: descriptor('digital')!, presets: FACTORY.digital, create: createDigital }
}
export function ensembleModule(): PluginModule {
  return { descriptor: descriptor('ensemble')!, presets: FACTORY.ensemble, create: createEnsemble }
}
export function phaseModule(): PluginModule {
  return { descriptor: descriptor('phase')!, presets: FACTORY.phase, create: createPhase }
}
export function rotorModule(): PluginModule {
  return { descriptor: descriptor('rotor')!, presets: FACTORY.rotor, create: createRotor }
}
