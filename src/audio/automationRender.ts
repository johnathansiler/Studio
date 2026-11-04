import { sanitize } from './plugins/dsp'
import { mixChainSlot, type ChainPool, type ChainSlot } from './plugins/chain'
import type { AutomationLane, AutomationPoint } from '../model/types'
import { curveAt, prepareCurve } from '../model/automation'
import { samplesToBeats } from '../model/time'
import { isSteppedParam, usesBlockValue } from './core/smooth'
import type { BlockContext } from './plugins/types'

interface CurveRef {
  param: string
  points: AutomationPoint[]
  fallback: number
}

/** Buffers for the sample-accurate path. The worklet prepares these so process() does not allocate. */
export interface AccurateScratch {
  frames: number
  slots: number
  base: Record<string, number>[]
  live: Record<string, number>[]
  curves: CurveRef[][]
  paramKeys: string[][]
  side: (Float32Array | null)[]
  curveCache: Map<string, { source: AutomationPoint[]; points: AutomationPoint[] }>
  state: Float32Array[]
  oneIn: Float32Array[]
  oneWet: Float32Array[]
  step: BlockContext
  keySample: Float32Array
  blockWet: Float32Array[]
  wetViews: Map<number, Float32Array[]>
  stateViews: Map<number, Float32Array[]>
}

export function prepareAccurate(slots: number, frames: number): AccurateScratch {
  const n = Math.max(1, frames | 0)
  const count = Math.max(1, slots | 0)
  const step: BlockContext = {
    sampleRate: 48000,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full',
  }
  return {
    frames: n,
    slots: count,
    base: Array.from({ length: count }, () => ({})),
    live: Array.from({ length: count }, () => ({})),
    curves: Array.from({ length: count }, () => []),
    paramKeys: Array.from({ length: count }, () => []),
    side: Array.from({ length: count }, () => null),
    curveCache: new Map(),
    state: [new Float32Array(n), new Float32Array(n)],
    oneIn: [new Float32Array(1), new Float32Array(1)],
    oneWet: [new Float32Array(1), new Float32Array(1)],
    step,
    keySample: new Float32Array(1),
    blockWet: [new Float32Array(n), new Float32Array(n)],
    wetViews: new Map(),
    stateViews: new Map(),
  }
}

export function preseedAccurate(scratch: AccurateScratch, sizes: readonly number[]) {
  for (let i = 0; i < sizes.length; i++) {
    const frames = sizes[i] | 0
    if (frames > 0 && frames <= scratch.frames) {
      viewPair(scratch.stateViews, scratch.state, frames)
      viewPair(scratch.wetViews, scratch.blockWet, frames)
    }
  }
}

/**
 * One plugin sample at a time so a moving lane is heard at that sample.
 * Processor state carries across the calls.
 * Parameter objects are reused across samples. The values match a fresh object per sample.
 */
export function processSampleAccurate(
  slots: ChainSlot[],
  input: Float32Array[],
  output: Float32Array[],
  ctx: BlockContext,
  lanes: AutomationLane[],
  sidechainAt?: (id: string, length: number) => Float32Array | null,
  beatAt?: (sample: number) => number,
  scratch?: AccurateScratch,
  pool?: ChainPool,
) {
  const n = input[0]?.length ?? 0
  const channels = Math.max(1, output.length)
  const pooled = !!(scratch && scratch.frames >= n && scratch.slots >= slots.length && n > 0)
  const base = pooled ? scratch.base : slots.map((slot) => ({ ...slot.params }))
  const live = pooled ? scratch.live : base.map((row) => ({ ...row }))
  const curves: CurveRef[][] = pooled ? scratch.curves : []
  if (!pooled) {
    for (let s = 0; s < slots.length; s++) {
      curves.push(curvesFor(slots[s], lanes, base[s]))
    }
  } else {
    for (let s = 0; s < slots.length; s++) {
      const row = base[s]
      const params = slots[s].params
      const listed = scratch.paramKeys[s]
      copyNamed(row, params, listed)
      copyNamed(live[s], row, listed)
      fillCurves(curves[s], slots[s], lanes, row, scratch)
    }
  }
  const keys: (Float32Array | null)[] = pooled ? scratch.side : []
  if (pooled) {
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]
      keys[s] = slot.sidechain && sidechainAt ? sidechainAt(slot.sidechain, n) : null
    }
  } else {
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s]
      keys.push(slot.sidechain && sidechainAt ? sidechainAt(slot.sidechain, n) : null)
    }
  }
  const state = pooled
    ? scratch.state
    : [0, 1].map((channel) => Float32Array.from(input[Math.min(channel, input.length - 1)] ?? new Float32Array(n)))
  const oneIn = pooled ? scratch.oneIn : [new Float32Array(1), new Float32Array(1)]
  const oneWet = pooled ? scratch.oneWet : [new Float32Array(1), new Float32Array(1)]
  const step = pooled ? scratch.step : { ...ctx, sidechain: null as Float32Array | null }
  const keySample = pooled ? scratch.keySample : new Float32Array(1)
  if (pooled) {
    copyState(input, state, n)
    fillStep(step, ctx)
  }
  const wetBlock = pooled ? viewPair(scratch.wetViews, scratch.blockWet, n) : [new Float32Array(n), new Float32Array(n)]
  const stateView = pooled ? viewPair(scratch.stateViews, state, n) : state
  for (let s = 0; s < slots.length; s++) {
    const slot = slots[s]
    const params = live[s]
    const active = slot.enabled && !slot.failed && slot.processor && slot.wet > 0.0001
    if (!active || !slot.processor) continue
    const blockScoped = usesBlockValue(slot.pluginId, slot.processor.latencySamples || 0, params)
    try {
      if (blockScoped) {
        const beat0 = beatAt ? beatAt(ctx.sampleTime) : samplesToBeats(ctx.sampleTime, ctx.sampleRate, ctx.tempo)
        writeCurves(params, curves[s], beat0)
        step.sampleTime = ctx.sampleTime
        step.sidechain = keys[s]
        slot.processor.process(stateView, wetBlock, params, step)
      } else {
        for (let i = 0; i < n; i++) {
          const beat = beatAt ? beatAt(ctx.sampleTime + i) : samplesToBeats(ctx.sampleTime + i, ctx.sampleRate, ctx.tempo)
          writeCurves(params, curves[s], beat)
          oneIn[0][0] = state[0][i] || 0
          oneIn[1][0] = state[1][i] || 0
          const side = keys[s]
          let key: Float32Array | null = null
          if (side && i < side.length) {
            keySample[0] = side[i]
            key = keySample
          }
          step.sampleTime = ctx.sampleTime + i
          step.sidechain = key
          slot.processor.process(oneIn, oneWet, params, step)
          wetBlock[0][i] = oneWet[0][0] || 0
          wetBlock[1][i] = oneWet[1][0] || 0
        }
      }
      const mix = Math.min(1, Math.max(0, slot.wet))
      if (mix >= 0.9995 && (slot.processor.latencySamples || 0) <= 0) {
        for (let i = 0; i < n; i++) {
          state[0][i] = sanitize(wetBlock[0][i] || 0)
          state[1][i] = sanitize(wetBlock[1][i] || 0)
        }
      } else {
        mixChainSlot(slot, s, stateView, wetBlock, stateView, channels, n, ctx.sampleRate, pool)
      }
    } catch {
      slot.failed = true
    }
  }
  for (let c = 0; c < channels; c++) {
    const src = state[Math.min(c, state.length - 1)]
    const dest = output[c]
    if (!dest || !src) continue
    const count = Math.min(n, dest.length, src.length)
    if (src.length === dest.length) dest.set(src)
    else for (let i = 0; i < count; i++) dest[i] = src[i]
  }
}

