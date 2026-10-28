import { descriptor, FACTORY, tuneLatency } from './catalog'
import { TUNE_TRACE_FRAMES, tuneLiveHop, tuneLiveLatency, tuneSnapMidi } from './autoTune'
import { clamp, sanitize } from './dsp'
import { Psola, type PitchFrame } from '../stretch/voice'
import type { BlockContext, PluginModule, Processor } from './types'

export function createTune(sampleRate: number): Processor {
  const hq = new Psola(sampleRate, 2)
  const live = new Psola(sampleRate, 2, tuneLiveHop(sampleRate))
  let smoothed = 0
  let center = 0
  let path: 'dry' | 'live' | 'hq' = 'dry'
  const trace = new Float32Array(TUNE_TRACE_FRAMES * 2)
  const remember = (detected: number, corrected: number) => {
    trace.copyWithin(0, 2)
    trace[trace.length - 2] = detected > 0 ? detected : 0
    trace[trace.length - 1] = corrected > 0 ? corrected : 0
  }
  return {
    latencySamples: 0,
    trace,
    reset() {
      hq.reset()
      live.reset()
      smoothed = 0
      center = 0
      path = 'dry'
      trace.fill(0)
    },
    process(input, output, params, ctx) {
      if ((params.amount ?? 0) <= 0.001) {
        if (path !== 'dry') {
          hq.reset()
          live.reset()
          smoothed = 0
          center = 0
          path = 'dry'
        }
        this.latencySamples = 0
        copyThrough(input, output)
        return
      }
      const monitoring = ctx.offline === false && (params.hq ?? 0) < 0.5
      const engine = monitoring ? live : hq
      if (path !== (monitoring ? 'live' : 'hq')) {
        engine.reset()
        smoothed = 0
        center = 0
        path = monitoring ? 'live' : 'hq'
      }
      this.latencySamples = monitoring ? tuneLiveLatency(ctx.sampleRate) : tuneLatency(ctx.sampleRate)
      const hop = monitoring ? tuneLiveHop(ctx.sampleRate) : ctx.quality === 'eco' ? 256 : 128
      engine.process(
        input,
        output,
        (frame) => {
          const corrected = targetHz(frame, params, ctx, () => smoothed, (value) => {
            smoothed = value
          }, () => center, (value) => {
            center = value
          })
          remember(frame.hz, corrected)
          return corrected
        },
        ctx.sampleRate,
        params.minHz || 80,
        params.maxHz || 900,
        hop,
        params.formant ?? 0,
      )
    },
  }
}

function targetHz(
  frame: PitchFrame,
  params: Record<string, number>,
  ctx: BlockContext,
  smoothed: () => number,
  setSmoothed: (value: number) => void,
  center: () => number,
  setCenter: (value: number) => void,
) {
  if (frame.hz <= 0 || frame.confidence < 0.7) return 0
  const ref = clamp(params.a4 ?? 440, 430, 450)
  const midi = 69 + 12 * Math.log2(frame.hz / ref) + (params.transpose || 0)
  const heardPc = ((Math.round(midi) % 12) + 12) % 12
  if ((Math.round(params.bypassMask || 0) & (1 << heardPc)) !== 0) return 0
  const held = Math.round(params.holdMidi ?? -1)
  const snapped = held >= 0 && held <= 127 ? held : tuneSnapMidi(midi, params, ctx)
  const nudgePc = ((Math.round(snapped) % 12) + 12) % 12
  const nudge = clamp(params[`n${nudgePc}`] ?? 0, -200, 200) / 100
  const goal = ref * 2 ** ((snapped + nudge - 69) / 12)
  const slow = center() || frame.hz
  setCenter(slow + (frame.hz - slow) * 0.08)
  const human = clamp(params.humanize ?? 0, 0, 1)
  const amount = clamp(params.amount ?? 0, 0, 1)
  const classic = (params.color ?? 0) >= 0.5
  const flex = classic ? 0 : clamp(params.flex ?? 0, 0, 1)
  const centsOff = 1200 * Math.log2(frame.hz / goal)
  const window = flex * 40
  const pull = Math.sign(centsOff) * Math.max(0, Math.abs(centsOff) - window)
  const flexed = frame.hz * 2 ** (-pull / 1200)
  const kept = flexed + human * (frame.hz - flexed)
  let aimed = frame.hz + amount * (kept - frame.hz)
  const vibe = clamp(params.vibrato ?? 0, 0, 1)
  if (vibe > 0) aimed += vibe * (frame.hz - slow)
  const speed = clamp(params.retune ?? 0.5, 0.02, 1)
  const rate = classic ? Math.min(1, 0.35 + speed * 0.65) : speed
  const prev = smoothed() || frame.hz
  const next = prev + (aimed - prev) * rate
  setSmoothed(next)
  return clamp(next, 40, 2000)
}

const plugin: PluginModule = { descriptor: descriptor('tune')!, presets: FACTORY.tune, create: createTune }
export default plugin

function copyThrough(input: Float32Array[], output: Float32Array[]) {
  const n = input[0]?.length ?? 0
  for (let c = 0; c < output.length; c++) {
    const src = input[Math.min(c, input.length - 1)]
    for (let i = 0; i < n; i++) output[c][i] = sanitize(src?.[i] ?? 0)
  }
}
