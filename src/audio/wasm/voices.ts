import type { Processor, BlockContext } from '../plugins/types'
import type { PluginInstance } from '../../model/types'
import { loadDspWasmBytes } from './engine'
import {
  createSamplePool,
  registerWasmPool,
  type PitchMode,
  type SamplePool,
  type VintageStage,
} from '../voices/engine'

interface VoiceExports {
  memory: WebAssembly.Memory
  ch_voice_create: (sampleRate: number) => number
  ch_voice_destroy: (ptr: number) => void
  ch_voice_prepare: (ptr: number, sampleRate: number, maxBlock: number) => void
  ch_voice_reset: (ptr: number) => void
  ch_voice_load_ptr: (ptr: number, len: number) => number
  ch_voice_load: (ptr: number, id: number, len: number, fileRate: number) => void
  ch_voice_set_region: (ptr: number, pad: number, sampleId: number, start: number, end: number) => void
  ch_voice_set_fade: (ptr: number, pad: number, fadeIn: number, fadeOut: number) => void
  ch_voice_set_pitch: (ptr: number, pad: number, semis: number, cents: number, stretch: number) => void
  ch_voice_set_vintage: (ptr: number, pad: number, bitDepth: number, sampleRate: number, wow: number, flutter: number, noise: number, crackle: number, lowpass: number) => void
  ch_voice_set_filter: (ptr: number, pad: number, highpass: number, lowpass: number) => void
  ch_voice_set_choke: (ptr: number, pad: number, group: number) => void
  ch_voice_set_reverse: (ptr: number, pad: number, on: number) => void
  ch_voice_set_hold: (ptr: number, pad: number, on: number) => void
  ch_voice_set_swing: (ptr: number, pad: number, samples: number) => void
  ch_voice_set_level: (ptr: number, pad: number, level: number, pan: number) => void
  ch_voice_note: (ptr: number, offset: number, pad: number, velocity: number) => void
  ch_voice_channel_ptr: (ptr: number, channel: number) => number
  ch_voice_process: (ptr: number, frames: number) => void
}

let wasm: VoiceExports | null = null

export async function preloadVoices() {
  if (wasm) return
  const bytes = await loadDspWasmBytes()
  const module = await WebAssembly.compile(bytes)
  const instance = await WebAssembly.instantiate(module)
  wasm = instance.exports as unknown as VoiceExports
  registerWasmPool((sampleRate) => new WasmPool(wasm!, sampleRate) as unknown as SamplePool)
}

class WasmPad {
  constructor(private readonly pool: WasmPool, private readonly index: number) {}

  setRegion(sampleId: number, start: number, end: number) {
    this.pool.exp.ch_voice_set_region(this.pool.ptr, this.index, sampleId, start | 0, end | 0)
  }

  setFade(fadeIn: number, fadeOut: number) {
    this.pool.exp.ch_voice_set_fade(this.pool.ptr, this.index, fadeIn | 0, fadeOut | 0)
  }

  setPitch(semis: number, cents: number, mode: PitchMode) {
    this.pool.exp.ch_voice_set_pitch(this.pool.ptr, this.index, semis, cents, mode === 'stretch' ? 1 : 0)
  }

  setVintage(stage: VintageStage) {
    this.pool.exp.ch_voice_set_vintage(
      this.pool.ptr, this.index,
      stage.bitDepth ?? 0, stage.sampleRate ?? 0, stage.wow ?? 0, stage.flutter ?? 0,
      stage.noise ?? 0, stage.crackle ?? 0, stage.lowpass ?? 0,
    )
  }

  setFilter(highpass: number, lowpass: number) {
    this.pool.exp.ch_voice_set_filter(this.pool.ptr, this.index, highpass, lowpass)
  }

  setChokeGroup(group: number) {
    this.pool.exp.ch_voice_set_choke(this.pool.ptr, this.index, group | 0)
  }

  setReverse(on: boolean) {
    this.pool.exp.ch_voice_set_reverse(this.pool.ptr, this.index, on ? 1 : 0)
  }

  setHold(on: boolean) {
    this.pool.exp.ch_voice_set_hold(this.pool.ptr, this.index, on ? 1 : 0)
  }

  setSwing(samples: number) {
    this.pool.exp.ch_voice_set_swing(this.pool.ptr, this.index, Math.max(0, samples | 0))
  }

