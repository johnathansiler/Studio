import { renderStretch, type StretchOptions } from './engine'

declare const currentFrame: number
declare const sampleRate: number

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}

declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void

class CueStretchProcessor extends AudioWorkletProcessor {
  private rendered: Float32Array[] | null = null
  private startFrame = 0
  private skip = 0
  private end = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string
        channels?: Float32Array[]
        sampleRate?: number
        options?: StretchOptions
        startFrame?: number
        skip?: number
        frames?: number
      }
      if (!data || data.type !== 'stretch' || !data.channels?.length) return
      const channels = data.channels.map((channel) => Float32Array.from(channel))
      this.rendered = renderStretch(channels, data.sampleRate || sampleRate, data.options ?? { ratio: 1 })
      this.startFrame = data.startFrame ?? 0
      this.skip = data.skip ?? 0
      this.end = this.skip + (data.frames ?? this.rendered[0].length)
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const rendered = this.rendered
    if (!out?.[0] || !rendered?.[0]) return true
    const count = out[0].length
    let alive = currentFrame + count < this.startFrame
    for (let i = 0; i < count; i++) {
      const frame = currentFrame + i
      const at = frame - this.startFrame + this.skip
      const on = frame >= this.startFrame && at >= this.skip && at < this.end
      if (on) alive = true
      for (let c = 0; c < out.length; c++) {
        const src = rendered[Math.min(c, rendered.length - 1)]
        out[c][i] = on && at < src.length ? src[at] : 0
      }
    }
    return alive
  }
}

registerProcessor('cueharbor-stretch', CueStretchProcessor)
