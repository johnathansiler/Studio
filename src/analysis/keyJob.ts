import type { KeyDetectOptions, KeyReading } from './clipKey'
import type { KeyWorkerOut } from './keyWorker'

interface PendingKey {
  resolve: (reading: KeyReading) => void
  reject: (error: Error) => void
  samples: Float32Array
  sampleRate: number
  options?: KeyDetectOptions
}

let worker: Worker | null = null
let seq = 1
const pending = new Map<number, PendingKey>()

function client() {
  if (typeof Worker === 'undefined') return null
  try {
    if (!worker) {
      worker = new Worker(new URL('./keyWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<KeyWorkerOut>) => {
        const wait = pending.get(event.data?.id)
        if (!wait) return
        pending.delete(event.data.id)
        if (event.data.error || !event.data.reading) wait.reject(new Error(event.data.error || 'Detection failed'))
        else wait.resolve(event.data.reading)
      }
      worker.onerror = () => {
        const host = worker
        worker = null
        host?.terminate()
        const queued = [...pending.values()]
        pending.clear()
        for (const wait of queued) runLocal(wait.samples, wait.sampleRate, wait.options).then(wait.resolve, wait.reject)
      }
    }
    return worker
  } catch {
    worker = null
    return null
  }
}

async function runLocal(samples: Float32Array, sampleRate: number, options?: KeyDetectOptions) {
  const { detectKey } = await import('./clipKey')
  return detectKey(samples, sampleRate, options)
}

/**
 * Key of one buffer, off the main thread.
 * The transport clock lives on the main thread and only stays a few seconds
 * ahead of the speakers. A full-loop detect is about a second on a desktop
 * core and a few seconds on a phone, so it cannot run there.
 * Callers keep their own buffer. This copies, then hands the copy to the worker.
 */
export function detectKeyOffThread(samples: ArrayLike<number>, sampleRate: number, options?: KeyDetectOptions): Promise<KeyReading> {
  const copy = Float32Array.from(samples)
  const host = client()
  if (!host) return runLocal(copy, sampleRate, options)
  const id = seq++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error('Detection is taking too long.'))
    }, 45000)
    pending.set(id, {
      samples: copy,
      sampleRate,
      options,
      resolve: (reading) => {
        clearTimeout(timer)
        resolve(reading)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    try {
      const payload = Float32Array.from(copy)
      host.postMessage({ id, samples: payload, sampleRate, options }, [payload.buffer])
    } catch {
      clearTimeout(timer)
      pending.delete(id)
      runLocal(copy, sampleRate, options).then(resolve, reject)
    }
  })
}
