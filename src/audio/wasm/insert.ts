import { descriptor } from '../plugins/catalog'
import type { BlockContext, Processor } from '../plugins/types'
import { WASM_INSERTS } from './codes'
import { dspWasmBytes } from './engine'

interface PlugExports {
  memory: WebAssembly.Memory
  ch_plug_create: (code: number) => number
  ch_plug_destroy: (ptr: number) => void
  ch_plug_prepare: (ptr: number, sampleRate: number, maxBlock: number) => void
  ch_plug_reset: (ptr: number) => void
  ch_plug_set_param: (ptr: number, id: number, value: number) => void
  ch_plug_latency: (ptr: number) => number
  ch_plug_set_transport: (ptr: number, tempo: number, eco: number, offline: number, scaleRoot: number) => void
  ch_plug_set_scale_len: (ptr: number, intervals: number, cents: number) => void
  ch_plug_set_interval: (ptr: number, index: number, interval: number) => void
  ch_plug_set_cents: (ptr: number, index: number, cents: number) => void
  ch_plug_note: (ptr: number, pitch: number, vel: number) => void
  ch_plug_midi: (ptr: number, offset: number, pitch: number, vel: number) => void
  ch_plug_channel_ptr: (ptr: number, channel: number) => number
  ch_plug_process: (ptr: number, channels: number, frames: number, sideFrames: number) => void
}

let shared: PlugExports | null = null

function wasmExports(): PlugExports {
  if (shared) return shared
  const bytes = dspWasmBytes()
  const module = new WebAssembly.Module(bytes)
  const instance = new WebAssembly.Instance(module)
  shared = instance.exports as unknown as PlugExports
  return shared
}

const MAX_BLOCK = 8192

/**
 * One Rust insert. The host chain still owns wet mix, dry-path delay, and
 * sample-offset slicing. This object is the processor those call.
 */
export class WasmInsert implements Processor {
  latencySamples = 0
  private readonly exp: PlugExports
  private readonly ptr: number
  private readonly id: string
  private readonly maxBlock = MAX_BLOCK

  constructor(id: string, sampleRate: number) {
    const code = WASM_INSERTS[id]
    if (code == null) throw new Error(`No Rust insert for ${id}`)
    this.id = id
    this.exp = wasmExports()
    this.ptr = this.exp.ch_plug_create(code)
    this.exp.ch_plug_prepare(this.ptr, sampleRate, this.maxBlock)
  }

  reset() {
    this.exp.ch_plug_reset(this.ptr)
    this.latencySamples = 0
  }

  destroy() {
    this.exp.ch_plug_destroy(this.ptr)
  }

  /** Immediate note, used when the chain has already sliced at the sample offset. */
  note(pitch: number, vel: number) {
    this.exp.ch_plug_note(this.ptr, pitch, vel)
  }

  /** Sample offset inside the block, for a host that does not slice. */
  midi(offset: number, pitch: number, vel: number) {
    this.exp.ch_plug_midi(this.ptr, offset, pitch, vel)
  }

  process(input: Float32Array[], output: Float32Array[], params: Record<string, number>, ctx: BlockContext) {
    const frames = output[0]?.length ?? input[0]?.length ?? 0
    if (!frames) return
    if (frames > this.maxBlock) throw new Error(`Insert block ${frames} exceeds prepared ${this.maxBlock}`)
    const spec = descriptor(this.id)
    if (spec) {
      for (let i = 0; i < spec.params.length; i++) {
        const key = spec.params[i].id
        const value = typeof params[key] === 'number' ? params[key] : spec.params[i].default
        this.exp.ch_plug_set_param(this.ptr, i, value)
      }
    }
    const intervals = ctx.scaleIntervals ?? []
    const cents = ctx.scaleCents ?? []
    const intervalCount = Math.min(24, intervals.length)
    const centCount = Math.min(24, cents.length)
    for (let i = 0; i < intervalCount; i++) this.exp.ch_plug_set_interval(this.ptr, i, intervals[i] || 0)
    for (let i = 0; i < centCount; i++) this.exp.ch_plug_set_cents(this.ptr, i, cents[i] || 0)
    this.exp.ch_plug_set_scale_len(this.ptr, intervalCount, centCount)
    this.exp.ch_plug_set_transport(this.ptr, ctx.tempo || 120, ctx.quality === 'eco' ? 1 : 0, ctx.offline === true ? 1 : 0, ctx.scaleRoot || 0)
    const channels = Math.max(output.length, 1)
    const side = ctx.sidechain
    for (let c = 0; c < 2; c++) {
      const src = input[Math.min(c, Math.max(0, input.length - 1))]
      const view = this.channel(c, frames)
      for (let i = 0; i < frames; i++) view[i] = src?.[i] || 0
    }
    if (side && side.length) {
      const view = this.channel(2, frames)
      const n = Math.min(frames, side.length)
      for (let i = 0; i < n; i++) view[i] = side[i] || 0
      for (let i = n; i < frames; i++) view[i] = 0
    }
    this.exp.ch_plug_process(this.ptr, channels, frames, side && side.length ? frames : 0)
    const outs = Math.max(1, output.length)
    for (let c = 0; c < outs; c++) {
      const view = this.channel(Math.min(c, 1), frames)
      const dst = output[c]
      if (!dst) continue
      const n = Math.min(frames, dst.length)
      for (let i = 0; i < n; i++) dst[i] = view[i]
    }
    this.latencySamples = this.exp.ch_plug_latency(this.ptr)
  }

  private channel(channel: number, frames: number) {
    const address = this.exp.ch_plug_channel_ptr(this.ptr, channel)
    return new Float32Array(this.exp.memory.buffer, address, frames)
  }
}

export function createWasmInsert(id: string, sampleRate: number): WasmInsert {
  return new WasmInsert(id, sampleRate)
}
