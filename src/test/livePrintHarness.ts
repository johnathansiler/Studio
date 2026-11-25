/**
 * Browser null of renderClipToAudio against a separately built live graph:
 * cueharbor-rack, the insert worklet, and the transport oscillators.
 * Playwright loads this module. Vitest does not.
 */

import { CueRackVoice } from '../audio/rack/voice'
import { releaseTailSamples, renderClipToAudio } from '../audio/renderToAudio'
import { writeSharedNoise } from '../audio/sharedNoise'
import { connectNotePan, startTransportHit } from '../audio/transportHit'
import { createPlugin } from '../audio/plugins/catalog'
import { tuneBlockScale } from '../audio/plugins/autoTune'
import { wasmDspRequested } from '../audio/wasm/flag'
import { patternHitTrack } from '../model/channelRack'
import { makeDevice } from '../model/rack'
import { beatSpanSamples, projectSampleBeat } from '../model/tempoMap'
import { patternPlayRange, renderPattern, starterPattern } from '../model/steps'
import { createEmptyProject, type PluginInstance, type Project, type Track } from '../model/types'
import type { RenderedHit } from '../model/steps'
import { emptySampler } from '../audio/sample/engine'
import { ProjectStore } from '../state/store'

export interface NullRow {
  case: string
  peakDb: number
  rmsDb: number
  corr: number
  samples: number
}

export async function runLivePrintNull(): Promise<NullRow[]> {
  const rows: NullRow[] = []
  rows.push(await keysRow('Keys dry', false, false))
  rows.push(await keysRow('Keys filter+reverb', true, false))
  rows.push(await keysRow('Track reverb insert', false, true))
  rows.push(await bassRow())
  rows.push(await drumRow())
  rows.push(await samplerRow())
  return rows
}

async function keysRow(name: string, devices: boolean, inserts: boolean): Promise<NullRow> {
  const store = new ProjectStore(createEmptyProject(48000, name))
  const keys = store.project.tracks.find((track) => track.type === 'midi')!
  if (devices) keys.rack!.devices.push(makeDevice('filter'), makeDevice('reverb'))
  if (inserts) {
    const reverb = createPlugin('reverb')
    reverb.params = { ...reverb.params, kind: 2, mix: 0.45, size: 0.8, decay: 0.7 }
    keys.plugins = [reverb]
  }
  keys.midiClips = [clip('lead', 'Lead', 0, 1, [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }])]
  return nullMidi(name, store, keys, 'lead', inserts)
}

async function bassRow(): Promise<NullRow> {
  const store = new ProjectStore(createEmptyProject(48000, '808'))
  const id = store.addQuickTrack('bass808')!
  const track = store.track(id)!
  track.midiClips = [clip('slide', 'Slide', 0, 2, [
    { id: 'a', pitch: 36, startBeat: 0, durationBeats: 1, velocity: 0.9 },
    { id: 'b', pitch: 48, startBeat: 1, durationBeats: 1, velocity: 0.85, slide: true },
  ])]
  return nullMidi('808 Bass', store, track, 'slide', false)
}

async function nullMidi(name: string, store: ProjectStore, track: Track, clipId: string, inserts: boolean): Promise<NullRow> {
  const clip = track.midiClips.find((item) => item.id === clipId)!
  const span = beatSpanSamples(store.project, clip.startBeat, clip.durationBeats)
  const length = Math.max(1, span.duration + releaseTailSamples(track, 48000, inserts))
  const notes = notesFor(store.project, clip, span.start, length)
  const live = await captureRack(track, store.project, span.start, notes, length)
  if (inserts) {
    const printed = await captureInsert(track.plugins, live, store.project, span.start)
    const bounce = await renderClipToAudio({
      project: store.project,
      assets: store.buffers,
      target: { kind: 'midi', trackId: track.id, clipId },
      includeEffects: true,
      normalize: false,
    })
    return score(name, bounce.channels[0], printed[0])
  }
  const bounce = await renderClipToAudio({
    project: store.project,
    assets: store.buffers,
    target: { kind: 'midi', trackId: track.id, clipId },
    includeEffects: false,
    normalize: false,
  })
  const clock = new CueRackVoice(48000)
  clock.onMessage({ type: 'clock', originTime: 0, originBeat: projectSampleBeat(store.project, span.start), tempo: store.project.tempo, lanes: [] })
  clock.onMessage({ type: 'state', rack: track.rack!, tempo: store.project.tempo, quality: 'full', buffers: [] })
  for (const note of notes) {
    clock.onMessage({ type: 'note', pitch: note.pitch, vel: note.velocity, time: note.time, slide: note.slide })
    clock.onMessage({ type: 'note', pitch: note.pitch, vel: 0, time: note.off })
  }
  const pulled = clock.pull(length)
  const clockRow = score(`${name} clock`, live[0], pulled[0])
  if (clockRow.peakDb > -60) return { ...score(name, bounce.channels[0], live[0]), case: `${name} (worklet vs bounce; clock ${clockRow.peakDb.toFixed(1)} dB)` }
  return score(name, bounce.channels[0], live[0])
}

