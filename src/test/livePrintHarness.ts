/**
 * Null renderClipToAudio against real AudioEngine playback.
 * Each case opens an interactive AudioContext at 44.1 kHz and at 48 kHz,
 * calls resume via openDevice, retargets the project, then records the
 * track input while Play runs.
 */

import { AudioEngine } from '../audio/engine'
import { emptyPatternLoopSamples } from '../model/channelRack'
import { renderClipToAudio } from '../audio/renderToAudio'
import { createPlugin } from '../audio/plugins/catalog'
import { makeDevice } from '../model/rack'
import { createEmptyProject, type Track } from '../model/types'
import { emptySampler } from '../audio/sample/engine'
import { ProjectStore } from '../state/store'

export interface NullRow {
  case: string
  rate: number
  peakDb: number
  rmsDb: number
  corr: number
  lag: number
  livePeak: number
  bouncePeak: number
}

const RATES = [44100, 48000]

export async function runLivePrintNull(): Promise<NullRow[]> {
  const rows: NullRow[] = []
  for (const rate of RATES) {
    rows.push(await runCase(rate, 'Keys dry', setupKeys(false, false)))
    rows.push(await runCase(rate, 'Keys filter+reverb', setupKeys(true, false)))
    rows.push(await runCase(rate, 'Track reverb insert', setupKeys(false, true)))
    rows.push(await runCase(rate, 'Sampler voice', setupSampler()))
    rows.push(await runCase(rate, '808 Bass', setupBass()))
    rows.push(await runCase(rate, 'Beat Machine song', setupDrums('song')))
    rows.push(await runCase(rate, 'Beat Machine pattern', setupDrums('pattern')))
  }
  return rows
}

function setupKeys(devices: boolean, inserts: boolean) {
  return (store: ProjectStore) => {
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    if (devices) keys.rack!.devices.push(makeDevice('filter'), makeDevice('reverb'))
    if (inserts) {
      const reverb = createPlugin('reverb')
      reverb.params = { ...reverb.params, kind: 2, mix: 0.45, size: 0.8, decay: 0.7 }
      keys.plugins = [reverb]
    }
    keys.midiClips = [midi('lead', 'Lead', 0, 1, [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }])]
    return { track: keys, target: { kind: 'midi' as const, trackId: keys.id, clipId: 'lead' }, effects: inserts, seconds: 2.2 }
  }
}

function setupSampler() {
  return (store: ProjectStore) => {
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    const tone = new Float32Array(4800)
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.5
    const plugin = createPlugin('sampler')
    plugin.sampler = { ...emptySampler(), bufferId: 'tone', root: 60, loopMode: 2 }
    track.instrument = 'sampler'
    track.plugins = [plugin]
    track.midiClips = [midi('lead', 'Lead', 0, 1, [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }])]
    store.buffers.set('tone', { id: 'tone', name: 'tone', sampleRate: 48000, channels: [tone] })
    return { track, target: { kind: 'midi' as const, trackId: track.id, clipId: 'lead' }, effects: false, seconds: 1.6 }
  }
}

function setupBass() {
  return (store: ProjectStore) => {
    const id = store.addQuickTrack('bass808')!
    const track = store.track(id)!
    track.midiClips = [midi('slide', 'Slide', 0, 2, [
      { id: 'a', pitch: 36, startBeat: 0, durationBeats: 1, velocity: 0.9 },
      { id: 'b', pitch: 48, startBeat: 1, durationBeats: 1, velocity: 0.85, slide: true },
    ])]
    return { track, target: { kind: 'midi' as const, trackId: id, clipId: 'slide' }, effects: false, seconds: 3 }
  }
}

function setupDrums(mode: 'song' | 'pattern') {
  return (store: ProjectStore) => {
    if (mode === 'song') store.setRackMode('song')
    store.placePattern(0)
    const clip = store.project.patternClips!.find((item) => item.placed)!
    const track = store.track(clip.trackId || '') ?? store.project.tracks.find((item) => item.type === 'midi')!
    return { track, target: { kind: 'pattern' as const, clipId: clip.id }, effects: false, seconds: 2.6 }
  }
}

