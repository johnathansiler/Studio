import insertWorkletUrl from './insert.worklet.ts?worker&url'
import type { PluginInstance, Project } from '../model/types'
import { tuneBlockScale } from './plugins/autoTune'
import type { StripNodes } from './strips'
import { processChain, type ChainSlot } from './plugins/chain'
import { automationAt, latencyOf } from './plugins/catalog'
import { automationSchedule, sendLane, valueChanges } from '../model/automation'
import { projectSampleBeat } from '../model/tempoMap'
import { applyRamps } from './paramCurve'
import { processSampleAccurate } from './automationRender'
import { loadModule } from './plugins/registry'
import type { Processor } from './plugins/types'
import { MASTER, REMOTE, edgeDelays, findCycle, type RoutePoint } from './routing'

interface Tap {
  input: GainNode
  output: GainNode
  proc: ScriptProcessorNode | null
  worklet: AudioWorkletNode | null
  direct: boolean
}

const SCRIPT_BLOCK = 256

/**
 * Inserts the plugin chain in front of each strip and routes buses.
 * Bypassed tracks stay on a plain gain so they add no latency and no cost.
 * A monitored mic only hits plugins when that track has an enabled insert.
 */
export class LiveRack {
  cpu = 0
  quality: 'full' | 'eco' = 'full'
  clock: () => number = () => 0
  assetOf: (id: string) => { channels: Float32Array[] } | undefined = () => undefined
  private project: Project | null = null
  private readonly taps = new Map<string, Tap>()
  private readonly processors = new Map<string, Processor>()
  private readonly failed = new Set<string>()
  private readonly spectra = new Map<string, Float32Array>()
  private readonly tuners = new Map<string, { hz: number; cents: number; note: number }>()
  private readonly meters = new Map<string, { vu: number; gr: number }>()
  private readonly traces = new Map<string, Float32Array>()
  private readonly tapsOut = new Map<string, Float32Array>()
  private readonly sendGains = new Map<string, GainNode>()
  private readonly keys = new Map<string, Float32Array>()
  private readonly keyTaps = new Map<string, AudioNode>()
  private readonly keySinks = new Map<string, GainNode>()
  private readonly keptAudio = new Map<string, Float32Array>()
  private readonly sentBuffers = new Map<string, string>()
  private workletPromise: Promise<boolean> | null = null
  private workletOk = false
  private topology = ''
  private playing = false
  private originTime = 0
  private originSample = 0
  private links: { from: AudioNode; to: AudioNode }[] = []
  private generation = 0
  private signature = ''
  private phone = false
  private meterReading: Record<string, number> | null = null
  private meterScope: Float32Array | null = null
  private blockTime = 0
  private ctx: AudioContext | null = null
  private strips: Map<string, StripNodes> = new Map()
  private localBus: AudioNode | null = null
  private remoteBus: AudioNode | null = null

  constructor() {
    if (typeof matchMedia !== 'undefined') {
      this.phone = matchMedia('(max-width: 520px), (max-height: 520px) and (orientation: landscape)').matches
      if (this.phone) this.quality = 'eco'
    }
  }

  spectrum(pluginId: string) {
    return this.spectra.get(pluginId) ?? null
  }

  trigger(pluginId: string, note: number, vel: number) {
    const node = this.nodeFor(pluginId)
    const time = this.ctx?.currentTime ?? 0
    if (node) {
      node.port.postMessage({ type: 'note', id: pluginId, pitch: note, vel, time })
      return
    }
    const proc = this.processors.get(pluginId) as Processor & { note?: (pitch: number, vel: number) => void }
    proc?.note?.(note, vel)
  }

  /** Queue a sampler note on the audio clock. `time` is an AudioContext time. */
  schedule(pluginId: string, note: number, vel: number, time: number) {
    const node = this.nodeFor(pluginId)
    if (node) {
      node.port.postMessage({ type: 'note', id: pluginId, pitch: note, vel, time })
      return
    }
    const proc = this.processors.get(pluginId) as Processor & {
      schedule?: (pitch: number, vel: number, time: number) => void
      note?: (pitch: number, vel: number) => void
    }
    if (proc?.schedule) proc.schedule(note, vel, time)
    else proc?.note?.(note, vel)
  }

