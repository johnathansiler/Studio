import { parentPort, workerData } from 'node:worker_threads'
import { serveRealtime } from '../realtimeWorkerLoop'

const port = {
  onMessage(handler: (data: { type: string }) => void) {
    parentPort?.on('message', handler)
  },
  postMessage(data: unknown) {
    parentPort?.postMessage(data)
  },
}

serveRealtime(port, workerData.sab as SharedArrayBuffer, workerData.mine as number[])