async function runCase(rate: number, name: string, prepare: (store: ProjectStore) => {
  track: Track
  target: { kind: 'midi'; trackId: string; clipId: string } | { kind: 'pattern'; clipId: string }
  effects: boolean
  seconds: number
}): Promise<NullRow> {
  const store = new ProjectStore(createEmptyProject(48000, name))
  store.project.metronomeEnabled = false
  const plan = prepare(store)
  const engine = new AudioEngine()
  try {
    const ctx = await engine.openDevice(rate)
    store.retargetSampleRate(ctx.sampleRate)
    engine.sync(store.project, (id) => store.buffers.get(id))
    await engine.insertsReady()
    const live = await record(engine, ctx, plan.track.id, plan.seconds)
    const bounce = await renderClipToAudio({
      project: store.project,
      assets: store.buffers,
      target: plan.target,
      includeEffects: plan.effects,
      normalize: false,
    })
    const loop = name.includes('pattern') ? emptyPatternLoopSamples(store.project) : 0
    const limit = loop > 16 ? Math.max(1, loop - Math.round(ctx.sampleRate * 0.05)) : bounce.channels[0].length
    const row = score(name, ctx.sampleRate, live[0], bounce.channels[0], limit)
    if (row.livePeak < 1e-4) return { ...row, case: `${name} (live silent)` }
    return row
  } finally {
    engine.closeDevice()
  }
}

async function record(engine: AudioEngine, ctx: AudioContext, trackId: string, seconds: number) {
  const url = URL.createObjectURL(new Blob([TAP], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  const node = new AudioWorkletNode(ctx, 'cue-live-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  })
  const silent = ctx.createGain()
  silent.gain.value = 0
  node.connect(silent)
  silent.connect(ctx.destination)
  if (!engine.probeInstrument(trackId, node)) throw new Error(`no strip for ${trackId}`)
  const dumped = new Promise<Float32Array[]>((resolve) => {
    node.port.onmessage = (event: MessageEvent<{ left: Float32Array; right: Float32Array }>) => {
      resolve([event.data.left, event.data.right])
    }
  })
  await engine.play(0)
  await new Promise((resolve) => setTimeout(resolve, Math.ceil(seconds * 1000)))
  engine.stop()
  node.port.postMessage('dump')
  const audio = await dumped
  node.disconnect()
  silent.disconnect()
  return audio
}

function score(name: string, rate: number, live: ArrayLike<number>, bounce: ArrayLike<number>, limit = bounce.length): NullRow {
  const lag = bestLag(live, bounce, rate)
  const count = Math.min(limit, bounce.length, Math.max(0, live.length - lag))
  let energy = 0
  let peak = 0
  let ab = 0
  let aa = 0
  let bb = 0
  let livePeak = 0
  let bouncePeak = 0
  for (let i = 0; i < count; i++) {
    const heard = live[lag + i] || 0
    const printed = bounce[i] || 0
    const delta = heard - printed
    energy += delta * delta
    peak = Math.max(peak, Math.abs(delta))
    ab += heard * printed
    aa += heard * heard
    bb += printed * printed
    livePeak = Math.max(livePeak, Math.abs(heard))
    bouncePeak = Math.max(bouncePeak, Math.abs(printed))
  }
  const db = (value: number) => (value <= 1e-12 ? -180 : 20 * Math.log10(value))
  const corr = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
  return {
    case: name,
    rate,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(energy / Math.max(1, count))),
    corr,
    lag,
    livePeak,
    bouncePeak,
  }
}

function bestLag(live: ArrayLike<number>, bounce: ArrayLike<number>, _rate: number) {
  const guess = Math.max(0, onset(live, 1e-4) - onset(bounce, 1e-4))
  const from = Math.max(0, guess - 256)
  const to = Math.min(Math.max(0, live.length - 8), guess + 32)
  let best = guess
  let bestEnergy = Number.POSITIVE_INFINITY
  for (let lag = from; lag <= to; lag++) {
    let energy = 0
    const end = Math.min(bounce.length, live.length - lag)
    for (let i = 0; i < end; i += 2) {
      const delta = (live[lag + i] || 0) - (bounce[i] || 0)
      energy += delta * delta
    }
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = lag
    }
  }
  return best
}

function onset(data: ArrayLike<number>, floor = 1e-4) {
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] || 0) > floor) return i
  return 0
}

function midi(id: string, name: string, startBeat: number, durationBeats: number, notes: Track['midiClips'][number]['notes']): Track['midiClips'][number] {
  return { id, name, startBeat, durationBeats, notes }
}

const TAP = `
class CueLiveTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.left = []
    this.right = []
    this.port.onmessage = () => {
      let count = 0
      for (const chunk of this.left) count += chunk.length
      const left = new Float32Array(count)
      const right = new Float32Array(count)
      let offset = 0
      for (let i = 0; i < this.left.length; i++) {
        left.set(this.left[i], offset)
        right.set(this.right[i], offset)
        offset += this.left[i].length
      }
      this.left = []
      this.right = []
      this.port.postMessage({ left, right }, [left.buffer, right.buffer])
    }
  }
  process(inputs) {
    const left = inputs[0] && inputs[0][0]
    const right = (inputs[0] && inputs[0][1]) || left
    if (left && left.length) {
      this.left.push(left.slice())
      this.right.push(right.slice())
    }
    return true
  }
}
registerProcessor('cue-live-tap', CueLiveTap)
`