  /** Transport origin so insert plugins stay on the arrangement clock without a main-thread buffer. */
  setPerformanceClock(playing: boolean, originTime: number, originSample: number, tempo: number) {
    this.playing = playing
    this.originTime = originTime
    this.originSample = originSample
    for (const tap of this.taps.values()) {
      tap.worklet?.port.postMessage({ type: 'clock', playing, originTime, originSample, tempo })
    }
  }

  keptLoop(pluginId: string) {
    const cached = this.keptAudio.get(pluginId)
    if (cached) return cached
    const proc = this.processors.get(pluginId) as Processor & { kept?: () => Float32Array | null }
    return proc?.kept?.() ?? null
  }

  /** Start the looper's playhead over so an overdub lines up with the loop. */
  rewindLoop(pluginId: string) {
    const node = this.nodeFor(pluginId)
    if (node) {
      node.port.postMessage({ type: 'reset', id: pluginId })
      return
    }
    this.processors.get(pluginId)?.reset()
  }

  tuner(pluginId: string) {
    return this.tuners.get(pluginId) ?? null
  }

  meter(pluginId: string) {
    return this.meters.get(pluginId) ?? null
  }

  trace(pluginId: string) {
    return this.traces.get(pluginId) ?? null
  }

  ownerLatency(owner: string) {
    const project = this.project
    const ctx = this.ctx
    if (!project || !ctx) return 0
    const plugins = owner === 'master' ? project.masterPlugins : project.tracks.find((track) => track.id === owner)?.plugins ?? []
    return this.latency(owner, plugins, ctx.sampleRate)
  }

  reading() {
    return this.meterReading
  }

  scope() {
    return this.meterScope
  }

  isFailed(pluginId: string) {
    return this.failed.has(pluginId)
  }

  route(
    ctx: AudioContext,
    project: Project,
    strips: Map<string, StripNodes>,
    master: StripNodes,
    localBus: AudioNode,
    remoteBus: AudioNode,
  ) {
    this.project = project
    this.ctx = ctx
    this.strips = strips
    this.localBus = localBus
    this.remoteBus = remoteBus
    this.dropMissing(strips)
    this.splice(ctx, master, 'master')
    for (const track of project.tracks) {
      const strip = strips.get(track.id)
      if (strip) this.splice(ctx, strip, track.id)
    }
    const next = this.topologyOf(project)
    if (next !== this.topology) {
      this.topology = next
      const generation = ++this.generation
      void this.finish(ctx, project, strips, master, generation)
    } else this.pushParams()
    this.connectIfNeeded()
  }

  private topologyOf(project: Project) {
    return this.owners(project).map((owner) => {
      const chain = owner.plugins.map((plugin) => `${plugin.id}:${plugin.pluginId}:${plugin.enabled ? 1 : 0}:${plugin.wet > 0.0001 ? 1 : 0}:${plugin.sidechain}`).join(',')
      return `${owner.id}[${chain}]`
    }).join('|')
  }

  private dropMissing(strips: Map<string, StripNodes>) {
    for (const id of [...this.taps.keys()]) {
      if (id === 'master' || strips.has(id)) continue
      const tap = this.taps.get(id)
      this.taps.delete(id)
      if (!tap) continue
      try { tap.input.disconnect() } catch { /* gone */ }
      try { tap.proc?.disconnect() } catch { /* gone */ }
      try { tap.worklet?.disconnect() } catch { /* gone */ }
      try { tap.output.disconnect() } catch { /* gone */ }
    }
  }

  private splice(ctx: AudioContext, strip: StripNodes, id: string) {
    if (this.taps.has(id)) return
    try {
      strip.input.disconnect(strip.eqLow)
    } catch {
      /* already spliced or not connected */
    }
    const input = ctx.createGain()
    const output = ctx.createGain()
    strip.input.connect(input)
    output.connect(strip.eqLow)
    input.connect(output)
    this.taps.set(id, { input, output, proc: null, worklet: null, direct: true })
  }

