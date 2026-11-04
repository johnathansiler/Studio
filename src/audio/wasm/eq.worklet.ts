import { WasmEq } from './engine'

declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void

function hostRate() {
  if (typeof sampleRate === 'number' && sampleRate > 0) return sampleRate
  const hinted = (globalThis as { sampleRate?: number }).sampleRate
  return typeof hinted === 'number' && hinted > 0 ? hinted : 48000
}

const WorkletBase = ((globalThis as { AudioWorkletProcessor?: new () => AudioWorkletProcessor }).AudioWorkletProcessor
  ?? AudioWorkletProcessor) as abstract new () => AudioWorkletProcessor

interface WasmMessage {
  type?: string
  id?: number
  value?: number
  bytes?: Uint8Array
}

/**
 * AudioWorklet wrapper for the Rust EQ. The live insert chain does not load this.
 * `boot` resolves once the module is prepared. Messages that arrive early are queued.
 */
class WasmEqProcessor extends WorkletBase {
  private engine: WasmEq | null = null
  private pending: WasmMessage[] = []
  readonly boot: Promise<void>

  constructor() {
    super()
    this.port.postMessage({ type: 'constructed' })
    this.boot = WasmEq.create().then((engine) => {
      engine.prepare(hostRate(), 2048)
      this.engine = engine
      const queued = this.pending
      this.pending = []
      for (const message of queued) this.apply(message)
      this.port.postMessage({ type: 'ready' })
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.port.postMessage({ type: 'error', message })
    })
    this.port.onmessage = (event: MessageEvent<WasmMessage>) => {
      const message = event.data
      if (!message) return
      if (!this.engine) this.pending.push(message)
      else this.apply(message)
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const output = outputs[0]
    if (!output?.[0]) return true
    const input = inputs[0] ?? []
    const engine = this.engine
    if (!engine) {
      const available = input.length
      for (let c = 0; c < output.length; c++) {
        const src = available ? input[Math.min(c, available - 1)] : undefined
        const dst = output[c]
        if (!dst) continue
        if (src && src !== dst) {
          const count = Math.min(dst.length, src.length)
          for (let i = 0; i < count; i++) dst[i] = src[i]
          for (let i = count; i < dst.length; i++) dst[i] = 0
        } else if (!src) {
          dst.fill(0)
        }
      }
      return true
    }
    engine.processArrays(input, output)
    return true
  }

  private apply(message: WasmMessage) {
    const engine = this.engine
    if (!engine) return
    if (message.type === 'param' && typeof message.id === 'number' && typeof message.value === 'number') {
      engine.setParameter(message.id, message.value)
    } else if (message.type === 'settle') {
      engine.settle()
    } else if (message.type === 'reset') {
      engine.reset()
    } else if (message.type === 'state' && message.bytes) {
      engine.setState(message.bytes)
    }
  }
}

const register = (globalThis as { registerProcessor?: (name: string, ctor: new () => AudioWorkletProcessor) => void }).registerProcessor
  ?? registerProcessor
register('cueharbor-wasm-eq', WasmEqProcessor)
