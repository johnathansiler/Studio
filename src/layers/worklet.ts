import { LayerRuntime, type LayerBuffer } from './engine'
import type { LayerPatch } from './types'

declare const sampleRate: number
declare const currentTime: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void

interface NoteMsg {
  type: 'note'
  pitch: number
  vel: number
  time: number
}

interface StateMsg {
  type: 'state'
  patch: LayerPatch
  quality: 'full' | 'eco'
  buffers?: { id: string; sampleRate: number; data: Float32Array }[]
}

class LayerProcessor extends AudioWorkletProcessor {
  private runtime = new LayerRuntime(sampleRate)
  private patch: LayerPatch | null = null
  private quality: 'full' | 'eco' = 'full'
  private buffers = new Map<string, LayerBuffer>()
  private pending: { pitch: number; vel: number; time: number }[] = []

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<NoteMsg | StateMsg | { type: 'off' }>) => {
      const data = event.data
      if (data.type === 'state') {
        this.patch = data.patch
        this.quality = data.quality
        if (data.buffers) {
          this.buffers = new Map(data.buffers.map((item) => [item.id, { sampleRate: item.sampleRate, channel: item.data }]))
        }
      } else if (data.type === 'note') {
        this.pending.push({ pitch: data.pitch, vel: data.vel, time: data.time })
        this.pending.sort((a, b) => a.time - b.time)
      } else if (data.type === 'off') {
        this.runtime.allOff()
        this.pending = []
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const frames = out?.[0]?.length ?? 0
    if (!out || !frames) return true
    const now = currentTime
    const patch = this.patch
    while (this.pending.length && this.pending[0].time <= now) {
      const note = this.pending.shift()!
      this.runtime.note(note.pitch, note.vel, patch?.polyphony ?? 8)
    }
    if (!patch) {
      out[0]?.fill(0)
      out[1]?.fill(0)
      return true
    }
    const started = typeof performance !== 'undefined' ? performance.now() : 0
    const rendered = this.runtime.render(patch, frames, this.quality, this.buffers)
    out[0]?.set(rendered[0])
    if (out[1]) out[1].set(rendered[1])
    const budget = (frames / sampleRate) * 1000
    if (budget > 0) this.port.postMessage({ type: 'cpu', value: ((typeof performance !== 'undefined' ? performance.now() : started) - started) / budget })
    return true
  }
}

registerProcessor('cueharbor-layers', LayerProcessor)
