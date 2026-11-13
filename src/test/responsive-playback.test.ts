import { afterEach, describe, expect, it } from 'vitest'
import { AudioEngine } from '../audio/engine'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { resetTicker, subscribeFrame } from '../audio/ticker'
import { createMixDrag } from '../ui/liveMix'
import { placePlayhead, playheadPx, playheadTransform } from '../ui/playhead'

interface Recorded {
  method: string
  value: number
  time: number
  tau?: number
}

interface AudioParamMock {
  value: number
  events: Recorded[]
  cancelScheduledValues(time: number): void
  setValueAtTime(value: number, time: number): void
  setTargetAtTime(value: number, time: number, tau: number): void
  linearRampToValueAtTime(value: number, time: number): void
  exponentialRampToValueAtTime(value: number, time: number): void
}

function audioParam(initial = 0): AudioParamMock {
  const events: Recorded[] = []
  const param: AudioParamMock = {
    value: initial,
    events,
    cancelScheduledValues() {},
    setValueAtTime(value) {
      param.value = value
      events.push({ method: 'set', value, time: 0 })
    },
    setTargetAtTime(value, time, tau) {
      events.push({ method: 'target', value, time, tau })
    },
    linearRampToValueAtTime(value, time) {
      events.push({ method: 'linear', value, time })
    },
    exponentialRampToValueAtTime(value, time) {
      events.push({ method: 'exp', value, time })
    },
  }
  return param
}

class MockNode {
  readonly params: AudioParamMock[]
  constructor(params: AudioParamMock[]) {
    this.params = params
  }
  connect() { return this }
  disconnect() {}
}

