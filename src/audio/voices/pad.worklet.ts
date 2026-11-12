import { PadGraph } from './live'
import type { PadPlan } from './program'

declare const sampleRate: number
declare const currentTime: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void

type ArmMsg = { type: 'arm'; plan: PadPlan }
type HitMsg = { type: 'hit'; pitch: number; velocity: number; time: number; tune?: number; filter?: number }
type ReleaseMsg = { type: 'release'; pitch: number; time: number }
type CancelMsg = { type: 'cancel'; pitch: number; afterTime: number }
type DuckMsg = { type: 'duck'; pitch: number; time: number }

/**
 * Live pad voice on the audio thread. A 128-sample quantum replaces the
 * 256-sample ScriptProcessor, and a hit at the block start speaks in that block.
 */
class PadProcessor extends AudioWorkletProcessor {
  private graph = new PadGraph(sampleRate, undefined, { wasm: false })
  private pulled = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<ArmMsg | HitMsg | ReleaseMsg | CancelMsg | DuckMsg>) => {
      const data = event.data
      if (data.type === 'arm') this.graph.arm(data.plan)
      else if (data.type === 'hit') this.graph.hit(data.pitch, data.velocity, data.time, { tune: data.tune, filter: data.filter })
      else if (data.type === 'release' || data.type === 'duck') this.graph.release(data.pitch, data.time)
      else if (data.type === 'cancel') this.graph.cancel(data.pitch, data.afterTime)
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const left = out?.[0]
    const right = out && out.length > 1 ? out[1] : left
    if (!left || !right) return true
    this.graph.renderInto(currentTime, left, right)
    if (!this.pulled) {
      this.pulled = true
      this.port.postMessage({ type: 'pulled' })
    }
    return true
  }
}

registerProcessor('cueharbor-pads', PadProcessor)
