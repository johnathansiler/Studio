import { descriptor, FACTORY, tuneLatency } from './catalog'
import { clamp, sanitize } from './dsp'
import { Psola } from './psola'
import type { PluginModule, Processor } from './types'

export function createPitch(sampleRate: number): Processor {
  const lead = new Psola(sampleRate, 2)
  const harm = new Psola(sampleRate, 2)
  const scratch: Float32Array[] = [new Float32Array(256), new Float32Array(256)]
  return {
    latencySamples: 0,
    reset() {
      lead.reset()
      harm.reset()
    },
    process(input, output, params, ctx) {
      const mix = clamp(params.mix ?? 0, 0, 1)
      if (mix <= 0.001) {
        this.latencySamples = 0
        const n = input[0]?.length ?? 0
        for (let c = 0; c < output.length; c++) {
          const src = input[Math.min(c, input.length - 1)]
          for (let i = 0; i < n; i++) output[c][i] = sanitize(src?.[i] ?? 0)
        }
        return
      }
      this.latencySamples = tuneLatency(ctx.sampleRate)
      const n = input[0]?.length ?? 0
      if (scratch[0].length !== n) {
        scratch[0] = new Float32Array(n)
        scratch[1] = new Float32Array(n)
      }
      const semis = params.semis || 0
      const harmony = params.harmony || 0
      const harmonyMix = clamp(params.harmonyMix ?? 0, 0, 1)
      const hop = ctx.quality === 'eco' ? 256 : 128
      lead.process(input, output, (frame) => shift(frame.hz, frame.confidence, semis), ctx.sampleRate, 50, 1600, hop)
      if (harmonyMix > 0.001) {
        harm.process(input, scratch, (frame) => shift(frame.hz, frame.confidence, harmony), ctx.sampleRate, 50, 1600, hop)
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < output.length; c++) {
            const dry = input[Math.min(c, input.length - 1)]?.[i] ?? 0
            const shifted = output[c][i]
            const second = scratch[Math.min(c, 1)][i]
            const wet = shifted * (1 - harmonyMix) + second * harmonyMix
            output[c][i] = sanitize(dry * (1 - mix) + wet * mix)
          }
        }
      } else {
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < output.length; c++) {
            const dry = input[Math.min(c, input.length - 1)]?.[i] ?? 0
            output[c][i] = sanitize(dry * (1 - mix) + output[c][i] * mix)
          }
        }
      }
    },
  }
}

const plugin: PluginModule = { descriptor: descriptor('pitch')!, presets: FACTORY.pitch, create: createPitch }
export default plugin

function shift(hz: number, confidence: number, semis: number) {
  if (hz <= 0 || confidence < 0.65) return 0
  return clamp(hz * 2 ** (semis / 12), 40, 2000)
}