function installAudioMocks() {
  const params: AudioParamMock[] = []
  const make = () => {
    const node = new MockNode(params)
    return new Proxy(node, {
      get(target, key) {
        if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key]
        if (typeof key !== 'string') return undefined
        if (key === 'gain' || key === 'frequency' || key === 'Q' || key === 'pan' || key === 'delayTime' || key === 'threshold' || key === 'knee' || key === 'ratio' || key === 'attack' || key === 'release' || key === 'playbackRate') {
          const created = audioParam(key === 'gain' ? 1 : key === 'frequency' ? 350 : 0)
          params.push(created)
          ;(target as unknown as Record<string, unknown>)[key] = created
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
  const ctx = {
    sampleRate: 48000,
    currentTime: 2,
    state: 'running',
    destination: make(),
    params,
    resume: async () => undefined,
    audioWorklet: { addModule: async () => undefined },
    createGain: () => make(),
    createDelay: () => make(),
    createBiquadFilter: () => make(),
    createDynamicsCompressor: () => make(),
    createConvolver: () => make(),
    createStereoPanner: () => make(),
    createAnalyser: () => make(),
    createOscillator: () => make(),
    createBufferSource: () => ({ ...make(), buffer: null, start() {}, stop() {}, onended: null }),
    createBuffer: (channels: number, length: number, sampleRate: number) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
      copyToChannel() {},
    }),
    createMediaStreamDestination: () => ({ stream: { getTracks: () => [] } }),
    createScriptProcessor: () => ({ ...make(), onaudioprocess: null }),
  }
  class AudioWorkletNode {
    port = { messages: [] as unknown[], onmessage: null as ((event: { data: unknown }) => void) | null, postMessage(data: unknown) { this.messages.push(data) } }
    connect() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { AudioWorkletNode: typeof AudioWorkletNode }).AudioWorkletNode = AudioWorkletNode
  return ctx
}

function arm(engine: AudioEngine, ctx: ReturnType<typeof installAudioMocks>) {
  const live = engine as unknown as {
    ctx: unknown
    localBus: unknown
    remoteBus: unknown
    masterGain: { gain: AudioParamMock }
    masterStrip: unknown
    strips: Map<string, { fader: { gain: AudioParamMock }; pan: { pan: AudioParamMock } }>
  }
  live.ctx = ctx
  live.localBus = ctx.createGain()
  live.remoteBus = ctx.createGain()
  live.masterGain = ctx.createGain() as unknown as { gain: AudioParamMock }
  const master = ctx.createGain()
  live.masterStrip = {
    input: ctx.createGain(),
    eqLow: ctx.createBiquadFilter(),
    eqMid: ctx.createBiquadFilter(),
    eqHigh: ctx.createBiquadFilter(),
    comp: ctx.createDynamicsCompressor(),
    delay: ctx.createDelay(),
    delayFb: ctx.createGain(),
    delayWet: ctx.createGain(),
    delaySend: ctx.createGain(),
    convolver: ctx.createConvolver(),
    revWet: ctx.createGain(),
    revSend: ctx.createGain(),
    pan: ctx.createStereoPanner(),
    fader: ctx.createGain(),
    mute: ctx.createGain(),
    analyser: ctx.createAnalyser(),
    output: master,
    irDecay: 0,
    compLive: false,
  }
  return live
}

function targets(param: AudioParamMock) {
  return param.events.filter((event) => event.method === 'target')
}

describe('shared animation frame', () => {
  const queue: FrameRequestCallback[] = []
  const previous = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame

  afterEach(() => {
    resetTicker()
    globalThis.requestAnimationFrame = previous
    globalThis.cancelAnimationFrame = previousCancel
    queue.length = 0
  })

  function install() {
    queue.length = 0
    let id = 0
    const jobs = new Map<number, FrameRequestCallback>()
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      id += 1
      jobs.set(id, cb)
      queue.push(cb)
      return id
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((handle: number) => {
      const cb = jobs.get(handle)
      jobs.delete(handle)
      if (!cb) return
      const index = queue.lastIndexOf(cb)
      if (index >= 0) queue.splice(index, 1)
    }) as typeof cancelAnimationFrame
  }

  function flush(now = 16) {
    const batch = queue.splice(0, queue.length)
    for (const cb of batch) cb(now)
    return batch.length
  }

  it('keeps one requestAnimationFrame loop while several meters are mounted', () => {
    install()
    const stops = [0, 1, 2, 3].map(() => subscribeFrame(() => true))
    expect(queue).toHaveLength(1)
    flush()
    expect(queue).toHaveLength(1)
    flush()
    expect(queue).toHaveLength(1)
    for (const stop of stops) stop()
    expect(queue).toHaveLength(0)
  })

  it('stops the loop once every meter has gone idle', () => {
    install()
    const stops = [0, 1, 2].map(() => subscribeFrame(() => false))
    expect(queue).toHaveLength(1)
    flush()
    expect(queue).toHaveLength(0)
    for (const stop of stops) stop()
  })
})

describe('playhead pixels', () => {
  it('uses fractional pixels from the audio clock', () => {
    const engine = new AudioEngine()
    const live = engine as unknown as { playing: boolean; ctx: { currentTime: number; sampleRate: number }; playOriginCtx: number; playOriginSample: number }
    live.playing = true
    live.ctx = { currentTime: 1 + 0.5 / 48000, sampleRate: 48000 }
    live.playOriginCtx = 1
    live.playOriginSample = 10
    const sample = engine.visualSample()
    expect(sample).toBeCloseTo(10.5)
    expect(Number.isInteger(sample)).toBe(false)
    const px = playheadPx(sample, 48000, 90)
    expect(px).toBeCloseTo((sample / 48000) * 90)
    expect(px).not.toBe(Math.round(px))
    const node = { style: { transform: '' } }
    const placed = placePlayhead(node, sample, 48000, 90)
    expect(placed).toBe(px)
    expect(node.style.transform).toBe(playheadTransform(px))
    expect(node.style.transform).toBe(`translateX(${px}px)`)
    expect(node.style.transform).toContain('.')
  })
})

describe('fader drag', () => {
  const queue: FrameRequestCallback[] = []

  afterEach(() => {
    resetTicker()
    queue.length = 0
  })

  function installFrames() {
    queue.length = 0
    let id = 0
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      queue.push(cb)
      id += 1
      return id
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
  }

  function flush() {
    const batch = queue.splice(0, queue.length)
    for (const cb of batch) cb(16)
  }

  it('a drag of N moves rebuilds the graph zero times and commits the store at most once per frame plus once on release', () => {
    installFrames()
    const ctx = installAudioMocks()
    const store = new ProjectStore(createEmptyProject(48000))
    const engine = new AudioEngine()
    const live = arm(engine, ctx)
    const stop = store.subscribe(() => engine.sync(store.project, () => undefined))
    engine.sync(store.project, () => undefined)
    const built = engine.graphRebuilds
    expect(built).toBeGreaterThan(0)
    const track = store.project.tracks[0]
    const spec = { trackId: track.id, target: 'volume' as const, param: 'volume', min: 0, max: 1.25 }
    const strip = live.strips.get(track.id)!
    const beforeTargets = targets(strip.fader.gain).length
    const origin = track.volume
    let screens = 0
    const frameCommits: number[] = []
    let version = store.version
    store.beginAutomationTouch()
    const drag = createMixDrag({
      audio: (value) => engine.previewMix('volume', track.id, value),
      project: (value) => {
        store.reviseMix(spec, value, false, 0)
      },
      screen: () => {
        screens += 1
        frameCommits.push(store.version - version)
        version = store.version
      },
      commit: () => {
        engine.armMixFollow()
        store.finishMixGesture()
      },
      sample: () => 0,
    })
    const moves = 12
    for (let i = 0; i < moves; i++) drag.move(origin * (1 - (i + 1) / (moves + 2)))
    expect(screens).toBe(0)
    expect(store.version).toBe(version)
    expect(targets(strip.fader.gain).length - beforeTargets).toBe(moves)
    expect(engine.graphRebuilds).toBe(built)

    expect(store.project.tracks[0].volume).not.toBeCloseTo(origin)
    flush()
    expect(screens).toBe(1)
    expect(frameCommits).toEqual([0])
    expect(store.version).toBe(version)

    for (let i = 0; i < 5; i++) drag.move(0.2 + i * 0.01)
    flush()
    expect(screens).toBe(2)
    expect(frameCommits.every((count) => count <= 1)).toBe(true)
    expect(engine.graphRebuilds).toBe(built)

    const beforeRelease = store.version
    drag.release()
    store.endAutomationTouch()
    expect(store.version - beforeRelease).toBe(1)
    expect(store.project.tracks.find((item) => item.id === track.id)!.volume).toBeLessThan(origin)
    expect(engine.graphRebuilds).toBe(built)
    expect(store.canUndo).toBe(true)
    store.undo()
    expect(store.project.tracks.find((item) => item.id === track.id)!.volume).toBeCloseTo(origin)
    stop()
  })
})
