import { RackRuntime } from './dsp'
import type { RackState } from '../../model/rack'
import type { SampleBuffer } from './dsp'

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
  slide?: boolean
}

interface StateMsg {
  type: 'state'
  rack: RackState
  tempo: number
  quality: 'full' | 'eco'
  buffers: { id: string; sampleRate: number; data: Float32Array }[]
}

class RackProcessor extends AudioWorkletProcessor {
  private runtime = new RackRuntime(sampleRate)
  private rack: RackState | null = null
  private tempo = 120
  private quality: 'full' | 'eco' = 'full'
  private buffers = new Map<string, SampleBuffer>()
  private pending: { pitch: number; vel: number; time: number; slide?: boolean }[] = []

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<NoteMsg | StateMsg | { type: 'off' }>) => {
      const data = event.data
      if (data.type === 'state') {
        this.rack = data.rack
        this.tempo = data.tempo
        this.quality = data.quality
        if (data.buffers.length) {
          this.buffers = new Map(data.buffers.map((item) => [item.id, { sampleRate: item.sampleRate, channels: [item.data] }]))
        }
      } else if (data.type === 'note') {
        this.pending.push({ pitch: data.pitch, vel: data.vel, time: data.time, slide: data.slide })
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
    const rack = this.rack
    while (this.pending.length && this.pending[0].time <= now) {
      const note = this.pending.shift()!
      this.runtime.note(note.pitch, note.vel, rack?.polyphony ?? 8, !!note.slide)
    }
    if (!rack) {
      out[0]?.fill(0)
      out[1]?.fill(0)
      return true
    }
    const started = typeof performance !== 'undefined' ? performance.now() : 0
    const rendered = this.runtime.render(rack, frames, this.tempo, this.quality, this.buffers)
    out[0]?.set(rendered[0])
    if (out[1]) out[1].set(rendered[1])
    else out[0]?.set(rendered[0])
    const budget = (frames / sampleRate) * 1000
    if (budget > 0) this.port.postMessage({ type: 'cpu', value: ((typeof performance !== 'undefined' ? performance.now() : started) - started) / budget })
    return true
  }
}

registerProcessor('cueharbor-rack', RackProcessor)
