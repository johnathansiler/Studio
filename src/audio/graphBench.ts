import { availableParallelism } from 'node:os'
import { countOverruns } from './core/graph'
import { createNodePool } from './nodePool'
import { renderGraphParallel, type ChainRunner } from './parallelRender'
import { renderInserts } from './renderChain'
import { renderGraph, type GraphTrack, type RenderOptions } from './renderGraph'
import { prepareAccurate } from './automationRender'
import { prepareChainPool, type ChainSlot } from './plugins/chain'
import { createPlugin } from './plugins/catalog'
import { loadModule, peekModule } from './plugins/registry'

/**
 * Why realtime playback stays on one thread.
 * Measured by `benchmarkMixGraph`: a worker round trip for one quantum is
 * slower than rendering that quantum in place, and it cannot be sample-locked
 * to the audio callback without SharedArrayBuffer.
 */
export const REALTIME_LIMIT = 'One AudioContext runs every AudioWorklet on a single audio thread, in graph order. A second worklet does not add a core. A Worker round trip copies the block because SharedArrayBuffer stays off with COOP/COEP. That copy is slower than rendering the quantum in place, so realtime playback stays on the audio thread. Offline bounce can wait, and independent tracks run on workers there.'

export interface MixBenchmark {
  tracks: number
  inserts: string[]
  sampleRate: number
  seconds: number
  quantum: number
  cores: number
  workers: number
  realtime: {
    adopted: 'single-audio-thread'
    reason: string
    measure: string
    before: ReturnType<typeof countOverruns>
    after: ReturnType<typeof countOverruns>
    workerRoundTrip: ReturnType<typeof countOverruns>
  }
  offline: {
    sequentialMs: number
    parallelMs: number
    speedup: number
    maxError: number
  }
}

export async function benchmarkMixGraph(options?: {
  tracks?: number
  seconds?: number
  sampleRate?: number
  quantum?: number
  blocks?: number
  runner?: ChainRunner
}): Promise<MixBenchmark> {
  const tracks = options?.tracks ?? 12
  const seconds = options?.seconds ?? 1
  const sampleRate = options?.sampleRate ?? 48000
  const quantum = options?.quantum ?? 128
  const blocks = options?.blocks ?? 6
  const length = Math.max(quantum, Math.round(sampleRate * seconds))
  const inserts = ['eq', 'compressor', 'saturator']
  await Promise.all(inserts.map((id) => loadModule(id)))
  const built = buildProject(tracks, length, sampleRate, inserts)
  const single = await timeQuantums(built, quantum, blocks)
  const owned = !options?.runner
  const runner = options?.runner ?? createNodePool()
  try {
    await renderGraphParallel(sliceOptions(built, quantum), runner)
    const workerTimes: number[] = []
    for (let block = 0; block < blocks; block++) {
      const started = performance.now()
      await renderGraphParallel(sliceOptions(built, quantum), runner)
      workerTimes.push(performance.now() - started)
    }
    renderGraph(renderOptions(built, Math.min(length, quantum * 4)))
    const sequentialStarted = performance.now()
    const sequential = renderGraph(renderOptions(built, length))
    const sequentialMs = performance.now() - sequentialStarted
    const parallelStarted = performance.now()
    const parallel = await renderGraphParallel(renderOptions(built, length), runner)
    const parallelMs = performance.now() - parallelStarted
    const before = countOverruns(single, quantum, sampleRate)
    return {
      tracks,
      inserts,
      sampleRate,
      seconds,
      quantum,
      cores: availableParallelism(),
      workers: runner.size,
    realtime: {
      adopted: 'single-audio-thread' as const,
      reason: REALTIME_LIMIT,
      measure: 'Prepared insert chains for one quantum, summed on one thread. That is the live audio thread: each track worklet runs there, one after another. Before and after match because that thread was not split.',
      before,
      after: before,
      workerRoundTrip: countOverruns(workerTimes, quantum, sampleRate),
    },
      offline: {
        sequentialMs,
        parallelMs,
        speedup: parallelMs > 0 ? sequentialMs / parallelMs : 0,
        maxError: maxError(sequential.master, parallel.master),
      },
    }
  } finally {
    if (owned) await runner.close()
  }
}

