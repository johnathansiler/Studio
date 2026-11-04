import type { AutomationLane, TempoPoint } from '../model/types'
import { valueChanges } from '../model/automation'
import { projectSampleBeat } from '../model/tempoMap'
import { prepareChainPool, processChain, type ChainPool, type ChainSlot } from './plugins/chain'
import { prepareAccurate, processSampleAccurate, type AccurateScratch } from './automationRender'
import { automationAt } from './plugins/catalog'
import { loadModule, peekModule } from './plugins/registry'
import type { Processor } from './plugins/types'

export type InsertClock = {
  sampleRate: number
  tempo: number
  tempoMap?: TempoPoint[]
  automation: AutomationLane[]
  scaleRoot: number
  scaleIntervals: readonly number[]
  scaleCents?: readonly number[]
  quality?: 'full' | 'eco'
  offline?: boolean
}

/** Mono key for one sidechain source, or null when this block has no key. */
export type InsertKey = (id: string, offset: number, count: number) => Float32Array | null

/**
 * Run one insert chain over a buffer. Offline rendering calls this directly.
 * A worker calls `renderInsertJob`, which builds the slots and then this.
 */
export function renderInserts(
  slots: ChainSlot[],
  input: Float32Array[],
  opts: InsertClock,
  keyAt: InsertKey,
  pool: ChainPool,
  scratch: AccurateScratch,
) {
  const n = input[0]?.length ?? 0
  const output = [new Float32Array(n), new Float32Array(n)]
  const block = pool.frames
  const base = new Map(slots.map((slot) => [slot.id, { ...slot.params }]))
  for (let offset = 0; offset < n; offset += block) {
    const count = Math.min(block, n - offset)
    const sliceIn = input.map((channel) => channel.subarray(offset, offset + count))
    const sliceOut = output.map((channel) => channel.subarray(offset, offset + count))
    const clock = { tempo: opts.tempo, sampleRate: opts.sampleRate, tempoMap: opts.tempoMap, automation: opts.automation }
    const beat = projectSampleBeat(clock, offset)
    for (const slot of slots) slot.params = automationAt(opts.automation, slot.id, base.get(slot.id) ?? slot.params, beat)
    const blockCtx = {
      sampleRate: opts.sampleRate,
      tempo: opts.tempo,
      sampleTime: offset,
      sidechain: null,
      scaleRoot: opts.scaleRoot,
      scaleIntervals: opts.scaleIntervals,
      scaleCents: opts.scaleCents,
      quality: opts.quality ?? 'full' as const,
      offline: opts.offline !== false,
    }
    const endBeat = projectSampleBeat(clock, offset + count - 1)
    const moving = opts.offline !== false && slots.some((slot) => opts.automation.some((lane) => (lane.target == null || lane.target === 'plugin') && lane.pluginId === slot.id && valueChanges(lane.points, beat, endBeat, 0)))
    const at = (id: string, keyLength: number) => keyAt(id, offset, keyLength)
    if (moving) {
      processSampleAccurate(slots, sliceIn, sliceOut, blockCtx, opts.automation, at, (sample) => projectSampleBeat(clock, sample), scratch, pool)
      continue
    }
    processChain(slots, sliceIn, sliceOut, blockCtx, at, pool)
  }
  return output
}

export interface InsertPlugin {
  id: string
  pluginId: string
  enabled: boolean
  wet: number
  params: Record<string, number>
  sidechain: string
}

/** Plain data a worker can receive. Processors are created on that side. */
export interface InsertJob extends InsertClock {
  plugins: InsertPlugin[]
  input: Float32Array[]
  keys: { id: string; samples: Float32Array }[]
  /** Set on the main thread. Workers have no `location.search`. */
  wasmDsp?: boolean
}

export async function renderInsertJob(job: InsertJob) {
  const ids = [...new Set(job.plugins.map((plugin) => plugin.pluginId))]
  await Promise.all(ids.map((id) => loadModule(id)))
  const flagged = await wasmProcessors(job)
  const slots: ChainSlot[] = job.plugins.map((plugin) => ({
    id: plugin.id,
    pluginId: plugin.pluginId,
    enabled: plugin.enabled,
    wet: plugin.wet,
    params: { ...plugin.params },
    failed: false,
    sidechain: plugin.sidechain,
    processor: flagged?.(plugin.pluginId, job.sampleRate) ?? peekModule(plugin.pluginId)?.create(job.sampleRate) ?? passthrough(),
  }))
  const keys = new Map(job.keys.map((key) => [key.id, key.samples]))
  const block = 128
  const width = Math.max(1, slots.length)
  const pool = prepareChainPool(width, 2, block)
  const scratch = prepareAccurate(width, block)
  return renderInserts(slots, job.input, job, (id, offset, count) => {
    const channel = keys.get(id)
    if (!channel) return null
    const out = new Float32Array(count)
    for (let i = 0; i < count; i++) out[i] = channel[offset + i] || 0
    return out
  }, pool, scratch)
}

async function wasmProcessors(job: InsertJob): Promise<((id: string, sampleRate: number) => Processor | null) | null> {
  const host = globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }
  if (!job.wasmDsp) {
    host.__CUEHARBOR_WASM_DSP__ = false
    return null
  }
  host.__CUEHARBOR_WASM_DSP__ = true
  try {
    const mod = await import('./plugins/createAll')
    await mod.preloadWasmInserts()
    return mod.createProcessor
  } catch {
    delete host.__CUEHARBOR_WASM_DSP__
    return null
  }
}

function passthrough(): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)]
        if (src) output[c].set(src)
      }
    },
  }
}
