import { RackRuntime } from './dsp'
import type { RackAutomation, RackState } from '../../model/rack'
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

interface ClockMsg {
  type: 'clock'
  originTime: number
  originBeat: number
  tempo: number
  lanes: RackAutomation[]
}

class RackProcessor extends AudioWorkletProcessor {
  private runtime = new RackRuntime(sampleRate)
  private rack: RackState | null = null
  private tempo = 120
  private quality: 'full' | 'eco' = 'full'
  private buffers = new Map<string, SampleBuffer>()
  private pending: { pitch: number; vel: number; time: number; slide?: boolean }[] = []
  private lanes: RackAutomation[] = []
  private originTime = 0
  private originBeat = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<NoteMsg | StateMsg | ClockMsg | { type: 'off' } | { type: 'drop'; pitch: number }>) => {
      const data = event.data
      if (data.type === 'clock') {
        this.originTime = data.originTime
        this.originBeat = data.originBeat
        this.tempo = data.tempo
        this.lanes = data.lanes ?? []
      } else if (data.type === 'state') {
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
      } else if (data.type === 'drop') {
        this.pending = this.pending.filter((note) => note.pitch !== data.pitch)
        this.runtime.note(data.pitch, 0, this.rack?.polyphony ?? 8, false)
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const frames = out?.[0]?.length ?? 0
    if (!out || !frames) return true
    const now = currentTime
    const rack = this.rack
    const left = out[0]
    const right = out[1]
    if (!rack || !left) {
      left?.fill(0)
      right?.fill(0)
      return true
    }
    const started = typeof performance !== 'undefined' ? performance.now() : 0
    let rendered = 0
    while (rendered < frames) {
      const at = now + rendered / sampleRate
      while (this.pending.length && this.pending[0].time <= at + 0.5 / sampleRate) {
        const note = this.pending.shift()!
        this.runtime.note(note.pitch, note.vel, rack.polyphony, !!note.slide)
      }
      let until = frames
      if (this.pending.length) {
        const next = Math.floor((this.pending[0].time - now) * sampleRate)
        if (next > rendered) until = Math.min(frames, next)
      }
      const span = Math.max(1, Math.min(frames - rendered, until - rendered))
      const beat = this.originBeat + (at - this.originTime) * (this.tempo / 60)
      const block = this.runtime.render(rack, span, this.tempo, this.quality, this.buffers, this.lanes, beat)
      left.set(block[0], rendered)
      if (right) right.set(block[1], rendered)
      rendered += span
    }
    const budget = (frames / sampleRate) * 1000
    if (budget > 0 && (currentTime * sampleRate) % 2048 < frames) {
      this.port.postMessage({ type: 'cpu', value: ((typeof performance !== 'undefined' ? performance.now() : started) - started) / budget })
    }
    return true
  }
}

registerProcessor('cueharbor-rack', RackProcessor)
