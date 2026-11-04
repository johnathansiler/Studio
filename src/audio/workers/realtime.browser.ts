import { serveRealtime } from '../realtimeWorkerLoop'

interface InitMsg {
  type: 'init'
  sab: SharedArrayBuffer
  mine: number[]
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<InitMsg | { type: string }>) => void) | null
  postMessage: (data: unknown) => void
}

const handlers: ((data: { type: string }) => void)[] = []
scope.onmessage = (event) => {
  const data = event.data
  if (data?.type === 'init' && 'sab' in data) {
    serveRealtime({
      onMessage(handler) {
        handlers.push(handler)
      },
      postMessage(message) {
        scope.postMessage(message)
      },
    }, data.sab, data.mine)
    return
  }
  for (const handler of handlers) handler(data)
}
