import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { AudioEngine } from '../audio/engine'
import {
  SCHEDULER_HORIZON_SEC,
  WORKLET_QUEUE_CAP,
  advanceLoopCursor,
  enqueueWorkletMessage,
  placeNoteTime,
  timingStats,
} from '../audio/liveStage'
import { transportSample } from '../model/transportSync'
import { createEmptyProject, type AudioAsset } from '../model/types'
import { assetWavStamp, encodedAssetWav } from '../storage/idb'
import { ProjectStore } from '../state/store'

interface RecordedStart {
  when: number
  now: number
}

interface FakeParam {
  value: number
  cancelScheduledValues: (time?: number) => void
  setValueAtTime: (value: number, time: number) => void
  setTargetAtTime: (value: number, time: number, tau: number) => void
  linearRampToValueAtTime: (value: number, time: number) => void
  exponentialRampToValueAtTime: (value: number, time: number) => void
}

class FakeNode {
  starts: RecordedStart[] = []
  onended: (() => void) | null = null
  buffer: { duration: number } | null = null
  playbackRate: FakeParam
  loop = false
  loopStart = 0
  loopEnd = 0
  type = 'sine'
  curve: Float32Array | null = null
  oversample = 'none'
  fftSize = 256
  smoothingTimeConstant = 0
  channelCount = 2
  channelCountMode = 'explicit'
  channelInterpretation = 'speakers'
  maxChannelCount = 2
  private ended = false
  constructor(private ctx: FakeContext, readonly kind: string) {
    this.playbackRate = param(1)
  }
  connect() { return this }
  disconnect() {}
  start(when?: number) {
    if (this.ended || typeof when !== 'number') return
    const hit = { when, now: this.ctx.currentTime }
    this.starts.push(hit)
    this.ctx.starts.push(hit)
  }
  stop() {
    if (this.ended) return
    this.ended = true
    this.onended?.()
  }
  getFloatTimeDomainData(into: Float32Array) {
    into.fill(0)
  }
}

function param(initial: number): FakeParam {
  const node: FakeParam = {
    value: initial,
    cancelScheduledValues() {},
    setValueAtTime(value) { node.value = value },
    setTargetAtTime(value) { node.value = value },
    linearRampToValueAtTime(value) { node.value = value },
    exponentialRampToValueAtTime(value) { node.value = value },
  }
  return node
}

class FakeContext {
  sampleRate = 48000
  currentTime = 5
  state: AudioContextState = 'running'
  starts: RecordedStart[] = []
  created = { osc: 0, gain: 0, filter: 0, buffer: 0 }
  destination: FakeNode
  private listeners = new Set<() => void>()
  constructor() {
    this.destination = new FakeNode(this, 'destination')
  }
  resume = async () => {
    this.state = 'running'
    return undefined
  }
  close = async () => {
    this.state = 'closed'
  }
  addEventListener(_type: string, fn: () => void) { this.listeners.add(fn) }
  removeEventListener(_type: string, fn: () => void) { this.listeners.delete(fn) }
  audioWorklet = { addModule: async () => undefined }
  createGain = () => {
    this.created.gain += 1
    return this.node('gain')
  }
  createDelay = () => this.node('delay')
  createBiquadFilter = () => {
    this.created.filter += 1
    return this.node('filter')
  }
  createDynamicsCompressor = () => this.node('comp')
  createConvolver = () => this.node('convolver')
  createStereoPanner = () => this.node('panner')
  createAnalyser = () => this.node('analyser')
  createWaveShaper = () => this.node('shaper')
  createOscillator = () => {
    this.created.osc += 1
    return this.node('osc')
  }
  createBufferSource = () => this.node('buffer-source')
  createChannelMerger = () => this.node('merger')
  createChannelSplitter = () => this.node('splitter')
  createConstantSource = () => this.node('constant')
  createScriptProcessor = () => this.node('script')
  createMediaStreamDestination = () => ({ stream: { getTracks: () => [] as MediaStreamTrack[] } })
  createMediaStreamSource = () => this.node('stream')
  createBuffer = (_channels: number, length: number, rate: number) => {
    this.created.buffer += 1
    const data = new Float32Array(Math.max(1, length))
    return {
      numberOfChannels: Math.max(1, _channels),
      length: data.length,
      sampleRate: rate,
      duration: data.length / rate,
      getChannelData: () => data,
      copyToChannel: (source: Float32Array) => { data.set(source.subarray(0, data.length)) },
    }
  }
  private node(kind: string) {
    const raw = new FakeNode(this, kind)
    return new Proxy(raw, {
      get(target, key) {
        if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key]
        if (key === 'gain' || key === 'frequency' || key === 'Q' || key === 'pan' || key === 'delayTime' || key === 'threshold' || key === 'knee' || key === 'ratio' || key === 'attack' || key === 'release' || key === 'offset') {
          const created = param(key === 'gain' ? 1 : key === 'frequency' ? 440 : 0)
          ;(target as unknown as Record<string, unknown>)[key as string] = created
          return created
        }
        return undefined
      },
      set(target, key, value) {
        ;(target as unknown as Record<string | symbol, unknown>)[key] = value
        return true
      },
    })
  }
}

