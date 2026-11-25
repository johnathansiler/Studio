/**
 * Audio thread for cueharbor-rack.
 * The worklet shell and the bounce both drive this class. Note times are AudioContext seconds.
 */

import { RackRuntime, type SampleBuffer } from './dsp'
import { glideValue } from '../paramCurve'
import type { RackAutomation, RackState } from '../../model/rack'

export type RackMsg =
  | { type: 'note'; pitch: number; vel: number; time: number; slide?: boolean }
  | { type: 'state'; rack: RackState; tempo: number; quality: 'full' | 'eco'; buffers: { id: string; sampleRate: number; data: Float32Array }[] }
  | { type: 'clock'; originTime: number; originBeat: number; tempo: number; lanes: RackAutomation[] }
  | { type: 'off' }
  | { type: 'drop'; pitch: number }

export class CueRackVoice {
  private runtime: RackRuntime
  private rack: RackState | null = null
  private tempo = 120
  private quality: 'full' | 'eco' = 'full'
  private buffers = new Map<string, SampleBuffer>()
  private pending: { pitch: number; vel: number; time: number; slide?: boolean }[] = []
  private lanes: RackAutomation[] = []
  private originTime = 0
  private originBeat = 0
  private smooth = new Map<string, Record<string, number>>()

  constructor(readonly sampleRate: number) {
    this.runtime = new RackRuntime(sampleRate)
  }

  onMessage(data: RackMsg) {
    if (data.type === 'clock') {
      this.originTime = data.originTime
      this.originBeat = data.originBeat
      this.tempo = data.tempo
      this.lanes = data.lanes ?? []
      return
    }
    if (data.type === 'state') {
      this.rack = data.rack
      this.tempo = data.tempo
      this.quality = data.quality
      if (data.buffers.length) {
        this.buffers = new Map(data.buffers.map((item) => [item.id, { sampleRate: item.sampleRate, channels: [item.data] }]))
      }
      return
    }
    if (data.type === 'note') {
      this.pending.push({ pitch: data.pitch, vel: data.vel, time: data.time, slide: data.slide })
      this.pending.sort((a, b) => a.time - b.time || (a.vel === 0 ? -1 : 0) - (b.vel === 0 ? -1 : 0))
      return
    }
    if (data.type === 'off') {
      this.runtime.allOff()
      this.pending = []
      return
    }
    this.pending = this.pending.filter((note) => note.pitch !== data.pitch)
    this.runtime.note(data.pitch, 0, this.rack?.polyphony ?? 8, false)
  }

  /** One quantum. `now` is currentTime at the first sample of this block. */
  process(outputs: Float32Array[], now: number) {
    const left = outputs[0]
    const right = outputs.length > 1 ? outputs[1] : left
    const frames = left?.length ?? 0
    if (!left || !frames) return
    const rack = this.rack
    if (!rack || !right) {
      left?.fill(0)
      right?.fill(0)
      return
    }
    let rendered = 0
    while (rendered < frames) {
      const at = now + rendered / this.sampleRate
      const atSample = Math.round(at * this.sampleRate)
      while (this.pending.length && Math.round(this.pending[0].time * this.sampleRate) <= atSample) {
        const note = this.pending.shift()!
        this.runtime.note(note.pitch, note.vel, rack.polyphony, !!note.slide)
      }
      let until = frames
      if (this.pending.length) {
        const next = Math.round(this.pending[0].time * this.sampleRate) - Math.round(now * this.sampleRate)
        if (next > rendered) until = Math.min(frames, next)
      }
      const span = Math.max(1, Math.min(frames - rendered, until - rendered))
      const beat = this.originBeat + (at - this.originTime) * (this.tempo / 60)
      const block = this.runtime.render(this.glideRack(rack, span), span, this.tempo, this.quality, this.buffers, this.lanes, beat)
      left.set(block[0], rendered)
      if (right !== left) right.set(block[1], rendered)
      rendered += span
    }
  }

  pull(frames: number, quantum = 128) {
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    let offset = 0
    const step = Math.max(1, quantum)
    while (offset < frames) {
      const count = Math.min(step, frames - offset)
      this.process([left.subarray(offset, offset + count), right.subarray(offset, offset + count)], offset / this.sampleRate)
      offset += count
    }
    return [left, right]
  }

  private glideRack(rack: RackState, frames: number): RackState {
    let changed = false
    const devices = rack.devices.map((device) => {
      const prev = this.smooth.get(device.id)
      const next: Record<string, number> = {}
      for (const [key, value] of Object.entries(device.params)) {
        const from = prev && typeof prev[key] === 'number' ? prev[key] : value
        next[key] = glideValue(from, value, frames, this.sampleRate)
        if (Math.abs(next[key] - value) > 1e-4) changed = true
      }
      this.smooth.set(device.id, next)
      if (!prev) return device
      return { ...device, params: next }
    })
    return changed || devices.some((device, index) => device !== rack.devices[index]) ? { ...rack, devices } : rack
  }
}
