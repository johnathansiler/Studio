import type { AutomationLane, PluginInstance } from '../model/types'
import { audibleIds } from '../model/audible'
import { curveForLength, laneFor, sendLane, valueChanges } from '../model/automation'
import { projectSampleBeat } from '../model/tempoMap'
import type { TempoPoint } from '../model/types'
import { processChain, type ChainSlot } from './plugins/chain'
import { automationAt, latencyOf } from './plugins/catalog'
import { createLoudness, measureLoudness, sanitize } from './plugins/dsp'
import { processSampleAccurate } from './automationRender'
import { sidechainMono } from './sidechain'
import { MASTER, REMOTE, edgeDelays, findCycle, type RoutePoint } from './routing'
import type { Processor } from './plugins/types'

export interface GraphTrack {
  id: string
  type: string
  input: string
  buffer: Float32Array[]
  volume: number
  pan: number
  mute: boolean
  solo: boolean
  soloSafe?: boolean
  plugins: PluginInstance[]
  sends: { id: string; busId: string; gain: number; preFader: boolean; enabled: boolean }[]
  output: string | null
  groupId: string | null
}

export function renderGraph(opts: {
  tracks: GraphTrack[]
  masterPlugins: PluginInstance[]
  masterVolume: number
  sampleRate: number
  tempo: number
  tempoMap?: TempoPoint[]
  length: number
  scaleRoot: number
  scaleIntervals: readonly number[]
  automation: AutomationLane[]
  quality?: 'full' | 'eco'
  /** Mastering uses linear-phase EQ and 4x oversampling on this path. */
  offline?: boolean
  liveRemote?: boolean
  create: (pluginId: string, sampleRate: number) => Processor
}) {
  const length = Math.max(1, opts.length)
  const blank = () => [new Float32Array(length), new Float32Array(length)]
  const anySolo = opts.tracks.some((track) => track.solo)
  const heard = audibleIds(opts.tracks)
  const processors = new Map<string, ChainSlot[]>()
  const latencyFor = (plugins: PluginInstance[], owner: string) => {
    const slots = slotsFor(plugins, opts.create, opts.sampleRate, processors, owner)
    return slots.reduce((sum, slot, index) => {
      const plugin = plugins[index]
      if (!plugin?.enabled) return sum
      return sum + Math.max(slot.processor?.latencySamples ?? 0, latencyOf(plugin.pluginId, plugin.params, opts.sampleRate, true))
    }, 0)
  }

  const points: RoutePoint[] = opts.tracks.map((track) => ({
    id: track.id,
    dest: destination(track, opts.liveRemote === true),
    sends: track.sends.filter((send) => send.enabled).map((send) => send.busId),
    latency: latencyFor(track.plugins, track.id),
  }))
  points.push({ id: MASTER, dest: null, sends: [], latency: latencyFor(opts.masterPlugins, MASTER) })
  points.push({ id: REMOTE, dest: null, sends: [], latency: 0 })
  const cyclic = findCycle(points)
  const safe = cyclic
    ? points.map((point) => (point.id === MASTER || point.id === REMOTE ? point : { ...point, dest: MASTER, sends: [] }))
    : points
  const delays = edgeDelays(safe)
  const byId = new Map(opts.tracks.map((track) => [track.id, track]))
  const incoming = new Map<string, Edge[]>()
  for (const point of safe) {
    if (point.dest) pushEdge(incoming, point.dest, { from: point.id, to: point.dest, gain: 1, pre: false })
    const track = byId.get(point.id)
    if (!track || cyclic) continue
    for (const send of track.sends) {
      if (!send.enabled) continue
      pushEdge(incoming, send.busId, { from: track.id, to: send.busId, gain: send.gain, pre: send.preFader, sendId: send.id })
    }
  }

  const order = topo(safe.map((point) => point.id), incoming)
  const rendered = new Map<string, { pre: Float32Array[]; post: Float32Array[] }>()
  for (const id of order) {
    if (id === MASTER || id === REMOTE) continue
    const track = byId.get(id)
    if (!track) continue
    const audible = heard.has(id)
    const soloedOut = anySolo && !heard.has(id)
    const base = mixIncoming(blank(), incoming.get(id) ?? [], rendered, delays, length, opts)
    add(base, fit(track.buffer, length))
    const slots = slotsFor(track.plugins, opts.create, opts.sampleRate, processors, id)
    const processed = runBlocks(slots, base, opts, rendered, byId)
    const pre = soloedOut ? blank() : processed
    const post = audible ? applyAutomatedFader(processed, track, opts) : blank()
    rendered.set(id, { pre, post })
  }

  const masterIn = mixIncoming(blank(), incoming.get(MASTER) ?? [], rendered, delays, length, opts)
  const masterSlots = slotsFor(opts.masterPlugins, opts.create, opts.sampleRate, processors, MASTER)
  const mastered = runBlocks(masterSlots, masterIn, opts, rendered, byId)
  const master = applyGain(mastered, opts.masterVolume)
  for (const channel of master) for (let i = 0; i < channel.length; i++) channel[i] = sanitize(channel[i])
  const loudness = measureLoudness(createLoudness(opts.sampleRate), master[0], master[1], opts.sampleRate)
  const delayMap: Record<string, number> = {}
  for (const [key, value] of delays) delayMap[key] = value
  return { master, delays: delayMap, ...loudness, cyclic: cyclic ?? [] }
}