  setLevel(level: number, pan: number) {
    this.pool.exp.ch_voice_set_level(this.pool.ptr, this.index, level, pan)
  }
}

class WasmPool {
  readonly ptr: number
  constructor(readonly exp: VoiceExports, private readonly rate: number) {
    this.ptr = exp.ch_voice_create(rate)
    exp.ch_voice_prepare(this.ptr, rate, 8192)
  }

  load(id: number, data: Float32Array, fileRate = this.rate) {
    const ptr = this.exp.ch_voice_load_ptr(this.ptr, data.length)
    new Float32Array(this.exp.memory.buffer, ptr, data.length).set(data)
    this.exp.ch_voice_load(this.ptr, id, data.length, fileRate)
  }

  pad(index: number) {
    return new WasmPad(this, index)
  }

  note(offset: number, pad: number, velocity: number) {
    this.exp.ch_voice_note(this.ptr, offset | 0, pad, velocity)
  }

  process(left: Float32Array, right: Float32Array) {
    const frames = Math.min(left.length, right.length, 8192)
    this.exp.ch_voice_process(this.ptr, frames)
    const l = this.exp.ch_voice_channel_ptr(this.ptr, 0)
    const r = this.exp.ch_voice_channel_ptr(this.ptr, 1)
    left.set(new Float32Array(this.exp.memory.buffer, l, frames))
    right.set(new Float32Array(this.exp.memory.buffer, r, frames))
  }

  reset() {
    this.exp.ch_voice_reset(this.ptr)
  }
}

interface Scheduled {
  time: number
  pitch: number
  vel: number
}

/** Sampler insert backed by the pad pool. Stretch of a whole file stays on the host. */
export function createWasmSampler(sampleRate: number): Processor & {
  bind: (plugin: PluginInstance, channel: (id: string) => Float32Array | null) => void
  note: (pitch: number, vel: number) => void
  schedule: (pitch: number, vel: number, time: number) => void
  sounding: () => number
} {
  const pool = createSamplePool(sampleRate)
  const pending: Scheduled[] = []
  let root = 60
  let active = 0
  return {
    latencySamples: 0,
    reset() {
      pool.reset()
      pending.length = 0
      active = 0
    },
    bind(plugin, channel) {
      const state = plugin.sampler
      if (!state?.bufferId) return
      const buffer = channel(state.bufferId)
      if (!buffer || buffer.length < 2) return
      pool.load(1, buffer, state.sourceRate || sampleRate)
      const start = Math.floor(Math.max(0, Math.min(1, state.start ?? 0)) * buffer.length)
      const end = Math.max(start + 2, Math.floor(Math.max(0, Math.min(1, state.end ?? 1)) * buffer.length))
      const pad = pool.pad(0)
      pad.setRegion(1, start, Math.min(buffer.length, end))
      pad.setPitch(0, 0, 'vinyl')
      pad.setHold(false)
      root = state.root || 60
    },
    note(pitch, vel) {
      const pad = pool.pad(0)
      pad.setPitch(Math.round(pitch) - root, 0, 'vinyl')
      pool.note(0, 0, vel)
      if (vel > 0.0001) active = 1
    },
    schedule(pitch, vel, time) {
      if (!Number.isFinite(time)) {
        this.note(pitch, vel)
        return
      }
      pending.push({ time, pitch, vel })
      pending.sort((a, b) => a.time - b.time)
    },
    sounding: () => active,
    process(_input, output, _params, ctx: BlockContext) {
      const frames = output[0]?.length ?? 0
      const play = ctx.playTime
      if (play != null && pending.length) {
        const end = play + frames / sampleRate
        while (pending.length && pending[0].time <= end + 1e-6) {
          const event = pending.shift()!
          const offset = Math.max(0, Math.min(Math.max(0, frames - 1), Math.round((event.time - play) * sampleRate)))
          pool.pad(0).setPitch(Math.round(event.pitch) - root, 0, 'vinyl')
          pool.note(offset, 0, event.vel)
        }
      }
      const left = output[0] ?? new Float32Array(frames)
      const right = output[1] ?? left
      pool.process(left, right)
      if (output[0] && output[0] !== left) output[0].set(left)
      if (output[1] && output[1] !== right) output[1].set(right)
    },
  }
}
