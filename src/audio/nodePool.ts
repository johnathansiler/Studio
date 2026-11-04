import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { createChainRunner, type ChainRunner, type ChainWorker } from './chainPool'

/** Node offline pool. The browser uses module workers instead of this file. */
export function createNodePool(size = Math.max(1, Math.min(8, availableParallelism()))): ChainRunner {
  const workerUrl = new URL('./workers/track.node.ts', import.meta.url)
  const workers = Array.from({ length: size }, () => {
    const worker = new Worker(workerUrl, { execArgv: ['--import', 'tsx'] })
    worker.unref()
    return wrap(worker)
  })
  return createChainRunner(workers)
}

function wrap(worker: Worker): ChainWorker {
  return {
    postMessage(message, transfer) {
      worker.postMessage(message, transfer as never)
    },
    on(event, handler) {
      if (event === 'message') worker.on('message', handler)
      else worker.on('error', handler as (error: Error) => void)
    },
    terminate() {
      return worker.terminate()
    },
  }
}