function curvesFor(slot: ChainSlot, lanes: AutomationLane[], base: Record<string, number>): CurveRef[] {
  const out: CurveRef[] = []
  fillCurves(out, slot, lanes, base)
  return out
}

function fillCurves(
  out: CurveRef[],
  slot: ChainSlot,
  lanes: AutomationLane[],
  base: Record<string, number>,
  scratch?: AccurateScratch,
) {
  let count = 0
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]
    if ((lane.target != null && lane.target !== 'plugin') || lane.pluginId !== slot.id || !lane.points.length) continue
    const curve = out[count] ?? { param: lane.param, points: lane.points, fallback: 0 }
    curve.param = lane.param
    curve.points = cachedCurve(scratch, lane)
    curve.fallback = base[lane.param] ?? 0
    out[count] = curve
    count += 1
  }
  out.length = count
}

function cachedCurve(scratch: AccurateScratch | undefined, lane: AutomationLane) {
  if (!scratch) return prepareCurve(lane.points)
  const hit = scratch.curveCache.get(lane.id)
  if (hit && hit.source === lane.points) return hit.points
  const points = prepareCurve(lane.points)
  scratch.curveCache.set(lane.id, { source: lane.points, points })
  return points
}

function copyNamed(dest: Record<string, number>, src: Record<string, number>, keys: readonly string[]) {
  if (keys.length) {
    for (let i = 0; i < keys.length; i++) dest[keys[i]] = src[keys[i]]
    return
  }
  for (const key of Object.keys(src)) dest[key] = src[key]
}

function viewPair(cache: Map<number, Float32Array[]>, buffers: Float32Array[], frames: number) {
  if (buffers[0]?.length === frames) return buffers
  const hit = cache.get(frames)
  if (hit) return hit
  const view = buffers.map((buffer) => buffer.subarray(0, frames))
  cache.set(frames, view)
  return view
}

function writeCurves(params: Record<string, number>, curves: CurveRef[], beat: number) {
  for (let i = 0; i < curves.length; i++) {
    const curve = curves[i]
    const raw = curveAt(curve.points, beat, curve.fallback)
    params[curve.param] = isSteppedParam(curve.param) ? Math.round(raw) : raw
  }
}

function fillStep(target: BlockContext, ctx: BlockContext) {
  target.sampleRate = ctx.sampleRate
  target.tempo = ctx.tempo
  target.sampleTime = ctx.sampleTime
  target.sidechain = null
  target.scaleRoot = ctx.scaleRoot
  target.scaleIntervals = ctx.scaleIntervals
  target.scaleCents = ctx.scaleCents
  target.quality = ctx.quality
  target.offline = ctx.offline
  target.playTime = ctx.playTime
}

function copyState(from: Float32Array[], to: Float32Array[], frames: number) {
  for (let c = 0; c < 2; c++) {
    const src = from[Math.min(c, Math.max(0, from.length - 1))]
    const dest = to[c]
    if (!src) {
      for (let i = 0; i < frames; i++) dest[i] = 0
      continue
    }
    const n = Math.min(frames, src.length)
    for (let i = 0; i < n; i++) dest[i] = src[i]
    for (let i = n; i < frames; i++) dest[i] = 0
  }
}
