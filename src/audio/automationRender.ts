import { sanitize } from './plugins/dsp'
import type { ChainSlot } from './plugins/chain'
import type { AutomationLane } from '../model/types'
import { curveAt, prepareCurve } from '../model/automation'
import { samplesToBeats } from '../model/time'
import type { BlockContext } from './plugins/types'

/**
 * One plugin sample at a time so a moving lane is heard at that sample.
 * Processor state carries across the calls.
 */
export function processSampleAccurate(
  slots: ChainSlot[],
  input: Float32Array[],
  output: Float32Array[],
  ctx: BlockContext,
  lanes: AutomationLane[],
  sidechainAt?: (id: string, length: number) => Float32Array | null,
  beatAt?: (sample: number) => number,
) {
  const n = input[0]?.length ?? 0
  const channels = Math.max(1, output.length)
  const base = slots.map((slot) => ({ ...slot.params }))
  const curves = slots.map((slot) =>
    lanes
      .filter((lane) => (lane.target == null || lane.target === 'plugin') && lane.pluginId === slot.id && lane.points.length)
      .map((lane) => ({ param: lane.param, points: prepareCurve(lane.points) })),
  )
  const keys = slots.map((slot) => (slot.sidechain && sidechainAt ? sidechainAt(slot.sidechain, n) : null))
  const state = [0, 1].map((channel) => Float32Array.from(input[Math.min(channel, input.length - 1)] ?? new Float32Array(n)))
  const oneIn = [new Float32Array(1), new Float32Array(1)]
  const oneWet = [new Float32Array(1), new Float32Array(1)]
  for (let i = 0; i < n; i++) {
    oneIn[0][0] = state[0][i] || 0
    oneIn[1][0] = state[1][i] || 0
    const beat = beatAt ? beatAt(ctx.sampleTime + i) : samplesToBeats(ctx.sampleTime + i, ctx.sampleRate, ctx.tempo)
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]
      const params = { ...base[s] }
      for (const curve of curves[s]) params[curve.param] = curveAt(curve.points, beat, params[curve.param] ?? 0)
      const active = slot.enabled && !slot.failed && slot.processor && slot.wet > 0.0001
      if (!active || !slot.processor) continue
      try {
        const side = keys[s]
        const key = side && i < side.length ? side.subarray(i, i + 1) : null
        slot.processor.process(oneIn, oneWet, params, {
          ...ctx,
          sampleTime: ctx.sampleTime + i,
          sidechain: key,
        })
        const mix = Math.min(1, Math.max(0, slot.wet))
        oneIn[0][0] = sanitize((oneIn[0][0] || 0) * (1 - mix) + (oneWet[0][0] || 0) * mix)
        oneIn[1][0] = sanitize((oneIn[1][0] || 0) * (1 - mix) + (oneWet[1][0] || 0) * mix)
      } catch {
        slot.failed = true
      }
    }
    state[0][i] = oneIn[0][0] || 0
    state[1][i] = oneIn[1][0] || 0
  }
  for (let c = 0; c < channels; c++) output[c].set(state[Math.min(c, state.length - 1)])
}
