import { processChain, type ChainSlot } from './plugins/chain'
import { processSampleAccurate } from './automationRender'
import { createProcessor } from './plugins/createAll'
import { projectSampleBeat } from '../model/tempoMap'
import { valueChanges } from '../model/automation'
import { automationAt } from './plugins/catalog'
import { transparentLimit } from './liveStage'
import type { AutomationLane, PluginInstance, TempoPoint } from '../model/types'
import type { Processor } from './plugins/types'

declare const sampleRate: number
declare const currentTime: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void

interface SlotMsg {
  id: string
  pluginId: string
  enabled: boolean
  wet: number
  params: Record<string, number>
  sidechain: string
  sampler?: PluginInstance['sampler']
}

interface StateMsg {
  type: 'state'
  slots: SlotMsg[]
  automation: AutomationLane[]
  tempo: number
  projectRate: number
  tempoMap: TempoPoint[]
  scaleRoot: number
  scaleIntervals: number[]
  scaleCents?: number[]
  quality: 'full' | 'eco'
  playing: boolean
  originTime: number
  originSample: number
}

type LiveProc = Processor & {
  note?: (pitch: number, vel: number) => void
  schedule?: (pitch: number, vel: number, time: number) => void
  bind?: (plugin: PluginInstance, channel: (id: string) => Float32Array | null) => void
  kept?: () => Float32Array | null
}

