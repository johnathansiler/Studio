import { prepareChainPool, preseedChain, processChain, type ChainPool, type ChainSlot, type SlotNote } from './plugins/chain'
import { prepareAccurate, preseedAccurate, processSampleAccurate, type AccurateScratch } from './automationRender'
import { createProcessor, preloadWasmInserts } from './plugins/createAll'
import { projectSampleBeat } from '../model/tempoMap'
import { valueChanges } from '../model/automation'
import { automationAt } from './plugins/catalog'
import { transparentLimit } from './liveStage'
import { primeProcessor } from './core/adapt'
import { publishTrack, takeTrack } from './core/sabClock'
import { BlockSmoother } from './core/smooth'
import type { AutomationLane, PluginInstance, TempoPoint } from '../model/types'
import type { BlockContext, Processor } from './plugins/types'

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

const QUANTA = [128, 256, 512, 1024, 2048]
const MAX_BLOCK = 2048
const MAX_SLOTS = 24

interface MeterRow {
  id: string
  failed: boolean
  spectrum: Float32Array | null
  tuner: { hz: number; cents: number; note: number } | null
  meter: { vu: number; gr: number } | null
  trace: Float32Array | null
  meters: Record<string, number> | null
  scope: Float32Array | null
  kept: Float32Array | null
  outputPeak: number
  latency: number
}

class InsertProcessor extends AudioWorkletProcessor {
  private slots: SlotMsg[] = []
  private procs = new Map<string, LiveProc>()
  private failed = new Set<string>()
  private buffers = new Map<string, Float32Array>()
  private keys = new Map<string, Float32Array>()
  private automation: AutomationLane[] = []
  private tempo = 120
  private projectRate = sampleRate
  private tempoMap: TempoPoint[] = []
  private scaleRoot = 0
  private scaleIntervals: number[] = [0, 2, 4, 5, 7, 9, 11]
  private scaleCents: number[] | undefined
  private quality: 'full' | 'eco' = 'full'
  private playing = false
  private originTime = 0
  private originSample = 0
  private posts = 0
  private smoother = new BlockSmoother()
  private shells: ChainSlot[] = []
  private targets: Record<string, number>[] = []
  private heldParams: Record<string, number>[] = []
  private paramKeys: string[][] = []
  private ins: Float32Array[] = [new Float32Array(0), new Float32Array(0)]
  private outs: Float32Array[] = [new Float32Array(0), new Float32Array(0)]
  private clock = { tempo: 120, tempoMap: [] as TempoPoint[], automation: [] as AutomationLane[], sampleRate }
  private keyViews = new Map<string, { buf: Float32Array; view: Float32Array; length: number }>()
  private pool: ChainPool = prepareChainPool(MAX_SLOTS, 2, MAX_BLOCK)
  private scratch: AccurateScratch = prepareAccurate(MAX_SLOTS, MAX_BLOCK)
  private silence = new Float32Array(MAX_BLOCK)
  private silenceViews = new Map<number, Float32Array>()
  private blockCtx: BlockContext = {
    sampleRate,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: this.scaleIntervals,
    quality: 'full',
  }
  private meterRows: MeterRow[] = []
  private meterMsg: { type: 'meters'; rows: MeterRow[] } = { type: 'meters', rows: this.meterRows }
  private sincePost = 0
  private knownIds = new Set<string>()
  private stateEpoch = 0
  private binds: PluginInstance[] = []
  private pending = new Map<string, { time: number | null; pitch: number; vel: number }[]>()
  private noteLists: SlotNote[][] = []
  private readonly asset = (id: string) => this.buffers.get(id) ?? null
  private readonly readKey = (id: string, length: number) => this.keyView(id, length)
  private readonly beatAt = (sample: number) => projectSampleBeat(this.clock, sample)
  private parallelSlot = -1
  private parallelSab: SharedArrayBuffer | null = null
  private parallelMisses = 0
  private parallelPrimed = false
  private parallelFrames = 0
  private parallelHold = [new Float32Array(2048), new Float32Array(2048)]

