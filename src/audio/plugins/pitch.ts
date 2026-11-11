import { SampleGlide } from '../core/smooth'
import { descriptor, FACTORY, tuneLatency } from './catalog'
import { clamp, sanitize } from './dsp'
import { Psola } from '../stretch/voice'
import type { PluginModule, Processor } from './types'

export function createPitch(sampleRate: number): Processor {
  const lead = new Psola(sampleRate, 2)
  const harm = new Psola(sampleRate, 2)
  const scratchFull = [new Float32Array(2048), new Float32Array(2048)]
  const scratchViews = new Map<number, Float32Array[]>()
  for (const frames of [128, 256, 512, 1024, 2048]) scratchViews.set(frames, [scratchFull[0].subarray(0, frames), scratchFull[1].subarray(0, frames)])
  const mixGlide = new SampleGlide()
  const pair = (frames: number) => {
    const hit = scratchViews.get(frames)
    if (hit) return hit
    const view = frames <= scratchFull[0].length
      ? [scratchFull[0].subarray(0, frames), scratchFull[1].subarray(0, frames)]
      : [new Float32Array(frames), new Float32Array(frames)]
    scratchViews.set(frames, view)
    return view
  }
  return {
    latencySamples: 0,
    reset() {
      lead.reset()
      harm.reset()
    },
    process(input, output, params, ctx) {
      mixGlide.prepare(ctx.sampleRate)
      const mixTarget = clamp(params.mix ?? 0, 0, 1)
      if (mixTarget <= 0.001 && (!mixGlide.settled || mixGlide.peek() <= 0.001)) {
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
      const scratch = pair(n)
      const semis = params.semis || 0
      const harmony = params.harmony || 0
      const harmonyMix = clamp(params.harmonyMix ?? 0, 0, 1)
      const hop = ctx.quality === 'eco' ? 256 : 128
      lead.process(input, output, (frame) => shift(frame.hz, frame.confidence, semis), ctx.sampleRate, 50, 1600, hop)
      if (harmonyMix > 0.001) {
        harm.process(input, scratch, (frame) => shift(frame.hz, frame.confidence, harmony), ctx.sampleRate, 50, 1600, hop)
        for (let i = 0; i < n; i++) {
          const mix = mixGlide.next(mixTarget)
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
          const mix = mixGlide.next(mixTarget)
          for (let c = 0; c < output.length; c++) {
            const dry = input[Math.min(c, input.length - 1)]?.[i] ?? 0
            output[c][i] = sanitize(dry * (1 - mix) + output[c][i] * mix)
          }
        }
      }
    },
  }
}

const plugin: PluginModule = { descriptor: descriptor('pitch')!, presets: FACTORY.pitch ?? [], create: createPitch }
export default plugin

function shift(hz: number, confidence: number, semis: number) {
  if (hz <= 0 || confidence < 0.65) return 0
  return clamp(hz * 2 ** (semis / 12), 40, 2000)
}
