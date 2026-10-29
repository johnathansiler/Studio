import { PatchEngine } from '../instruments/patch/engine'
import type { OmniPatch } from '../instruments/patch/types'

declare const sampleRate: number
declare const currentTime: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void

class PatchProcessor extends AudioWorkletProcessor {
  private engine = new PatchEngine(sampleRate)

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<{ type?: string; patch?: OmniPatch; id?: string; channel?: Float32Array | null; pitch?: number; vel?: number; time?: number }>) => {
      const data = event.data
      if (!data?.type) return
      if (data.type === 'patch' && data.patch) this.engine.setPatch(data.patch)
      else if (data.type === 'buffer' && data.id) this.engine.setBuffer(data.id, data.channel ?? null)
      else if (data.type === 'note') this.engine.schedule(Number(data.pitch) || 0, Number(data.vel) || 0, Number(data.time) || currentTime)
      else if (data.type === 'release') this.engine.releasePitch(Number(data.pitch) || 0)
      else if (data.type === 'off') this.engine.allOff()
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const frames = out?.[0]?.length ?? 0
    if (!out || !frames) return true
    const rendered = this.engine.renderAt(frames, currentTime)
    out[0].set(rendered.left.subarray(0, frames))
    if (out[1]) out[1].set(rendered.right.subarray(0, frames))
    return true
  }
}

registerProcessor('cueharbor-patch', PatchProcessor)