function destination(track: GraphTrack, liveRemote: boolean) {
  if (track.groupId) return track.groupId
  if (track.output) return track.output
  if (liveRemote && track.input.startsWith('remote:')) return REMOTE
  return MASTER
}

interface Edge {
  from: string
  to: string
  gain: number
  pre: boolean
  sendId?: string
}

function pushEdge(map: Map<string, Edge[]>, to: string, edge: Edge) {
  const list = map.get(to) ?? []
  list.push(edge)
  map.set(to, list)
}

function topo(ids: string[], incoming: Map<string, { from: string }[]>) {
  const pending = new Map(ids.map((id) => [id, (incoming.get(id) ?? []).filter((edge) => ids.includes(edge.from)).length]))
  const ready = ids.filter((id) => (pending.get(id) ?? 0) === 0)
  const ordered: string[] = []
  const downstream = new Map<string, string[]>()
  for (const [to, edges] of incoming) {
    for (const edge of edges) {
      const list = downstream.get(edge.from) ?? []
      list.push(to)
      downstream.set(edge.from, list)
    }
  }
  while (ready.length) {
    const id = ready.shift()!
    ordered.push(id)
    for (const next of downstream.get(id) ?? []) {
      pending.set(next, (pending.get(next) ?? 1) - 1)
      if ((pending.get(next) ?? 0) === 0) ready.push(next)
    }
  }
  for (const id of ids) if (!ordered.includes(id)) ordered.push(id)
  return ordered
}

function slotsFor(
  plugins: PluginInstance[],
  create: (pluginId: string, sampleRate: number) => Processor,
  sampleRate: number,
  cache: Map<string, ChainSlot[]>,
  owner: string,
) {
  const cached = cache.get(owner)
  if (cached) return cached
  const slots = plugins.map((plugin) => ({
    id: plugin.id,
    pluginId: plugin.pluginId,
    enabled: plugin.enabled,
    wet: plugin.wet,
    params: plugin.params,
    failed: false,
    sidechain: plugin.sidechain,
    processor: create(plugin.pluginId, sampleRate),
  }))
  cache.set(owner, slots)
  return slots
}

type RenderClock = { sampleRate: number; tempo: number; tempoMap?: TempoPoint[]; automation: AutomationLane[] }

function runBlocks(
  slots: ChainSlot[],
  input: Float32Array[],
  opts: RenderClock & { scaleRoot: number; scaleIntervals: readonly number[]; quality?: 'full' | 'eco'; offline?: boolean },
  rendered: Map<string, { pre: Float32Array[]; post: Float32Array[] }>,
  tracks: Map<string, GraphTrack>,
) {
  const n = input[0].length
  const output = [new Float32Array(n), new Float32Array(n)]
  const block = 128
  const base = new Map(slots.map((slot) => [slot.id, { ...slot.params }]))
  for (let offset = 0; offset < n; offset += block) {
    const count = Math.min(block, n - offset)
    const sliceIn = input.map((channel) => channel.subarray(offset, offset + count))
    const sliceOut = output.map((channel) => channel.subarray(offset, offset + count))
    const clock = { tempo: opts.tempo, sampleRate: opts.sampleRate, tempoMap: opts.tempoMap, automation: opts.automation }
    const beat = projectSampleBeat(clock, offset)
    for (const slot of slots) slot.params = automationAt(opts.automation, slot.id, base.get(slot.id) ?? slot.params, beat)
    const blockCtx = {
      sampleRate: opts.sampleRate,
      tempo: opts.tempo,
      sampleTime: offset,
      sidechain: null,
      scaleRoot: opts.scaleRoot,
      scaleIntervals: opts.scaleIntervals,
      quality: opts.quality ?? 'full' as const,
      offline: opts.offline !== false,
    }
    const keyAt = (id: string, keyLength: number) => sidechainMono(id, offset, keyLength, [...tracks.values()], rendered)
    const endBeat = projectSampleBeat(clock, offset + count - 1)
    const moving = opts.offline !== false && slots.some((slot) => opts.automation.some((lane) => (lane.target == null || lane.target === 'plugin') && lane.pluginId === slot.id && valueChanges(lane.points, beat, endBeat, 0)))
    if (moving) {
      processSampleAccurate(slots, sliceIn, sliceOut, blockCtx, opts.automation, keyAt, (sample) => projectSampleBeat(clock, sample))
      continue
    }
    processChain(slots, sliceIn, sliceOut, blockCtx, keyAt)
  }
  return output
}

