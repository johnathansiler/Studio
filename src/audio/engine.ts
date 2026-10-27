import { analyserRms, applyInserts, createStrip, type StripNodes } from './strips'
import type { AudioAsset, AudioClip, MidiNote, Project, Track } from '../model/types'
import { beatsToSamples, projectEndSample, samplesPerBeatUnit, samplesToMusical } from '../model/time'
import { findPeakOffset, jamDelays, perfAtContextTime, type SliceChunk, sliceChunksByPerf } from '../model/latency'
import { encodeWav } from '../model/wav'
import { scaleById } from '../model/scale'
import { LiveRack } from './liveRack'
import { renderGraph } from './renderGraph'
import { loadModule, peekModule } from './plugins/registry'
import { createLoudness, measureLoudness, type LoudnessState } from './plugins/dsp'
import type { Processor } from './plugins/types'

export type EngineStatus = 'stopped' | 'playing' | 'recording' | 'counting-in'

export interface CaptureResult {
  channels: Float32Array[]
  sampleRate: number
  startSample: number
  source: 'local' | 'guide'
  peerId?: string
  takeId?: string
}

interface RecordInput {
  key: string
  stream: MediaStream
  source: 'local' | 'guide'
  peerId?: string
  takeId?: string
}

interface ActiveRec {
  node: AudioWorkletNode
  source: MediaStreamAudioSourceNode
  silent: GainNode
  chunks: { frame: number; left: Float32Array; right: Float32Array | null }[]
  meta: RecordInput
  timelineSample: number
  anchorCtx: number
}

interface Stoppable {
  stop: (when?: number) => void
  disconnect: () => void
}

type PunchInfo = { timelineSample: number; cueEpochHostPerf: number; ctxTime: number }

export class AudioEngine {
  ctx: AudioContext | null = null
  status: EngineStatus = 'stopped'
  positionSamples = 0
  mode: 'arrangement' | 'session' = 'arrangement'
  loopbackMs: number | null = null

  private project: Project | null = null
  private assetOf: (id: string) => AudioAsset | undefined = () => undefined
  private audioBuffers = new Map<string, AudioBuffer>()
  private strips = new Map<string, StripNodes>()
  private masterStrip: StripNodes | null = null
  private localBus: GainNode | null = null
  private remoteBus: GainNode | null = null
  private monitorDelay: DelayNode | null = null
  private remoteDelay: DelayNode | null = null
  private masterGain: GainNode | null = null
  private speakerGain: GainNode | null = null
  private talkBus: GainNode | null = null
  private metroGain: GainNode | null = null
  private cueDest: MediaStreamAudioDestinationNode | null = null
  private recordSink: MediaStreamAudioDestinationNode | null = null
  private inputAnalyser: AnalyserNode | null = null
  private talkAnalyser: AnalyserNode | null = null
  private cueReturnGain: GainNode | null = null
  private cueReturnSrc: MediaStreamAudioSourceNode | null = null
  private meterScratch = new Float32Array(256)
  private readonly rack = new LiveRack()
  private loudness: LoudnessState | null = null
  private lufs = -70
  private truePeak = -70

  private localMicSrc: MediaStreamAudioSourceNode | null = null
  private localMicGain: GainNode | null = null
  private remoteGains = new Map<string, { src: MediaStreamAudioSourceNode; gain: GainNode }>()
  private talkGains = new Map<string, GainNode>()

  private sources: Stoppable[] = []
  private scheduler = 0
  private raf = 0
  private playing = false
  private playOriginCtx = 0
  private playOriginSample = 0
  private arrangementScheduled = false
  private nextLoopCtx: number | null = null
  private nextLoopSample = 0
  private nextMetroSample = 0
  private sessionStarted = new Set<string>()
  private launches = new Map<string, string>()
  private perfAtCtx0 = 0
  private workletsReady = false
  private recorders = new Map<string, ActiveRec>()
  private pendingRecorders: { key: string; stream: MediaStream; handler: () => void }[] = []
  private rollingChunks: SliceChunk[] = []
  private rollingNode: AudioWorkletNode | null = null
  private rollingSrc: MediaStreamAudioSourceNode | null = null
  private rollingSilent: GainNode | null = null
  private countTimer = 0
  private countWait: (() => void) | null = null
  private countPlan: { tempo: number; numerator: number; denominator: number } | null = null
  private lastUiEmit = 0
  private pcmTap: AudioWorkletNode | null = null
  private pcmTapSilent: GainNode | null = null
  private pcmPlayer: AudioWorkletNode | null = null
  private listeners = new Set<() => void>()

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  currentMode(): 'arrangement' | 'session' {
    return this.mode
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? this.project?.sampleRate ?? 48000
  }

  /** baseLatency is the graph block; outputLatency is the device after that. */
  get outputLatencyMs() {
    if (!this.ctx) return 0
    return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000
  }

  get baseLatencyMs() {
    return (this.ctx?.baseLatency || 0) * 1000
  }

  /** Without a loopback measurement, estimate input as one audio block. */
  get inputLatencyMs() {
    if (this.loopbackMs != null) return Math.max(0, this.loopbackMs - this.outputLatencyMs)
    return this.baseLatencyMs || 10
  }

  get cueStream() {
    return this.cueDest?.stream ?? null
  }

  workletError = ''

