import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { AudioEngine } from '../audio/engine'
import {
  SCHEDULER_HORIZON_SEC,
  WORKLET_QUEUE_CAP,
  advanceLoopCursor,
  clipSliceEnvelope,
  enqueueWorkletMessage,
  nextTimelineSample,
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
  offset: number
  duration: number | null
  kind: string
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
  start(when?: number, offset?: number, duration?: number) {
    if (this.ended || typeof when !== 'number') return
    const hit = {
      when,
      now: this.ctx.currentTime,
      offset: offset ?? 0,
      duration: duration ?? null,
      kind: this.kind,
    }
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

function param(initial: number, onLinear?: (value: number, time: number) => void): FakeParam {
  const node: FakeParam = {
    value: initial,
    cancelScheduledValues() {},
    setValueAtTime(value) { node.value = value },
    setTargetAtTime(value) { node.value = value },
    linearRampToValueAtTime(value, time) {
      node.value = value
      onLinear?.(value, time)
    },
    exponentialRampToValueAtTime(value) { node.value = value },
  }
  return node
}

class FakeContext {
  sampleRate = 48000
  currentTime = 5
  state: AudioContextState = 'running'
  starts: RecordedStart[] = []
  linearRamps: { value: number; time: number }[] = []
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
    const ctx = this
    const raw = new FakeNode(this, kind)
    return new Proxy(raw, {
      get(target, key) {
        if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key]
        if (key === 'gain' || key === 'frequency' || key === 'Q' || key === 'pan' || key === 'delayTime' || key === 'threshold' || key === 'knee' || key === 'ratio' || key === 'attack' || key === 'release' || key === 'offset') {
          const created = param(key === 'gain' ? 1 : key === 'frequency' ? 440 : 0, key === 'gain' ? (value, time) => ctx.linearRamps.push({ value, time }) : undefined)
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
    const trimmed = data.subarray(0, data.length - 32)
    expect(assetWavStamp({ ...asset, channels: [trimmed] })).not.toBe(stamp)
    const same = new Float32Array(4096)
    for (let i = 0; i < same.length; i++) same[i] = Math.sin(i / 12) * 0.2
    const renamed = await encodedAssetWav({ id: 'take-copy', name: 'take', sampleRate: 48000, channels: [same] })
    expect(renamed.hash).toBe(first.hash)
    expect(renamed.wav).not.toBe(first.wav)
  })

  it('keeps the last sample of a loop and continues a fade across slices', () => {
    const cap = Math.ceil(SCHEDULER_HORIZON_SEC * 48000)
    const end = cap + 1
    let cursor = 0
    let reached = 0
    for (let pass = 0; pass < 4 && cursor < end; pass++) {
      const samples = Math.min(end - cursor, cap)
      reached = cursor + samples
      cursor = nextTimelineSample(cursor, samples, end, 0)
    }
    expect(reached).toBe(end)
    expect(cursor).toBe(0)
    const fade = clipSliceEnvelope({
      at: 10,
      dur: 0.35,
      relFrom: 0,
      relTo: 0.35,
      clipGain: 1,
      fadeInSec: 1,
      fadeOutSec: 0,
      clipDurSec: 4,
      join: false,
    })
    expect(fade.at(-1)?.value).toBeCloseTo(0.35, 5)
    const next = clipSliceEnvelope({
      at: 10.35,
      dur: 0.35,
      relFrom: 0.35,
      relTo: 0.7,
      clipGain: 1,
      fadeInSec: 1,
      fadeOutSec: 0,
      clipDurSec: 4,
      join: false,
    })
    expect(next[0]?.value).toBeCloseTo(fade.at(-1)?.value ?? 0, 5)
    const tail = clipSliceEnvelope({
      at: 12,
      dur: 0.35,
      relFrom: 3.7,
      relTo: 4,
      clipGain: 1,
      fadeInSec: 0,
      fadeOutSec: 1,
      clipDurSec: 4,
      join: false,
    })
    expect(tail[0]?.value).toBeGreaterThan(0.2)
    expect(tail.at(-1)?.value).toBeLessThan(0.05)
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

  it('starts a sustained note once, and a clip from its own offset', async () => {
    installHost()
    const engine = new AudioEngine()
    const project = createEmptyProject(48000)
    project.metronomeEnabled = false
    project.loopEnabled = true
    project.loopStartSample = 0
    project.loopEndSample = project.sampleRate * 2
    const keys = project.tracks.find((track) => track.type === 'midi')!
    keys.midiClips.push({
      id: 'held-clip',
      name: 'Held',
      startBeat: 0,
      durationBeats: 4,
      notes: [{ id: 'held', pitch: 64, startBeat: 0, durationBeats: 2, velocity: 0.8 }],
    })
    const samples = new Float32Array(96000)
    samples.fill(0.2)
    const vocal = project.tracks.find((track) => track.type === 'audio')!
    vocal.clips.push({
      id: 'voice',
      name: 'Voice',
      bufferId: 'take',
      startSample: 12000,
      offsetSamples: 5000,
      durationSamples: 48000,
      fadeInSamples: 48000,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
    })
    engine.sync(project, (id) => (id === 'take' ? { id, name: 'take', sampleRate: 48000, channels: [samples] } : undefined))
    await engine.play(0)
    const ctx = engine.ctx as unknown as FakeContext
    for (let step = 0; step < 80; step++) {
      ctx.currentTime += 0.025
      engine.wakeTransport()
    }
    const notes = ctx.starts.filter((start) => start.kind === 'osc')
    expect(notes).toHaveLength(2)
    expect((notes[1]?.when ?? 0) - (notes[0]?.when ?? 0)).toBeGreaterThan(1.5)
    const clips = ctx.starts.filter((start) => start.kind === 'buffer-source' && start.duration != null)
    expect(clips.length).toBeGreaterThan(1)
    const origin = (engine as unknown as { playOriginCtx: number }).playOriginCtx
    expect(clips[0]?.offset).toBeCloseTo(5000 / 48000, 5)
    expect(clips[0]?.when).toBeCloseTo(origin + 12000 / 48000, 5)
    for (let index = 1; index < clips.length; index++) {
      const previous = clips[index - 1]!
      const next = clips[index]!
      const gap = next.when - ((previous.when ?? 0) + (previous.duration ?? 0))
      expect(gap).toBeGreaterThan(-0.001)
      if (next.offset + 1e-4 < previous.offset) {
        expect(next.offset).toBeCloseTo(5000 / 48000, 4)
      } else {
        expect(gap).toBeLessThan(0.002)
        expect(next.offset).toBeGreaterThan(previous.offset)
      }
    }
    const firstSliceEnd = (clips[0]?.when ?? 0) + (clips[0]?.duration ?? 0)
    const earlyFull = ctx.linearRamps.some((ramp) => ramp.value > 0.8 && ramp.time < firstSliceEnd - 0.01)
    expect(earlyFull).toBe(false)
    const continued = ctx.linearRamps.some((ramp) => ramp.value > 0.05 && ramp.value < 0.25)
    expect(continued).toBe(true)
    engine.stop()
    expect(engine.stability().playing).toBe(false)

    const loopSamples = new Float32Array(project.loopEndSample)
    for (let i = 0; i < loopSamples.length; i++) loopSamples[i] = Math.sin((2 * Math.PI * 12 * i) / loopSamples.length) * 0.5
    vocal.clips.splice(0, vocal.clips.length, {
      id: 'fill',
      name: 'Fill',
      bufferId: 'fill',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: loopSamples.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
    })
    engine.sync(project, (id) => (id === 'fill' ? { id, name: 'fill', sampleRate: 48000, channels: [loopSamples] } : undefined))
    await engine.play(0)
    const looping = (engine.ctx as unknown as FakeContext).starts.filter((start) => start.kind === 'buffer-source' && start.duration == null)
    expect(looping.length).toBe(1)
    for (let step = 0; step < 40; step++) {
      ;(engine.ctx as unknown as FakeContext).currentTime += 0.05
      engine.wakeTransport()
    }
    const still = (engine.ctx as unknown as FakeContext).starts.filter((start) => start.kind === 'buffer-source' && start.duration == null)
    expect(still.length).toBe(1)
    engine.stop()

    await engine.play(0)
    expect(engine.positionSamples).toBe(0)
    expect(engine.stability().playing).toBe(true)
    engine.stop()
  })

  it('does not revive playback when stop wins, including a seek back to zero', async () => {
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
    engine.stop()
    engine.seek(0)
    release!()
    await first
    await flush()
    expect(engine.stability().playing).toBe(false)
    expect(engine.status).toBe('stopped')
    await engine.play(0)
    expect(engine.positionSamples).toBe(0)
    expect(engine.stability().playing).toBe(true)
    engine.stop()
  })

  it('punches in on a running transport and resumes after the tab returns', async () => {
    installHost()
    const engine = new AudioEngine()
    const project = createEmptyProject(48000)
    project.metronomeEnabled = false
    engine.sync(project, () => undefined)
    await engine.play(0)
    const ctx = engine.ctx as unknown as FakeContext
    ctx.currentTime += 0.5
    engine.wakeTransport()
    const at = engine.positionSamples
    expect(at).toBeGreaterThan(1000)
    await engine.beginRecord({ fromSample: at, inputs: [], countIn: false })
    expect(engine.status).toBe('recording')
    expect(engine.stability().playing).toBe(true)
    engine.stop()
    await engine.play(at)
    visibility.state = 'hidden'
    for (const listener of visListeners) listener()
    await flush()
    expect(engine.stability().playing).toBe(false)
    expect(engine.stability().heldPlaying).toBe(true)
    visibility.state = 'visible'
    for (const listener of visListeners) listener()
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(engine.stability().playing).toBe(true)
    expect(engine.positionSamples).toBeGreaterThan(1000)
    engine.stop()
  })
})

function indexEnabled(id: string) {
  return id.charCodeAt(id.length - 1) % 2 === 0
}