class InsertProcessor extends AudioWorkletProcessor {
  private slots: SlotMsg[] = []
  private procs = new Map<string, LiveProc>()
  private failed = new Set<string>()
  private buffers = new Map<string, Float32Array>()
  private keys = new Map<string, Float32Array>()
  private automation: AutomationLane[] = []
  private tempo = 120
  private projectRate = 48000
  private tempoMap: TempoPoint[] = []
  private scaleRoot = 0
  private scaleIntervals: number[] = [0, 2, 4, 5, 7, 9, 11]
  private scaleCents: number[] | undefined
  private quality: 'full' | 'eco' = 'full'
  private playing = false
  private originTime = 0
  private originSample = 0
  private posts = 0
  private held = new Map<string, Record<string, number>>()

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<StateMsg | { type: string; [key: string]: unknown }>) => {
      this.onMessage(event.data)
    }
  }

  private onMessage(data: StateMsg | { type?: string; [key: string]: unknown }) {
    if (!data?.type) return
    if (data.type === 'state') {
      const msg = data as unknown as StateMsg
      this.slots = msg.slots || []
      this.automation = msg.automation || []
      this.tempo = msg.tempo || 120
      this.projectRate = msg.projectRate || sampleRate
      this.tempoMap = msg.tempoMap || []
      this.scaleRoot = msg.scaleRoot || 0
      this.scaleIntervals = msg.scaleIntervals?.length ? msg.scaleIntervals : this.scaleIntervals
      this.scaleCents = msg.scaleCents
      this.quality = msg.quality === 'eco' ? 'eco' : 'full'
      this.playing = !!msg.playing
      this.originTime = msg.originTime || 0
      this.originSample = msg.originSample || 0
      this.ensureProcs()
      return
    }
    if (data.type === 'clock') {
      this.playing = !!data.playing
      this.originTime = Number(data.originTime) || 0
      this.originSample = Number(data.originSample) || 0
      this.tempo = Number(data.tempo) || this.tempo
      return
    }
    if (data.type === 'buffer' && typeof data.id === 'string' && data.channel instanceof Float32Array) {
      this.buffers.set(data.id, data.channel)
      return
    }
    if (data.type === 'key' && typeof data.id === 'string' && data.channel instanceof Float32Array) {
      this.keys.set(data.id, data.channel)
      return
    }
    if (data.type === 'note' && typeof data.id === 'string') {
      const proc = this.procs.get(data.id)
      const pitch = Number(data.pitch) || 0
      const vel = Number(data.vel) || 0
      const time = Number(data.time)
      if (proc?.schedule && Number.isFinite(time)) proc.schedule(pitch, vel, time)
      else proc?.note?.(pitch, vel)
      return
    }
    if (data.type === 'reset' && typeof data.id === 'string') {
      this.procs.get(data.id)?.reset()
    }
  }

  private ensureProcs() {
    const live = new Set(this.slots.map((slot) => slot.id))
    for (const id of [...this.procs.keys()]) {
      if (live.has(id)) continue
      this.procs.delete(id)
      this.failed.delete(id)
    }
    for (const slot of this.slots) {
      if (this.procs.has(slot.id) || this.failed.has(slot.id)) {
        this.bind(slot)
        continue
      }
      const proc = createProcessor(slot.pluginId, sampleRate) as LiveProc | null
      if (!proc) {
        this.failed.add(slot.id)
        continue
      }
      this.procs.set(slot.id, proc)
      this.bind(slot)
    }
  }

  private bind(slot: SlotMsg) {
    const proc = this.procs.get(slot.id)
    proc?.bind?.({
      id: slot.id,
      pluginId: slot.pluginId,
      version: '1',
      enabled: slot.enabled,
      wet: slot.wet,
      params: slot.params,
      sidechain: slot.sidechain,
      sampler: slot.sampler,
    } as PluginInstance, (id) => this.buffers.get(id) ?? null)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0]
    const frames = output?.[0]?.length ?? 0
    if (!output || !frames) return true
    const input = inputs[0]
    const left = input?.[0] ?? new Float32Array(frames)
    const rightIn = input?.[1] ?? left
    const inputChannels = [Float32Array.from(left.subarray(0, frames)), Float32Array.from(rightIn.subarray(0, frames))]
    const right = output[1] ?? output[0]
    const outputChannels = [output[0], right]
    const sampleTime = this.playing
      ? this.originSample + (currentTime - this.originTime) * sampleRate
      : this.originSample
    const project = { tempo: this.tempo, tempoMap: this.tempoMap, automation: this.automation, sampleRate: this.projectRate }
    const beatAt = (sample: number) => projectSampleBeat(project, sample)
    const beat = beatAt(sampleTime)
    for (const slot of this.slots) this.bind(slot)
    const chain: ChainSlot[] = this.slots.map((slot) => ({
      id: slot.id,
      pluginId: slot.pluginId,
      enabled: slot.enabled,
      wet: slot.wet,
      params: { ...slot.params },
      failed: this.failed.has(slot.id),
      sidechain: slot.sidechain,
      processor: this.procs.get(slot.id) ?? null,
    }))
    const ctx = {
      sampleRate,
      tempo: this.tempo,
      sampleTime,
      sidechain: null,
      scaleRoot: this.scaleRoot,
      scaleIntervals: this.scaleIntervals,
      scaleCents: this.scaleCents,
      quality: this.quality,
      offline: false,
      playTime: currentTime,
    }
    const keyAt = (id: string, length: number) => {
      const buf = this.keys.get(id)
      if (!buf?.length) return null
      return buf.subarray(0, Math.min(buf.length, length))
    }
    const endBeat = beatAt(sampleTime + Math.max(0, frames - 1))
    const moving = this.automation.some((lane) => (lane.target == null || lane.target === 'plugin') && chain.some((slot) => slot.id === lane.pluginId) && valueChanges(lane.points, beat, endBeat, 0))
    if (moving) processSampleAccurate(chain, inputChannels, outputChannels, ctx, this.automation, keyAt, beatAt)
    else {
      for (const slot of chain) slot.params = this.glide(slot.id, automationAt(this.automation, slot.id, slot.params, beat), frames)
      processChain(chain, inputChannels, outputChannels, ctx, keyAt)
    }
    const outL = output[0]
    const outR = output[1]
    for (let i = 0; i < frames; i++) {
      outL[i] = transparentLimit(outL[i] || 0)
      if (outR && outR !== outL) outR[i] = transparentLimit(outR[i] || 0)
    }
    this.posts += 1
    if (this.posts % 16 === 0) this.postMeters(chain)
    return true
  }

  /** Approach the posted value over about 10 ms so a knob does not click. */
  private glide(id: string, params: Record<string, number>, frames: number) {
    const prev = this.held.get(id)
    const next = { ...params }
    if (!prev) {
      this.held.set(id, { ...next })
      return next
    }
    const alpha = Math.min(1, frames / Math.max(1, 0.01 * sampleRate))
    for (const key of Object.keys(next)) {
      const from = typeof prev[key] === 'number' ? prev[key] : next[key]
      const value = from + ((next[key] ?? from) - from) * alpha
      next[key] = value
      prev[key] = value
    }
    for (const key of Object.keys(prev)) if (!(key in next)) delete prev[key]
    return next
  }

  private postMeters(chain: ChainSlot[]) {
    const rows = chain.map((slot) => ({
      id: slot.id,
      failed: slot.failed || this.failed.has(slot.id),
      spectrum: slot.processor?.spectrum ? Float32Array.from(slot.processor.spectrum) : null,
      tuner: slot.processor?.tuner ?? null,
      meter: slot.processor?.meter ?? null,
      trace: slot.processor?.trace ? Float32Array.from(slot.processor.trace) : null,
      meters: slot.processor?.meters ?? null,
      scope: slot.processor?.scope ? Float32Array.from(slot.processor.scope) : null,
      kept: (slot.processor as LiveProc | null)?.kept?.() ?? null,
    }))
    this.port.postMessage({ type: 'meters', rows })
  }
}

class KeyProcessor extends AudioWorkletProcessor {
  private id = ''

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<{ id?: string }>) => {
      if (event.data?.id) this.id = event.data.id
    }
  }

  process(inputs: Float32Array[][]) {
    const left = inputs[0]?.[0]
    if (!left?.length || !this.id) return true
    const right = inputs[0]?.[1]
    const mono = new Float32Array(left.length)
    for (let i = 0; i < left.length; i++) mono[i] = ((left[i] || 0) + (right?.[i] || 0)) * 0.5
    this.port.postMessage({ type: 'key', id: this.id, channel: mono }, [mono.buffer])
    return true
  }
}

registerProcessor('cueharbor-insert', InsertProcessor)
registerProcessor('cueharbor-key', KeyProcessor)