  constructor() {
    super()
    preseedChain(this.pool, QUANTA)
    preseedAccurate(this.scratch, QUANTA)
    for (const frames of QUANTA) this.silenceViews.set(frames, this.silence.subarray(0, frames))
    this.port.onmessage = (event: MessageEvent<StateMsg | { type: string; [key: string]: unknown }>) => {
      this.onMessage(event.data)
    }
  }

  private onMessage(data: StateMsg | { type?: string; [key: string]: unknown }) {
    if (!data?.type) return
    if (data.type === 'parallel' && data.sab instanceof SharedArrayBuffer && typeof data.slot === 'number') {
      this.parallelSab = data.sab
      this.parallelSlot = data.slot
      this.parallelMisses = 0
      this.parallelPrimed = false
      return
    }
    if (data.type === 'state') {
      const msg = data as unknown as StateMsg & { wasmDsp?: boolean }
      const epoch = ++this.stateEpoch
      if (msg.wasmDsp) {
        void this.installWasm(msg, epoch)
        return
      }
      if (typeof msg.wasmDsp === 'boolean') {
        ;(globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }).__CUEHARBOR_WASM_DSP__ = false
      }
      this.applyState(msg)
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
      if (proc?.schedule && Number.isFinite(time)) {
        proc.schedule(pitch, vel, time)
        return
      }
      const queued = this.pending.get(data.id) ?? []
      queued.push({ time: Number.isFinite(time) ? time : null, pitch, vel })
      this.pending.set(data.id, queued)
      return
    }
    if (data.type === 'reset-all') {
      for (const proc of this.procs.values()) proc.reset()
      return
    }
    if (data.type === 'reset' && typeof data.id === 'string') {
      this.procs.get(data.id)?.reset()
    }
  }

  /** The DSP chunk loads for the default Rust chain. `process()` keeps the previous chain until it arrives. */
  private async installWasm(msg: StateMsg & { wasmDsp?: boolean }, epoch: number) {
    ;(globalThis as { __CUEHARBOR_WASM_DSP__?: boolean }).__CUEHARBOR_WASM_DSP__ = true
    try {
      await preloadWasmInserts()
    } catch {
      // TypeScript processors still build when the chunk fails.
    }
    if (epoch !== this.stateEpoch) return
    this.applyState(msg)
  }

  private applyState(msg: StateMsg) {
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
      primeProcessor(proc, sampleRate, 128)
      this.procs.set(slot.id, proc)
      this.bind(slot)
    }
    this.syncShells()
  }

  /** Slot shells and parameter key lists are built here, off the render loop. */
  private syncShells() {
    const live = new Set(this.slots.map((slot) => slot.id))
    for (const id of this.knownIds) if (!live.has(id)) this.smoother.reset(id)
    this.knownIds = live
    while (this.shells.length < this.slots.length) {
      this.shells.push({
        id: '',
        pluginId: '',
        enabled: true,
        wet: 1,
        params: {},
        failed: false,
        sidechain: '',
        processor: null,
      })
      this.targets.push({})
      this.heldParams.push({})
      this.paramKeys.push([])
    }
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]
      const keys = Object.keys(slot.params)
      for (const lane of this.automation) {
        if (lane.pluginId === slot.id && lane.param && !keys.includes(lane.param)) keys.push(lane.param)
      }
      this.paramKeys[i] = keys
      const target = this.targets[i]
      for (const key of Object.keys(target)) if (!keys.includes(key)) delete target[key]
      const held = this.heldParams[i]
      if (held) for (const key of Object.keys(held)) if (!keys.includes(key)) delete held[key]
      this.scratch.paramKeys[i] = keys
      const base = this.scratch.base[i]
      const liveRow = this.scratch.live[i]
      if (base) for (const key of Object.keys(base)) if (!keys.includes(key)) delete base[key]
      if (liveRow) for (const key of Object.keys(liveRow)) if (!keys.includes(key)) delete liveRow[key]
    }
  }

  private bind(slot: SlotMsg) {
    this.bindAt(slot, this.slots.indexOf(slot))
  }

  private bindAt(slot: SlotMsg, index: number) {
    const proc = this.procs.get(slot.id)
    if (!proc?.bind) return
    let plugin = this.binds[index]
    if (!plugin) {
      plugin = {
        id: slot.id,
        pluginId: slot.pluginId,
        version: '1',
        enabled: slot.enabled,
        wet: slot.wet,
        params: slot.params,
        sidechain: slot.sidechain,
        sampler: slot.sampler,
      }
      this.binds[index] = plugin
    } else {
      plugin.id = slot.id
      plugin.pluginId = slot.pluginId
      plugin.enabled = slot.enabled
      plugin.wet = slot.wet
      plugin.params = slot.params
      plugin.sidechain = slot.sidechain
      plugin.sampler = slot.sampler
    }
    proc.bind(plugin, this.asset)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0]
    const frames = output?.[0]?.length ?? 0
    if (!output || !frames) return true
    const count = Math.min(this.slots.length, this.shells.length)
    const input = inputs[0]
    const quiet = this.silenceViews.get(frames) ?? this.silence
    const left = input?.[0] ?? quiet
    const rightIn = input?.[1] ?? left
    this.ins[0] = left
    this.ins[1] = rightIn
    const right = output[1] ?? output[0]
    this.outs[0] = output[0]
    this.outs[1] = right
    if (this.parallelSab && this.parallelSlot >= 0 && this.playParallel(left, rightIn, output[0], right, frames)) {
      this.limitOutput(output[0], right, frames)
      this.posts += 1
      if (this.posts % 16 === 0) this.postMeters(Math.min(this.slots.length, this.shells.length))
      return true
    }
    const sampleTime = this.playing
      ? this.originSample + (currentTime - this.originTime) * sampleRate
      : this.originSample
    this.clock.tempo = this.tempo
    this.clock.tempoMap = this.tempoMap
    this.clock.automation = this.automation
    this.clock.sampleRate = this.projectRate > 0 ? this.projectRate : sampleRate
    const beat = projectSampleBeat(this.clock, sampleTime)
    const ctx = this.blockCtx
    ctx.sampleRate = sampleRate
    ctx.tempo = this.tempo
    ctx.sampleTime = sampleTime
    ctx.sidechain = null
    ctx.scaleRoot = this.scaleRoot
    ctx.scaleIntervals = this.scaleIntervals
    ctx.scaleCents = this.scaleCents
    ctx.quality = this.quality
    ctx.offline = false
    ctx.playTime = currentTime
    for (let i = 0; i < count; i++) {
      const slot = this.slots[i]
      const shell = this.shells[i]
      this.bindAt(slot, i)
      shell.id = slot.id
      shell.pluginId = slot.pluginId
      shell.enabled = slot.enabled
      shell.wet = slot.wet
      shell.failed = this.failed.has(slot.id)
      shell.sidechain = slot.sidechain
      shell.processor = this.procs.get(slot.id) ?? null
    }
    this.assignNotes(count, frames)
    const endBeat = projectSampleBeat(this.clock, sampleTime + Math.max(0, frames - 1))
    let moving = false
    const lanes = this.automation
    for (let i = 0; i < lanes.length && !moving; i++) {
      const lane = lanes[i]
      if (lane.target != null && lane.target !== 'plugin') continue
      for (let s = 0; s < count; s++) {
        if (this.shells[s].id === lane.pluginId && valueChanges(lane.points, beat, endBeat, 0)) {
          moving = true
          break
        }
      }
    }
    if (moving) {
      for (let i = 0; i < count; i++) {
        copyKeys(this.targets[i], this.slots[i].params, this.paramKeys[i])
        this.shells[i].params = this.targets[i]
      }
      processSampleAccurate(this.shells, this.ins, this.outs, ctx, lanes, this.readKey, this.beatAt, frames <= this.scratch.frames ? this.scratch : undefined, frames <= this.pool.frames ? this.pool : undefined)
      for (let i = 0; i < count; i++) this.shells[i].params = this.heldParams[i]
    } else {
      for (let i = 0; i < count; i++) {
        const shell = this.shells[i]
        automationAt(lanes, shell.id, this.slots[i].params, beat, this.targets[i], this.paramKeys[i])
        shell.params = this.smoother.apply(shell.id, this.targets[i], frames, sampleRate, this.heldParams[i], this.paramKeys[i])
      }
      processChain(this.shells, this.ins, this.outs, ctx, this.readKey, frames <= this.pool.frames ? this.pool : undefined, count)
    }
    const outL = output[0]
    const outR = output[1]
    let peak = this.sincePost
    for (let i = 0; i < frames; i++) {
      const limited = transparentLimit(outL[i] || 0)
      outL[i] = limited
      const abs = limited < 0 ? -limited : limited
      if (abs > peak) peak = abs
      if (outR && outR !== outL) {
        const rightLimited = transparentLimit(outR[i] || 0)
        outR[i] = rightLimited
        const rightAbs = rightLimited < 0 ? -rightLimited : rightLimited
        if (rightAbs > peak) peak = rightAbs
      }
    }
    this.sincePost = peak
    this.posts += 1
    if (this.posts % 16 === 0) this.postMeters(count)
    return true
  }

  private assignNotes(count: number, frames: number) {
    const blockEnd = currentTime + frames / sampleRate
    for (let i = 0; i < count; i++) {
      const id = this.shells[i].id
      let list = this.noteLists[i]
      if (!list) {
        list = []
        this.noteLists[i] = list
      }
      let used = 0
      const queued = this.pending.get(id)
      if (queued?.length) {
        let keep = 0
        for (let n = 0; n < queued.length; n++) {
          const item = queued[n]
          if (item.time != null && item.time >= blockEnd) {
            queued[keep] = item
            keep += 1
            continue
          }
          const offset = item.time == null
            ? 0
            : Math.max(0, Math.min(frames - 1, Math.round((item.time - currentTime) * sampleRate)))
          const slot = list[used] ?? { offset: 0, pitch: 0, vel: 0 }
          slot.offset = offset
          slot.pitch = item.pitch
          slot.vel = item.vel
          list[used] = slot
          used += 1
        }
        queued.length = keep
      }
      list.length = used
      this.shells[i].notes = list
    }
  }

  private keyView(id: string, length: number) {
    const buf = this.keys.get(id)
    if (!buf?.length) return null
    const n = Math.min(buf.length, length)
    const hit = this.keyViews.get(id)
    if (hit && hit.buf === buf && hit.length === n) return hit.view
    const view = buf.subarray(0, n)
    this.keyViews.set(id, { buf, view, length: n })
    return view
  }

  private playParallel(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number) {
    const sab = this.parallelSab
    if (!sab || this.parallelSlot < 0) return false
    const took = takeTrack(sab, this.parallelSlot, outL, outR, frames)
    if (took === 'busy' || (this.parallelPrimed && took !== 'ready')) {
      this.parallelMisses += 1
      if (this.parallelMisses > 6) {
        this.parallelSlot = -1
        return false
      }
      const n = Math.min(frames, this.parallelHold[0].length, outL.length)
      outL.set(this.parallelHold[0].subarray(0, n))
      outR.set(this.parallelHold[1].subarray(0, n))
      return true
    }
    if (took !== 'ready') {
      const n = Math.min(frames, inL.length, outL.length)
      for (let i = 0; i < n; i++) {
        outL[i] = inL[i] || 0
        outR[i] = (inR[i] ?? inL[i]) || 0
      }
    }
    this.parallelMisses = 0
    this.parallelPrimed = true
    this.parallelFrames = frames
    const held = Math.min(frames, this.parallelHold[0].length, outL.length)
    this.parallelHold[0].set(outL.subarray(0, held))
    this.parallelHold[1].set(outR.subarray(0, held))
    publishTrack(sab, this.parallelSlot, inL, inR, frames)
    return true
  }

  private limitOutput(outL: Float32Array, outR: Float32Array, frames: number) {
    let peak = this.sincePost
    for (let i = 0; i < frames; i++) {
      const limited = transparentLimit(outL[i] || 0)
      outL[i] = limited
      const abs = limited < 0 ? -limited : limited
      if (abs > peak) peak = abs
      if (outR !== outL) {
        const rightLimited = transparentLimit(outR[i] || 0)
        outR[i] = rightLimited
        const rightAbs = rightLimited < 0 ? -rightLimited : rightLimited
        if (rightAbs > peak) peak = rightAbs
      }
    }
    this.sincePost = peak
  }

  private postMeters(count: number) {
    const rows = this.meterRows
    while (rows.length < count) {
      rows.push({
        id: '',
        failed: false,
        spectrum: null,
        tuner: null,
        meter: null,
        trace: null,
        meters: null,
        scope: null,
        kept: null,
        outputPeak: 0,
        latency: 0,
      })
    }
    for (let i = 0; i < count; i++) {
      const slot = this.shells[i]
      const row = rows[i]
      const proc = slot.processor
      row.id = slot.id
      row.failed = slot.failed || this.failed.has(slot.id)
      row.tuner = proc?.tuner ?? null
      row.meter = proc?.meter ?? null
      row.meters = proc?.meters ?? null
      row.spectrum = copyInto(row.spectrum, proc?.spectrum)
      row.trace = copyInto(row.trace, proc?.trace)
      row.scope = copyInto(row.scope, proc?.scope)
      row.kept = (proc as LiveProc | null)?.kept?.() ?? null
      row.outputPeak = i === 0 ? this.sincePost : 0
      row.latency = (proc?.latencySamples || 0) + (this.parallelSlot >= 0 ? this.parallelFrames : 0)
    }
    rows.length = count
    this.sincePost = 0
    this.port.postMessage(this.meterMsg)
  }
}

