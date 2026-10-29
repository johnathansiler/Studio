import { MemoryBank } from './multisample/cache'
import { SamplerInstrument } from './multisample/engine'
import type { MicPosition, SamplerProgram } from './multisample/types'

declare const sampleRate: number
declare const currentTime: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void

interface NoteMsg {
  pitch: number
  vel: number
  time: number
}

class LibraryProcessor extends AudioWorkletProcessor {
  private bank = new MemoryBank()
  private instrument = new SamplerInstrument(sampleRate, this.bank)
  private notes: NoteMsg[] = []

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<{ type?: string; program?: SamplerProgram | null; id?: string; sampleRate?: number; channels?: Float32Array[]; pitch?: number; vel?: number; time?: number; mics?: MicPosition[]; limit?: number; key?: number | null }>) => {
      const data = event.data
      if (!data?.type) return
      if (data.type === 'program') this.instrument.setProgram(data.program ?? null)
      else if (data.type === 'sample' && data.id && data.channels) {
        this.bank.put(data.id, { sampleRate: data.sampleRate || sampleRate, channels: data.channels })
      } else if (data.type === 'mics' && data.mics) this.instrument.applyMics(data.mics)
      else if (data.type === 'limit') this.instrument.setVoiceLimit(Number(data.limit) || 32)
      else if (data.type === 'key') this.instrument.setKeyswitch(data.key ?? null)
      else if (data.type === 'note') {
        this.notes.push({ pitch: Number(data.pitch) || 0, vel: Number(data.vel) || 0, time: Number(data.time) || currentTime })
        this.notes.sort((a, b) => a.time - b.time)
      } else if (data.type === 'off') {
        this.notes = []
        this.instrument.silence()
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const frames = out?.[0]?.length ?? 0
    if (!out || !frames) return true
    const start = currentTime
    const end = start + frames / sampleRate
    const due = this.notes.filter((note) => note.time < end + 1 / sampleRate)
    this.notes = this.notes.filter((note) => note.time >= end + 1 / sampleRate)
    due.sort((a, b) => a.time - b.time)
    const left = out[0]
    const right = out[1] ?? left
    let rendered = 0
    const run = (from: number, to: number) => {
      if (to <= from) return
      const block = this.instrument.render(to - from)
      left.set(block[0].subarray(0, to - from), from)
      if (right !== left) right.set(block[1].subarray(0, to - from), from)
    }
    for (const note of due) {
      const at = Math.max(rendered, Math.min(frames, Math.round((note.time - start) * sampleRate)))
      run(rendered, at)
      if (note.vel <= 0) this.instrument.noteOff(note.pitch)
      else this.instrument.noteOn(note.pitch, note.vel)
      rendered = at
    }
    run(rendered, frames)
    return true
  }
}

registerProcessor('cueharbor-library', LibraryProcessor)