  private async finish(ctx: AudioContext, project: Project, strips: Map<string, StripNodes>, master: StripNodes, generation: number) {
    const owners = this.owners(project)
    const ids = new Set(owners.flatMap((owner) => owner.plugins.map((plugin) => plugin.pluginId)))
    await Promise.all([...ids].map((id) => loadModule(id)))
    if (generation !== this.generation) return
    this.workletOk = await this.ensureWorklet(ctx)
    if (generation !== this.generation) return
    if (!this.workletOk) await this.ensureProcessors(project, ctx.sampleRate)
    if (generation !== this.generation) return
    let activeCount = 0
    for (const owner of owners) {
      const tap = this.taps.get(owner.id)
      const strip = owner.id === 'master' ? master : strips.get(owner.id)
      if (!tap || !strip) continue
      const active = owner.plugins.some((plugin) => plugin.enabled && plugin.wet > 0.0001 && !this.failed.has(plugin.id))
      if (!active) {
        this.setDirect(tap, true)
        continue
      }
      activeCount += 1
      if (this.workletOk && !tap.worklet) {
        try {
          const node = new AudioWorkletNode(ctx, 'cueharbor-insert', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
          })
          node.port.onmessage = (event) => this.onWorklet(event.data)
          tap.worklet = node
        } catch {
          this.workletOk = false
        }
      }
      if (!tap.worklet && !tap.proc) {
        try {
          tap.proc = ctx.createScriptProcessor(SCRIPT_BLOCK, 2, 2)
        } catch {
          this.setDirect(tap, true)
          continue
        }
        const ownerId = owner.id
        tap.proc.onaudioprocess = (event) => {
          const played = event.playbackTime
          this.blockTime = played && Number.isFinite(played) ? played : (this.ctx?.currentTime ?? 0)
          this.processOwner(ownerId, event)
        }
      }
      this.setDirect(tap, false)
    }
    if (activeCount === 0) this.cpu = 0
    this.pushParams()
    this.rebuildKeys()
    this.connectIfNeeded()
  }

  private owners(project: Project) {
    return [
      { id: 'master', plugins: project.masterPlugins },
      ...project.tracks.map((track) => ({ id: track.id, plugins: track.plugins })),
    ]
  }

  private setDirect(tap: Tap, direct: boolean) {
    const node = tap.worklet || tap.proc
    if (tap.direct === direct && (direct || node)) return
    try { tap.input.disconnect() } catch { /* fresh */ }
    try { tap.proc?.disconnect() } catch { /* fresh */ }
    try { tap.worklet?.disconnect() } catch { /* fresh */ }
    if (direct || !node) {
      tap.input.connect(tap.output)
      tap.direct = true
      return
    }
    tap.input.connect(node)
    node.connect(tap.output)
    tap.direct = false
  }

  private processOwner(owner: string, event: AudioProcessingEvent) {
    const project = this.project
    if (!project) return
    const plugins = owner === 'master' ? project.masterPlugins : project.tracks.find((track) => track.id === owner)?.plugins
    if (!plugins) return
    const rate = event.inputBuffer.sampleRate
    const input = [event.inputBuffer.getChannelData(0), event.inputBuffer.getChannelData(1)]
    const output = [event.outputBuffer.getChannelData(0), event.outputBuffer.getChannelData(1)]
    const beatAt = (sample: number) => projectSampleBeat(project, sample)
    const beat = beatAt(this.clock())
    const scale = tuneBlockScale(project.scale)
    for (const plugin of plugins) {
      const proc = this.processors.get(plugin.id) as Processor & { bind?: (plugin: PluginInstance, channel: (id: string) => Float32Array | null) => void }
      proc?.bind?.(plugin, (id) => this.assetOf(id)?.channels[0] ?? null)
    }
    const origin = this.clock()
    const slots: ChainSlot[] = plugins.map((plugin) => ({
      id: plugin.id,
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      wet: plugin.wet,
      params: { ...plugin.params },
      failed: this.failed.has(plugin.id),
      sidechain: plugin.sidechain,
      processor: this.processors.get(plugin.id) ?? null,
    }))
    const started = performance.now()
    const blockCtx = {
      sampleRate: rate,
      tempo: project.tempo,
      sampleTime: origin,
      sidechain: null,
      scaleRoot: scale.scaleRoot,
      scaleIntervals: scale.scaleIntervals,
      scaleCents: scale.scaleCents,
      quality: this.quality,
      offline: false,
      playTime: this.blockTime,
    }
    const keyAt = (id: string, length: number) => {
      const buf = this.keys.get(id) ?? this.tapsOut.get(id)
      if (!buf?.length) return null
      return buf.subarray(0, Math.min(buf.length, length))
    }
    const endBeat = beatAt(origin + Math.max(0, input[0].length - 1))
    const moving = project.automation.some((lane) => (lane.target == null || lane.target === 'plugin') && plugins.some((plugin) => plugin.id === lane.pluginId) && valueChanges(lane.points, beat, endBeat, 0))
    if (moving) {
      processSampleAccurate(slots, input, output, blockCtx, project.automation, keyAt, beatAt)
    } else {
      for (const slot of slots) slot.params = automationAt(project.automation, slot.id, slot.params, beat)
      processChain(slots, input, output, blockCtx, keyAt)
    }
    for (const slot of slots) {
      if (slot.failed) this.failed.add(slot.id)
      if (slot.processor?.spectrum) this.spectra.set(slot.id, slot.processor.spectrum)
      if (slot.processor?.tuner) this.tuners.set(slot.id, slot.processor.tuner)
      if (slot.processor?.meter) this.meters.set(slot.id, slot.processor.meter)
      if (slot.processor?.trace) this.traces.set(slot.id, slot.processor.trace)
      if (slot.processor?.meters) {
        this.meterReading = slot.processor.meters
        this.meterScope = slot.processor.scope ?? this.meterScope
      }
    }
    this.tapsOut.set(owner, Float32Array.from(output[0]))
    const budget = (input[0].length / rate) * 1000
    const load = budget > 0 ? (performance.now() - started) / budget : 0
    this.cpu = this.cpu * 0.8 + Math.min(4, load) * 0.2
    if (this.phone && this.cpu > 0.7) this.quality = 'eco'
    else if (this.cpu < 0.3) this.quality = 'full'
  }

  private async ensureProcessors(project: Project, sampleRate: number) {
    const plugins = [...project.masterPlugins, ...project.tracks.flatMap((track) => track.plugins)]
    await Promise.all(plugins.map(async (plugin) => {
      if (this.processors.has(plugin.id) || this.failed.has(plugin.id)) return
      const module = await loadModule(plugin.pluginId)
      if (!module) return
      try {
        this.processors.set(plugin.id, module.create(sampleRate))
      } catch {
        this.failed.add(plugin.id)
      }
    }))
  }

  private signatureOf() {
    const project = this.project
    const ctx = this.ctx
    if (!project || !ctx) return ''
    const tracks = project.tracks.map((track) => {
      const dest = track.groupId || track.output || (track.input.startsWith('remote:') ? REMOTE : MASTER)
      const sends = track.sends.filter((send) => send.enabled).map((send) => `${send.id}:${send.busId}:${send.preFader ? 1 : 0}`).join(',')
      return `${track.id}>${dest}@${this.latency(track.id, track.plugins, ctx.sampleRate)}[${sends}]`
    })
    return `${tracks.join(';')}|m${this.latency('master', project.masterPlugins, ctx.sampleRate)}`
  }

  private connectIfNeeded() {
    const project = this.project
    if (!project) return
    const next = this.signatureOf()
    if (next && next === this.signature) {
      this.applySendGains(project)
      this.captureKeys(project)
      return
    }
    this.signature = next
    this.connectGraph()
  }

  private applySendGains(project: Project) {
    for (const track of project.tracks) {
      for (const send of track.sends) {
        const gain = this.sendGains.get(send.id)
        if (gain) gain.gain.value = send.gain
      }
    }
  }

  /** Schedule send levels. A moving lane becomes a sample-accurate ramp on the audio clock. */
  applyAutomation(project: Project, playing: boolean, sample: number, now: number, endSample: number) {
    for (const track of project.tracks) {
      for (const send of track.sends) {
        const node = this.sendGains.get(send.id)
        if (!node) continue
        const points = sendLane(project.automation, track.id, send.id)?.points
        if (!playing || !points?.length) {
          node.gain.cancelScheduledValues(now)
          node.gain.setTargetAtTime(send.gain, now, 0.015)
          continue
        }
        applyRamps(node.gain, automationSchedule(points, send.gain, project, sample, now, endSample), now)
      }
    }
    this.captureKeys(project)
  }

  /** Pre-fader tap so a muted or unprocessed track can still key a compressor or gate. */
  private captureKeys(project: Project) {
    const ctx = this.ctx
    if (!ctx) return
    const needed = new Set<string>()
    for (const plugin of [...project.masterPlugins, ...project.tracks.flatMap((track) => track.plugins)]) {
      if (plugin.sidechain) needed.add(plugin.sidechain)
    }
    for (const id of [...this.keyTaps.keys()]) {
      if (needed.has(id)) continue
      try { this.keyTaps.get(id)?.disconnect() } catch { /* gone */ }
      try { this.keySinks.get(id)?.disconnect() } catch { /* gone */ }
      this.keyTaps.delete(id)
      this.keySinks.delete(id)
    }
    for (const id of needed) {
      if (this.keyTaps.has(id)) continue
      const strip = this.strips.get(id)
      if (!strip) continue
      let proc: AudioNode
      if (this.workletOk) {
        try {
          const node = new AudioWorkletNode(ctx, 'cueharbor-key', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
          node.port.postMessage({ id })
          node.port.onmessage = (event) => {
            const channel = event.data?.channel
            if (event.data?.type !== 'key' || !(channel instanceof Float32Array)) return
            this.keys.set(id, channel)
            this.forwardKey(id, channel)
          }
          proc = node
        } catch {
          continue
        }
      } else {
        let script: ScriptProcessorNode
        try {
          script = ctx.createScriptProcessor(SCRIPT_BLOCK, 2, 2)
        } catch {
          continue
        }
        script.onaudioprocess = (event) => {
          const left = event.inputBuffer.getChannelData(0)
          const right = event.inputBuffer.getChannelData(1)
          const mono = new Float32Array(left.length)
          for (let i = 0; i < left.length; i++) mono[i] = ((left[i] || 0) + (right[i] || 0)) * 0.5
          this.keys.set(id, mono)
          this.forwardKey(id, mono)
          event.outputBuffer.getChannelData(0).set(left)
          event.outputBuffer.getChannelData(1).set(right)
        }
        proc = script
      }
      const sink = ctx.createGain()
      sink.gain.value = 0
      try {
        strip.pan.connect(proc)
        proc.connect(sink)
        sink.connect(ctx.destination)
      } catch {
        continue
      }
      this.keyTaps.set(id, proc)
      this.keySinks.set(id, sink)
    }
  }

  private connectGraph() {
    const ctx = this.ctx
    const project = this.project
    const localBus = this.localBus
    const remoteBus = this.remoteBus
    if (!ctx || !project || !localBus || !remoteBus) return
    for (const link of this.links) {
      try { link.from.disconnect(link.to) } catch { /* already gone */ }
    }
    this.links = []
    this.sendGains.clear()
    const points: RoutePoint[] = project.tracks.map((track) => ({
      id: track.id,
      dest: track.groupId || track.output || (track.input.startsWith('remote:') ? REMOTE : MASTER),
      sends: track.sends.filter((send) => send.enabled).map((send) => send.busId),
      latency: this.latency(track.id, track.plugins, ctx.sampleRate),
    }))
    points.push({ id: MASTER, dest: null, sends: [], latency: this.latency('master', project.masterPlugins, ctx.sampleRate) })
    points.push({ id: REMOTE, dest: null, sends: [], latency: 0 })
    const cyclic = findCycle(points)
    const safe = cyclic ? points.map((point) => (point.id === MASTER || point.id === REMOTE ? point : { ...point, dest: MASTER, sends: [] })) : points
    const delays = edgeDelays(safe)
    const node = (id: string) => {
      if (id === MASTER) return localBus
      if (id === REMOTE) return remoteBus
      return this.strips.get(id)?.input ?? null
    }
    for (const point of safe) {
      if (!point.dest) continue
      const strip = this.strips.get(point.id)
      const dest = node(point.dest)
      if (!strip || !dest || point.dest === point.id) continue
      this.link(ctx, strip.output, dest, delays.get(`${point.id}>${point.dest}`) ?? 0)
      const track = project.tracks.find((item) => item.id === point.id)
      if (!track || cyclic) continue
      for (const send of track.sends) {
        if (!send.enabled) continue
        const bus = node(send.busId)
        if (!bus) continue
        const gain = ctx.createGain()
        gain.gain.value = send.gain
        this.sendGains.set(send.id, gain)
        const from = send.preFader ? strip.pan : strip.output
        this.link(ctx, from, gain, 0)
        this.link(ctx, gain, bus, delays.get(`${track.id}>${send.busId}`) ?? 0)
      }
    }
  }

  private latency(owner: string, plugins: PluginInstance[], sampleRate: number) {
    const tap = this.taps.get(owner)
    const script = tap && !tap.direct && !tap.worklet ? SCRIPT_BLOCK : 0
    return script + plugins.reduce((sum, plugin) => sum + latencyOf(plugin.pluginId, plugin.params, sampleRate, plugin.enabled && plugin.wet > 0, true), 0)
  }

  private async ensureWorklet(ctx: AudioContext) {
    if (this.workletOk) return true
    if (!this.workletPromise) {
      this.workletPromise = ctx.audioWorklet.addModule(insertWorkletUrl).then(() => true).catch(() => false)
    }
    return this.workletPromise
  }

  private pushParams() {
    const project = this.project
    if (!project) return
    const scale = tuneBlockScale(project.scale)
    for (const owner of this.owners(project)) {
      const tap = this.taps.get(owner.id)
      if (!tap?.worklet) continue
      tap.worklet.port.postMessage({
        type: 'state',
        slots: owner.plugins.map((plugin) => ({
          id: plugin.id,
          pluginId: plugin.pluginId,
          enabled: plugin.enabled,
          wet: plugin.wet,
          params: { ...plugin.params },
          sidechain: plugin.sidechain,
          sampler: plugin.sampler,
        })),
        automation: project.automation,
        tempo: project.tempo,
        projectRate: project.sampleRate,
        tempoMap: project.tempoMap ?? [],
        scaleRoot: scale.scaleRoot,
        scaleIntervals: [...scale.scaleIntervals],
        scaleCents: scale.scaleCents ? [...scale.scaleCents] : undefined,
        quality: this.quality,
        playing: this.playing,
        originTime: this.originTime,
        originSample: this.originSample,
      })
      this.postBuffers(tap.worklet, owner.plugins)
    }
  }

  private postBuffers(node: AudioWorkletNode, plugins: PluginInstance[]) {
    const ids = new Set<string>()
    for (const plugin of plugins) {
      if (plugin.sampler?.bufferId) ids.add(plugin.sampler.bufferId)
      for (const slice of plugin.sampler?.slices ?? []) if (slice.bufferId) ids.add(slice.bufferId)
    }
    for (const id of ids) {
      const asset = this.assetOf(id)
      const channel = asset?.channels[0]
      if (!channel?.length) continue
      const mark = `${channel.length}:${channel[0] || 0}`
      if (this.sentBuffers.get(id) === mark) continue
      this.sentBuffers.set(id, mark)
      node.port.postMessage({ type: 'buffer', id, channel: channel.slice() })
    }
  }

  private nodeFor(pluginId: string) {
    const project = this.project
    if (!project) return null
    for (const owner of this.owners(project)) {
      if (!owner.plugins.some((plugin) => plugin.id === pluginId)) continue
      return this.taps.get(owner.id)?.worklet ?? null
    }
    return null
  }

  private forwardKey(id: string, channel: Float32Array) {
    const project = this.project
    if (!project) return
    for (const owner of this.owners(project)) {
      if (!owner.plugins.some((plugin) => plugin.sidechain === id)) continue
      this.taps.get(owner.id)?.worklet?.port.postMessage({ type: 'key', id, channel })
    }
  }

  private onWorklet(data: { type?: string; rows?: { id: string; failed?: boolean; spectrum?: Float32Array | null; tuner?: { hz: number; cents: number; note: number } | null; meter?: { vu: number; gr: number } | null; trace?: Float32Array | null; meters?: Record<string, number> | null; scope?: Float32Array | null; kept?: Float32Array | null }[] }) {
    if (data?.type !== 'meters' || !data.rows) return
    for (const row of data.rows) {
      if (row.failed) this.failed.add(row.id)
      if (row.spectrum) this.spectra.set(row.id, row.spectrum)
      if (row.tuner) this.tuners.set(row.id, row.tuner)
      if (row.meter) this.meters.set(row.id, row.meter)
      if (row.trace) this.traces.set(row.id, row.trace)
      if (row.meters) {
        this.meterReading = row.meters
        if (row.scope) this.meterScope = row.scope
      }
      if (row.kept?.length) this.keptAudio.set(row.id, row.kept)
    }
  }

  private rebuildKeys() {
    for (const id of [...this.keyTaps.keys()]) {
      try { this.keyTaps.get(id)?.disconnect() } catch { /* gone */ }
      try { this.keySinks.get(id)?.disconnect() } catch { /* gone */ }
      this.keyTaps.delete(id)
      this.keySinks.delete(id)
    }
    if (this.project) this.captureKeys(this.project)
  }

  private link(ctx: AudioContext, from: AudioNode, to: AudioNode, samples: number) {
    if (samples <= 0) {
      from.connect(to)
      this.links.push({ from, to })
      return
    }
    const delay = ctx.createDelay(2)
    delay.delayTime.value = Math.min(1.9, samples / ctx.sampleRate)
    from.connect(delay)
    delay.connect(to)
    this.links.push({ from, to: delay }, { from: delay, to })
  }
}