class FakeWorklet {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (_data: unknown) => undefined,
  }
  connect() {}
  disconnect() {}
}

const visListeners = new Set<() => void>()
const visibility = { state: 'visible' as DocumentVisibilityState }

function installHost() {
  const flag = globalThis as { __CUEHARBOR_WASM_DSP__?: boolean; AudioContext?: unknown; AudioWorkletNode?: unknown; document?: Document; window?: Window & typeof globalThis }
  flag.__CUEHARBOR_WASM_DSP__ = false
  const Ctx = class {
    constructor() { return new FakeContext() }
  }
  flag.AudioContext = Ctx
  flag.AudioWorkletNode = FakeWorklet
  flag.window = globalThis as Window & typeof globalThis
  flag.document = {
    addEventListener(type: string, fn: () => void) {
      if (type === 'visibilitychange') visListeners.add(fn)
    },
    removeEventListener(_type: string, fn: () => void) {
      visListeners.delete(fn)
    },
  } as unknown as Document
  Object.defineProperty(flag.document, 'visibilityState', { get: () => visibility.state, configurable: true })
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => undefined
}

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function projectWithLoop() {
  const project = createEmptyProject(48000)
  project.loopEnabled = true
  project.loopStartSample = 0
  project.loopEndSample = project.sampleRate * 2
  project.metronomeEnabled = true
  const keys = project.tracks.find((track) => track.type === 'midi')!
  keys.midiClips.push({
    id: 'loop-keys',
    name: 'Keys',
    startBeat: 0,
    durationBeats: 4,
    notes: [0, 1, 2, 3].map((beat) => ({
      id: `n${beat}`,
      pitch: 60 + beat,
      startBeat: beat,
      durationBeats: 0.2,
      velocity: 0.8,
    })),
  })
  return project
}

describe('scheduler health', () => {
  it('slips a slightly late note and drops one that missed the horizon', () => {
    expect(placeNoteTime(10, 10)).toBe(10)
    expect(placeNoteTime(10.01, 10)).toBe(10.01)
    expect(placeNoteTime(9.99, 10)).toBeCloseTo(10.001)
    expect(placeNoteTime(9.5, 10)).toBeNull()
    const jumped = advanceLoopCursor(1, 1 + SCHEDULER_HORIZON_SEC + 0.2, 0.5)
    expect(jumped.jumped).toBe(true)
    expect(jumped.cursor).toBeGreaterThan(1 + SCHEDULER_HORIZON_SEC)
    expect(advanceLoopCursor(10, 10.05, 2).jumped).toBe(false)
    const queued = Array.from({ length: 60 }, (_, index) => index)
    const capped = queued.reduce<number[]>((queue, message) => enqueueWorkletMessage(queue, message), [])
    expect(capped).toHaveLength(WORKLET_QUEUE_CAP)
    expect(capped[0]).toBe(60 - WORKLET_QUEUE_CAP)
    expect(capped.at(-1)).toBe(59)
    expect(timingStats([0.001, -0.002, 0.0005]).maxMs).toBeCloseTo(2)
    expect(readFileSync('public/worklets/keys.js', 'utf8')).toContain('this.queueCap = 48')
  })

  it('reuses the encoded wav when an asset has not changed', async () => {
    const data = new Float32Array(4096)
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 12) * 0.2
    const asset: AudioAsset = { id: 'take', name: 'take', sampleRate: 48000, channels: [data] }
    const stamp = assetWavStamp(asset)
    expect(assetWavStamp(asset)).toBe(stamp)
    const first = await encodedAssetWav(asset)
    const second = await encodedAssetWav(asset)
    expect(second.wav).toBe(first.wav)
    expect(second.hash).toBe(first.hash)
    data[100] = 0.9
    expect(assetWavStamp(asset)).not.toBe(stamp)
    const edited = new Float32Array(data)
    edited[100] = -0.9
    const third = await encodedAssetWav({ ...asset, channels: [edited] })
    expect(third.wav).not.toBe(first.wav)
    expect(third.hash).not.toBe(first.hash)
  })
})