async function drumRow(): Promise<NullRow> {
  const store = new ProjectStore(createEmptyProject(48000, 'kit'))
  const keys = store.project.tracks.find((track) => track.type === 'midi')!
  const pattern = starterPattern()
  pattern.swing = 0
  store.project.beats = { activeId: pattern.id, patterns: [pattern] }
  store.project.patternClips = [{
    id: 'beat',
    patternId: pattern.id,
    startBeat: 0,
    lengthBeats: 4,
    scene: null,
    trackId: keys.id,
    placed: true,
  }]
  const bounce = await renderClipToAudio({
    project: store.project,
    assets: store.buffers,
    target: { kind: 'pattern', clipId: 'beat' },
    includeEffects: false,
    normalize: false,
  })
  const span = beatSpanSamples(store.project, 0, 4)
  const length = Math.max(bounce.channels[0].length, span.duration + releaseTailSamples(keys, 48000, false))
  const live = await captureDrums(store.project, keys.id, length)
  return score('Beat Machine kit', bounce.channels[0], live)
}

async function samplerRow(): Promise<NullRow> {
  const store = new ProjectStore(createEmptyProject(48000, 'sampler'))
  const track = store.project.tracks.find((item) => item.type === 'midi')!
  const tone = new Float32Array(4800)
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.5
  const plugin = createPlugin('sampler')
  plugin.sampler = { ...emptySampler(), bufferId: 'tone', root: 60, loopMode: 2 }
  track.instrument = 'sampler'
  track.plugins = [plugin]
  track.midiClips = [clip('lead', 'Lead', 0, 1, [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }])]
  store.buffers.set('tone', { id: 'tone', name: 'tone', sampleRate: 48000, channels: [tone] })
  const span = beatSpanSamples(store.project, 0, 1)
  const length = Math.max(1, span.duration + releaseTailSamples(track, 48000, false))
  const notes = notesFor(store.project, track.midiClips[0], span.start, length).flatMap((note) => [
    { time: note.time, pitch: note.pitch, vel: note.velocity },
    { time: note.off, pitch: note.pitch, vel: 0 },
  ])
  const live = await captureSampler(plugin, tone, notes, length, store.project, span.start)
  const bounce = await renderClipToAudio({
    project: store.project,
    assets: store.buffers,
    target: { kind: 'midi', trackId: track.id, clipId: 'lead' },
    includeEffects: false,
    normalize: false,
  })
  return score('Sampler voice', bounce.channels[0], live[0])
}

function notesFor(project: Project, item: Track['midiClips'][number], origin: number, length: number) {
  const end = origin + length
  const notes: { pitch: number; velocity: number; time: number; off: number; slide: boolean }[] = []
  for (const note of item.notes) {
    const span = beatSpanSamples(project, item.startBeat + note.startBeat, note.durationBeats)
    if (span.start >= end || span.start + span.duration < origin) continue
    notes.push({
      pitch: note.pitch,
      velocity: note.velocity,
      time: Math.max(0, (span.start - origin) / 48000),
      off: Math.max(0, (span.start + span.duration - origin) / 48000),
      slide: !!note.slide,
    })
  }
  return notes
}

async function captureRack(track: Track, project: Project, origin: number, notes: { pitch: number; velocity: number; time: number; off: number; slide: boolean }[], length: number) {
  const url = (await import('../audio/rack/rack.worklet.ts?worker&url')).default as string
  const ctx = new OfflineAudioContext(2, length, 48000)
  await ctx.audioWorklet.addModule(url)
  const node = new AudioWorkletNode(ctx, 'cueharbor-rack', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
  node.connect(ctx.destination)
  await waitFor(node, 'ready', () => node.port.postMessage({ type: 'state', rack: track.rack, tempo: project.tempo, quality: 'full', buffers: [] }))
  node.port.postMessage({ type: 'clock', originTime: 0, originBeat: projectSampleBeat(project, origin), tempo: project.tempo, lanes: [] })
  for (const note of notes) {
    node.port.postMessage({ type: 'note', pitch: note.pitch, vel: note.velocity, time: note.time, slide: note.slide })
    node.port.postMessage({ type: 'note', pitch: note.pitch, vel: 0, time: note.off })
  }
  await waitFor(node, 'armed', () => node.port.postMessage({ type: 'arm' }))
  const rendered = await ctx.startRendering()
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()]
}

