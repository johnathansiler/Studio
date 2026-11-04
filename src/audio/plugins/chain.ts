import { latencyOf } from './catalog'
import { sanitize } from './dsp'
import type { BlockContext, Processor } from './types'

export interface ChainSlot {
  id: string
  pluginId: string
  enabled: boolean
  wet: number
  params: Record<string, number>
  failed: boolean
  sidechain: string
  processor: Processor | null
}

/** Preallocated ping-pong buffers. `processChain` allocates nothing when this fits the block. */
export interface ChainPool {
  frames: number
  channels: number
  maxSlots: number
  stages: Float32Array[][]
  wet: Float32Array[][]
  side: BlockContext
}

export function prepareChainPool(maxSlots: number, channels: number, frames: number): ChainPool {
  const slots = Math.max(1, maxSlots | 0)
  const ch = Math.max(1, channels | 0)
  const n = Math.max(1, frames | 0)
  const stages: Float32Array[][] = []
  for (let s = 0; s <= slots; s++) stages.push(Array.from({ length: ch }, () => new Float32Array(n)))
  const wet: Float32Array[][] = []
  for (let s = 0; s < slots; s++) wet.push(Array.from({ length: ch }, () => new Float32Array(n)))
  return {
    frames: n,
    channels: ch,
    maxSlots: slots,
    stages,
    wet,
    side: {
      sampleRate: 48000,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      quality: 'full',
    },
  }
}

export function processChain(
  slots: ChainSlot[],
  input: Float32Array[],
  output: Float32Array[],
  ctx: BlockContext,
  sidechainAt?: (id: string, length: number) => Float32Array | null,
  pool?: ChainPool,
  count?: number,
) {
  const nSlots = count ?? slots.length
  const n = input[0]?.length ?? output[0]?.length ?? 0
  const channels = output.length
  const pooled = !!(pool && n > 0 && pool.frames === n && pool.channels >= Math.max(1, channels) && pool.maxSlots >= nSlots)
  let current = pooled ? pool.stages[0] : input.map((channel) => Float32Array.from(channel ?? new Float32Array(n)))
  if (!current.length) current = [new Float32Array(n)]
  if (pooled) copyInto(input, current, n, channels)
  else while (current.length < channels) current.push(Float32Array.from(current[0]))
  let latency = 0
  const started = now()
  for (let s = 0; s < nSlots; s++) {
    const slot = slots[s]
    const next = pooled ? pool.stages[s + 1] : current.map(() => new Float32Array(n))
    const active = slot.enabled && !slot.failed && slot.processor && slot.wet > 0.0001
    if (!active || !slot.processor) {
      copy(current, next)
    } else {
      try {
        const wet = pooled ? pool.wet[s] : next.map(() => new Float32Array(n))
        const sidechain = slot.sidechain && sidechainAt ? sidechainAt(slot.sidechain, n) : null
        const block = sidechain ? fillSide(pooled ? pool.side : { ...ctx, sidechain }, ctx, sidechain) : ctx
        slot.processor.process(current, wet, slot.params, block)
        const mix = Math.min(1, Math.max(0, slot.wet))
        for (let c = 0; c < channels; c++) {
          for (let i = 0; i < n; i++) {
            const dry = current[c]?.[i] ?? 0
            const processed = wet[c]?.[i] ?? dry
            next[c][i] = sanitize(dry * (1 - mix) + processed * mix)
          }
        }
        latency += slot.processor.latencySamples || latencyOf(slot.pluginId, slot.params, ctx.sampleRate, true)
      } catch {
        slot.failed = true
        copy(current, next)
      }
    }
    current = next
  }
  for (let c = 0; c < channels; c++) {
    output[c].set(current[c] ?? current[0])
  }
  return { latency, cpu: now() - started }
}

function fillSide(target: BlockContext, ctx: BlockContext, sidechain: Float32Array) {
  target.sampleRate = ctx.sampleRate
  target.tempo = ctx.tempo
  target.sampleTime = ctx.sampleTime
  target.sidechain = sidechain
  target.scaleRoot = ctx.scaleRoot
  target.scaleIntervals = ctx.scaleIntervals
  target.scaleCents = ctx.scaleCents
  target.quality = ctx.quality
  target.offline = ctx.offline
  target.playTime = ctx.playTime
  return target
}

function copyInto(from: Float32Array[], to: Float32Array[], frames: number, channels: number) {
  const sourceCount = Math.max(1, from.length)
  for (let c = 0; c < channels; c++) {
    const src = from[Math.min(c, sourceCount - 1)]
    const dest = to[c]
    if (!dest) continue
    if (!src) {
      for (let i = 0; i < frames; i++) dest[i] = 0
      continue
    }
    const n = Math.min(frames, src.length)
    for (let i = 0; i < n; i++) dest[i] = src[i]
    for (let i = n; i < frames; i++) dest[i] = 0
  }
}

function copy(from: Float32Array[], to: Float32Array[]) {
  for (let c = 0; c < to.length; c++) {
    const src = from[Math.min(c, from.length - 1)]
    if (src) to[c].set(src)
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
