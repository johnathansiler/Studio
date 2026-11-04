import { parentPort } from 'node:worker_threads'
import { renderInsertJob, type InsertJob } from '../renderChain'

parentPort?.on('message', (message: { id: number; job: InsertJob }) => {
  void renderInsertJob(message.job).then((channels) => {
    const transfer = channels.flatMap((channel) => channel.buffer instanceof ArrayBuffer ? [channel.buffer] : [])
    parentPort?.postMessage({ id: message.id, channels }, transfer)
  }).catch((error: Error) => {
    parentPort?.postMessage({ id: message.id, error: error?.message || 'render failed' })
  })
})
