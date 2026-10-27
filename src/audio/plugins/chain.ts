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

export function processChain(
  slots: ChainSlot[],
  input: Float32Array[],
  output: Float32Array[],
  ctx: BlockContext,
  sidechainAt?: (id: string, length: number) => Float32Array | null,
) {
  const n = input[0]?.length ?? 0
  const channels = output.length
  let current = input.map((channel) => Float32Array.from(channel ?? new Float32Array(n)))
  if (!current.length) current = [new Float32Array(n)]
  while (current.length < channels) current.push(Float32Array.from(current[0]))
  let latency = 0
  const started = now()
  for (const slot of slots) {
    const next = current.map(() => new Float32Array(n))
    const active = slot.enabled && !slot.failed && slot.processor && slot.wet > 0.0001
    if (!active || !slot.processor) {
      copy(current, next)
    } else {
      try {
        const wet = next.map(() => new Float32Array(n))
        const sidechain = slot.sidechain && sidechainAt ? sidechainAt(slot.sidechain, n) : null
        slot.processor.process(current, wet, slot.params, sidechain ? { ...ctx, sidechain } : ctx)
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

function copy(from: Float32Array[], to: Float32Array[]) {
  for (let c = 0; c < to.length; c++) {
    const src = from[Math.min(c, from.length - 1)]
    if (src) to[c].set(src)
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
