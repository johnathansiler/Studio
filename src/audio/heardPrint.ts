/**
 * What the speakers hear of one clip.
 * Keys run cueharbor-rack (OfflineAudioContext worklet, or the same CueRackVoice class).
 * Beat Machine patterns run the transport oscillators and the shared noise buffer.
 * Sampler voices use the live processor flags (offline: false).
 */

import { graphPlugins } from './arrangeSources'
import { tuneBlockScale } from './plugins/autoTune'
import { wasmDspRequested } from './wasm/flag'
import { primeProcessor } from './core/adapt'
import { prepareChainPool, processChain, type ChainSlot } from './plugins/chain'
import { transparentLimit } from './liveStage'
import { CueRackVoice } from './rack/voice'
import { renderSamplerSpan } from './plugins/sampler'
import { writeSharedNoise } from './sharedNoise'
import { startTransportHit } from './transportHit'
import { patternHitTrack } from '../model/channelRack'
import { DRUM_PADS, residentDrums } from '../model/drums'
import { rackLanesFor } from '../model/automation'
import { prepareClipNotes } from '../model/midiTools'
import { beatSpanSamples, projectSampleBeat } from '../model/tempoMap'
import { patternPlayRange, renderPattern } from '../model/steps'
import { performancesOn } from '../instruments/scaler/model'
import type { AudioAsset, MidiNote, PluginInstance, Project, Track } from '../model/types'

type HeardTarget =
  | { kind: 'midi'; trackId: string; clipId: string }
  | { kind: 'pattern'; clipId: string }
  | { kind: 'track'; trackId: string }

export async function renderHeard(opts: {
  project: Project
  assets: Map<string, AudioAsset>
  target: HeardTarget
  source: Track
  origin: number
  length: number
  includeEffects: boolean
  onProgress?: (ratio: number) => void
}): Promise<Float32Array[]> {
  const rate = opts.project.sampleRate || 48000
  const dry = await renderSource(opts, rate)
  if (!opts.includeEffects) return dry
  return renderLiveInserts(opts.source, dry, opts.project, opts.origin, rate)
}

async function renderSource(opts: {
  project: Project
  assets: Map<string, AudioAsset>
  target: HeardTarget
  source: Track
  origin: number
  length: number
  onProgress?: (ratio: number) => void
}, rate: number) {
  const { project, assets, target, source, origin, length, onProgress } = opts
  const notes = midiNotes(project, source, target)
  const patterns = target.kind === 'pattern'
    ? (project.patternClips ?? []).filter((clip) => clip.id === target.clipId)
    : (project.patternClips ?? []).filter((clip) => clip.trackId === source.id && clip.scene == null && !clip.suppressed && !clip.muted)
  if (target.kind === 'pattern' || (target.kind === 'track' && patterns.length && !notes.length)) {
    return renderPatternHits(project, patterns, source.id, origin, length, rate)
  }
  const sampler = source.instrument === 'sampler'
    ? source.plugins.find((plugin) => plugin.pluginId === 'sampler' && plugin.enabled && plugin.sampler?.bufferId)
    : null
  if (sampler?.sampler) {
    const channel = assets.get(sampler.sampler.bufferId)?.channels[0]
    if (channel?.length) return renderLiveSampler(project, source, sampler, channel, origin, length, rate, target)
  }
  if (source.rack?.devices?.length) return renderRack(project, source, target, origin, length, rate, onProgress)
  return [new Float32Array(length), new Float32Array(length)]
}

async function renderRack(
  project: Project,
  source: Track,
  target: HeardTarget,
  origin: number,
  length: number,
  rate: number,
  onProgress?: (ratio: number) => void,
) {
  const tempo = project.tempo || 120
  const lanes = rackLanesFor(project, source.id)
  const originBeat = projectSampleBeat(project, origin)
  const notes = timedNotes(project, source, target, origin, length, rate)
  const viaWorklet = await renderRackWorklet(source.rack!, tempo, lanes, originBeat, notes, length, rate)
  if (viaWorklet) return viaWorklet
  const voice = new CueRackVoice(rate)
  voice.onMessage({ type: 'clock', originTime: 0, originBeat, tempo, lanes })
  voice.onMessage({ type: 'state', rack: source.rack!, tempo, quality: 'full', buffers: [] })
  for (const note of notes) {
    voice.onMessage({ type: 'note', pitch: note.pitch, vel: note.velocity, time: note.time, slide: note.slide })
    voice.onMessage({ type: 'note', pitch: note.pitch, vel: 0, time: note.off })
  }
  const frames = Math.max(1, length)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  let offset = 0
  let painted = 0
  while (offset < frames) {
    const count = Math.min(128, frames - offset)
    voice.process([left.subarray(offset, offset + count), right.subarray(offset, offset + count)], offset / rate)
    offset += count
    if (onProgress && offset - painted >= rate) {
      painted = offset
      onProgress(0.1 + (offset / frames) * 0.6)
    }
  }
  return [left, right]
}