async function captureInsert(plugins: PluginInstance[], input: Float32Array[], project: Project, origin: number) {
  const frames = input[0].length
  const opened = await openInsert(frames, false)
  const buffer = opened.ctx.createBuffer(2, frames, 48000)
  buffer.copyToChannel(pcm(input[0]), 0)
  buffer.copyToChannel(pcm(input[1] ?? input[0]), 1)
  const src = opened.ctx.createBufferSource()
  src.buffer = buffer
  src.connect(opened.worklet)
  await waitFor(opened.worklet, 'ready', () => opened.worklet.port.postMessage(insertState(plugins, project, origin)))
  src.start(0)
  await waitFor(opened.worklet, 'armed', () => opened.worklet.port.postMessage({ type: 'arm' }))
  const rendered = await opened.ctx.startRendering()
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()]
}

async function captureSampler(
  plugin: PluginInstance,
  channel: Float32Array,
  events: { time: number; pitch: number; vel: number }[],
  length: number,
  project: Project,
  origin: number,
) {
  const opened = await openInsert(length, true)
  await waitFor(opened.worklet, 'ready', () => opened.worklet.port.postMessage(insertState([plugin], project, origin)))
  opened.worklet.port.postMessage({ type: 'buffer', id: plugin.sampler?.bufferId, channel })
  for (const event of events) opened.worklet.port.postMessage({ type: 'note', id: plugin.id, pitch: event.pitch, vel: event.vel, time: event.time })
  await waitFor(opened.worklet, 'armed', () => opened.worklet.port.postMessage({ type: 'arm' }))
  const rendered = await opened.ctx.startRendering()
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()]
}

async function openInsert(frames: number, generator: boolean) {
  const url = (await import('../audio/insert.worklet.ts?worker&url')).default as string
  const ctx = new OfflineAudioContext(2, frames, 48000)
  await ctx.audioWorklet.addModule(url)
  const worklet = new AudioWorkletNode(ctx, 'cueharbor-insert', {
    numberOfInputs: generator ? 0 : 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
  })
  worklet.connect(ctx.destination)
  return { ctx, worklet }
}

function insertState(plugins: PluginInstance[], project: Project, origin: number) {
  const scale = tuneBlockScale(project.scale)
  return {
    type: 'state',
    slots: plugins.map((plugin) => ({
      id: plugin.id,
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      wet: plugin.wet,
      params: { ...plugin.params },
      sidechain: plugin.sidechain || '',
      sampler: plugin.sampler,
    })),
    automation: [],
    tempo: project.tempo || 120,
    projectRate: 48000,
    tempoMap: project.tempoMap ?? [],
    scaleRoot: scale.scaleRoot,
    scaleIntervals: [...scale.scaleIntervals],
    scaleCents: scale.scaleCents ? [...scale.scaleCents] : undefined,
    quality: 'full',
    wasmDsp: wasmDspRequested(),
    playing: true,
    originTime: 0,
    originSample: origin,
  }
}

async function captureDrums(project: Project, sourceId: string, length: number) {
  const ctx = new OfflineAudioContext(2, length, 48000)
  const dest = ctx.createGain()
  dest.connect(ctx.destination)
  const noise = ctx.createBuffer(1, 48000, 48000)
  writeSharedNoise(noise.getChannelData(0))
  const clip = project.patternClips!.find((item) => item.id === 'beat')!
  const pattern = project.beats!.patterns.find((item) => item.id === clip.patternId)!
  const range = patternPlayRange(clip)
  const origin = beatSpanSamples(project, clip.startBeat, clip.lengthBeats).start
  for (const hit of renderPattern(pattern, range.from, range.to)) {
    const destId = patternHitTrack(project, hit, clip)
    if (destId && destId !== sourceId) continue
    const span = beatSpanSamples(project, clip.startBeat + (hit.startBeat - range.from), hit.durationBeats)
    const when = (span.start - origin) / 48000
    if (when >= length / 48000) continue
    playHit(ctx, dest, hit, Math.max(0, when), span.duration / 48000, noise)
  }
  const rendered = await ctx.startRendering()
  const heard = rendered.getChannelData(0).slice()
  const engine = new OfflineAudioContext(2, length, 48000)
  const bus = engine.createGain()
  bus.connect(engine.destination)
  const shared = engine.createBuffer(1, 48000, 48000)
  writeSharedNoise(shared.getChannelData(0))
  for (const hit of renderPattern(pattern, range.from, range.to)) {
    const destId = patternHitTrack(project, hit, clip)
    if (destId && destId !== sourceId) continue
    const span = beatSpanSamples(project, clip.startBeat + (hit.startBeat - range.from), hit.durationBeats)
    const when = (span.start - origin) / 48000
    if (when >= length / 48000) continue
    startTransportHit({ ctx: engine, destination: bus, hit, when: Math.max(0, when), dur: span.duration / 48000, noise: shared, resident: null })
  }
  const check = await engine.startRendering()
  const row = score('drum graph', heard, check.getChannelData(0))
  if (row.peakDb > -60) throw new Error(`handwritten kit does not match the transport graph (${row.peakDb.toFixed(1)} dB)`)
  return heard
}

