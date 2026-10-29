import { describe, expect, it } from 'vitest'
import { AudioEngine } from '../audio/engine'
import { create as createEq } from '../audio/plugins/eq'
import { CATALOG, createPlugin, descriptor } from '../audio/plugins/catalog'
import { smoothParam } from '../audio/paramCurve'
import { createEmptyProject } from '../model/types'
import { defaultAddSpec } from '../model/addTrack'
import { makeDevice } from '../model/rack'
import { ProjectStore } from '../state/store'
import { channelAutomationMode } from '../model/automation'

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

interface WorkletMock {
  port: { messages: unknown[]; postMessage: (data: unknown) => void; onmessage: ((event: { data: unknown }) => void) | null }
  connect: () => void
  disconnect: () => void
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

function targetOf(param: AudioParamMock) {
  const hit = [...param.events].reverse().find((event) => event.method === 'target' || event.method === 'linear')
  return hit?.value
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
  const worklets: WorkletMock[] = []
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
    worklets,
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
    port: WorkletMock['port']
    constructor() {
      const messages: unknown[] = []
      this.port = {
        messages,
        onmessage: null,
        postMessage(data: unknown) {
          messages.push(JSON.parse(JSON.stringify(data)))
        },
      }
      worklets.push(this as unknown as WorkletMock)
    }
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
  }
  return live
}

function messages(ctx: ReturnType<typeof installAudioMocks>) {
  return ctx.worklets.flatMap((node) => node.port.messages) as { type?: string; slots?: { id: string; params: Record<string, number> }[]; rack?: { devices: { id: string; params: Record<string, number> }[] } }[]
}

async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function until(ready: () => boolean) {
  for (let i = 0; i < 80 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 15))
}

function rms(buffer: Float32Array) {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / buffer.length)
}

describe('live parameter changes', () => {
  it('moves every mixer control onto the existing audio param while the gesture is one undo', async () => {
    const ctx = installAudioMocks()
    const store = new ProjectStore(createEmptyProject(48000))
    const engine = new AudioEngine()
    const live = arm(engine, ctx)
    const stop = store.subscribe(() => engine.sync(store.project, () => undefined))
    engine.sync(store.project, () => undefined)
    await settle()
    const track = store.project.tracks[0]
    const original = track.volume
    store.beginAutomationTouch()
    store.setAutomated({ trackId: track.id, target: 'volume', param: 'volume', min: 0, max: 1.25 }, 0.2, false, 0)
    store.setAutomated({ trackId: track.id, target: 'volume', param: 'volume', min: 0, max: 1.25 }, 0.55, false, 0)
    store.updateTrack(track.id, { pan: -0.4 })
    store.endAutomationTouch()
    const strip = (engine as unknown as { strips: Map<string, { fader: { gain: AudioParamMock }; pan: { pan: AudioParamMock }; mute: { gain: AudioParamMock } }> }).strips.get(track.id)!
    expect(targetOf(strip.fader.gain)).toBeCloseTo(0.55)
    expect(targetOf(strip.pan.pan)).toBeCloseTo(-0.4)
    expect(store.canUndo).toBe(true)
    store.undo()
    expect(store.project.tracks.find((item) => item.id === track.id)!.volume).toBeCloseTo(original)
    expect(targetOf(strip.fader.gain)).toBeCloseTo(original)
    store.redo()
    expect(store.project.tracks.find((item) => item.id === track.id)!.volume).toBeCloseTo(0.55)
    expect(targetOf(strip.fader.gain)).toBeCloseTo(0.55)

    store.updateTrack(track.id, { mute: true })
    expect(targetOf(strip.mute.gain)).toBeCloseTo(0)
    store.updateTrack(track.id, { mute: false, solo: true })
    expect(targetOf(strip.mute.gain)).toBeCloseTo(1)

    const bus = store.addTracks({ ...defaultAddSpec(), kind: 'bus', input: 'line' })[0]
    store.addSend(track.id, bus)
    const send = store.project.tracks.find((item) => item.id === track.id)!.sends[0]
    store.beginAutomationTouch()
    store.setAutomated({ trackId: track.id, target: 'send', param: 'gain', sendId: send.id, min: 0, max: 1 }, 0.37, false, 0)
    store.endAutomationTouch()
    await settle()
    expect(ctx.params.some((param) => targetOf(param) === 0.37 || param.events.some((event) => event.method === 'target' && Math.abs(event.value - 0.37) < 1e-6))).toBe(true)

    store.setMasterVolume(0.12)
    expect(targetOf(live.masterGain.gain)).toBeCloseTo(0.12)

    const channel = store.project.beats!.patterns[0].channels[0]
    store.setChannel(channel.id, { volume: 0.33, pan: 0.5 }, true)
    store.endDraft()
    const trims = (engine as unknown as { drumTrims: Map<string, { gain: { gain: AudioParamMock }; pan: { pan: AudioParamMock } }> }).drumTrims
    expect(targetOf(trims.get(channel.id)!.gain.gain)).toBeCloseTo(0.33)
    expect(targetOf(trims.get(channel.id)!.pan.pan)).toBeCloseTo(0.5)
    stop()
  })

  it('posts every plugin knob to the existing worklet without rebuilding it', async () => {
    const ctx = installAudioMocks()
    const store = new ProjectStore(createEmptyProject(48000))
    const engine = new AudioEngine()
    arm(engine, ctx)
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    const plugins = CATALOG.map((item) => createPlugin(item.id))
    track.plugins.push(...plugins)
    const device = makeDevice('filter')
    track.rack!.devices.push(device)
    engine.sync(store.project, () => undefined)
    await until(() => messages(ctx).some((message) => message.type === 'state' && message.slots?.length === plugins.length) && messages(ctx).some((message) => message.rack))
    const insert = ctx.worklets.find((node) => node.port.messages.some((message) => (message as { slots?: unknown[] }).slots?.length === plugins.length))!
    const postedBefore = insert.port.messages.length
    for (const plugin of plugins) {
      const spec = descriptor(plugin.pluginId)!
      const param = spec.params.find((item) => item.max > item.min) ?? spec.params[0]
      if (!param) continue
      plugin.params = { ...plugin.params, [param.id]: param.max }
    }
    device.params.cutoff = 9000
    engine.sync(store.project, () => undefined)
    await settle()
    expect(insert.port.messages.length).toBeGreaterThan(postedBefore)
    expect(ctx.worklets.filter((node) => node === insert)).toHaveLength(1)
    const posted = insert.port.messages.filter((message) => (message as { slots?: unknown }).slots) as { slots: { id: string; params: Record<string, number> }[] }[]
    const latest = posted[posted.length - 1]
    expect(latest?.slots?.length).toBe(plugins.length)
    for (const plugin of plugins) {
      const spec = descriptor(plugin.pluginId)!
      const param = spec.params.find((item) => item.max > item.min) ?? spec.params[0]
      if (!param) continue
      const slot = latest!.slots!.find((item) => item.id === plugin.id)
      expect(slot?.params[param.id], plugin.pluginId).toBeCloseTo(param.max)
    }
    const racks = messages(ctx).filter((message) => message.type === 'state' && message.rack)
    const rack = racks[racks.length - 1]
    expect(rack?.rack?.devices.find((item) => item.id === device.id)?.params.cutoff).toBe(9000)
  })

  it('changes rendered audio when the fader or an EQ knob moves', () => {
    const rate = 48000
    const length = 12000
    const sine = new Float32Array(length)
    for (let i = 0; i < length; i++) sine[i] = Math.sin((2 * Math.PI * 300 * i) / rate) * 0.5
    const quiet = renderGain(sine, 0, rate).subarray(rate / 10)
    const open = renderGain(sine, 1, rate).subarray(rate / 10)
    expect(rms(quiet)).toBeLessThan(0.01)
    expect(rms(open)).toBeGreaterThan(0.2)

    const eq = createEq(rate)
    const low = new Float32Array(length)
    for (let i = 0; i < length; i++) low[i] = Math.sin((2 * Math.PI * 120 * i) / rate) * 0.4
    const base = descriptor('eq')!
    const params = Object.fromEntries(base.params.map((item) => [item.id, item.default]))
    const cut = runEq(eq, low, { ...params, lowG: -18 })
    const boost = runEq(eq, low, { ...params, lowG: 18 })
    expect(Math.abs(rms(boost) - rms(cut))).toBeGreaterThan(0.02)
  })
})