async function renderRackWorklet(
  rack: NonNullable<Track['rack']>,
  tempo: number,
  lanes: ReturnType<typeof rackLanesFor>,
  originBeat: number,
  notes: { pitch: number; velocity: number; time: number; off: number; slide: boolean }[],
  length: number,
  rate: number,
): Promise<Float32Array[] | null> {
  const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext
  if (typeof Ctx !== 'function' || typeof AudioWorkletNode !== 'function') return null
  let url = ''
  try {
    url = (await import('./rack/rack.worklet.ts?worker&url')).default as string
  } catch {
    return null
  }
  const ctx = new Ctx(2, Math.max(1, length), rate)
  if (!ctx.audioWorklet?.addModule) return null
  try {
    await ctx.audioWorklet.addModule(url)
  } catch {
    return null
  }
  const node = new AudioWorkletNode(ctx, 'cueharbor-rack', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
  node.connect(ctx.destination)
  try {
    await once(node, 'ready', () => node.port.postMessage({ type: 'state', rack, tempo, quality: 'full', buffers: [] }))
    node.port.postMessage({ type: 'clock', originTime: 0, originBeat, tempo, lanes })
    for (const note of notes) {
      node.port.postMessage({ type: 'note', pitch: note.pitch, vel: note.velocity, time: note.time, slide: note.slide })
      node.port.postMessage({ type: 'note', pitch: note.pitch, vel: 0, time: note.off })
    }
    await once(node, 'armed', () => node.port.postMessage({ type: 'arm' }))
    const rendered = await ctx.startRendering()
    return [copyChannel(rendered, 0), copyChannel(rendered, 1)]
  } catch {
    return null
  }
}

const workletPorts = new WeakSet<AudioWorkletNode>()

function once(node: AudioWorkletNode, type: string, send: () => void) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      node.port.removeEventListener('message', onMessage)
      reject(new Error(type))
    }, 10000)
    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type !== type) return
      clearTimeout(timer)
      node.port.removeEventListener('message', onMessage)
      resolve()
    }
    if (!workletPorts.has(node)) {
      node.port.start()
      workletPorts.add(node)
    }
    node.port.addEventListener('message', onMessage)
    send()
  })
}

async function renderLiveSampler(
  project: Project,
  source: Track,
  plugin: PluginInstance,
  channel: Float32Array,
  origin: number,
  length: number,
  rate: number,
  target: HeardTarget,
) {
  const events = timedNotes(project, source, target, origin, length, rate).flatMap((note) => [
    { time: note.time, pitch: note.pitch, vel: note.velocity },
    { time: note.off, pitch: note.pitch, vel: 0 },
  ])
  const viaWorklet = await renderSamplerWorklet(plugin, channel, events, length, rate, project, origin)
  if (viaWorklet) return viaWorklet
  return renderSamplerSpan(plugin, channel, events, rate, length, false)
}

