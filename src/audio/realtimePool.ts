import { createSab, SAB_TRACKS } from './core/sabClock'
import { isolationAvailable } from './core/isolate'
import { wasmDspRequested } from './wasm/flag'
import type { InsertPlugin } from './renderChain'

export interface RealtimeHandle {
  sab: SharedArrayBuffer
  tracks: number
  configure(slot: number, sampleRate: number, plugins: InsertPlugin[]): Promise<void>
  close(): Promise<void>
}

/**
 * Browser pool. Starts only when the page is cross-origin isolated.
 * Otherwise the insert worklet keeps running on the audio thread.
 */
export function startBrowserRealtime(workers = 4, tracks = SAB_TRACKS): RealtimeHandle | null {
  if (!isolationAvailable() || typeof Worker === 'undefined') return null
  const sab = createSab(tracks)
  const pool = Math.max(1, Math.min(8, workers))
  const threads: Worker[] = []
  try {
    for (let index = 0; index < pool; index++) {
      const mine: number[] = []
      for (let slot = index; slot < tracks; slot += pool) mine.push(slot)
      const worker = new Worker(new URL('./workers/realtime.browser.ts', import.meta.url), { type: 'module' })
      worker.postMessage({ type: 'init', sab, mine })
      threads.push(worker)
    }
  } catch {
    for (const worker of threads) worker.terminate()
    return null
  }
  const ready = new Map<number, () => void>()
  for (const worker of threads) {
    worker.onmessage = (event: MessageEvent<{ type?: string; slot?: number }>) => {
      const data = event.data
      if (data?.type === 'ready' && data.slot != null) ready.get(data.slot)?.()
    }
  }
  return {
    sab,
    tracks,
    configure(slot, sampleRate, plugins) {
      const worker = threads[slot % pool]
      return new Promise((resolve, reject) => {
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
      for (const worker of threads) worker.terminate()
    },
  }
}