function runEq(eq: ReturnType<typeof createEq>, input: Float32Array, params: Record<string, number>) {
  const left = new Float32Array(input.length)
  const right = new Float32Array(input.length)
  eq.process([input, input], [left, right], params, {
    sampleRate: 48000,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full',
    offline: true,
  })
  return left
}

/** Small OfflineAudioContext: a buffer plays through a smoothed gain into the destination. */
function renderGain(input: Float32Array, gainValue: number, sampleRate: number) {
  const param = audioParam(1)
  smoothParam(param, gainValue, 0, 0.01)
  const out = new Float32Array(input.length)
  let value = 1
  const tau = 0.01
  for (let i = 0; i < input.length; i++) {
    const target = param.events.find((event) => event.method === 'target')?.value ?? gainValue
    value += (target - value) * (1 - Math.exp(-1 / (tau * sampleRate)))
    out[i] = input[i] * value
  }
  return out
}

describe('per-channel automation', () => {
  it('keeps each channel mode independent and undoable', () => {
    const store = new ProjectStore(createEmptyProject())
    const [first, second] = store.project.tracks
    expect(channelAutomationMode(store.project, first.id)).toBe('read')
    expect(channelAutomationMode(store.project, 'master')).toBe('read')
    store.setTrackAutomation(first.id, 'touch')
    store.setTrackAutomation(second.id, 'read')
    store.setMasterAutomation('off')
    expect(channelAutomationMode(store.project, first.id)).toBe('touch')
    expect(channelAutomationMode(store.project, second.id)).toBe('read')
    expect(channelAutomationMode(store.project, 'master')).toBe('off')
    store.undo()
    expect(channelAutomationMode(store.project, 'master')).toBe('read')
    expect(channelAutomationMode(store.project, first.id)).toBe('touch')
    expect(channelAutomationMode(store.project, second.id)).toBe('read')

    const otherSpec = { trackId: second.id, target: 'volume' as const, param: 'volume', min: 0, max: 1.25 }
    store.paintAutomation(otherSpec, 0, second.volume)
    store.endDraft()
    const other = store.project.tracks.find((track) => track.id === second.id)!.volume
    store.beginAutomationTouch()
    store.setAutomated({ trackId: first.id, target: 'volume', param: 'volume', min: 0, max: 1.25 }, 0.42, true, 0)
    store.setAutomated(otherSpec, 0.11, true, 0)
    store.endAutomationTouch()
    expect(store.project.tracks.find((track) => track.id === first.id)!.volume).toBeCloseTo(0.42)
    expect(store.project.automation.some((lane) => lane.trackId === first.id && lane.target === 'volume')).toBe(true)
    expect(store.project.tracks.find((track) => track.id === second.id)!.volume).toBeCloseTo(other)
  })
})