async function renderPatternHits(
  project: Project,
  clips: NonNullable<Project['patternClips']>,
  sourceId: string,
  origin: number,
  length: number,
  rate: number,
) {
  const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext
  if (typeof Ctx !== 'function') throw new Error('Pattern bounce needs OfflineAudioContext')
  const ctx = new Ctx(2, Math.max(1, length), rate)
  const dest = ctx.createGain()
  dest.connect(ctx.destination)
  const noise = ctx.createBuffer(1, rate, rate)
  writeSharedNoise(noise.getChannelData(0))
  const drums = residentDrums(rate).map((drum) => {
    const buffer = ctx.createBuffer(1, Math.max(1, drum.samples.length), rate)
    buffer.getChannelData(0).set(drum.samples)
    return buffer
  })
  for (const clip of clips) {
    const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
    if (!pattern) continue
    const range = patternPlayRange(clip)
    for (const hit of renderPattern(pattern, range.from, range.to)) {
      const destId = patternHitTrack(project, hit, clip)
      if (destId && destId !== sourceId) continue
      const span = beatSpanSamples(project, clip.startBeat + (hit.startBeat - range.from), hit.durationBeats)
      const when = (span.start - origin) / rate
      if (when >= length / rate) continue
      startTransportHit({
        ctx,
        destination: dest,
        hit,
        when: Math.max(0, when),
        dur: span.duration / rate,
        noise,
        resident: drums[DRUM_PADS.findIndex((pad) => pad.pitch === Math.round(hit.pitch))] ?? null,
      })
    }
  }
  const rendered = await ctx.startRendering()
  return [copyChannel(rendered, 0), copyChannel(rendered, 1)]
}

export async function renderLiveInserts(track: Track, input: Float32Array[], project: Project, origin: number, sampleRate: number) {
  const plugins = graphPlugins(track).filter((plugin) => plugin.enabled && plugin.wet > 0)
  if (!plugins.length) return input
  const viaWorklet = await renderInsertWorklet(plugins, input, project, origin, sampleRate)
  if (viaWorklet) return viaWorklet
  const { createProcessor } = await import('./plugins/createAll')
  const scale = tuneBlockScale(project.scale)
  const slots: ChainSlot[] = plugins.map((plugin) => ({
    id: plugin.id,
    pluginId: plugin.pluginId,
    enabled: true,
    wet: plugin.wet,
    params: { ...plugin.params },
    failed: false,
    sidechain: plugin.sidechain || '',
    processor: createProcessor(plugin.pluginId, sampleRate) ?? null,
  }))
  for (const slot of slots) if (slot.processor) primeProcessor(slot.processor, sampleRate, 128)
  const frames = input[0]?.length ?? 0
  const output = [new Float32Array(frames), new Float32Array(frames)]
  const pool = prepareChainPool(Math.max(4, slots.length + 1), 2, 128)
  let offset = 0
  while (offset < frames) {
    const count = Math.min(128, frames - offset)
    const sliceIn = [0, 1].map((channel) => (input[channel] ?? input[0]).subarray(offset, offset + count))
    const sliceOut = [0, 1].map((channel) => output[channel].subarray(offset, offset + count))
    processChain(slots, sliceIn, sliceOut, {
      sampleRate,
      tempo: project.tempo || 120,
      sampleTime: origin + offset,
      sidechain: null,
      scaleRoot: scale.scaleRoot,
      scaleIntervals: scale.scaleIntervals,
      scaleCents: scale.scaleCents,
      quality: 'full',
      offline: false,
    }, () => null, pool)
    for (let i = 0; i < count; i++) {
      sliceOut[0][i] = transparentLimit(sliceOut[0][i] || 0)
      sliceOut[1][i] = transparentLimit(sliceOut[1][i] || 0)
    }
    offset += count
  }
  return output
}

async function renderInsertWorklet(
  plugins: PluginInstance[],
  input: Float32Array[],
  project: Project,
  origin: number,
  sampleRate: number,
): Promise<Float32Array[] | null> {
  const node = await openInsert(input[0].length, sampleRate, false)
  if (!node) return null
  const { ctx, worklet } = node
  const buffer = ctx.createBuffer(2, input[0].length, sampleRate)
  buffer.copyToChannel(new Float32Array(input[0]), 0)
  buffer.copyToChannel(new Float32Array(input[1] ?? input[0]), 1)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(worklet)
  try {
    await once(worklet, 'ready', () => worklet.port.postMessage(insertState(plugins, project, origin, sampleRate)))
    src.start(0)
    await once(worklet, 'armed', () => worklet.port.postMessage({ type: 'arm' }))
    const rendered = await ctx.startRendering()
    return [copyChannel(rendered, 0), copyChannel(rendered, 1)]
  } catch {
    return null
  }
}

