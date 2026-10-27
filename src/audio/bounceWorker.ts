import { runBounce, type BounceJob } from './bounce'

let cancel = false

self.onmessage = (event: MessageEvent<{ type: string; job?: BounceJob }>) => {
  if (event.data?.type === 'cancel') {
    cancel = true
    return
  }
  if (event.data?.type !== 'start' || !event.data.job) return
  cancel = false
  const job = event.data.job
  const host = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void }
  void runBounce(job, (progress) => {
    host.postMessage({ type: 'progress', progress })
  }, () => cancel).then((files) => {
    const transfer: Transferable[] = []
    for (const file of files) {
      if (file.bytes.buffer instanceof ArrayBuffer) transfer.push(file.bytes.buffer)
    }
    host.postMessage({ type: 'done', files }, transfer)
  }).catch((error: Error) => {
    host.postMessage({ type: 'error', message: error?.name === 'BounceCancelled' ? 'Cancelled' : error?.message || 'Bounce failed' })
  })
}
