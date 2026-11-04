import { renderInsertJob, type InsertJob } from '../renderChain'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; job: InsertJob }>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

scope.onmessage = (event) => {
  const message = event.data
  if (!message?.job) return
  void renderInsertJob(message.job).then((channels) => {
    const transfer = channels.flatMap((channel) => channel.buffer instanceof ArrayBuffer ? [channel.buffer] : [])
    scope.postMessage({ id: message.id, channels }, transfer)
  }).catch((error: Error) => {
    scope.postMessage({ id: message.id, error: error?.message || 'render failed' })
  })
}