async function renderSamplerWorklet(
  plugin: PluginInstance,
  channel: Float32Array,
  events: { time: number; pitch: number; vel: number }[],
  length: number,
  sampleRate: number,
  project: Project,
  origin: number,
): Promise<Float32Array[] | null> {
  const opened = await openInsert(length, sampleRate, true)
  if (!opened || !plugin.sampler) return null
  const { ctx, worklet } = opened
  try {
    await once(worklet, 'ready', () => worklet.port.postMessage(insertState([plugin], project, origin, sampleRate)))
    worklet.port.postMessage({ type: 'buffer', id: plugin.sampler.bufferId, channel })
    for (const event of events) {
      worklet.port.postMessage({ type: 'note', id: plugin.id, pitch: event.pitch, vel: event.vel, time: event.time })
    }
    await once(worklet, 'armed', () => worklet.port.postMessage({ type: 'arm' }))
    const rendered = await ctx.startRendering()
    return [copyChannel(rendered, 0), copyChannel(rendered, 1)]
  } catch {
    return null
  }
}

async function openInsert(frames: number, sampleRate: number, generator: boolean) {
  const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext
  if (typeof Ctx !== 'function' || typeof AudioWorkletNode !== 'function') return null
  let url = ''
  try {
    url = (await import('./insert.worklet.ts?worker&url')).default as string
  } catch {
    return null
  }
  const ctx = new Ctx(2, Math.max(1, frames), sampleRate)
  if (!ctx.audioWorklet?.addModule) return null
  try {
    await ctx.audioWorklet.addModule(url)
  } catch {
    return null
  }
  const worklet = new AudioWorkletNode(ctx, 'cueharbor-insert', {
    numberOfInputs: generator ? 0 : 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
  })
  worklet.connect(ctx.destination)
  return { ctx, worklet }
}

function insertState(plugins: PluginInstance[], project: Project, origin: number, sampleRate: number) {
  const scale = tuneBlockScale(project.scale)
  return {
    type: 'state' as const,
    slots: plugins.map((plugin) => ({
      id: plugin.id,
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      wet: plugin.wet,
      params: { ...plugin.params },
      sidechain: plugin.sidechain || '',
      sampler: plugin.sampler,
    })),
    automation: [] as [],
    tempo: project.tempo || 120,
    projectRate: sampleRate,
    tempoMap: project.tempoMap ?? [],
    scaleRoot: scale.scaleRoot,
    scaleIntervals: [...scale.scaleIntervals],
    scaleCents: scale.scaleCents ? [...scale.scaleCents] : undefined,
    quality: 'full' as const,
    wasmDsp: wasmDspRequested(),
    playing: true,
    originTime: 0,
    originSample: origin,
  }
}

function timedNotes(project: Project, source: Track, target: HeardTarget, origin: number, length: number, rate: number) {
  const notes: { pitch: number; velocity: number; time: number; off: number; slide: boolean }[] = []
  const end = origin + length
  for (const note of midiNotes(project, source, target)) {
    const span = beatSpanSamples(project, note.clipStart + note.startBeat, note.durationBeats)
    if (span.start >= end || span.start + span.duration < origin) continue
    notes.push({
      pitch: note.pitch,
      velocity: note.velocity,
      time: Math.max(0, (span.start - origin) / rate),
      off: Math.max(0, (span.start + span.duration - origin) / rate),
      slide: !!note.slide,
    })
  }
  return notes
}

function midiNotes(project: Project, source: Track, target: HeardTarget) {
  const out: (MidiNote & { clipStart: number })[] = []
  if (target.kind === 'pattern') return out
  for (const group of performancesOn(project, source)) {
    for (const clip of group.clips) {
      if (clip.slotOnly || clip.scene != null) continue
      if (target.kind === 'midi' && clip.id !== target.clipId) continue
      if (clip.muted && target.kind !== 'midi') continue
      for (const note of prepareClipNotes(project, group.owner, clip)) {
        if (note.muted) continue
        out.push({ ...note, clipStart: clip.startBeat })
      }
    }
  }
  return out
}

function copyChannel(buffer: AudioBuffer, index: number) {
  const data = buffer.getChannelData(Math.min(index, buffer.numberOfChannels - 1))
  const out = new Float32Array(data.length)
  out.set(data)
  return out
}
