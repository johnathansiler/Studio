/** Sample-accurate pad graph. A hit at the start of a block speaks in that block. */

import { createSamplePool, SamplePool, wasmPoolReady, type PitchMode } from './engine'
import { applySlots, hitVoice, loadPlan, type PadPlan, type PoolLike, type SlotPlan } from './program'

export const PAD_LATENCY_SAMPLES = 0

export interface ScheduledHit {
  time: number
  pad: number
  velocity: number
  semis: number
  cents: number
  mode: PitchMode
  highpass: number
  lowpass: number
}

/** Offset of a hit inside this block. Late hits still speak now. Future hits wait. */
export function noteOffset(hitTime: number, blockTime: number, frames: number, sampleRate: number) {
  if (!(frames > 0) || !(sampleRate > 0) || !Number.isFinite(hitTime) || !Number.isFinite(blockTime)) return null
  const offset = Math.round((hitTime - blockTime) * sampleRate)
  if (offset >= frames) return null
  return offset < 0 ? 0 : offset
}

export class PadGraph {
  readonly latencySamples = PAD_LATENCY_SAMPLES
  private pool: PoolLike
  private readonly rate: number
  private slots = new Map<number, SlotPlan>()
  private pending: ScheduledHit[] = []
  private plan: PadPlan | null = null
  private sampleSig = ''
  private upgraded = false
  private wasmAllowed: boolean

  constructor(sampleRate: number, pool?: PoolLike, options?: { wasm?: boolean }) {
    this.rate = sampleRate > 0 ? sampleRate : 48000
    this.pool = pool ?? new SamplePool(this.rate)
    this.wasmAllowed = options?.wasm ?? false
    this.upgraded = !this.wasmAllowed
  }

  get usesRust() {
    return !(this.pool instanceof SamplePool)
  }

  arm(plan: PadPlan) {
    this.plan = plan
    const sig = plan.samples.map((sample) => `${sample.key}:${sample.samples.length}:${sample.sampleRate}`).join(',')
    if (sig !== this.sampleSig) {
      loadPlan(this.pool, plan)
      this.sampleSig = sig
    }
    applySlots(this.pool, plan)
    this.slots = new Map(plan.slots.map((slot) => [slot.pitch, slot]))
  }

  hit(pitch: number, velocity: number, time: number, color?: { tune?: number; filter?: number }) {
    const slot = this.slots.get(pitch)
    if (!slot || slot.loop || slot.busId) return false
    const voice = hitVoice(slot, color)
    const event: ScheduledHit = {
      time,
      pad: slot.slot,
      velocity,
      semis: voice.semis,
      cents: voice.cents,
      mode: voice.mode,
      highpass: voice.highpass,
      lowpass: voice.lowpass,
    }
    let at = this.pending.length
    this.pending.push(event)
    while (at > 0 && this.pending[at - 1].time > event.time) {
      this.pending[at] = this.pending[at - 1]
      at -= 1
    }
    this.pending[at] = event
    return true
  }

  release(pitch: number, time: number) {
    if (!this.slots.has(pitch)) return
    this.hit(pitch, 0, time)
  }

  cancel(pitch: number, afterTime: number) {
    const slot = this.slots.get(pitch)
    if (!slot) return
    this.pending = this.pending.filter((event) => event.pad !== slot.slot || event.time < afterTime - 1e-4)
  }

  renderInto(blockTime: number, left: Float32Array, right: Float32Array) {
    this.maybeUpgrade()
    const frames = Math.min(left.length, right.length)
    const chunk = 128
    for (let offset = 0; offset < frames; offset += chunk) {
      const count = Math.min(chunk, frames - offset)
      this.fireDue(blockTime + offset / this.rate, count)
      this.pool.process(left.subarray(offset, offset + count), right.subarray(offset, offset + count))
    }
  }

  private fireDue(blockTime: number, frames: number) {
    if (!this.pending.length) return
    const keep: ScheduledHit[] = []
    const due: { event: ScheduledHit; offset: number }[] = []
    for (const event of this.pending) {
      const offset = noteOffset(event.time, blockTime, frames, this.rate)
      if (offset == null) keep.push(event)
      else due.push({ event, offset })
    }
    this.pending = keep
    for (const item of due) {
      const pad = this.pool.pad(item.event.pad)
      pad.setPitch(item.event.semis, item.event.cents, item.event.mode)
      pad.setFilter(item.event.highpass, item.event.lowpass)
      this.pool.note(item.offset, item.event.pad, item.event.velocity)
    }
  }

  private maybeUpgrade() {
    if (this.upgraded || !this.wasmAllowed || !wasmPoolReady()) return
    const next = createSamplePool(this.rate)
    this.upgraded = true
    if (next instanceof SamplePool) return
    this.pool = next
    this.sampleSig = ''
    if (this.plan) this.arm(this.plan)
  }
}
