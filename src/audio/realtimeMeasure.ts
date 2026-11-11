import { blockingStep } from './core/sabClock'
import { adoptRealtime } from './core/isolate'
import { prepareChainPool, type ChainSlot } from './plugins/chain'
import { prepareAccurate } from './automationRender'
import { createPlugin } from './plugins/catalog'
import { loadProcessors } from './plugins/loadProcessors'
import { renderInserts, type InsertPlugin } from './renderChain'
import type { RealtimeHandle } from './realtimePool'

const INSERTS = ['eq', 'compressor', 'saturator'] as const

let createProcessor: (id: string, sampleRate: number) => ReturnType<Awaited<ReturnType<typeof loadProcessors>>['createProcessor']> = () => null

/**
 * Steady-state cost of one quantum on one thread versus the shared-memory pool.
 * `adopt` is true only when the workers finish inside the buffer and beat one thread.
 */
export async function measureRealtime(handle: RealtimeHandle, options?: { tracks?: number; frames?: number; sampleRate?: number; rounds?: number }) {
  const tracks = options?.tracks ?? 8
  const frames = options?.frames ?? 128
  const sampleRate = options?.sampleRate ?? 48000
  const rounds = options?.rounds ?? 6
  const processors = await loadProcessors()
  createProcessor = processors.createProcessor
  await processors.preloadWasmInserts()
  const plugins = INSERTS.map(insertPlugin)
  for (let slot = 0; slot < tracks; slot++) await handle.configure(slot, sampleRate, plugins)
  const inputs = Array.from({ length: tracks }, (_, index) => {
    const noise = hashNoise(frames, index + 1)
    return [noise, noise.slice()]
  })
  const sequential = timeSequential(plugins, inputs, sampleRate, rounds)
  const firstParallel = blockingStep(handle.sab, inputs, 1000)
  const firstSequential = inputs.map((pair) => renderChain(plugins, pair, sampleRate))
  const maxError = compare(firstSequential, firstParallel.outputs)
  let parallelMs = 0
  let publishMs = 0
  let misses = firstParallel.misses
  for (let round = 0; round < rounds; round++) {
    const result = blockingStep(handle.sab, inputs, 1000)
    if (round === 0) continue
    parallelMs += result.waitMs + result.publishMs
    publishMs += result.publishMs
    misses += result.misses
  }
  const used = Math.max(1, rounds - 1)
  const parallel = parallelMs / used
  const publish = publishMs / used
  const budgetMs = (frames / sampleRate) * 1000
  return {
    tracks,
    frames,
    sampleRate,
    budgetMs,
    sequentialMs: sequential.ms,
    parallelMs: parallel,
    publishMs: publish,
    misses,
    maxError,
    headroomMs: budgetMs - parallel,
    gainMs: sequential.ms - parallel,
    adopt: adoptRealtime(sequential.ms, parallel, misses, budgetMs),
  }
}

function timeSequential(plugins: InsertPlugin[], inputs: Float32Array[][], sampleRate: number, rounds: number) {
  const run = () => inputs.map((pair) => renderChain(plugins, pair, sampleRate))
  run()
  const started = performance.now()
  let outputs: Float32Array[][] = []
  for (let round = 0; round < rounds - 1; round++) outputs = run()
  return { ms: (performance.now() - started) / Math.max(1, rounds - 1), outputs }
}

function renderChain(plugins: InsertPlugin[], input: Float32Array[], sampleRate: number) {
  const slots: ChainSlot[] = plugins.map((plugin) => ({
    id: plugin.id,
    pluginId: plugin.pluginId,
    enabled: plugin.enabled,
    wet: plugin.wet,
    params: { ...plugin.params },
    failed: false,
    sidechain: plugin.sidechain,
    processor: createProcessor(plugin.pluginId, sampleRate),
  }))
  const pool = prepareChainPool(Math.max(1, slots.length), 2, input[0].length)
  const scratch = prepareAccurate(Math.max(1, slots.length), input[0].length)
  return renderInserts(slots, input, {
    sampleRate,
    tempo: 120,
    automation: [],
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    offline: false,
  }, () => null, pool, scratch)
}

function insertPlugin(pluginId: string): InsertPlugin {
  const plugin = createPlugin(pluginId)
  if (pluginId === 'eq') plugin.params.midG = 3
  if (pluginId === 'compressor') plugin.params.threshold = -18
  return {
    id: plugin.id,
    pluginId: plugin.pluginId,
    enabled: plugin.enabled,
    wet: plugin.wet,
    params: { ...plugin.params },
    sidechain: plugin.sidechain || '',
  }
}

function hashNoise(length: number, seed: number) {
  const out = new Float32Array(length)
  let state = seed * 1103515245 + 12345
  for (let index = 0; index < length; index++) {
    state = (state * 1664525 + 1013904223) >>> 0
    out[index] = (state / 4294967296) * 0.4 - 0.2
  }
  return out
}

function compare(left: Float32Array[][], right: Float32Array[][]) {
  let worst = 0
  const tracks = Math.min(left.length, right.length)
  for (let track = 0; track < tracks; track++) {
    const a = left[track][0]
    const b = right[track]?.[0]
    if (!a || !b) continue
    const n = Math.min(a.length, b.length)
    for (let index = 0; index < n; index++) worst = Math.max(worst, Math.abs(a[index] - b[index]))
  }
  return worst
}
