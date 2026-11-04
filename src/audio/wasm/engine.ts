import { DSP_WASM_BASE64 } from './dspBytes'

export interface WasmLayoutControl {
  paramId: number
  key: string
  name: string
  min: number
  max: number
  defaultValue: number
  unit: string
  automatable: boolean
}

export interface WasmLayout {
  id: string
  name: string
  version: string
  controls: WasmLayoutControl[]
}

interface WasmExports {
  memory: WebAssembly.Memory
  ch_eq_create: () => number
  ch_eq_destroy: (ptr: number) => void
  ch_eq_prepare: (ptr: number, sampleRate: number, maxBlock: number) => void
  ch_eq_release: (ptr: number) => void
  ch_eq_reset: (ptr: number) => void
  ch_eq_set_parameter: (ptr: number, id: number, value: number) => void
  ch_eq_get_parameter: (ptr: number, id: number) => number
  ch_eq_num_parameters: (ptr: number) => number
  ch_eq_latency: (ptr: number) => number
  ch_eq_process: (ptr: number, channels: number, frames: number) => void
  ch_eq_channel_ptr: (ptr: number, channel: number) => number
  ch_eq_state_ptr: (ptr: number) => number
  ch_eq_get_state: (ptr: number) => number
  ch_eq_set_state: (ptr: number, len: number) => number
  ch_eq_layout: (ptr: number) => number
  ch_glide_block: (from: number, to: number, frames: number, rate: number) => number
}

const STATE_CAP = 16384

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** AudioWorklet has no `atob`. This is the same alphabet Node and browsers use. */
export function dspWasmBytes(): Uint8Array<ArrayBuffer> {
  const input = DSP_WASM_BASE64
  const table = new Uint8Array(128)
  for (let i = 0; i < BASE64.length; i++) table[BASE64.charCodeAt(i)] = i
  const padding = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0
  const length = (input.length >> 2) * 3 - padding
  const buffer = new ArrayBuffer(length)
  const bytes = new Uint8Array(buffer)
  let out = 0
  for (let i = 0; i < input.length; i += 4) {
    const a = table[input.charCodeAt(i)]
    const b = table[input.charCodeAt(i + 1)]
    const c = input[i + 2] === '=' ? 0 : table[input.charCodeAt(i + 2)]
    const d = input[i + 3] === '=' ? 0 : table[input.charCodeAt(i + 3)]
    const chunk = (a << 18) | (b << 12) | (c << 6) | d
    bytes[out++] = (chunk >>> 16) & 255
    if (input[i + 2] !== '=' && out < length) bytes[out++] = (chunk >>> 8) & 255
    if (input[i + 3] !== '=' && out < length) bytes[out++] = chunk & 255
  }
  return bytes
}

/** One EQ instance backed by the shared Rust core. */
export class WasmEq {
  private readonly exp: WasmExports
  private readonly ptr: number
  private maxBlock = 0

  private constructor(exp: WasmExports, ptr: number) {
    this.exp = exp
    this.ptr = ptr
  }

  static async create(): Promise<WasmEq> {
    const module = await WebAssembly.compile(dspWasmBytes())
    const instance = await WebAssembly.instantiate(module)
    const exp = instance.exports as unknown as WasmExports
    return new WasmEq(exp, exp.ch_eq_create())
  }

  prepare(sampleRate: number, maxBlock: number) {
    this.maxBlock = maxBlock
    this.exp.ch_eq_prepare(this.ptr, sampleRate, maxBlock)
  }

  release() {
    this.exp.ch_eq_release(this.ptr)
  }

  reset() {
    this.exp.ch_eq_reset(this.ptr)
  }

  destroy() {
    this.exp.ch_eq_destroy(this.ptr)
  }

  setParameter(id: number, value: number) {
    this.exp.ch_eq_set_parameter(this.ptr, id, value)
  }

  getParameter(id: number): number {
    return this.exp.ch_eq_get_parameter(this.ptr, id)
  }

  numParameters(): number {
    return this.exp.ch_eq_num_parameters(this.ptr)
  }

  latency(): number {
    return this.exp.ch_eq_latency(this.ptr)
  }

  /** Snap the smoother onto the current targets. A settled knob then matches one direct process call. */
  settle() {
    this.setState(this.getState())
  }

  glide(from: number, to: number, frames: number, rate: number): number {
    return this.exp.ch_glide_block(from, to, frames, rate)
  }

  getState(): Uint8Array {
    const length = this.exp.ch_eq_get_state(this.ptr)
    return this.stateBytes(length).slice()
  }

  setState(data: Uint8Array): boolean {
    if (data.byteLength > STATE_CAP) return false
    this.stateBytes(data.byteLength).set(data)
    return this.exp.ch_eq_set_state(this.ptr, data.byteLength) === 1
  }

  layout(): WasmLayout {
    const length = this.exp.ch_eq_layout(this.ptr)
    const text = new TextDecoder().decode(this.stateBytes(length))
    return JSON.parse(text) as WasmLayout
  }

  /**
   * Process one block no longer than `prepare`'s max size.
   * Input channel 1 falls back to channel 0, matching the TypeScript EQ.
   */
  processBlock(input: ArrayLike<ArrayLike<number> | undefined>, output: Float32Array[]) {
    const frames = output[0]?.length ?? 0
    if (!frames) return
    if (frames > this.maxBlock) throw new Error(`EQ block ${frames} exceeds prepared ${this.maxBlock}`)
    const channels = Math.min(2, output.length)
    const available = input.length
    for (let c = 0; c < channels; c++) {
      const src = input[Math.min(c, Math.max(0, available - 1))]
      const view = this.channel(c, frames)
      for (let i = 0; i < frames; i++) view[i] = src?.[i] || 0
    }
    this.exp.ch_eq_process(this.ptr, channels, frames)
    for (let c = 0; c < channels; c++) {
      const view = this.channel(c, frames)
      const dst = output[c]
      for (let i = 0; i < frames; i++) dst[i] = view[i]
    }
  }

  /** Chunk a longer buffer into the prepared block size. Used by the AudioWorklet. */
  processArrays(input: ArrayLike<Float32Array | undefined>, output: Float32Array[]) {
    const total = output[0]?.length ?? 0
    if (!total || !this.maxBlock) return
    const channels = Math.min(2, output.length)
    const available = input.length
    for (let offset = 0; offset < total; offset += this.maxBlock) {
      const frames = Math.min(this.maxBlock, total - offset)
      for (let c = 0; c < channels; c++) {
        const src = available ? input[Math.min(c, available - 1)] : undefined
        const view = this.channel(c, frames)
        if (src) {
          for (let i = 0; i < frames; i++) view[i] = src[offset + i] || 0
        } else {
          view.fill(0)
        }
      }
      this.exp.ch_eq_process(this.ptr, channels, frames)
      for (let c = 0; c < channels; c++) {
        const view = this.channel(c, frames)
        const dst = output[c]
        for (let i = 0; i < frames; i++) dst[offset + i] = view[i]
      }
    }
  }

  private channel(channel: number, frames: number) {
    const address = this.exp.ch_eq_channel_ptr(this.ptr, channel)
    return new Float32Array(this.exp.memory.buffer, address, frames)
  }

  private stateBytes(length: number) {
    const address = this.exp.ch_eq_state_ptr(this.ptr)
    return new Uint8Array(this.exp.memory.buffer, address, length)
  }
}
