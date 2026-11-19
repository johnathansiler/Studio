import { detectKey, type KeyDetectOptions, type KeyReading } from './clipKey'

export interface KeyWorkerIn {
  id: number
  samples: Float32Array
  sampleRate: number
  options?: KeyDetectOptions
}

export interface KeyWorkerOut {
  id: number
  reading?: KeyReading
  error?: string
}

/** One key reading. The worker and the no-Worker fallback share this. */
export function readKeyMessage(message: KeyWorkerIn): KeyWorkerOut {
  try {
    const reading = detectKey(message.samples, message.sampleRate || 48000, message.options)
    return { id: message.id, reading }
  } catch (error) {
    return { id: message.id, error: error instanceof Error ? error.message : 'Detection failed' }
  }
}

const scope = globalThis as typeof globalThis & {
  postMessage?: (data: unknown) => void
  onmessage?: ((event: MessageEvent<KeyWorkerIn>) => void) | null
}

const inWorker = typeof window === 'undefined' && typeof scope.postMessage === 'function' && typeof document === 'undefined'

if (inWorker) {
  scope.onmessage = (event: MessageEvent<KeyWorkerIn>) => {
    scope.postMessage?.(readKeyMessage(event.data))
  }
}