  /** Call from the tap handler itself. Creates the context and resumes it before any await. */
  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
      } catch {
        this.ctx = new AudioContext({ latencyHint: 'interactive' })
      }
      this.buildMaster()
    }
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined)
    return this.ctx
  }

  async resume(preferredRate = 48000) {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: preferredRate })
      } catch {
        this.ctx = new AudioContext({ latencyHint: 'interactive' })
      }
      this.buildMaster()
    }
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume()
      } catch {
        /* iOS rejects resume outside a tap. The camera must still open. */
      }
    }
    await this.ensureWorklets()
    this.refreshClockAnchor()
    return this.ctx
  }

  private async ensureWorklets() {
    if (!this.ctx || this.workletsReady) return
    try {
      await this.ctx.audioWorklet.addModule('/worklets/recorder.js')
      await this.ctx.audioWorklet.addModule('/worklets/ping.js')
      await this.ctx.audioWorklet.addModule('/worklets/pcm-tap.js')
      await this.ctx.audioWorklet.addModule('/worklets/pcm-player.js')
      this.workletsReady = true
      this.workletError = ''
    } catch (error) {
      this.workletError = error instanceof Error ? error.message : 'AudioWorklet failed'
    }
  }

  refreshClockAnchor() {
    if (!this.ctx) return
    this.perfAtCtx0 = performance.now() - this.ctx.currentTime * 1000
  }

  perfForContext(ctxTime: number) {
    return perfAtContextTime(this.perfAtCtx0, ctxTime)
  }

  contextForPerf(perf: number) {
    return (perf - this.perfAtCtx0) / 1000
  }

  frameForPerf(perf: number) {
    return Math.round(this.contextForPerf(perf) * this.sampleRate)
  }

  private buildMaster() {
    const ctx = this.ctx!
    this.localBus = ctx.createGain()
    this.remoteBus = ctx.createGain()
    this.monitorDelay = ctx.createDelay(2)
    this.monitorDelay.delayTime.value = 0
    this.remoteDelay = ctx.createDelay(2)
    this.remoteDelay.delayTime.value = 0
    this.masterGain = ctx.createGain()
    this.speakerGain = ctx.createGain()
    this.talkBus = ctx.createGain()
    this.metroGain = ctx.createGain()
    this.metroGain.gain.value = 0.45
    this.cueDest = ctx.createMediaStreamDestination()
    this.recordSink = ctx.createMediaStreamDestination()
    this.inputAnalyser = ctx.createAnalyser()
    this.inputAnalyser.fftSize = 256
    this.talkAnalyser = ctx.createAnalyser()
    this.talkAnalyser.fftSize = 256
    this.masterStrip = createStrip(ctx)

    this.localBus.connect(this.masterStrip.input)
    this.masterStrip.output.connect(this.masterGain)
    this.masterGain.connect(this.cueDest)
    this.masterGain.connect(this.monitorDelay)
    this.monitorDelay.connect(this.speakerGain)
    this.remoteBus.connect(this.remoteDelay)
    this.remoteDelay.connect(this.speakerGain)
    this.talkBus.connect(this.talkAnalyser)
    this.talkAnalyser.connect(this.speakerGain)
    this.speakerGain.connect(ctx.destination)
    this.metroGain.connect(this.localBus)
    this.localMicGain = ctx.createGain()
    this.localMicGain.gain.value = 1
  }

  sync(project: Project, assetOf: (id: string) => AudioAsset | undefined) {
    this.project = project
    this.assetOf = assetOf
    if (!this.ctx || !this.localBus || !this.remoteBus || !this.masterGain || !this.masterStrip) return
    for (const track of project.tracks) {
      if (!this.strips.has(track.id)) this.strips.set(track.id, createStrip(this.ctx))
    }
    for (const id of [...this.strips.keys()]) {
      if (!project.tracks.some((t) => t.id === id)) {
        this.strips.get(id)?.output.disconnect()
        this.strips.delete(id)
      }
    }
    const anySolo = project.tracks.some((t) => t.solo)
    for (const track of project.tracks) {
      const strip = this.strips.get(track.id)!
      applyInserts(this.ctx, strip, track.inserts)
      const now = this.ctx.currentTime
      strip.fader.gain.setTargetAtTime(track.volume, now, 0.015)
      strip.pan.pan.setTargetAtTime(track.pan, now, 0.015)
      const audible = !track.mute && (!anySolo || track.solo)
      strip.mute.gain.setTargetAtTime(audible ? 1 : 0, now, 0.01)
    }
    applyInserts(this.ctx, this.masterStrip, project.masterInserts)
    this.masterGain.gain.setTargetAtTime(project.masterVolume, this.ctx.currentTime, 0.015)
    this.rack.assetOf = assetOf
    this.rack.clock = () => this.currentTimelineSample()
    this.rack.route(this.ctx, project, this.strips, this.masterStrip, this.localBus, this.remoteBus)
    this.routeLocalMic()
    this.routeRemotes()
  }

  /** CPU load and master loudness. Loudness is read from the master analyser and includes the master fader. */
  mixMeters() {
    this.sampleLoudness()
    return { cpu: this.rack.cpu, lufs: this.lufs, truePeak: this.truePeak }
  }

  spectrum(pluginId: string) {
    return this.rack.spectrum(pluginId)
  }

  previewSample(pluginId: string, note: number) {
    this.unlock()
    if (this.project) this.sync(this.project, this.assetOf)
    this.rack.trigger(pluginId, note, 0.85)
    window.setTimeout(() => this.rack.trigger(pluginId, note, 0), 280)
  }

  pluginFailed(pluginId: string) {
    return this.rack.isFailed(pluginId)
  }

  private sampleLoudness() {
    if (!this.ctx || !this.masterStrip) return
    if (!this.loudness) this.loudness = createLoudness(this.ctx.sampleRate)
    const frame = new Float32Array(this.masterStrip.analyser.fftSize)
    this.masterStrip.analyser.getFloatTimeDomainData(frame)
    const reading = measureLoudness(this.loudness, frame, null, this.ctx.sampleRate)
    const vol = this.project?.masterVolume ?? 1
    const gainDb = vol > 1e-6 ? 20 * Math.log10(vol) : -80
    this.lufs = Math.max(-70, reading.lufs + gainDb)
    this.truePeak = Math.max(-70, reading.truePeak + gainDb)
  }

  setLaunches(map: Record<string, string | null>) {
    this.launches = new Map(Object.entries(map).filter((e): e is [string, string] => !!e[1]))
  }

  setJam(enabled: boolean, delayMs: number, oneWayMs: number) {
    const delays = jamDelays(enabled, delayMs, oneWayMs)
    if (!this.ctx || !this.monitorDelay || !this.remoteDelay) return delays
    const now = this.ctx.currentTime
    this.monitorDelay.delayTime.setTargetAtTime(delays.localMonitorMs / 1000, now, 0.03)
    this.remoteDelay.delayTime.setTargetAtTime(delays.remoteExtraMs / 1000, now, 0.03)
    return delays
  }

  async setOutputDevice(deviceId: string) {
    if (this.ctx?.setSinkId && deviceId) await this.ctx.setSinkId(deviceId)
  }

  setLocalMic(stream: MediaStream | null) {
    if (!this.ctx || !this.localMicGain || !this.inputAnalyser) return
    this.localMicSrc?.disconnect()
    this.localMicSrc = null
    if (!stream) return
    this.localMicSrc = this.ctx.createMediaStreamSource(stream)
    this.localMicSrc.connect(this.localMicGain)
    this.localMicSrc.connect(this.inputAnalyser)
    this.routeLocalMic()
  }

  private routeLocalMic() {
    if (!this.localMicGain || !this.project) return
    try {
      this.localMicGain.disconnect()
    } catch {
      /* noop */
    }
    if (this.inputAnalyser && this.localMicSrc) {
      try {
        this.localMicSrc.connect(this.inputAnalyser)
      } catch {
        /* already */
      }
    }
    for (const track of this.project.tracks) {
      if (track.input === 'mic' && track.monitor) {
        const strip = this.strips.get(track.id)
        if (strip) this.localMicGain.connect(strip.input)
      }
    }
  }

  setRemoteMusic(peerId: string, stream: MediaStream | null) {
    const prev = this.remoteGains.get(peerId)
    prev?.src.disconnect()
    prev?.gain.disconnect()
    this.remoteGains.delete(peerId)
    if (!stream || !this.ctx) return
    const src = this.ctx.createMediaStreamSource(stream)
    const gain = this.ctx.createGain()
    src.connect(gain)
    this.remoteGains.set(peerId, { src, gain })
    this.routeRemotes()
  }

  private routeRemotes() {
    if (!this.project) return
    for (const entry of this.remoteGains.values()) {
      try {
        entry.gain.disconnect()
      } catch {
        /* noop */
      }
    }
    for (const track of this.project.tracks) {
      if (!track.input.startsWith('remote:')) continue
      const peerId = track.input.slice('remote:'.length)
      const entry = this.remoteGains.get(peerId)
      const strip = this.strips.get(track.id)
      if (entry && strip && track.monitor) entry.gain.connect(strip.input)
    }
  }

  setTalk(peerId: string, stream: MediaStream | null, audible: boolean) {
    const prev = this.talkGains.get(peerId)
    if (prev) {
      prev.disconnect()
      this.talkGains.delete(peerId)
    }
    if (!stream || !this.ctx || !this.talkBus) return
    const src = this.ctx.createMediaStreamSource(stream)
    const gain = this.ctx.createGain()
    gain.gain.value = audible ? 1 : 0
    src.connect(gain)
    gain.connect(this.talkBus)
    this.talkGains.set(peerId, gain)
  }

  setTalkAudible(peerId: string, audible: boolean) {
    const gain = this.talkGains.get(peerId)
    if (gain && this.ctx) gain.gain.setTargetAtTime(audible ? 1 : 0, this.ctx.currentTime, 0.02)
  }

  /** Guest cue return: the host mix, straight to speakers, never back into the cue send. */
  setCueReturn(stream: MediaStream | null) {
    this.cueReturnSrc?.disconnect()
    this.cueReturnSrc = null
    if (!stream || !this.ctx || !this.speakerGain) return
    if (!this.cueReturnGain) {
      this.cueReturnGain = this.ctx.createGain()
      this.cueReturnGain.connect(this.speakerGain)
    }
    this.cueReturnSrc = this.ctx.createMediaStreamSource(stream)
    this.cueReturnSrc.connect(this.cueReturnGain)
  }

  setCueAudible(on: boolean) {
    if (this.cueReturnGain && this.ctx) this.cueReturnGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02)
  }

  levels() {
    const tracks: Record<string, number> = {}
    for (const [id, strip] of this.strips) tracks[id] = analyserRms(strip.analyser, this.meterScratch)
    return {
      master: this.masterStrip ? analyserRms(this.masterStrip.analyser, this.meterScratch) : 0,
      input: this.inputAnalyser ? analyserRms(this.inputAnalyser, this.meterScratch) : 0,
      talk: this.talkAnalyser ? analyserRms(this.talkAnalyser, this.meterScratch) : 0,
      tracks,
    }
  }

  /** Timeline sample from the audio clock, including while the tab is in the background. */
  currentTimelineSample() {
    if (this.playing && this.ctx) return Math.max(0, this.sampleAt(this.ctx.currentTime))
    return this.positionSamples
  }

  seek(sample: number) {
    const next = Math.max(0, Math.round(sample))
    if (this.status === 'recording' || this.status === 'counting-in') return
    if (this.playing) {
      void this.play(next, this.mode)
      return
    }
    this.positionSamples = next
    this.emit()
  }

  async play(fromSample: number, mode: 'arrangement' | 'session' = 'arrangement') {
    await this.resume()
    const startAt = this.ctx!.currentTime + 0.05
    this.startTransport(startAt, fromSample, mode)
  }

  /**
   * Start so the playhead is at `sample` when performance.now() reaches `perfMs`.
   * A late call skips ahead instead of starting the downbeat in the past.
   */
  /** Clicks land on the beats before the next playAtPerf downbeat. */
  armCountIn(tempo: number, signature: { numerator: number; denominator: number }) {
    this.countPlan = { tempo, numerator: signature.numerator, denominator: signature.denominator }
  }

  async playAtPerf(sample: number, perfMs: number, mode: 'arrangement' | 'session' = 'arrangement') {
    await this.resume()
    this.refreshClockAnchor()
    const ctx = this.ctx!
    let startAt = this.contextForPerf(perfMs)
    let from = Math.max(0, sample)
    const earliest = ctx.currentTime + 0.02
    if (startAt < earliest) {
      from += Math.round((earliest - startAt) * this.sampleRate)
      startAt = earliest
    }
    const plan = this.countPlan
    this.countPlan = null
    if (plan) this.scheduleCountClicks(startAt, plan.tempo, plan)
    this.startTransport(startAt, from, mode)
    if (plan && startAt > ctx.currentTime + 0.05) {
      this.status = 'counting-in'
      const wait = Math.max(0, (startAt - ctx.currentTime) * 1000)
      window.clearTimeout(this.countTimer)
      this.countTimer = window.setTimeout(() => {
        if (this.playing && this.status === 'counting-in') {
          this.status = 'playing'
          this.emit()
        }
      }, wait)
      this.emit()
    }
  }

  private startTransport(startAt: number, fromSample: number, mode: 'arrangement' | 'session') {
    this.stopSources()
    this.mode = mode
    this.armTransport(startAt, Math.max(0, fromSample))
    this.status = 'playing'
    this.emit()
  }

  stop() {
    window.clearTimeout(this.countTimer)
    this.countPlan = null
    this.countWait?.()
    this.countWait = null
    this.playing = false
    this.stopSources()
    this.arrangementScheduled = false
    this.sessionStarted.clear()
    this.nextLoopCtx = null
    if (this.scheduler) {
      window.clearInterval(this.scheduler)
      this.scheduler = 0
    }
    if (this.status !== 'stopped') this.status = 'stopped'
    this.emit()
  }

  async beginRecord(opts: {
    fromSample: number
    inputs: RecordInput[]
    countIn: boolean
    hostPerfAtSample?: number
    onPunch?: (info: PunchInfo) => void
  }) {
    await this.resume()
    const punch = () => {
      const ctx = this.ctx!
      this.refreshClockAnchor()
      const ctxTime = opts.hostPerfAtSample != null ? Math.max(this.contextForPerf(opts.hostPerfAtSample), ctx.currentTime + 0.02) : ctx.currentTime + 0.04
      if (!this.playing) this.armTransport(ctxTime, opts.fromSample)
      const timelineSample = this.playing ? Math.round(this.sampleAt(ctxTime)) : opts.fromSample
      const cueEpochHostPerf = this.perfForContext(ctxTime)
      this.status = 'recording'
      this.armRecorders(opts.inputs, timelineSample, ctxTime)
      opts.onPunch?.({ timelineSample, cueEpochHostPerf, ctxTime })
      this.emit()
    }
    if (opts.countIn && opts.hostPerfAtSample != null && this.project && !this.playing) {
      const go = await this.holdForDownbeat(opts.hostPerfAtSample, this.project.tempo, this.project.timeSignature)
      if (!go) return
      punch()
      return
    }
    if (opts.countIn && this.project?.countIn && !this.playing) await this.runCountIn(punch)
    else punch()
  }

  async finishRecording(): Promise<CaptureResult[]> {
    const waits: Promise<void>[] = []
    for (const rec of this.recorders.values()) {
      waits.push(
        new Promise((resolve) => {
          const previous = rec.node.port.onmessage
          rec.node.port.onmessage = (event) => {
            previous?.call(rec.node.port, event)
            if (event.data?.final || event.data?.type === 'stopped') resolve()
          }
          rec.node.port.postMessage({ type: 'stop' })
          window.setTimeout(() => resolve(), 180)
        }),
      )
    }
    await Promise.all(waits)
    for (const pending of this.pendingRecorders) pending.stream.removeEventListener('addtrack', pending.handler)
    this.pendingRecorders = []
    const results: CaptureResult[] = []
    for (const rec of this.recorders.values()) {
      const built = this.assemble(rec)
      if (built) results.push(built)
      rec.source.disconnect()
      rec.node.disconnect()
      rec.silent.disconnect()
    }
    this.recorders.clear()
    if (this.status === 'recording') this.status = this.playing ? 'playing' : 'stopped'
    this.emit()
    return results
  }

  private assemble(rec: ActiveRec): CaptureResult | null {
    if (!rec.chunks.length) return null
    const sr = this.sampleRate
    const first = rec.chunks[0]
    const startSample = Math.round(rec.timelineSample + (first.frame / sr - rec.anchorCtx) * sr)
    let length = 0
    for (const chunk of rec.chunks) length += chunk.left.length
    const left = new Float32Array(length)
    const hasRight = rec.chunks.some((c) => c.right)
    const right = hasRight ? new Float32Array(length) : null
    let offset = 0
    for (const chunk of rec.chunks) {
      left.set(chunk.left, offset)
      if (right && chunk.right) right.set(chunk.right, offset)
      offset += chunk.left.length
    }
    return {
      channels: right ? [left, right] : [left],
      sampleRate: sr,
      startSample: Math.max(0, startSample),
      source: rec.meta.source,
      peerId: rec.meta.peerId,
      takeId: rec.meta.takeId,
    }
  }

  private armRecorders(inputs: RecordInput[], timelineSample: number, anchorCtx: number) {
    if (!this.ctx) return
    for (const input of inputs) {
      if (this.recorders.has(input.key)) continue
      const live = input.stream.getAudioTracks().some((track) => track.readyState === 'live')
      if (!live) {
        const handler = () => {
          if (!input.stream.getAudioTracks().some((track) => track.readyState === 'live')) return
          input.stream.removeEventListener('addtrack', handler)
          this.pendingRecorders = this.pendingRecorders.filter((pending) => pending.key !== input.key)
          if (this.status === 'recording') this.armRecorders([input], timelineSample, anchorCtx)
        }
        this.pendingRecorders = this.pendingRecorders.filter((pending) => pending.key !== input.key)
        this.pendingRecorders.push({ key: input.key, stream: input.stream, handler })
        input.stream.addEventListener('addtrack', handler)
        continue
      }
      let src: MediaStreamAudioSourceNode
      try {
        src = this.ctx.createMediaStreamSource(input.stream)
      } catch {
        continue
      }
      const node = new AudioWorkletNode(this.ctx, 'recorder-processor')
      const silent = this.ctx.createGain()
      silent.gain.value = 0
      src.connect(node)
      node.connect(silent)
      silent.connect(this.recordSink ?? this.ctx.destination)
      const rec: ActiveRec = {
        node,
        source: src,
        silent,
        chunks: [],
        meta: input,
        timelineSample,
        anchorCtx,
      }
      node.port.onmessage = (event) => {
        if (event.data?.type === 'chunk') {
          rec.chunks.push({ frame: event.data.frame, left: event.data.left, right: event.data.right })
        }
      }
      node.port.postMessage({ type: 'start' })
      this.recorders.set(input.key, rec)
    }
  }

  async startRolling(stream: MediaStream) {
    await this.resume()
    this.stopRolling()
    const ctx = this.ctx!
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'recorder-processor')
    const silent = ctx.createGain()
    silent.gain.value = 0
    src.connect(node)
    node.connect(silent)
    silent.connect(this.recordSink ?? ctx.destination)
    this.rollingChunks = []
    node.port.onmessage = (event) => {
      if (event.data?.type !== 'chunk') return
      this.refreshClockAnchor()
      const perfStart = this.perfForContext(event.data.frame / this.sampleRate)
      this.rollingChunks.push({
        perfStart,
        data: event.data.left,
        right: event.data.right instanceof Float32Array ? event.data.right : undefined,
        sampleRate: this.sampleRate,
      })
      const cutoff = performance.now() - 30000
      while (this.rollingChunks.length && this.rollingChunks[0].perfStart < cutoff) this.rollingChunks.shift()
    }
    node.port.postMessage({ type: 'start' })
    this.rollingNode = node
    this.rollingSrc = src
    this.rollingSilent = silent
  }

  stopRolling() {
    this.rollingNode?.port.postMessage({ type: 'stop' })
    this.rollingSrc?.disconnect()
    this.rollingNode?.disconnect()
    this.rollingSilent?.disconnect()
    this.rollingNode = null
    this.rollingSrc = null
    this.rollingSilent = null
    this.rollingChunks = []
  }

  sliceRolling(perfStart: number, perfEnd: number) {
    return sliceChunksByPerf(this.rollingChunks, perfStart, perfEnd)
  }

  async startPcmTap(onFrame: (samples: Float32Array, frame: number) => void) {
    await this.resume()
    this.stopPcmTap()
    const ctx = this.ctx!
    if (!this.masterGain) return
    const frameSize = Math.round(ctx.sampleRate / 100)
    const node = new AudioWorkletNode(ctx, 'pcm-tap', { processorOptions: { frameSize } })
    const silent = ctx.createGain()
    silent.gain.value = 0
    this.masterGain.connect(node)
    node.connect(silent)
    silent.connect(ctx.destination)
    node.port.onmessage = (event) => {
      if (event.data?.type === 'frame') onFrame(event.data.samples, event.data.frame)
    }
    node.port.postMessage({ type: 'start' })
    this.pcmTap = node
    this.pcmTapSilent = silent
  }

  async startMicPcmTap(stream: MediaStream, onFrame: (samples: Float32Array, frame: number) => void) {
    await this.resume()
    this.stopPcmTap()
    const ctx = this.ctx!
    const frameSize = Math.round(ctx.sampleRate / 100)
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-tap', { processorOptions: { frameSize } })
    const silent = ctx.createGain()
    silent.gain.value = 0
    src.connect(node)
    node.connect(silent)
    silent.connect(ctx.destination)
    node.port.onmessage = (event) => {
      if (event.data?.type === 'frame') onFrame(event.data.samples, event.data.frame)
    }
    node.port.postMessage({ type: 'start' })
    this.pcmTap = node
    this.pcmTapSilent = silent
  }

  stopPcmTap() {
    this.pcmTap?.port.postMessage({ type: 'stop' })
    this.pcmTap?.disconnect()
    this.pcmTapSilent?.disconnect()
    this.pcmTap = null
  }

  async ensurePcmPlayer() {
    await this.resume()
    if (this.pcmPlayer || !this.speakerGain || !this.ctx) return
    const node = new AudioWorkletNode(this.ctx, 'pcm-player')
    node.connect(this.speakerGain)
    this.pcmPlayer = node
  }

  writePcm(frame: number, samples: Float32Array) {
    this.pcmPlayer?.port.postMessage({ type: 'write', frame, samples })
  }

  attachPing(stream: MediaStream, onPeak: (frame: number, mag: number) => void) {
    if (!this.ctx) return () => undefined
    const src = this.ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(this.ctx, 'ping-processor')
    const silent = this.ctx.createGain()
    silent.gain.value = 0
    src.connect(node)
    node.connect(silent)
    silent.connect(this.ctx.destination)
    node.port.onmessage = (event) => {
      if (event.data?.type === 'peak') onPeak(event.data.frame, event.data.mag)
    }
    return () => {
      src.disconnect()
      node.disconnect()
      silent.disconnect()
    }
  }

  playCuePing(atCtxTime: number) {
    if (!this.ctx || !this.masterGain) return
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.frequency.value = 2100
    gain.gain.setValueAtTime(0.0001, atCtxTime)
    gain.gain.exponentialRampToValueAtTime(0.85, atCtxTime + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, atCtxTime + 0.025)
    osc.connect(gain)
    gain.connect(this.masterGain)
    osc.start(atCtxTime)
    osc.stop(atCtxTime + 0.04)
    this.sources.push(osc)
  }

  async calibrateLoopback(stream: MediaStream): Promise<number> {
    await this.resume()
    const ctx = this.ctx!
    const node = new AudioWorkletNode(ctx, 'recorder-processor')
    const src = ctx.createMediaStreamSource(stream)
    const silent = ctx.createGain()
    silent.gain.value = 0
    const chunks: Float32Array[] = []
    let firstFrame = 0
    node.port.onmessage = (event) => {
      if (event.data?.type !== 'chunk') return
      if (!chunks.length) firstFrame = event.data.frame
      chunks.push(event.data.left)
    }
    src.connect(node)
    node.connect(silent)
    silent.connect(ctx.destination)
    node.port.postMessage({ type: 'start' })
    const playAt = ctx.currentTime + 0.45
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = 1800
    gain.gain.setValueAtTime(0.0001, playAt)
    gain.gain.exponentialRampToValueAtTime(0.9, playAt + 0.001)
    gain.gain.exponentialRampToValueAtTime(0.0001, playAt + 0.03)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(playAt)
    osc.stop(playAt + 0.04)
    await new Promise((resolve) => window.setTimeout(resolve, 1600))
    node.port.postMessage({ type: 'stop' })
    await new Promise((resolve) => window.setTimeout(resolve, 80))
    src.disconnect()
    node.disconnect()
    silent.disconnect()
    const length = chunks.reduce((s, c) => s + c.length, 0)
    const recorded = new Float32Array(length)
    let offset = 0
    for (const chunk of chunks) {
      recorded.set(chunk, offset)
      offset += chunk.length
    }
    const playedIndex = Math.round(playAt * ctx.sampleRate) - firstFrame
    const delta = findPeakOffset(recorded, Math.max(0, playedIndex), Math.max(0, playedIndex))
    const ms = (delta / ctx.sampleRate) * 1000
    this.loopbackMs = ms
    this.emit()
    return ms
  }

  async exportMix(project: Project, assets: Map<string, AudioAsset>): Promise<ArrayBuffer> {
    const rate = this.sampleRate
    const end = Math.max(rate, projectEndSample(project.tracks, rate, project.tempo))
    const renderedTracks = []
    for (const track of project.tracks) {
      const offline = new OfflineAudioContext(2, end, rate)
      const input = offline.createGain()
      input.connect(offline.destination)
      const strip = { input } as StripNodes
      for (const clip of track.clips) {
        const asset = assets.get(clip.bufferId)
        if (!asset) continue
        const buffer = this.bufferFromAsset(offline, asset)
        this.scheduleAudioClip(offline, strip, buffer, clip, 0, 0, end)
      }
      for (const clip of track.midiClips) {
        for (const note of clip.notes) {
          const start = beatsToSamples(clip.startBeat + note.startBeat, rate, project.tempo)
          const dur = beatsToSamples(note.durationBeats, rate, project.tempo) / rate
          if (start >= end) continue
          this.scheduleVoice(offline, strip, note, start / rate, dur)
        }
      }
      const rendered = await offline.startRendering()
      const left = new Float32Array(rendered.getChannelData(0))
      const right = rendered.numberOfChannels > 1 ? new Float32Array(rendered.getChannelData(1)) : new Float32Array(left)
      renderedTracks.push({
        id: track.id,
        type: track.type,
        input: track.input,
        buffer: [left, right],
        volume: track.volume,
        pan: track.pan,
        mute: track.mute,
        solo: track.solo,
        plugins: track.plugins,
        sends: track.sends,
        output: track.output,
        groupId: track.groupId,
      })
    }
    const ids = new Set<string>()
    for (const track of project.tracks) for (const plugin of track.plugins) ids.add(plugin.pluginId)
    for (const plugin of project.masterPlugins) ids.add(plugin.pluginId)
    await Promise.all([...ids].map((id) => loadModule(id)))
    const scale = scaleById(project.scale?.scale)
    const graph = renderGraph({
      tracks: renderedTracks,
      masterPlugins: project.masterPlugins,
      masterVolume: project.masterVolume,
      sampleRate: rate,
      tempo: project.tempo,
      length: end,
      scaleRoot: project.scale?.root ?? 0,
      scaleIntervals: scale.intervals,
      automation: project.automation,
      liveRemote: false,
      create: (pluginId, sampleRate) => peekModule(pluginId)?.create(sampleRate) ?? passthrough(),
    })
    return encodeWav(graph.master, rate)
  }

  bufferFor(asset: AudioAsset) {
    if (!this.ctx) return null
    return this.bufferFromAsset(this.ctx, asset)
  }

  private bufferFromAsset(ctx: BaseAudioContext, asset: AudioAsset) {
    const cached = ctx === this.ctx ? this.audioBuffers.get(asset.id) : undefined
    if (cached) return cached
    const length = asset.channels[0]?.length ?? 0
    const buffer = ctx.createBuffer(Math.max(1, asset.channels.length), Math.max(1, length), asset.sampleRate)
    asset.channels.forEach((channel, index) => buffer.copyToChannel(new Float32Array(channel), index))
    if (ctx === this.ctx) this.audioBuffers.set(asset.id, buffer)
    return buffer
  }

  private scheduleCountClicks(startAt: number, tempo: number, signature: { numerator: number; denominator: number }) {
    if (!this.ctx) return
    const beatSec = samplesPerBeatUnit(this.sampleRate, tempo, signature) / this.sampleRate
    const beats = Math.max(1, signature.numerator)
    for (let i = 0; i < beats; i++) {
      const when = startAt - (beats - i) * beatSec
      if (when >= this.ctx.currentTime - 0.02) this.click(when, i === 0)
    }
  }

  /** Play the count-in and resolve at the downbeat. Stop during the wait resolves false. */
  private async holdForDownbeat(downbeatPerf: number, tempo: number, signature: { numerator: number; denominator: number }) {
    await this.resume()
    this.refreshClockAnchor()
    const ctx = this.ctx!
    const startAt = Math.max(this.contextForPerf(downbeatPerf), ctx.currentTime + 0.02)
    this.scheduleCountClicks(startAt, tempo, signature)
    this.status = 'counting-in'
    this.emit()
    const wait = Math.max(0, (startAt - ctx.currentTime) * 1000)
    await new Promise<void>((resolve) => {
      this.countWait = resolve
      this.countTimer = window.setTimeout(() => {
        this.countWait = null
        resolve()
      }, wait)
    })
    return this.status === 'counting-in'
  }

  private async runCountIn(done: () => void) {
    const ctx = this.ctx!
    const project = this.project!
    const beatSec = samplesPerBeatUnit(this.sampleRate, project.tempo, project.timeSignature) / this.sampleRate
    const beats = project.timeSignature.numerator
    const start = ctx.currentTime + 0.06
    for (let i = 0; i < beats; i++) this.click(start + i * beatSec, i === 0)
    this.status = 'counting-in'
    this.emit()
    const runAt = start + beats * beatSec
    await new Promise<void>((resolve) => {
      this.countTimer = window.setTimeout(() => resolve(), Math.max(0, (runAt - ctx.currentTime) * 1000))
    })
    if (this.status !== 'counting-in') return
    done()
  }

  private armTransport(startAt: number, fromSample: number) {
    this.playing = true
    this.playOriginCtx = startAt
    this.playOriginSample = fromSample
    this.positionSamples = fromSample
    this.arrangementScheduled = false
    this.sessionStarted.clear()
    this.nextLoopCtx = null
    const beat = this.project
      ? samplesPerBeatUnit(this.sampleRate, this.project.tempo, this.project.timeSignature)
      : this.sampleRate / 2
    this.nextMetroSample = Math.ceil(fromSample / beat - 1e-6) * beat
    if (!this.scheduler) {
      this.scheduler = window.setInterval(() => {
        this.scheduleAhead()
        if (this.playing && this.ctx) this.positionSamples = this.currentTimelineSample()
        const now = performance.now()
        if (now - this.lastUiEmit > 50) {
          this.lastUiEmit = now
          this.emit()
        }
      }, 25)
    }
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick())
    this.scheduleAhead()
  }

  private sampleAt(ctxTime: number) {
    return this.playOriginSample + (ctxTime - this.playOriginCtx) * this.sampleRate
  }

  private tick = () => {
    if (this.playing && this.ctx) {
      let sample = this.sampleAt(this.ctx.currentTime)
      const project = this.project
      if (
        project &&
        this.mode === 'arrangement' &&
        project.loopEnabled &&
        this.status !== 'recording' &&
        this.status !== 'counting-in'
      ) {
        const len = project.loopEndSample - project.loopStartSample
        if (len > 1 && sample >= project.loopEndSample) {
          sample = project.loopStartSample + ((sample - project.loopStartSample) % len)
        }
      }
      this.positionSamples = Math.max(0, sample)
      if (project && this.mode === 'arrangement' && !project.loopEnabled && this.status === 'playing') {
        const end = projectEndSample(project.tracks, this.sampleRate, project.tempo)
        if (sample > end + this.sampleRate) {
          this.stop()
          return
        }
      }
    }
    const now = performance.now()
    if (now - this.lastUiEmit > 50) {
      this.lastUiEmit = now
      this.emit()
    }
    if (this.playing || this.status === 'counting-in' || this.status === 'recording') {
      this.raf = requestAnimationFrame(this.tick)
    } else {
      this.raf = 0
      this.emit()
    }
  }

  private scheduleAhead() {
    if (!this.playing || !this.ctx || !this.project) return
    const horizon = this.ctx.currentTime + 0.35
    this.refreshClockAnchor()
    this.scheduleMetronome(horizon)
    if (this.mode === 'session') this.scheduleSession(horizon)
    else this.scheduleArrangement(horizon)
  }

  private scheduleMetronome(horizon: number) {
    const project = this.project
    if (!project?.metronomeEnabled || !this.ctx) return
    const beat = samplesPerBeatUnit(this.sampleRate, project.tempo, project.timeSignature)
    while (this.nextMetroSample < this.playOriginSample + this.sampleRate * 60 * 10) {
      const when = this.playOriginCtx + (this.nextMetroSample - this.playOriginSample) / this.sampleRate
      if (when > horizon) break
      if (when >= this.ctx.currentTime - 0.01) {
        const pos = samplesToMusical(this.nextMetroSample, this.sampleRate, project.tempo, project.timeSignature)
        this.click(when, pos.beat === 1)
      }
      this.nextMetroSample += beat
    }
  }

  private click(when: number, accent: boolean) {
    if (!this.ctx || !this.metroGain) return
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = accent ? 1760 : 1180
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(accent ? 0.35 : 0.18, when + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045)
    osc.connect(gain)
    gain.connect(this.metroGain)
    osc.start(when)
    osc.stop(when + 0.05)
    this.sources.push(osc)
  }

  private scheduleArrangement(horizon: number) {
    const project = this.project!
    const end = projectEndSample(project.tracks, this.sampleRate, project.tempo)
    if (!project.loopEnabled || this.status === 'recording') {
      if (this.arrangementScheduled) return
      this.arrangementScheduled = true
      this.scheduleWindow(this.playOriginCtx, this.playOriginSample, end)
      return
    }
    const loopLen = project.loopEndSample - project.loopStartSample
    if (loopLen < 16) return
    if (this.nextLoopCtx == null) {
      this.nextLoopCtx = this.playOriginCtx
      this.nextLoopSample = this.playOriginSample
    }
    while (this.nextLoopCtx < horizon) {
      const samples = Math.max(1, project.loopEndSample - this.nextLoopSample)
      this.scheduleWindow(this.nextLoopCtx, this.nextLoopSample, this.nextLoopSample + samples)
      this.nextLoopCtx += samples / this.sampleRate
      this.nextLoopSample = project.loopStartSample
    }
  }

  private scheduleSession(horizon: number) {
    const project = this.project!
    const sr = this.sampleRate
    const beat = samplesPerBeatUnit(sr, project.tempo, project.timeSignature)
    for (const [trackId, clipId] of this.launches) {
      if (this.sessionStarted.has(trackId)) continue
      const track = project.tracks.find((t) => t.id === trackId)
      const strip = this.strips.get(trackId)
      if (!track || !strip || !this.ctx) continue
      const nowSample = Math.max(this.playOriginSample, this.sampleAt(this.ctx.currentTime))
      const quant = Math.max(nowSample, Math.ceil((nowSample - 1) / beat) * beat)
      const when = this.playOriginCtx + (quant - this.playOriginSample) / sr
      if (when > horizon) continue
      const audio = track.clips.find((c) => c.id === clipId)
      const midi = track.midiClips.find((c) => c.id === clipId)
      if (audio) {
        const asset = this.assetOf(audio.bufferId)
        if (!asset) continue
        const buffer = this.bufferFromAsset(this.ctx, asset)
        const src = this.ctx.createBufferSource()
        src.buffer = buffer
        const offset = audio.offsetSamples / buffer.sampleRate
        const dur = audio.durationSamples / sr
        src.loop = true
        src.loopStart = offset
        src.loopEnd = offset + dur
        const gain = this.ctx.createGain()
        gain.gain.value = audio.gain
        src.connect(gain)
        gain.connect(strip.input)
        src.start(Math.max(when, this.ctx.currentTime + 0.01), offset)
        this.sources.push(src)
      } else if (midi) {
        this.scheduleMidiLoop(track, strip, midi.id, when)
      } else continue
      this.sessionStarted.add(trackId)
    }
  }

  private scheduleMidiLoop(track: Track, strip: StripNodes, clipId: string, firstWhen: number) {
    const project = this.project!
    const clip = track.midiClips.find((c) => c.id === clipId)
    if (!clip || !this.ctx) return
    const sr = this.sampleRate
    const durSec = beatsToSamples(clip.durationBeats, sr, project.tempo) / sr
    // Schedule two loops ahead; the look-ahead interval calls scheduleSession only once per track.
    // A dedicated repeater keeps MIDI session clips alive.
    const schedulePass = (when: number) => {
      if (!this.playing || this.mode !== 'session' || !this.launches.has(track.id)) return
      for (const note of clip.notes) {
        const noteDelay = beatsToSamples(note.startBeat, sr, project.tempo) / sr
        const noteDur = beatsToSamples(note.durationBeats, sr, project.tempo) / sr
        this.scheduleVoice(this.ctx!, strip, note, when + noteDelay, noteDur)
      }
      const timer = window.setTimeout(() => schedulePass(when + durSec), Math.max(20, durSec * 1000 - 200))
      this.sources.push({
        stop: () => window.clearTimeout(timer),
        disconnect: () => undefined,
      })
    }
    schedulePass(firstWhen)
  }

  private scheduleWindow(ctxTime: number, timelineStart: number, timelineEnd: number) {
    const project = this.project
    const ctx = this.ctx
    if (!project || !ctx) return
    for (const track of project.tracks) {
      const strip = this.strips.get(track.id)
      if (!strip) continue
      for (const clip of track.clips) {
        const asset = this.assetOf(clip.bufferId)
        if (!asset) continue
        const buffer = this.bufferFromAsset(ctx, asset)
        this.scheduleAudioClip(ctx, strip, buffer, clip, ctxTime, timelineStart, timelineEnd)
      }
      for (const clip of track.midiClips) {
        const clipStart = beatsToSamples(clip.startBeat, this.sampleRate, project.tempo)
        for (const note of clip.notes) {
          const noteStart = clipStart + beatsToSamples(note.startBeat, this.sampleRate, project.tempo)
          const noteDurSamples = beatsToSamples(note.durationBeats, this.sampleRate, project.tempo)
          if (noteStart + noteDurSamples <= timelineStart || noteStart >= timelineEnd) continue
          const when = ctxTime + (noteStart - timelineStart) / this.sampleRate
          if (when < ctx.currentTime) continue
          this.scheduleVoice(ctx, strip, note, when, noteDurSamples / this.sampleRate)
        }
      }
    }
  }

  private scheduleAudioClip(
    ctx: BaseAudioContext,
    strip: StripNodes,
    buffer: AudioBuffer,
    clip: AudioClip,
    ctxTime: number,
    timelineStart: number,
    timelineEnd: number,
  ) {
    const sr = ctx.sampleRate
    const clipEnd = clip.startSample + clip.durationSamples
    const from = Math.max(clip.startSample, timelineStart)
    const to = Math.min(clipEnd, timelineEnd)
    if (to - from < 8) return
    const when = ctxTime + (from - timelineStart) / sr
    if (ctx === this.ctx && when < ctx.currentTime - 0.02) return
    const offset = (clip.offsetSamples + (from - clip.startSample)) / buffer.sampleRate
    const dur = (to - from) / sr
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const gain = ctx.createGain()
    const relFrom = (from - clip.startSample) / sr
    const relTo = (to - clip.startSample) / sr
    const clipDur = clip.durationSamples / sr
    const fadeIn = clip.fadeInSamples / sr
    const fadeOut = clip.fadeOutSamples / sr
    const env = (t: number) => {
      let g = clip.gain
      if (fadeIn > 0 && t < fadeIn) g *= t / fadeIn
      if (fadeOut > 0 && t > clipDur - fadeOut) g *= Math.max(0, (clipDur - t) / fadeOut)
      return Math.max(0.0001, g)
    }
    gain.gain.setValueAtTime(env(relFrom), when)
    if (fadeIn > 0 && relFrom < fadeIn) {
      gain.gain.linearRampToValueAtTime(clip.gain, Math.min(when + (fadeIn - relFrom), when + dur))
    }
    if (fadeOut > 0 && relTo > clipDur - fadeOut) {
      const start = when + Math.max(0, clipDur - fadeOut - relFrom)
      gain.gain.setValueAtTime(Math.max(0.0001, clip.gain), start)
      gain.gain.linearRampToValueAtTime(0.0001, when + dur)
    }
    src.connect(gain)
    gain.connect(strip.input)
    src.start(Math.max(when, 0), Math.max(0, offset), dur)
    if (ctx === this.ctx) this.sources.push(src)
  }

  /** Local audition only. Stays on the speaker and never enters the cue or mic path. */
  previewPitches(pitches: number[]) {
    const ctx = this.ctx
    const out = this.speakerGain
    if (!ctx || !out) return
    const unique = [...new Set(pitches.map((pitch) => Math.round(pitch)).filter((pitch) => pitch >= 0 && pitch <= 127))]
    if (!unique.length) return
    const now = ctx.currentTime
    const bus = ctx.createGain()
    const level = 0.08 / Math.sqrt(unique.length)
    bus.gain.setValueAtTime(0.0001, now)
    bus.gain.exponentialRampToValueAtTime(level, now + 0.015)
    bus.gain.exponentialRampToValueAtTime(0.0001, now + 0.5)
    bus.connect(out)
    let pending = unique.length
    for (const pitch of unique) {
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = 440 * 2 ** ((pitch - 69) / 12)
      osc.connect(bus)
      osc.onended = () => {
        pending -= 1
        if (pending > 0) return
        try {
          bus.disconnect()
        } catch {
          /* already disconnected */
        }
      }
      osc.start(now)
      osc.stop(now + 0.55)
    }
  }

  private scheduleVoice(ctx: BaseAudioContext, strip: StripNodes, note: MidiNote, when: number, dur: number) {
    if (ctx === this.ctx && when < ctx.currentTime) return
    const osc = ctx.createOscillator()
    const filter = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12)
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(2200, when)
    filter.frequency.exponentialRampToValueAtTime(900, when + Math.min(0.3, dur))
    const peak = Math.max(0.001, 0.07 * note.velocity)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.05, dur))
    osc.connect(filter)
    filter.connect(gain)
    gain.connect(strip.input)
    osc.start(when)
    osc.stop(when + dur + 0.03)
    if (ctx === this.ctx) this.sources.push(osc)
  }

  private stopSources() {
    for (const src of this.sources) {
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    this.sources = []
  }
}

function passthrough(): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)]
        if (src && output[c]) output[c].set(src)
      }
    },
  }
}