function timeQuantums(project: Built, quantum: number, blocks: number) {
  const options = sliceOptions(project, quantum)
  const pool = prepareChainPool(24, 2, quantum)
  const scratch = prepareAccurate(24, quantum)
  const chains = [...options.tracks.map((item) => item.plugins), options.masterPlugins].map((plugins) => plugins.map((plugin): ChainSlot => ({
    id: plugin.id,
    pluginId: plugin.pluginId,
    enabled: plugin.enabled,
    wet: plugin.wet,
    params: { ...plugin.params },
    failed: false,
    sidechain: plugin.sidechain || '',
    processor: peekModule(plugin.pluginId)?.create(options.sampleRate) ?? null,
  })))
  const buffers = [
    ...options.tracks.map((item) => item.buffer),
    [new Float32Array(quantum), new Float32Array(quantum)],
  ]
  const clock = {
    sampleRate: options.sampleRate,
    tempo: options.tempo,
    automation: options.automation,
    scaleRoot: options.scaleRoot,
    scaleIntervals: options.scaleIntervals,
    quality: 'full' as const,
    offline: false,
  }
  const once = () => {
    for (let index = 0; index < chains.length; index++) {
      renderInserts(chains[index], buffers[index], clock, () => null, pool, scratch)
    }
  }
  once()
  const times: number[] = []
  for (let block = 0; block < blocks; block++) {
    const started = performance.now()
    once()
    times.push(performance.now() - started)
  }
  return times
}

interface Built {
  tracks: GraphTrack[]
  sampleRate: number
}

function buildProject(count: number, length: number, sampleRate: number, inserts: string[]): Built {
  const bus = track('bus', length, 'bus', null, [])
  const reverb = track('reverb', length, 'bus', null, [insert('eq')])
  const tracks: GraphTrack[] = []
  for (let index = 0; index < count; index++) {
    const noise = hashNoise(length, index + 1)
    const item = track(`t${index}`, length, 'audio', index % 2 === 0 ? 'bus' : null, inserts.map(insert))
    item.buffer = [noise, noise.slice()]
    item.sends = [{ id: `send-${index}`, busId: 'reverb', gain: 0.25, preFader: false, enabled: true }]
    tracks.push(item)
  }
  tracks.push(bus, reverb)
  return { tracks, sampleRate }
}

function track(id: string, length: number, type: string, output: string | null, plugins: GraphTrack['plugins']): GraphTrack {
  return {
    id,
    type,
    input: 'none',
    buffer: [new Float32Array(length), new Float32Array(length)],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    plugins,
    sends: [],
    output,
    groupId: null,
  }
}

function insert(pluginId: string) {
  const plugin = createPlugin(pluginId)
  if (pluginId === 'eq') plugin.params.midG = 3
  if (pluginId === 'compressor') plugin.params.threshold = -24
  return plugin
}

function renderOptions(project: Built, length: number): RenderOptions {
  return {
    tracks: project.tracks,
    masterPlugins: [insert('eq')],
    masterVolume: 1,
    sampleRate: project.sampleRate,
    tempo: 120,
    length,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    automation: [],
    offline: true,
    create: (pluginId, sampleRate) => {
      const created = peekModule(pluginId)?.create(sampleRate)
      if (!created) throw new Error(`Missing plugin ${pluginId}`)
      return created
    },
  }
}

function sliceOptions(project: Built, quantum: number): RenderOptions {
  const options = renderOptions(project, quantum)
  options.tracks = project.tracks.map((item) => ({
    ...item,
    buffer: item.buffer.map((channel) => channel.subarray(0, quantum)),
    plugins: item.plugins.map((plugin) => ({ ...plugin, params: { ...plugin.params } })),
    sends: item.sends.map((send) => ({ ...send })),
  }))
  return options
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

function maxError(left: Float32Array[], right: Float32Array[]) {
  let worst = 0
  const channels = Math.max(left.length, right.length)
  for (let channel = 0; channel < channels; channel++) {
    const a = left[channel] ?? left[0]
    const b = right[channel] ?? right[0]
    const n = Math.min(a?.length ?? 0, b?.length ?? 0)
    for (let index = 0; index < n; index++) worst = Math.max(worst, Math.abs((a?.[index] ?? 0) - (b?.[index] ?? 0)))
  }
  return worst
}