describe('transport and graph stress', () => {
  afterEach(() => {
    visibility.state = 'visible'
    visListeners.clear()
  })

  it('ignores a play that resolves after stop, and keeps the last seek', async () => {
    installHost()
    const engine = new AudioEngine()
    const real = engine.resume.bind(engine)
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    engine.resume = async (rate?: number, settle?: boolean) => {
      await gate
      return real(rate, settle)
    }
    const first = engine.play(0)
    engine.seek(5000)
    engine.seek(9000)
    engine.stop()
    release!()
    await first
    await flush()
    expect(engine.status).toBe('stopped')
    expect(engine.stability().playing).toBe(false)

    const again = engine.play(0)
    engine.seek(48000)
    engine.seek(96000)
    release!()
    await again
    await flush()
    expect(engine.positionSamples).toBe(96000)
    expect(engine.stability().playing).toBe(true)
    engine.stop()
  })

  it('stops a count-in immediately instead of leaving the record promise pending', async () => {
    installHost()
    const engine = new AudioEngine()
    const project = createEmptyProject(48000)
    project.countIn = true
    engine.sync(project, () => undefined)
    const pending = engine.beginRecord({ fromSample: 0, inputs: [], countIn: true })
    const started = Date.now()
    while (engine.status !== 'counting-in' && Date.now() - started < 2000) await flush()
    expect(engine.status).toBe('counting-in')
    engine.stop()
    await pending
    expect(engine.status).toBe('stopped')
    expect(engine.stability().recorders).toBe(0)
  })

  it('keeps sources bounded across a long loop and reports playhead drift and jitter', async () => {
    installHost()
    const engine = new AudioEngine()
    const project = projectWithLoop()
    engine.sync(project, () => undefined)
    await engine.play(0)
    const ctx = engine.ctx as unknown as FakeContext
    expect(ctx).toBeTruthy()
    const origin = (engine as unknown as { playOriginCtx: number }).playOriginCtx
    for (let step = 0; step < 800; step++) {
      ctx.currentTime += 0.025
      engine.wakeTransport()
    }
    const load = engine.stability()
    const linear = engine.currentTimelineSample()
    const heard = transportSample(linear, project)
    const drift = Math.abs(engine.positionSamples - heard)
    const errors = ctx.starts
      .filter((start) => Number.isFinite(start.when))
      .map((start) => {
        const beat = (start.when - origin) / 0.5
        const nearest = Math.round(beat)
        return start.when - (origin + nearest * 0.5)
      })
    const jitter = timingStats(errors)
    expect(ctx.created.osc, `oscillators created ${ctx.created.osc}, still held ${load.sources}, reaped ${load.reaped}`).toBeGreaterThan(30)
    expect(load.sources).toBeLessThanOrEqual(16)
    expect(load.reaped).toBeGreaterThan(20)
    expect(load.schedulerSkips).toBe(0)
    expect(load.schedulerGapSec).toBeLessThan(0.05)
    expect(drift).toBeLessThan(1)
    expect(jitter.maxMs).toBeLessThan(3)
    expect(engine.status).toBe('playing')

    ctx.currentTime += 2
    engine.wakeTransport()
    expect(engine.stability().schedulerSkips).toBeGreaterThanOrEqual(1)
    expect(engine.stability().sources).toBeLessThanOrEqual(16)
    engine.stop()
  })

  it('survives tempo sweeps, track churn, undo spam, and a hidden tab', async () => {
    installHost()
    const store = new ProjectStore(projectWithLoop())
    const engine = new AudioEngine()
    const sync = () => engine.sync(store.project, () => undefined)
    store.subscribe(sync)
    sync()
    await engine.play(0)
    const ctx = engine.ctx as unknown as FakeContext
    for (let tempo = 80; tempo <= 160; tempo += 4) {
      store.setTempo(tempo)
      ctx.currentTime += 0.03
      engine.wakeTransport()
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(engine.stability().playing).toBe(true)
    expect(engine.status).toBe('playing')

    for (let index = 0; index < 24; index++) store.addTrack('midi')
    sync()
    const order = [...store.project.tracks].reverse()
    store.project.tracks.splice(0, store.project.tracks.length, ...order)
    for (const track of store.project.tracks) {
      track.inserts = [{ id: `${track.id}-eq`, type: 'eq', enabled: indexEnabled(track.id), params: { low: 0, mid: 0, midFreq: 1000, high: 0 } }]
      track.plugins = []
    }
    sync()
    for (const track of store.project.tracks) {
      for (const insert of track.inserts) insert.enabled = !insert.enabled
    }
    sync()
    const removed = store.project.tracks.slice(0, 12).map((track) => track.id)
    for (const id of removed) store.removeTrack(id)
    sync()
    ctx.currentTime += 0.5
    engine.wakeTransport()
    expect(engine.stability().strips).toBe(store.project.tracks.length)
    expect(engine.stability().playing).toBe(true)
    expect(engine.stability().sources).toBeLessThanOrEqual(32)

    const beforeUndo = engine.positionSamples
    for (let step = 0; step < 30 && store.canUndo; step++) store.undo()
    expect(store.toasts.length).toBeLessThanOrEqual(4)
    expect(engine.stability().playing).toBe(true)
    expect(Number.isFinite(beforeUndo)).toBe(true)

    visibility.state = 'hidden'
    for (const listener of visListeners) listener()
    await flush()
    expect(engine.stability().playing).toBe(false)
    expect(engine.stability().heldPlaying).toBe(true)
    engine.stop()
    expect(engine.stability().heldPlaying).toBe(false)
    visibility.state = 'visible'
    for (const listener of visListeners) listener()
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(engine.stability().playing).toBe(false)
    expect(engine.status).toBe('stopped')
  })

  it('does not leave a MIDI indicator stuck after a bounced note-on, and bounds fast drum hits', async () => {
    installHost()
    const engine = new AudioEngine()
    const project = createEmptyProject(48000)
    engine.sync(project, () => undefined)
    await engine.resume()
    const ctx = engine.ctx as unknown as FakeContext
    const midi = project.tracks.find((track) => track.type === 'midi')!
    engine.playThrough(midi.id, 60, 0.9)
    engine.playThrough(midi.id, 60, 0.9)
    engine.releaseThrough(midi.id, 60)
    ctx.currentTime += 1
    expect(engine.midiActivity()[midi.id]).toBeFalsy()
    expect(engine.stability().liveBuiltins).toBe(0)

    for (let hit = 0; hit < 80; hit++) {
      ctx.currentTime += 0.02
      engine.triggerPad(midi.id, 36 + (hit % 4), 0.8)
    }
    ctx.currentTime += 2
    engine.wakeTransport()
    expect(engine.stability().sources).toBeLessThanOrEqual(16)
    expect(engine.stability().oneShots).toBeLessThanOrEqual(4)
    expect(engine.stability().padVoices).toBeLessThanOrEqual(16)
  })
})

function indexEnabled(id: string) {
  return id.charCodeAt(id.length - 1) % 2 === 0
}
