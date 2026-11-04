import { createScheduler, type MixSchedule, type RouteInput } from './core/graph'
import { createChainRunner, type ChainRunner, type ChainWorker } from './chainPool'
import {
  commitTrack,
  finishMaster,
  graphHasSidechain,
  insertJob,
  masterInput,
  nodeInput,
  prepareRender,
  renderGraph,
  type RenderOptions,
} from './renderGraph'
import { MASTER, REMOTE } from './routing'

export type { ChainRunner }

/**
 * Offline mix. Independent tracks run on workers. A bus is started only
 * after the tracks that feed it have finished, and a free worker takes the
 * next ready track instead of waiting on that bus.
 *
 * Pass `runner` from Node (`createNodePool`). The browser opens module
 * workers itself. Sidechain mixes stay on one thread so the key hears the
 * same rendered audio as the sequential graph. Realtime playback does not
 * call this: one AudioContext has one audio thread.
 */
export async function renderGraphParallel(opts: RenderOptions, runner?: ChainRunner) {
  if (graphHasSidechain(opts)) return renderGraph(opts)
  const owned = !runner
  const active = runner ?? openBrowserRunner()
  if (!active) return renderGraph(opts)
  try {
    return await renderDistributed(opts, active)
  } catch (error) {
    if (runner) throw error
    return renderGraph(opts)
  } finally {
    if (owned) await active.close()
  }
}

async function renderDistributed(opts: RenderOptions, runner: ChainRunner) {
  const state = prepareRender(opts)
  const scheduler = createScheduler(routesFromGraph(state.schedule))
  const limit = Math.max(1, runner.size)
  let inflight = 0
  let master: Float32Array[] | null = null
  let failure: Error | null = null

  const runNode = async (id: string) => {
    if (id === REMOTE || (id !== MASTER && !state.byId.has(id))) return
    if (id === MASTER) {
      const input = masterInput(state)
      master = await runner.run(insertJob(state, opts.masterPlugins, input))
      return
    }
    const track = state.byId.get(id)
    if (!track) return
    const input = nodeInput(state, id)
    commitTrack(state, id, await runner.run(insertJob(state, track.plugins, input)))
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (error?: Error) => {
      if (settled) return
      if (error) {
        if (inflight > 0) return
        settled = true
        reject(error)
        return
      }
      if (inflight === 0 && scheduler.done()) {
        settled = true
        resolve()
      }
    }
    const pump = () => {
      if (failure) {
        settle(failure)
        return
      }
      while (inflight < limit) {
        const id = scheduler.take()
        if (!id) break
        inflight += 1
        void runNode(id).then(() => {
          inflight -= 1
          scheduler.complete(id)
          pump()
        }).catch((error: Error) => {
          inflight -= 1
          failure = error instanceof Error ? error : new Error('Graph worker failed')
          pump()
        })
      }
      if (!failure && inflight === 0 && !scheduler.done()) failure = new Error('Mix graph stalled before every bus finished')
      settle(failure ?? undefined)
    }
    pump()
  })

  return finishMaster(state, master ?? masterInput(state))
}

function routesFromGraph(schedule: MixSchedule): RouteInput[] {
  const sends = new Map<string, string[]>()
  const dest = new Map<string, string>()
  for (const edge of schedule.graph.edges) {
    if (edge.kind === 'output') dest.set(edge.from, edge.to)
    else {
      const list = sends.get(edge.from) ?? []
      list.push(edge.to)
      sends.set(edge.from, list)
    }
  }
  return schedule.graph.nodes.map((node) => ({
    id: node.id,
    dest: dest.get(node.id) ?? null,
    sends: sends.get(node.id) ?? [],
    latency: node.latency,
    kind: node.kind,
  }))
}

function openBrowserRunner(): ChainRunner | null {
  if (typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined') return null
  if (typeof Worker === 'undefined') return null
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2
  const size = Math.max(1, Math.min(8, cores))
  try {
    const workers: ChainWorker[] = []
    for (let index = 0; index < size; index++) {
      const worker = new Worker(new URL('./workers/track.browser.ts', import.meta.url), { type: 'module' })
      workers.push({
        postMessage(message, transfer) {
          if (transfer && transfer.length) worker.postMessage(message, transfer)
          else worker.postMessage(message)
        },
        on(event, handler) {
          if (event === 'message') worker.onmessage = (message) => handler(message.data)
          else worker.onerror = (message) => handler(new Error(message.message || 'Graph worker failed'))
        },
        terminate() {
          worker.terminate()
        },
      })
    }
    return createChainRunner(workers)
  } catch {
    return null
  }
}
