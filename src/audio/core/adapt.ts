import { ParamSmoother } from './smooth'
import type { AudioBlock, ControlLayout, MidiBlock, NativePlugin, PluginLayout } from './contract'
import { EMPTY_MIDI } from './contract'
import type { BlockContext, ParamSpec, Processor } from '../plugins/types'

const STATE_VERSION = 1
const MAX_PREPARED = 2048

export interface AdaptOptions {
  id: string
  name: string
  version: string
  params: ParamSpec[]
  create: (sampleRate: number) => Processor
  latency?: (params: Record<string, number>, sampleRate: number) => number
  /** Called with note number and velocity 0–1. Existing instruments already speak this. */
  note?: (proc: Processor, pitch: number, velocity: number) => void
}

interface Views {
  input: Float32Array[]
}

/**
 * Wraps an existing processor. The DSP stays where it is.
 * `processBlock` smooths with one block step, then calls `process` once,
 * so a settled knob matches the processor called directly.
 */
export function adaptProcessor(options: AdaptOptions): NativePlugin {
  let sampleRate = 48000
  let maxBlock = 128
  let inner: Processor | null = null
  let prepared = false
  const keys = options.params.map((item) => item.id)
  const specs = options.params
  const target: Record<string, number> = {}
  const smoothed: Record<string, number> = {}
  const smoother = new ParamSmoother()
  const input: Float32Array[] = [new Float32Array(MAX_PREPARED), new Float32Array(MAX_PREPARED)]
  const views = new Map<number, Views>()
  const ctx: BlockContext = {
    sampleRate,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full',
  }
  for (let i = 0; i < specs.length; i++) {
    target[keys[i]] = specs[i].default
    smoothed[keys[i]] = specs[i].default
  }

  function layout(): PluginLayout {
    return {
      id: options.id,
      name: options.name,
      version: options.version,
      controls: specs.map((spec, index): ControlLayout => ({
        paramId: index,
        key: spec.id,
        name: spec.name,
        min: spec.min,
        max: spec.max,
        defaultValue: spec.default,
        unit: spec.unit,
        automatable: spec.automatable,
      })),
    }
  }

  function viewsFor(frames: number) {
    let hit = views.get(frames)
    if (!hit) {
      hit = { input: [input[0].subarray(0, frames), input[1].subarray(0, frames)] }
      views.set(frames, hit)
    }
    return hit
  }

  function snapAll() {
    for (let i = 0; i < keys.length; i++) {
      smoother.snap(i, target[keys[i]] ?? 0)
      smoothed[keys[i]] = target[keys[i]] ?? 0
    }
  }

  const plugin: NativePlugin = {
    prepare(rate, block) {
      sampleRate = rate > 0 ? rate : 48000
      maxBlock = Math.max(1, Math.min(MAX_PREPARED, block || 128))
      ctx.sampleRate = sampleRate
      smoother.prepare(keys.length, sampleRate)
      snapAll()
      inner = options.create(sampleRate)
      prepared = true
      views.clear()
      viewsFor(maxBlock)
      viewsFor(128)
      viewsFor(256)
    },
    release() {
      prepared = false
      inner = null
    },
    reset() {
      inner?.reset()
      snapAll()
    },
    processBlock(audio: AudioBlock, midi: MidiBlock = EMPTY_MIDI) {
      if (!prepared || !inner) return
      const frames = Math.max(0, Math.min(audio.numSamples, input[0].length, audio.channels[0]?.length ?? 0))
      if (!frames) return
      dispatchNotes(inner, midi, options.note)
      const view = viewsFor(frames)
      const channels = Math.max(1, Math.min(audio.numChannels, audio.channels.length, 2))
      for (let c = 0; c < channels; c++) {
        const src = audio.channels[c]
        const dst = view.input[c]
        for (let i = 0; i < frames; i++) dst[i] = src?.[i] || 0
      }
      if (channels < 2) {
        const dst = view.input[1]
        const src = view.input[0]
        for (let i = 0; i < frames; i++) dst[i] = src[i]
      }
      for (let i = 0; i < keys.length; i++) smoothed[keys[i]] = smoother.nextBlock(i, frames)
      const output = audio.channels
      inner.process(view.input, output, smoothed, ctx)
    },
    setParameter(paramId, value) {
      if (paramId < 0 || paramId >= keys.length) return
      const next = Number.isFinite(value) ? value : 0
      target[keys[paramId]] = next
      smoother.setTarget(paramId, next)
    },
    getParameter(paramId) {
      if (paramId < 0 || paramId >= keys.length) return 0
      return target[keys[paramId]] ?? 0
    },
    getNumParameters() {
      return keys.length
    },
    getLatencyInSamples() {
      const reported = inner?.latencySamples ?? 0
      const declared = options.latency?.(target, sampleRate) ?? 0
      return Math.max(0, reported, declared)
    },
    getState() {
      return encodeState(target)
    },
    setState(data) {
      const parsed = decodeState(data)
      if (!parsed) return
      for (const key of Object.keys(parsed)) {
        const index = keys.indexOf(key)
        if (index < 0) continue
        target[key] = parsed[key]
        smoother.snap(index, parsed[key])
        smoothed[key] = parsed[key]
      }
    },
    layout,
  }
  return plugin
}