function playHit(ctx: OfflineAudioContext, dest: GainNode, hit: RenderedHit, when: number, dur: number, noise: AudioBuffer) {
  if (hit.kind === 'kick') {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(160, when)
    osc.frequency.exponentialRampToValueAtTime(48, when + Math.max(0.02, Math.min(0.18, dur)))
    envelope(ctx, osc, when, Math.min(0.28, dur + 0.05), hit, undefined, dest)
    return
  }
  if (hit.kind === 'perc') {
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 440 * 2 ** ((hit.pitch - 69) / 12)
    envelope(ctx, osc, when, Math.min(0.16, dur), hit, undefined, dest)
    return
  }
  const source = ctx.createBufferSource()
  source.buffer = noise
  if (hit.kind === 'hat') {
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 7000
    source.connect(filter)
    envelope(ctx, filter, when, Math.min(0.06, dur), hit, source, dest)
    return
  }
  if (hit.kind === 'clap') {
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 1400
    source.connect(filter)
    envelope(ctx, filter, when, Math.min(0.18, dur), hit, source, dest)
    return
  }
  const tone = ctx.createOscillator()
  tone.type = 'triangle'
  tone.frequency.value = 190
  const filter = ctx.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = 800
  source.connect(filter)
  envelope(ctx, filter, when, Math.min(0.16, dur), hit, source, dest)
  envelope(ctx, tone, when, 0.08, { ...hit, velocity: hit.velocity * 0.4 }, undefined, dest)
}

function envelope(
  ctx: BaseAudioContext,
  source: AudioNode,
  when: number,
  dur: number,
  hit: Pick<RenderedHit, 'velocity' | 'pan' | 'volume'>,
  extra: AudioNode | undefined,
  into: AudioNode,
) {
  const gain = ctx.createGain()
  const peak = Math.max(0.001, 0.22 * hit.velocity * Math.max(0, hit.volume ?? 1))
  gain.gain.setValueAtTime(0.0001, when)
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.005)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.03, dur))
  source.connect(gain)
  connectNotePan(ctx, gain, into, hit.pan || 0)
  const startable = source as AudioScheduledSourceNode
  const end = when + dur + 0.02
  if (typeof startable.start === 'function') {
    startable.start(when)
    startable.stop(end)
  }
  const extraSource = extra as AudioScheduledSourceNode | undefined
  if (extraSource && typeof extraSource.start === 'function') extraSource.start(when)
  if (extraSource && typeof extraSource.stop === 'function') extraSource.stop(end)
}

const started = new WeakSet<AudioWorkletNode>()

function waitFor(node: AudioWorkletNode, type: string, send: () => void) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      node.port.removeEventListener('message', onMessage)
      reject(new Error(`worklet ${type} timed out`))
    }, 15000)
    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type !== type) return
      clearTimeout(timer)
      node.port.removeEventListener('message', onMessage)
      resolve()
    }
    if (!started.has(node)) {
      node.port.start()
      started.add(node)
    }
    node.port.addEventListener('message', onMessage)
    send()
  })
}

function pcm(data: ArrayLike<number>) {
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data[i] || 0
  return out
}

function score(name: string, bounce: ArrayLike<number>, live: ArrayLike<number>): NullRow {
  const count = Math.min(bounce.length, live.length)
  let energy = 0
  let peak = 0
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < count; i++) {
    const left = bounce[i] || 0
    const right = live[i] || 0
    const delta = left - right
    energy += delta * delta
    peak = Math.max(peak, Math.abs(delta))
    ab += left * right
    aa += left * left
    bb += right * right
  }
  const db = (value: number) => (value <= 1e-12 ? -180 : 20 * Math.log10(value))
  const corr = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
  return { case: name, peakDb: db(peak), rmsDb: db(Math.sqrt(energy / Math.max(1, count))), corr, samples: count }
}

function clip(id: string, name: string, startBeat: number, durationBeats: number, notes: Track['midiClips'][number]['notes']): Track['midiClips'][number] {
  return { id, name, startBeat, durationBeats, notes }
}