function copyKeys(dest: Record<string, number>, src: Record<string, number>, keys: readonly string[]) {
  for (let i = 0; i < keys.length; i++) dest[keys[i]] = src[keys[i]]
}

function copyInto(dest: Float32Array | null, src: Float32Array | undefined) {
  if (!src) return null
  let into = dest
  if (!into || into.length !== src.length) into = new Float32Array(src.length)
  into.set(src)
  return into
}

class KeyProcessor extends AudioWorkletProcessor {
  private id = ''
  private mono = new Map<number, Float32Array>()

  constructor() {
    super()
    this.mono.set(128, new Float32Array(128))
    this.mono.set(256, new Float32Array(256))
    this.port.onmessage = (event: MessageEvent<{ id?: string }>) => {
      if (event.data?.id) this.id = event.data.id
    }
  }

  process(inputs: Float32Array[][]) {
    const left = inputs[0]?.[0]
    if (!left?.length || !this.id) return true
    const right = inputs[0]?.[1]
    let mono = this.mono.get(left.length)
    if (!mono) {
      mono = new Float32Array(left.length)
      this.mono.set(left.length, mono)
    }
    for (let i = 0; i < left.length; i++) mono[i] = ((left[i] || 0) + (right?.[i] || 0)) * 0.5
    this.port.postMessage({ type: 'key', id: this.id, channel: mono })
    return true
  }
}

registerProcessor('cueharbor-insert', InsertProcessor)
registerProcessor('cueharbor-key', KeyProcessor)