/** Step Sequencer has no insert DSP. Patterns stay on the project. This adapter is the portable shell. */
export function adaptSequencer(layout: PluginLayout): NativePlugin {
  const keys = layout.controls.map((control) => control.key)
  const target: Record<string, number> = {}
  for (const control of layout.controls) target[control.key] = control.defaultValue
  let alive = false
  return {
    prepare() {
      alive = true
    },
    release() {
      alive = false
    },
    reset() {},
    processBlock(audio) {
      if (!alive) return
      const frames = audio.numSamples
      const left = audio.channels[0]
      const right = audio.channels[1] ?? left
      if (!left) return
      for (let i = 0; i < frames; i++) {
        const sample = left[i] || 0
        left[i] = sample
        if (right && right !== left) right[i] = right[i] || 0
      }
    },
    setParameter(paramId, value) {
      if (paramId < 0 || paramId >= keys.length) return
      target[keys[paramId]] = Number.isFinite(value) ? value : 0
    },
    getParameter(paramId) {
      if (paramId < 0 || paramId >= keys.length) return 0
      return target[keys[paramId]] ?? 0
    },
    getNumParameters() {
      return keys.length
    },
    getLatencyInSamples() {
      return 0
    },
    getState() {
      return encodeState(target)
    },
    setState(data) {
      const parsed = decodeState(data)
      if (!parsed) return
      for (const key of keys) if (typeof parsed[key] === 'number') target[key] = parsed[key]
    },
    layout() {
      return layout
    },
  }
}

/** Run one silent block so delay lines exist before the real render loop, then clear state. */
export function primeProcessor(proc: Processor, sampleRate: number, frames: number) {
  const n = Math.max(1, frames | 0)
  const input = [new Float32Array(n), new Float32Array(n)]
  const output = [new Float32Array(n), new Float32Array(n)]
  const ctx: BlockContext = {
    sampleRate: sampleRate > 0 ? sampleRate : 48000,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full',
  }
  try {
    proc.process(input, output, {}, ctx)
  } catch {
    /* The slot reports itself on the next real block. */
  }
  try {
    proc.reset()
  } catch {
    /* Reset is best-effort after a prime. */
  }
}

function dispatchNotes(
  proc: Processor,
  midi: MidiBlock,
  note?: (proc: Processor, pitch: number, velocity: number) => void,
) {
  if (!note || midi.numEvents <= 0) return
  const events = midi.events
  const count = Math.min(midi.numEvents, events.length)
  for (let i = 0; i < count; i++) {
    const event = events[i]
    const status = event.status & 0xf0
    if (status !== 0x90 && status !== 0x80) continue
    const velocity = status === 0x80 || event.data2 === 0 ? 0 : Math.max(0, Math.min(1, event.data2 / 127))
    note(proc, event.data1, velocity)
  }
}

function encodeState(params: Record<string, number>) {
  const json = JSON.stringify({ v: STATE_VERSION, params })
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json)
  const bytes = new Uint8Array(json.length)
  for (let i = 0; i < json.length; i++) bytes[i] = json.charCodeAt(i) & 0xff
  return bytes
}

function decodeState(data: Uint8Array): Record<string, number> | null {
  try {
    const json = typeof TextDecoder !== 'undefined'
      ? new TextDecoder().decode(data)
      : String.fromCharCode(...data)
    const parsed = JSON.parse(json) as { v?: number; params?: Record<string, number> }
    if (!parsed || parsed.v !== STATE_VERSION || !parsed.params) return null
    return parsed.params
  } catch {
    return null
  }
}
