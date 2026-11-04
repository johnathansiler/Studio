import type { AutomationLane, PluginInstance } from '../model/types'
import { audibleIds } from '../model/audible'
import { curveForLength, laneFor, sendLane } from '../model/automation'
import type { TempoPoint } from '../model/types'
import { prepareChainPool, type ChainPool, type ChainSlot } from './plugins/chain'
import { prepareAccurate, type AccurateScratch } from './automationRender'
import { reportedLatency } from './core/latency'
import { scheduleRoutes, type MixSchedule, type RouteInput } from './core/graph'
import { createLoudness, measureLoudness, sanitize } from './plugins/dsp'
import { sidechainMono } from './sidechain'
import { MASTER, REMOTE } from './routing'
import { renderInserts, type InsertClock, type InsertJob, type InsertPlugin } from './renderChain'
import { wasmDspRequested } from './wasm/flag'
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

export interface RenderOptions {
  tracks: GraphTrack[]
  masterPlugins: PluginInstance[]
  masterVolume: number
  sampleRate: number
  tempo: number
  tempoMap?: TempoPoint[]
  length: number
  scaleRoot: number
  scaleIntervals: readonly number[]
  scaleCents?: readonly number[]
  automation: AutomationLane[]
  quality?: 'full' | 'eco'
  /** Mastering uses linear-phase EQ and 4x oversampling on this path. */
  offline?: boolean
  liveRemote?: boolean
  create: (pluginId: string, sampleRate: number) => Processor
}

export function renderGraph(opts: RenderOptions) {
  const state = prepareRender(opts)
  for (const id of state.schedule.order) {
    if (id === MASTER || id === REMOTE) continue
    const track = state.byId.get(id)
    if (!track) continue
    const input = nodeInput(state, id)
    const slots = slotsFor(track.plugins, opts.create, opts.sampleRate, state.processors, id)
    commitTrack(state, id, renderInserts(slots, input, clockOf(opts), keyFor(state), state.pool, state.scratch))
  }
  const masterSlots = slotsFor(opts.masterPlugins, opts.create, opts.sampleRate, state.processors, MASTER)
  return finishMaster(state, renderInserts(masterSlots, masterInput(state), clockOf(opts), keyFor(state), state.pool, state.scratch))
}

export interface RenderState {
  opts: RenderOptions
  length: number
  schedule: MixSchedule
  incoming: Map<string, Edge[]>
  byId: Map<string, GraphTrack>
  heard: Set<string>
  anySolo: boolean
  processors: Map<string, ChainSlot[]>
  pool: ChainPool
  scratch: AccurateScratch
  rendered: Map<string, { pre: Float32Array[]; post: Float32Array[] }>
  cyclic: string[]
  feedback: string
}

export function prepareRender(opts: RenderOptions): RenderState {
  const length = Math.max(1, opts.length)
  const anySolo = opts.tracks.some((track) => track.solo)
  const heard = audibleIds(opts.tracks)
  const processors = new Map<string, ChainSlot[]>()
  const block = 128
  const pool = prepareChainPool(24, 2, block)
  const scratch = prepareAccurate(24, block)
  const latencyFor = (plugins: PluginInstance[], owner: string) => {
    const slots = slotsFor(plugins, opts.create, opts.sampleRate, processors, owner)
    return slots.reduce((sum, slot, index) => {
      const plugin = plugins[index]
      if (!plugin?.enabled) return sum
      return sum + reportedLatency(plugin.pluginId, plugin.params, opts.sampleRate, true, slot.processor?.latencySamples ?? 0, opts.offline === false)
    }, 0)
  }

  const points: RouteInput[] = opts.tracks.map((track) => ({
    id: track.id,
    dest: destination(track, opts.liveRemote === true),
    sends: track.sends.filter((send) => send.enabled).map((send) => send.busId),
    latency: latencyFor(track.plugins, track.id),
    kind: track.type === 'bus' ? 'bus' : track.type === 'group' ? 'group' : 'track',
  }))
  points.push({ id: MASTER, dest: null, sends: [], latency: latencyFor(opts.masterPlugins, MASTER), kind: 'master' })
  points.push({ id: REMOTE, dest: null, sends: [], latency: 0, kind: 'remote' })
  const first = scheduleRoutes(points)
  const cycle = first.feedback
  const safe = cycle
    ? points.map((point) => (point.id === MASTER || point.id === REMOTE ? point : { ...point, dest: MASTER, sends: [] }))
    : points
  const schedule = cycle ? scheduleRoutes(safe) : first
  const byId = new Map(opts.tracks.map((track) => [track.id, track]))
  const incoming = new Map<string, Edge[]>()
  for (const point of safe) {
    if (point.dest) pushEdge(incoming, point.dest, { from: point.id, to: point.dest, gain: 1, pre: false })
    const track = byId.get(point.id)
    if (!track || cycle) continue
    for (const send of track.sends) {
      if (!send.enabled) continue
      pushEdge(incoming, send.busId, { from: track.id, to: send.busId, gain: send.gain, pre: send.preFader, sendId: send.id })
    }
  }
  return {
    opts,
    length,
    schedule,
    incoming,
    byId,
    heard,
    anySolo,
    processors,
    pool,
    scratch,
    rendered: new Map(),
    cyclic: cycle?.path ?? [],
    feedback: cycle?.message ?? '',
  }
}

