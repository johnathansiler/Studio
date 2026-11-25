import { CueRackVoice, type RackMsg } from './voice'

declare const sampleRate: number
declare const currentTime: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void

class RackProcessor extends AudioWorkletProcessor {
  private voice = new CueRackVoice(sampleRate)

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<RackMsg | { type: 'arm' }>) => {
      const data = event.data
      if (data.type === 'arm') {
        this.port.postMessage({ type: 'armed' })
        return
      }
      this.voice.onMessage(data)
      if (data.type === 'state') this.port.postMessage({ type: 'ready' })
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const frames = out?.[0]?.length ?? 0
    if (!out || !frames) return true
    const started = typeof performance !== 'undefined' ? performance.now() : 0
    this.voice.process(out, currentTime)
    const budget = (frames / sampleRate) * 1000
    if (budget > 0 && (currentTime * sampleRate) % 2048 < frames) {
      this.port.postMessage({ type: 'cpu', value: ((typeof performance !== 'undefined' ? performance.now() : started) - started) / budget })
    }
    return true
  }
}

registerProcessor('cueharbor-rack', RackProcessor)
