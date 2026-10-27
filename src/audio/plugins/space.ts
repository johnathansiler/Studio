import { clamp, designBiquad, sanitize, tickBiquad } from './dsp'
import type { Processor } from './types'

export function createDelay(sampleRate: number): Processor {
  const length = Math.ceil(sampleRate * 2)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  let write = 0
  let filter = designBiquad('lowpass', sampleRate, 5000, 0.7)
  let freq = 5000
  return {
    latencySamples: 0,
    reset() {
      left.fill(0)
      right.fill(0)
      write = 0
      filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    },
    process(input, output, params, ctx) {
      if (params.filter !== freq) {
        const next = designBiquad('lowpass', ctx.sampleRate, params.filter, 0.7)
        filter = { ...filter, b0: next.b0, b1: next.b1, b2: next.b2, a1: next.a1, a2: next.a2 }
        freq = params.filter
      }
      const mix = clamp(params.mix, 0, 1)
      const feedback = clamp(params.feedback, 0, 0.9)
      const samples = params.sync >= 0.5
        ? Math.max(1, (60 / Math.max(1, ctx.tempo)) * params.division * ctx.sampleRate)
        : Math.max(1, (params.time / 1000) * ctx.sampleRate)
      const ping = params.pingpong >= 0.5
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const dryL = input[0][i] || 0
        const dryR = input[1]?.[i] ?? dryL
        const tapL = readAt(left, write, samples)
        const tapR = readAt(right, write, ping ? samples * 0.5 : samples)
        const fb = tickBiquad(filter, (tapL + tapR) * 0.5) * feedback
        left[write] = sanitize(dryL + fb)
        right[write] = sanitize(dryR + fb)
        write = (write + 1) % length
        if (output[0]) output[0][i] = sanitize(dryL * (1 - mix) + tapL * mix)
        if (output[1]) output[1][i] = sanitize(dryR * (1 - mix) + (ping ? tapR : tapL) * mix)
      }
    },
  }
}

export function createReverb(sampleRate: number): Processor {
  const combCount = 8
  const lengths = combLengths(sampleRate)
  const combs = lengths.map((size) => ({ buf: new Float32Array(size), index: 0, filter: 0 }))
  const all = [113, 83, 53, 37].map((prime) => ({
    buf: new Float32Array(Math.max(8, Math.round((prime * sampleRate) / 48000))),
    index: 0,
  }))
  return {
    latencySamples: 0,
    reset() {
      for (const comb of combs) {
        comb.buf.fill(0)
        comb.index = 0
        comb.filter = 0
      }
      for (const pass of all) {
        pass.buf.fill(0)
        pass.index = 0
      }
    },
    process(input, output, params, ctx) {
      const mix = clamp(params.mix, 0, 1)
      const size = clamp(params.size, 0.05, 1)
      const damp = clamp(params.damp, 0, 0.95)
      const mode = Math.round(clamp(params.mode, 0, 2))
      const feedback = (mode === 0 ? 0.55 : mode === 1 ? 0.62 : 0.78) * (0.45 + size * 0.55)
      const used = ctx.quality === 'eco' ? 4 : combCount
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const dryL = input[0][i] || 0
        const dryR = input[1]?.[i] ?? dryL
        const mono = (dryL + dryR) * 0.5
        let wet = 0
        for (let c = 0; c < used; c++) {
          const comb = combs[c]
          const delayed = comb.buf[comb.index]
          comb.filter = delayed * (1 - damp) + comb.filter * damp
          comb.buf[comb.index] = sanitize(mono + comb.filter * feedback)
          comb.index = (comb.index + 1) % comb.buf.length
          wet += delayed
        }
        wet /= used
        let splashed = wet
        for (const pass of all) {
          const delayed = pass.buf[pass.index]
          pass.buf[pass.index] = sanitize(splashed + delayed * 0.5)
          splashed = delayed - splashed * 0.5
          pass.index = (pass.index + 1) % pass.buf.length
        }
        const side = mode === 0 ? 0.2 : 0.45
        if (output[0]) output[0][i] = sanitize(dryL * (1 - mix) + (splashed * (1 - side) + wet * side) * mix)
        if (output[1]) output[1][i] = sanitize(dryR * (1 - mix) + (splashed * (1 + side) * 0.5 + wet * 0.2) * mix)
      }
    },
  }
}

function combLengths(sampleRate: number) {
  const base = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116]
  return base.map((length) => Math.max(8, Math.round((length * sampleRate) / 44100)))
}

function readAt(line: Float32Array, write: number, delay: number) {
  const index = write - delay
  const i0 = Math.floor(index)
  const frac = index - i0
  const a = line[((i0 % line.length) + line.length) % line.length]
  const b = line[(((i0 + 1) % line.length) + line.length) % line.length]
  return a + (b - a) * frac
}
