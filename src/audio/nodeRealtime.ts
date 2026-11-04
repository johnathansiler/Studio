import { Worker } from 'node:worker_threads'
import { createSab, SAB_TRACKS } from './core/sabClock'
import { wasmDspRequested } from './wasm/flag'
import type { InsertPlugin } from './renderChain'

export interface PreparedSlot {
  slot: number
  sampleRate: number
  plugins: InsertPlugin[]
}

/** Node pool. The browser uses module workers in `realtimePool.ts`. */
export function startNodeRealtime(workers = 4, tracks = SAB_TRACKS) {
  const sab = createSab(tracks)
  const pool = Math.max(1, workers)
  const threads = Array.from({ length: pool }, (_, index) => {
    const mine = []
    for (let slot = index; slot < tracks; slot += pool) mine.push(slot)
    const worker = new Worker(new URL('./workers/realtime.node.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      workerData: { sab, mine },
    })
    worker.unref()
    return worker
  })
  const ready = new Map<number, () => void>()
  for (const worker of threads) {
    worker.on('message', (data: { type?: string; slot?: number }) => {
      if (data?.type === 'ready' && data.slot != null) ready.get(data.slot)?.()
    })
  }
  return {
    sab,
    tracks,
    configure(slot: number, sampleRate: number, plugins: InsertPlugin[]) {
      const worker = threads[slot % pool]
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Realtime worker did not prepare')), 8000)
        ready.set(slot, () => {
          clearTimeout(timer)
          resolve()
        })
        worker.postMessage({ type: 'prepare', slot, sampleRate, plugins, wasm: wasmDspRequested() })
      })
    },
    async close() {
      for (const worker of threads) worker.postMessage({ type: 'stop' })
      await Promise.all(threads.map((worker) => worker.terminate()))
    },
  }
}
