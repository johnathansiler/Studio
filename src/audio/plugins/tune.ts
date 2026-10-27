import { SCALES, pitchClass } from '../../model/scale'
import { descriptor, FACTORY, tuneLatency } from './catalog'
import { clamp, sanitize } from './dsp'
import { Psola, type PitchFrame } from './psola'
import type { BlockContext, PluginModule, Processor } from './types'

export function createTune(sampleRate: number): Processor {
  const psola = new Psola(sampleRate, 2)
  let smoothed = 0
  let center = 0
  return {
    latencySamples: 0,
    reset() {
      psola.reset()
      smoothed = 0
      center = 0
    },
    process(input, output, params, ctx) {
      if ((params.amount ?? 0) <= 0.001) {
        this.latencySamples = 0
        copyThrough(input, output)
        return
      }
      this.latencySamples = tuneLatency(ctx.sampleRate)
      const hop = ctx.quality === 'eco' ? 256 : 128
      psola.process(
        input,
        output,
        (frame) => targetHz(frame, params, ctx, () => smoothed, (value) => {
          smoothed = value
        }, () => center, (value) => {
          center = value
        }),
        ctx.sampleRate,
        params.minHz || 80,
        params.maxHz || 900,
        hop,
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
  const midi = 69 + 12 * Math.log2(frame.hz / 440) + (params.transpose || 0)
  const snapped = nearestAllowed(midi, params, ctx)
  const goal = 440 * 2 ** ((snapped - 69) / 12)
  const tracked = center() || frame.hz
  setCenter(tracked + (frame.hz - tracked) * 0.08)
  const human = clamp(params.humanize ?? 0, 0, 1)
  const amount = clamp(params.amount ?? 0, 0, 1)
  const kept = goal + human * (frame.hz - goal)
  const aimed = frame.hz + amount * (kept - frame.hz)
  const speed = clamp(params.retune ?? 0.5, 0.02, 1)
  const prev = smoothed() || frame.hz
  const next = prev + (aimed - prev) * speed
  setSmoothed(next)
  return clamp(next, 40, 2000)
}

function nearestAllowed(midi: number, params: Record<string, number>, ctx: BlockContext) {
  const mask = Math.round(params.mask || 0)
  const chromatic = (params.mode ?? 1) < 0.5 && mask <= 0
  const root = (params.root ?? -1) >= 0 ? Math.round(params.root) : ctx.scaleRoot
  const scaleIndex = Math.round(params.scaleIndex ?? -1)
  const intervals: readonly number[] = scaleIndex >= 0 && SCALES[scaleIndex] ? SCALES[scaleIndex].intervals : ctx.scaleIntervals
  let best = Math.round(midi)
  let bestDist = 99
  for (let note = Math.floor(midi) - 3; note <= Math.ceil(midi) + 3; note++) {
    const pc = pitchClass(note)
    const rel = ((pc - root) % 12 + 12) % 12
    const allowed = mask > 0 ? (mask & (1 << pc)) !== 0 : chromatic ? true : intervals.some((interval) => interval === rel)
    if (!allowed) continue
    const dist = Math.abs(note - midi)
    if (dist < bestDist || (dist === bestDist && note < best)) {
      best = note
      bestDist = dist
    }
  }
  return best
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