export function nodeInput(state: RenderState, id: string) {
  const track = state.byId.get(id)
  const base = mixIncoming(blank(state.length), state.incoming.get(id) ?? [], state.rendered, state.schedule.delays, state.length, state.opts)
  if (track) add(base, fit(track.buffer, state.length))
  return base
}

export function masterInput(state: RenderState) {
  return mixIncoming(blank(state.length), state.incoming.get(MASTER) ?? [], state.rendered, state.schedule.delays, state.length, state.opts)
}

export function commitTrack(state: RenderState, id: string, processed: Float32Array[]) {
  const track = state.byId.get(id)
  if (!track) return
  const audible = state.heard.has(id)
  const soloedOut = state.anySolo && !state.heard.has(id)
  const pre = soloedOut ? blank(state.length) : processed
  const post = audible ? applyAutomatedFader(processed, track, state.opts) : blank(state.length)
  state.rendered.set(id, { pre, post })
}

export function finishMaster(state: RenderState, mastered: Float32Array[]) {
  const master = applyGain(mastered, state.opts.masterVolume)
  for (const channel of master) for (let i = 0; i < channel.length; i++) channel[i] = sanitize(channel[i])
  const loudness = measureLoudness(createLoudness(state.opts.sampleRate), master[0], master[1], state.opts.sampleRate)
  const delayMap: Record<string, number> = {}
  for (const [key, value] of state.schedule.delays) delayMap[key] = value
  return { master, delays: delayMap, ...loudness, cyclic: state.cyclic, feedback: state.feedback }
}

export function insertJob(state: RenderState, plugins: PluginInstance[], input: Float32Array[]): InsertJob {
  return {
    ...clockOf(state.opts),
    plugins: plugins.map(insertPlugin),
    input,
    keys: [],
    wasmDsp: wasmDspRequested(),
  }
}

export function graphHasSidechain(opts: Pick<RenderOptions, 'tracks' | 'masterPlugins'>) {
  const plugins = [...opts.masterPlugins, ...opts.tracks.flatMap((track) => track.plugins)]
  return plugins.some((plugin) => plugin.enabled && plugin.sidechain)
}

function insertPlugin(plugin: PluginInstance): InsertPlugin {
  return {
    id: plugin.id,
    pluginId: plugin.pluginId,
    enabled: plugin.enabled,
    wet: plugin.wet,
    params: { ...plugin.params },
    sidechain: plugin.sidechain,
  }
}

function clockOf(opts: RenderOptions): InsertClock {
  return {
    sampleRate: opts.sampleRate,
    tempo: opts.tempo,
    tempoMap: opts.tempoMap,
    automation: opts.automation,
    scaleRoot: opts.scaleRoot,
    scaleIntervals: opts.scaleIntervals,
    scaleCents: opts.scaleCents,
    quality: opts.quality,
    offline: opts.offline,
  }
}

function keyFor(state: RenderState) {
  const tracks = [...state.byId.values()]
  return (id: string, offset: number, count: number) => sidechainMono(id, offset, count, tracks, state.rendered)
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

function blank(length: number) {
  return [new Float32Array(length), new Float32Array(length)]
}

function mixIncoming(
  into: Float32Array[],
  edges: Edge[],
  rendered: Map<string, { pre: Float32Array[]; post: Float32Array[] }>,
  delays: Map<string, number>,
  length: number,
  opts: InsertClock,
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
    const gain = volume
    for (let i = 0; i < channel.length; i++) out[i] = channel[i] * gain
    return out
  })
}

function applyAutomatedFader(
  input: Float32Array[],
  track: GraphTrack,
  opts: InsertClock,
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
