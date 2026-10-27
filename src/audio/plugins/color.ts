import { clamp, designBiquad, sanitize, tickBiquad } from './dsp'
import type { Processor } from './types'

export function createSaturator(sampleRate: number): Processor {
  let tone = designBiquad('lowpass', sampleRate, 8000, 0.7)
  let freq = 8000
  return {
    latencySamples: 0,
    reset() {
      tone.x1 = tone.x2 = tone.y1 = tone.y2 = 0
    },
    process(input, output, params, ctx) {
      if (params.tone !== freq) {
        const next = designBiquad('lowpass', ctx.sampleRate, params.tone, 0.7)
        tone = { ...tone, b0: next.b0, b1: next.b1, b2: next.b2, a1: next.a1, a2: next.a2 }
        freq = params.tone
      }
      const drive = clamp(params.drive, 0, 1)
      const mix = clamp(params.mix ?? 1, 0, 1)
      const shape = 1 + drive * 8
      const neutral = drive <= 0.0001
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < output.length; c++) {
          const dry = input[Math.min(c, input.length - 1)]?.[i] ?? 0
          const bent = neutral ? dry : Math.tanh((dry + drive * dry * dry * 0.2) * shape) / Math.tanh(shape)
          const filtered = neutral ? dry : tickBiquad(tone, bent)
          output[c][i] = sanitize(dry * (1 - mix) + filtered * mix)
        }
      }
    },
  }
}

export function createDoubler(sampleRate: number): Processor {
  const length = Math.ceil(sampleRate * 0.05)
  const lines = [new Float32Array(length), new Float32Array(length)]
  let write = 0
  let phase = 0
  return {
    latencySamples: 0,
    reset() {
      lines[0].fill(0)
      lines[1].fill(0)
      write = 0
      phase = 0
    },
    process(input, output, params, ctx) {
      const mix = clamp(params.mix, 0, 1)
      const width = clamp(params.width, 0, 1)
      const base = clamp((params.delay / 1000) * ctx.sampleRate, 1, length - 2)
      const depth = clamp(params.depth, 0, 1) * ctx.sampleRate * 0.003
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const left = input[0][i] || 0
        const right = input[1]?.[i] ?? left
        lines[0][write] = left
        lines[1][write] = right
        phase += (0.35 * Math.PI * 2) / ctx.sampleRate
        const tapL = read(lines[0], write, base + Math.sin(phase) * depth)
        const tapR = read(lines[1], write, base * 1.3 + Math.cos(phase) * depth)
        const mid = (left + right) * 0.5
        const side = (left - right) * 0.5 * (1 + width)
        const wideL = mid + side
        const wideR = mid - side
        if (output[0]) output[0][i] = sanitize(left * (1 - mix) + (wideL * 0.7 + tapR * 0.5) * mix)
        if (output[1]) output[1][i] = sanitize(right * (1 - mix) + (wideR * 0.7 + tapL * 0.5) * mix)
        write = (write + 1) % length
      }
    },
  }
}

export function createChorus(sampleRate: number): Processor {
  const length = Math.ceil(sampleRate * 0.04)
  const line = new Float32Array(length)
  let write = 0
  let phase = 0
  return {
    latencySamples: 0,
    reset() {
      line.fill(0)
      write = 0
      phase = 0
    },
    process(input, output, params, ctx) {
      const mix = clamp(params.mix, 0, 1)
      const rate = clamp(params.rate, 0.05, 5)
      const depth = clamp(params.depth, 0, 1) * ctx.sampleRate * 0.008
      const base = ctx.sampleRate * 0.012
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const left = input[0][i] || 0
        const right = input[1]?.[i] ?? left
        line[write] = (left + right) * 0.5
        phase += (rate * Math.PI * 2) / ctx.sampleRate
        const wetL = read(line, write, base + (0.5 + 0.5 * Math.sin(phase)) * depth)
        const wetR = read(line, write, base + (0.5 + 0.5 * Math.sin(phase + 2)) * depth)
        if (output[0]) output[0][i] = sanitize(left * (1 - mix) + wetL * mix)
        if (output[1]) output[1][i] = sanitize(right * (1 - mix) + wetR * mix)
        write = (write + 1) % length
      }
    },
  }
}

function read(line: Float32Array, write: number, delay: number) {
  const index = write - delay
  const i0 = Math.floor(index)
  const frac = index - i0
  const a = line[((i0 % line.length) + line.length) % line.length]
  const b = line[(((i0 + 1) % line.length) + line.length) % line.length]
  return a + (b - a) * frac
}