function mixIncoming(
  into: Float32Array[],
  edges: Edge[],
  rendered: Map<string, { pre: Float32Array[]; post: Float32Array[] }>,
  delays: Map<string, number>,
  length: number,
  opts: RenderClock,
) {
  for (const edge of edges) {
    const source = rendered.get(edge.from)
    if (!source) continue
    const buffer = edge.pre ? source.pre : source.post
    const delay = delays.get(`${edge.from}>${edge.to}`) ?? 0
    const lane = edge.sendId ? sendLane(opts.automation, edge.from, edge.sendId) : undefined
    const gain = curveForLength(lane?.points, edge.gain, opts, length)
    addDelayed(into, buffer, delay, gain, length)
  }
  return into
}

function addDelayed(into: Float32Array[], buffer: Float32Array[], delay: number, gain: number | Float32Array, length: number) {
  for (let c = 0; c < into.length; c++) {
    const src = buffer[Math.min(c, buffer.length - 1)]
    for (let i = 0; i < length; i++) {
      const j = i - delay
      const amount = typeof gain === 'number' ? gain : gain[i] || 0
      if (j >= 0 && j < src.length) into[c][i] += src[j] * amount
    }
  }
}

function add(into: Float32Array[], extra: Float32Array[]) {
  for (let c = 0; c < into.length; c++) {
    const src = extra[Math.min(c, extra.length - 1)]
    for (let i = 0; i < into[c].length; i++) into[c][i] += src[i] || 0
  }
}

function fit(buffer: Float32Array[], length: number) {
  return [0, 1].map((channel) => {
    const src = buffer[Math.min(channel, buffer.length - 1)] ?? new Float32Array(0)
    const out = new Float32Array(length)
    out.set(src.subarray(0, length))
    return out
  })
}

function applyGain(input: Float32Array[], volume: number) {
  return input.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = channel[i] * volume
    return out
  })
}

function applyAutomatedFader(
  input: Float32Array[],
  track: GraphTrack,
  opts: RenderClock,
) {
  const length = input[0]?.length ?? 0
  const vol = curveForLength(laneFor(opts.automation, track.id, 'volume')?.points, track.volume, opts, length)
  const pan = curveForLength(laneFor(opts.automation, track.id, 'pan')?.points, track.pan, opts, length)
  if (typeof vol === 'number' && typeof pan === 'number') return applyFader(input, vol, pan)
  const out = [new Float32Array(length), new Float32Array(length)]
  for (let i = 0; i < length; i++) {
    const v = typeof vol === 'number' ? vol : vol[i]
    const p = typeof pan === 'number' ? pan : pan[i]
    const angle = ((p + 1) * Math.PI) / 4
    out[0][i] = (input[0]?.[i] || 0) * Math.cos(angle) * v
    out[1][i] = (input[1]?.[i] ?? input[0]?.[i] ?? 0) * Math.sin(angle) * v
  }
  return out
}

function applyFader(input: Float32Array[], volume: number, pan: number) {
  const angle = ((pan + 1) * Math.PI) / 4
  const left = Math.cos(angle) * volume
  const right = Math.sin(angle) * volume
  const gains = [left, right]
  return input.map((channel, index) => {
    const out = new Float32Array(channel.length)
    const gain = gains[index] ?? volume
    for (let i = 0; i < channel.length; i++) out[i] = channel[i] * gain
    return out
  })
}
