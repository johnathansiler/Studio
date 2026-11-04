import type { InsertJob } from './renderChain'

export interface ChainWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void
  on(event: 'message', handler: (data: unknown) => void): void
  on(event: 'error', handler: (error: Error) => void): void
  terminate(): void | Promise<unknown>
}

export interface ChainRunner {
  size: number
  run(job: InsertJob): Promise<Float32Array[]>
  close(): Promise<void>
}

interface Reply {
  id?: number
  channels?: Float32Array[]
  error?: string
}

/**
 * Hands insert jobs to a fixed set of workers.
 * The caller (the mix scheduler) decides which jobs are independent.
 */
export function createChainRunner(workers: ChainWorker[]): ChainRunner {
  let seq = 1
  let closed = false
  const free: ChainWorker[] = [...workers]
  const waiters: { job: InsertJob; resolve: (channels: Float32Array[]) => void; reject: (error: Error) => void }[] = []
  const pending = new Map<number, { resolve: (channels: Float32Array[]) => void; reject: (error: Error) => void; worker: ChainWorker }>()

  const failAll = (error: Error) => {
    closed = true
    for (const task of pending.values()) task.reject(error)
    pending.clear()
    for (const task of waiters) task.reject(error)
    waiters.length = 0
  }

  const pump = () => {
    while (!closed && free.length && waiters.length) {
      const worker = free.pop()
      const task = waiters.shift()
      if (!worker || !task) return
      const id = seq++
      pending.set(id, { resolve: task.resolve, reject: task.reject, worker })
      const input = task.job.input.map((channel) => new Float32Array(channel))
      const keys = task.job.keys.map((key) => ({ id: key.id, samples: new Float32Array(key.samples) }))
      const transfer: Transferable[] = []
      for (const channel of input) if (channel.buffer instanceof ArrayBuffer) transfer.push(channel.buffer)
      for (const key of keys) if (key.samples.buffer instanceof ArrayBuffer) transfer.push(key.samples.buffer)
      worker.postMessage({ id, job: { ...task.job, input, keys } }, transfer)
    }
  }

  for (const worker of workers) {
    worker.on('message', (data) => {
      const message = data as Reply
      if (message.id == null) return
      const task = pending.get(message.id)
      if (!task) return
      pending.delete(message.id)
      free.push(task.worker)
      if (message.error) task.reject(new Error(message.error))
      else task.resolve(message.channels?.length ? message.channels : [new Float32Array(0), new Float32Array(0)])
      pump()
    })
    worker.on('error', (error) => failAll(error))
  }

  return {
    size: Math.max(1, workers.length),
    run(job) {
      if (closed || !workers.length) return Promise.reject(new Error('Graph workers are closed'))
      return new Promise((resolve, reject) => {
        waiters.push({ job, resolve, reject })
        pump()
      })
    },
    async close() {
      closed = true
      await Promise.all(workers.map((worker) => Promise.resolve(worker.terminate())))
    },
  }
}
