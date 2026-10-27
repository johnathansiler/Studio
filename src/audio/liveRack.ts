import type { PluginInstance, Project } from '../model/types'
import { scaleById } from '../model/scale'
import { samplesToBeats } from '../model/time'
import type { StripNodes } from './strips'
import { processChain, type ChainSlot } from './plugins/chain'
import { automationAt, latencyOf } from './plugins/catalog'
import { loadModule } from './plugins/registry'
import type { Processor } from './plugins/types'
import { MASTER, REMOTE, edgeDelays, findCycle, type RoutePoint } from './routing'

interface Tap {
  input: GainNode
  output: GainNode
  proc: ScriptProcessorNode | null
  direct: boolean
}

/**
 * Inserts the plugin chain in front of each strip and routes buses.
 * Bypassed tracks stay on a plain gain so they add no latency and no cost.
 * A monitored mic only hits plugins when that track has an enabled insert.
 */
export class LiveRack {
  cpu = 0
  quality: 'full' | 'eco' = 'full'
  clock: () => number = () => 0
  private project: Project | null = null
  private readonly taps = new Map<string, Tap>()
  private readonly processors = new Map<string, Processor>()
  private readonly failed = new Set<string>()
  private readonly spectra = new Map<string, Float32Array>()
  private readonly tapsOut = new Map<string, Float32Array>()
  private readonly sendGains = new Map<string, GainNode>()
  private links: { from: AudioNode; to: AudioNode }[] = []
  private generation = 0
  private signature = ''
  private phone = false
  private ctx: AudioContext | null = null
  private strips: Map<string, StripNodes> = new Map()
  private localBus: AudioNode | null = null
  private remoteBus: AudioNode | null = null

  constructor() {
    if (typeof matchMedia !== 'undefined') this.phone = matchMedia('(max-width: 940px)').matches
  }

  spectrum(pluginId: string) {
    return this.spectra.get(pluginId) ?? null
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
    const generation = ++this.generation
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
    this.connectIfNeeded()
    void this.finish(ctx, project, strips, master, generation)
  }

  private dropMissing(strips: Map<string, StripNodes>) {
    for (const id of [...this.taps.keys()]) {
      if (id === 'master' || strips.has(id)) continue
      const tap = this.taps.get(id)
      this.taps.delete(id)
      if (!tap) continue
      try { tap.input.disconnect() } catch { /* gone */ }
      try { tap.proc?.disconnect() } catch { /* gone */ }
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
    this.taps.set(id, { input, output, proc: null, direct: true })
  }

  private async finish(ctx: AudioContext, project: Project, strips: Map<string, StripNodes>, master: StripNodes, generation: number) {
    const owners = this.owners(project)
    const ids = new Set(owners.flatMap((owner) => owner.plugins.map((plugin) => plugin.pluginId)))
    await Promise.all([...ids].map((id) => loadModule(id)))
    if (generation !== this.generation) return
    await this.ensureProcessors(project, ctx.sampleRate)
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
      if (!tap.proc) {
        try {
          tap.proc = ctx.createScriptProcessor(256, 2, 2)
        } catch {
          this.setDirect(tap, true)
          continue
        }
        tap.proc.onaudioprocess = (event) => this.processOwner(owner.id, event)
      }
      this.setDirect(tap, false)
    }
    if (activeCount === 0) this.cpu = 0
    this.connectIfNeeded()
  }

  private owners(project: Project) {
    return [
      { id: 'master', plugins: project.masterPlugins },
      ...project.tracks.map((track) => ({ id: track.id, plugins: track.plugins })),
    ]
  }

  private setDirect(tap: Tap, direct: boolean) {
    if (tap.direct === direct && (direct || tap.proc)) return
    try { tap.input.disconnect() } catch { /* fresh */ }
    try { tap.proc?.disconnect() } catch { /* fresh */ }
    if (direct || !tap.proc) {
      tap.input.connect(tap.output)
      tap.direct = true
      return
    }
    tap.input.connect(tap.proc)
    tap.proc.connect(tap.output)
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
    const beat = samplesToBeats(this.clock(), rate, project.tempo)
    const scale = scaleById(project.scale?.scale)
    const slots: ChainSlot[] = plugins.map((plugin) => ({
      id: plugin.id,
      pluginId: plugin.pluginId,
      enabled: plugin.enabled,
      wet: plugin.wet,
      params: automationAt(project.automation, plugin.id, plugin.params, beat),
      failed: this.failed.has(plugin.id),
      sidechain: plugin.sidechain,
      processor: this.processors.get(plugin.id) ?? null,
    }))
    const started = performance.now()
    processChain(slots, input, output, {
      sampleRate: rate,
      tempo: project.tempo,
      sampleTime: this.clock(),
      sidechain: null,
      scaleRoot: project.scale?.root ?? 0,
      scaleIntervals: scale.intervals,
      quality: this.quality,
    }, (id, length) => {
      const buf = this.tapsOut.get(id)
      if (!buf || !buf.length) return null
      return buf.subarray(0, Math.min(buf.length, length))
    })
    for (const slot of slots) {
      if (slot.failed) this.failed.add(slot.id)
      if (slot.processor?.spectrum) this.spectra.set(slot.id, slot.processor.spectrum)
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
    const script = tap && !tap.direct ? 256 : 0
    return script + plugins.reduce((sum, plugin) => sum + latencyOf(plugin.pluginId, plugin.params, sampleRate, plugin.enabled && plugin.wet > 0), 0)
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
