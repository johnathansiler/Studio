import { clipNeedsStretch, preferStretchCache, renderClipChannels, sourceSamplesOf, timelineSamples } from './stretch/engine'
import { onSpectralCommit } from './spectral/job'
import { onStretchCommit, readStretch, storeStretch, stretchCacheKey, stretchSlot } from './stretch/commit'
import type { StretchMode } from './stretch/engine'
import { analyserRms, applyInserts, createStrip, type StripNodes } from './strips'
import { compPieces, recordOffsetSamples } from '../model/comp'
import { quantizeSample, renderTempoWarp, warpRate } from '../model/launch'
import { clipLoops, holdUntilGrid, sessionStartContext } from '../model/sessionSlots'
import { DRUM_PADS, residentDrums, type ResidentDrum } from '../model/drums'
import { calibrationTrim, contextTimeForEvent, monitoringOffset, type ClockStamp } from '../model/midiClock'
import { isLocalInput, type AudioAsset, type AudioClip, type MidiNote, type Project, type Track } from '../model/types'
import { arrangementEndSample, beatSpanSamples, clickAccent, clickAtOrAfter, meterAtSample, nextClickAfter, projectSampleBeat, tempoAtSample } from '../model/tempoMap'
import { planLoopAudio } from '../model/loopEdit'
import { playbackStops, transportSample } from '../model/transportSync'
import { beatsToSamples, samplesPerBeatUnit, samplesToBeats } from '../model/time'
import { matchBufferRate, PatchHost, renderPatchSpan } from '../instruments/patch'
import { performancesOn, routeScaler } from '../instruments/scaler/model'
import { chokeTargets } from '../model/padMachine'
import { RackHost } from './rack/host'
import { renderNotes } from './rack/dsp'
import { LibraryHost } from './multisample/host'
import type { SamplePack } from './multisample/types'
import { renderQuantizedClip } from '../model/quantize'
import { emptyPatternLoopSamples, patternHitTrack, rackPlayMode, transportPatternClips } from '../model/channelRack'
import { patternPlayRange, renderPattern, type RenderedHit } from '../model/steps'
import { findPeakOffset, jamDelays, perfAtContextTime, type SliceChunk, sliceChunksByPerf } from '../model/latency'
import { encodeWav, linearResample } from '../model/wav'
import { tuneBlockScale } from './plugins/autoTune'
import { audibleIds } from '../model/audible'
import { automationSchedule, laneFor, modeOf, rackLanesFor, valueAtMappedSample } from '../model/automation'
import { applyRamps } from './paramCurve'
import { chainContext, enabledFx, LiveMidiChain, midiVelocityByte, noteBytes, prepareClipNotes } from '../model/midiTools'
import { LiveRack } from './liveRack'
import { renderSamplerSpan } from './plugins/sampler'
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
  /** Armed track id this capture was recorded for. */
  key?: string
}

interface RecordInput {
  key: string
  stream: MediaStream
  source: 'local' | 'guide'
  peerId?: string
  takeId?: string
  /** Interface channel. Omitted records the whole stream. */
  channel?: number
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
  /** Pauses meters and canvases while a performance is being recorded. */
  performanceMode = false
  private keysNode: AudioWorkletNode | null = null
  private keysSab: Int32Array | null = null
  private drumTable: ResidentDrum[] = []
  private drumBuffers: AudioBuffer[] = []
  private warmVoices: { osc: OscillatorNode; gain: GainNode; busy: boolean; pitch: number; age: number }[] = []
  lastOnsetFrame = -1
  private oneShots: { pitch: number; when: number; stop: () => void }[] = []
  /** While the Pads faceplate is open, hits go to that track's mixer channel. */
  private padRouteId: string | null = null
  private padVoices: { pitch: number; gain: GainNode; stop: (at?: number) => void; born: number; until: number; src: AudioBufferSourceNode }[] = []
  private padCaches = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>()
  private drumCache = new WeakMap<BaseAudioContext, AudioBuffer[]>()

  private project: Project | null = null
  private assetOf: (id: string) => AudioAsset | undefined = () => undefined
  private audioBuffers = new Map<string, AudioBuffer>()
  private strips = new Map<string, StripNodes>()
  private masterStrip: StripNodes | null = null
  /** Unrouted drum hits. Solo closes this gain; the master still passes what remains. */
  private patternStrip: StripNodes | null = null
  /** Live drums and keys that are not already inside a track strip. */
  private liveBus: GainNode | null = null
  private localBus: GainNode | null = null
  private remoteBus: GainNode | null = null
  private monitorDelay: DelayNode | null = null
  private remoteDelay: DelayNode | null = null
  private masterGain: GainNode | null = null
  /** Loudness-matched dry comparison. 1 leaves the master fader alone. */
  compareGain = 1
  private referenceOn = false
  private referenceSource: AudioBufferSourceNode | null = null
  private referenceGain: GainNode | null = null
  private speakerGain: GainNode | null = null
  /** Safety limiter in front of the speakers. Keeps a summed mix from hard-clipping. */
  private safety: DynamicsCompressorNode | null = null
  private talkBus: GainNode | null = null
  private metroGain: GainNode | null = null
  private cueDest: MediaStreamAudioDestinationNode | null = null
  private recordSink: MediaStreamAudioDestinationNode | null = null
  private inputAnalyser: AnalyserNode | null = null
  private tuneAnalyser: AnalyserNode | null = null
  private talkAnalyser: AnalyserNode | null = null
  private cueReturnGain: GainNode | null = null
  private cueReturnSrc: MediaStreamAudioSourceNode | null = null
  private meterScratch = new Float32Array(256)
  private readonly rackHost = new RackHost()
  private readonly libraryHost = new LibraryHost()
  private readonly libraryHeld = new Set<string>()
  private libraryWarmAt = 0
  private readonly patchHost = new PatchHost()
  private patchRateCache = new Map<string, Float32Array>()
  private readonly rack = new LiveRack()
  private loudness: LoudnessState | null = null
  private lufs = -70
  private truePeak = -70

  private localMicSrc: MediaStreamAudioSourceNode | null = null
  private monitorSplit: ChannelSplitterNode | null = null
  private localMicGain: GainNode | null = null
  private directMonitor = false
  private tuneMuted = false
  private remoteGains = new Map<string, { src: MediaStreamAudioSourceNode; gain: GainNode }>()
  private talkGains = new Map<string, GainNode>()

  private sources: Stoppable[] = []
  private previewStops: Stoppable[] = []
  /** Notes from the last Scaler preview, so the next chord can cut them. */
  private scalerVoices: Stoppable[] = []
  private scalerMidi: { pitch: number; onAt: number }[] = []
  private warpPcm = new Map<string, Float32Array[]>()
  private scheduler = 0
  /** Beat repeat is armed, so the look-ahead pump stays up while transport is stopped. */
  private repeatWatch = false
  private beatPump: ((now: number, horizon: number) => void) | null = null
  private raf = 0
  private playing = false
  private playOriginCtx = 0
  private playOriginSample = 0
  private arrangementScheduled = false
  /** Pattern mode and the open pattern. A change rearms the shared transport. */
  private rackToken = ''
  private loopArmed: boolean | null = null
  private loopSpanStart = -1
  private loopSpanEnd = -1
  private loopQueuedUntil = 0
  private loopQueuedCtx = 0
  private loopRestartAt = 0
  private loopAudioDirty = false
  private pendingSchedule = false
  private scheduling = false
  private nextLoopCtx: number | null = null
  private nextLoopSample = 0
  private nextMetroSample = 0
  private sessionStarted = new Set<string>()
  private sessionClip = new Map<string, string>()
  private sessionGen = new Map<string, number>()
  private sessionNodes = new Map<string, Stoppable[]>()
  /** Identifies the loop currently allowed to schedule on a track. */
  private activeLoop = new Map<string, object>()
  /** A clip that keeps sounding until a queued launch reaches the grid. */
  private retiring = new Map<string, { clipId: string; until: number; token: object; nodes: Stoppable[] }>()
  private launches = new Map<string, string>()
  private launchAt = new Map<string, number>()
  private launchGen = new Map<string, number>()
  private perfAtCtx0 = 0
  private workletsReady = false
  private stretchReady = false
  private readonly stretchKeys = new Set<string>()
  private joining = false
  private readonly dropCommit = onStretchCommit((key) => {
    if (this.stretchKeys.has(key)) this.adoptCommit()
  })
  private readonly dropSpectral = onSpectralCommit(() => this.adoptSpectral())
  private recorders = new Map<string, ActiveRec>()
  private pendingRecorders: { key: string; stream: MediaStream; handler: () => void }[] = []
  private rollingChunks: SliceChunk[] = []
  private rollingNode: AudioWorkletNode | null = null
  private rollingSrc: MediaStreamAudioSourceNode | null = null
  private rollingSilent: GainNode | null = null
  private countTimer = 0
  private countWait: (() => void) | null = null
  private countPlan: { tempo: number; numerator: number; denominator: number } | null = null
  private noise: AudioBuffer | null = null
  private lastUiEmit = 0
  private pcmTap: AudioWorkletNode | null = null
  private pcmTapSilent: GainNode | null = null
  private pcmPlayer: AudioWorkletNode | null = null
  private listeners = new Set<() => void>()
  /** Instrument track whose effects sit in front of on-screen notes. */
  liveTrackId: string | null = null
  midiOutChannel = 0
  /** Hardware note sink. Null leaves notes inside the browser. */
  midiSink: ((bytes: number[], timeMs?: number) => void) | null = null
  private chains = new Map<string, LiveMidiChain>()

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

  get tempo() {
    return this.project?.tempo || 120
  }

  get transportPlaying() {
    return this.playing
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

  get processQuality() {
    return this.rack.quality
  }

  directAvailable() {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype
  }

  /** Software monitor time, or the device output time when Direct is handing the input to the interface. */
  monitorInfo(trackId?: string) {
    const device = this.outputLatencyMs
    const chain = trackId ? (this.rack.ownerLatency(trackId) / this.sampleRate) * 1000 : 0
    const direct = this.directMonitor
    return {
      ms: direct ? (this.ctx?.outputLatency || 0) * 1000 : device + chain,
      direct,
      directAvailable: this.directAvailable(),
      eco: this.rack.quality === 'eco',
    }
  }

  setDirectMonitor(on: boolean) {
    this.directMonitor = on && this.directAvailable()
    this.routeLocalMic()
  }

  setTuneMute(on: boolean) {
    this.tuneMuted = on
    this.routeLocalMic()
  }

  tuner(pluginId: string) {
    return this.rack.tuner(pluginId)
  }

  inputFrame() {
    if (!this.tuneAnalyser) return null
    const frame = new Float32Array(this.tuneAnalyser.fftSize)
    this.tuneAnalyser.getFloatTimeDomainData(frame)
    return frame
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
      this.ctx = openContext(48000)
      this.buildMaster()
    }
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined)
    return this.ctx
  }

  async resume(preferredRate = 48000) {
    if (!this.ctx) {
      this.ctx = openContext(preferredRate)
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
    if (!this.ctx) return
    if (!this.workletsReady) {
      try {
        await this.ctx.audioWorklet.addModule('/worklets/recorder.js')
        await this.ctx.audioWorklet.addModule('/worklets/ping.js')
        await this.ctx.audioWorklet.addModule('/worklets/pcm-tap.js')
        await this.ctx.audioWorklet.addModule('/worklets/pcm-player.js')
        await this.ctx.audioWorklet.addModule('/worklets/keys.js')
        this.attachKeys()
        this.workletsReady = true
        this.workletError = ''
      } catch (error) {
        this.workletError = error instanceof Error ? error.message : 'AudioWorklet failed'
      }
    }
    if (!this.stretchReady) {
      try {
        await this.ctx.audioWorklet.addModule('/worklets/stretch.js')
        this.stretchReady = true
      } catch {
        this.stretchReady = false
      }
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

  /** Timeline sample for a performance.now() reading, using the output timestamp clock. */
  timelineSampleForPerf(perf: number) {
    if (!this.ctx || !this.playing) return Math.max(0, Math.round(this.positionSamples))
    return Math.max(0, Math.round(this.sampleAt(this.contextForPerf(perf))))
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
    this.tuneAnalyser = ctx.createAnalyser()
    this.tuneAnalyser.fftSize = 8192
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
    this.safety = ctx.createDynamicsCompressor()
    this.safety.threshold.value = -1.5
    this.safety.knee.value = 6
    this.safety.ratio.value = 20
    this.safety.attack.value = 0.003
    this.safety.release.value = 0.08
    this.speakerGain.connect(this.safety)
    this.safety.connect(ctx.destination)
    this.metroGain.connect(this.localBus)
    this.patternStrip = createStrip(ctx)
    this.patternStrip.output.connect(this.localBus)
    this.liveBus = ctx.createGain()
    this.liveBus.gain.value = 1
    this.liveBus.connect(this.localBus)
    this.drumTable = residentDrums(ctx.sampleRate)
    this.drumBuffers = this.drumTable.map((drum) => {
      const buffer = ctx.createBuffer(1, drum.samples.length, ctx.sampleRate)
      buffer.getChannelData(0).set(drum.samples)
      return buffer
    })
    this.armWarmVoices()
    this.localMicGain = ctx.createGain()
    this.localMicGain.gain.value = 1
  }

  sync(project: Project, assetOf: (id: string) => AudioAsset | undefined) {
    const loopFlip = this.loopArmed != null && this.loopArmed !== project.loopEnabled
    this.loopArmed = project.loopEnabled
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
    for (const track of project.tracks) {
      const strip = this.strips.get(track.id)!
      applyInserts(this.ctx, strip, track.inserts)
    }
    applyInserts(this.ctx, this.masterStrip, project.masterInserts)
    this.applyMasterGain()
    this.rack.assetOf = assetOf
    this.rack.clock = () => this.currentTimelineSample()
    this.rack.route(this.ctx, project, this.strips, this.masterStrip, this.localBus, this.remoteBus)
    this.routeLocalMic()
    this.routeRemotes()
    const buffers = new Map<string, AudioAsset>()
    for (const track of project.tracks) {
      for (const device of track.rack?.devices ?? []) {
        for (const zone of device.zones) {
          const asset = assetOf(zone.bufferId)
          if (asset) buffers.set(asset.id, asset)
        }
        for (const pad of device.pads ?? []) {
          const asset = pad.bufferId ? assetOf(pad.bufferId) : undefined
          if (asset) buffers.set(asset.id, asset)
        }
      }
    }
    this.rackHost.sync(this.ctx, project, this.strips, buffers)
    this.libraryHost.sync(this.ctx, project, this.strips, assetOf)
    this.patchHost.sync(this.ctx, project.tracks, this.strips, (id) => {
      const asset = this.assetOf(id)
      const channel = asset?.channels[0]
      if (!asset || !channel?.length) return null
      return { sampleRate: asset.sampleRate, channel }
    })
    this.applyMixerAutomation()
    const pattern = project.beats?.patterns.find((item) => item.id === project.beats?.activeId)
    const token = `${rackPlayMode(project)}:${pattern?.id ?? ''}:${pattern?.steps ?? 0}:${pattern?.swing ?? 0}`
    const rackChanged = this.rackToken !== '' && this.rackToken !== token
    this.rackToken = token
    const loopStart = project.loopStartSample
    const loopEnd = project.loopEndSample
    const firstSpan = this.loopSpanStart < 0
    const spanChanged = !firstSpan && (this.loopSpanStart !== loopStart || this.loopSpanEnd !== loopEnd)
    this.loopSpanStart = loopStart
    this.loopSpanEnd = loopEnd
    if (spanChanged && this.ctx) {
      if (this.playing) {
        const linear = Math.max(0, this.sampleAt(this.ctx.currentTime))
        this.positionSamples = this.heardSample(linear)
        this.loopAudioDirty = this.mode === 'arrangement'
        this.emit()
      } else if (project.loopEnabled) {
        const heard = transportSample(this.positionSamples, project)
        if (Math.abs(heard - this.positionSamples) > 0.5) {
          this.positionSamples = heard
          this.emit()
        }
      }
    }
    if (loopFlip && this.playing && this.mode === 'arrangement') {
      this.loopAudioDirty = false
      this.rearmLoop()
    } else if (rackChanged && this.playing && this.mode === 'arrangement' && this.status !== 'recording') {
      this.rearmLoop()
    } else if (this.loopAudioDirty) {
      this.applyLoopAudio()
      if (this.pendingSchedule) {
        this.pendingSchedule = false
        this.scheduleAhead()
      }
    }
  }

  /** Faders, pans, sends, and solo follow the project. Playing lanes are scheduled on the audio clock. */
  private applyMixerAutomation() {
    const project = this.project
    const ctx = this.ctx
    if (!project || !ctx) return
    const heard = audibleIds(project.tracks)
    const now = ctx.currentTime
    const sample = this.playing ? this.currentTimelineSample() : this.positionSamples
    const end = Math.max(sample + this.sampleRate, arrangementEndSample(project))
    const follow = modeOf(project) !== 'off'
    const anySolo = project.tracks.some((track) => track.solo)
    if (this.patternStrip) this.patternStrip.mute.gain.setTargetAtTime(anySolo ? 0 : 1, now, 0.01)
    if (this.liveBus) {
      const liveId = this.padRouteId || this.liveTrackId
      const open = liveId ? heard.has(liveId) : !anySolo
      this.liveBus.gain.setTargetAtTime(open ? 1 : 0, now, 0.01)
    }
    for (const track of project.tracks) {
      const strip = this.strips.get(track.id)
      if (!strip) continue
      strip.mute.gain.setTargetAtTime(heard.has(track.id) ? 1 : 0, now, 0.01)
      this.scheduleControl(strip.fader.gain, follow ? laneFor(project.automation, track.id, 'volume')?.points : undefined, track.volume, sample, now, end)
      this.scheduleControl(strip.pan.pan, follow ? laneFor(project.automation, track.id, 'pan')?.points : undefined, track.pan, sample, now, end)
    }
    this.rack.applyAutomation(project, this.playing, sample, now, end)
    const originBeat = projectSampleBeat(project, this.playing ? this.playOriginSample : sample)
    this.rackHost.setTransport(project, this.playing ? this.playOriginCtx : now, originBeat)
  }

  private scheduleControl(param: AudioParam, points: { beat: number; value: number }[] | undefined, fallback: number, sample: number, now: number, end: number) {
    const project = this.project
    if (!project) return
    if (!this.playing || !points?.length) {
      const value = points?.length ? valueAtMappedSample(points, project, sample, fallback) : fallback
      param.cancelScheduledValues(now)
      param.setTargetAtTime(value, now, 0.015)
      return
    }
    applyRamps(param, automationSchedule(points, fallback, project, sample, now, end), now)
  }

  /** Play Scaler notes through the track's chosen sound. The previous preview chord is released first. */
  auditionScaler(trackId: string, notes: { pitch: number; fine?: number; delay: number; duration: number; velocity: number }[]) {
    this.unlock()
    if (!notes.length) return
    this.stopScalerPreview()
    if (this.project) this.sync(this.project, this.assetOf)
    const track = this.project?.tracks.find((item) => item.id === trackId)
    const strip = track ? this.strips.get(track.id) : undefined
    const ctx = this.ctx
    if (!track || !strip || !ctx || !this.project) return
    const routed = routeScaler(this.project, track)
    const out = this.strips.get(routed.liveStripId) ?? strip
    const now = ctx.currentTime + 0.03
    for (const note of notes) {
      const dur = Math.max(0.05, note.duration)
      const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)))
      const when = now + Math.max(0, note.delay)
      this.scalerMidi.push({ pitch, onAt: this.perfForContext(when) })
      this.scheduleVoice(ctx, out, {
        id: 'scaler',
        pitch,
        fine: note.fine,
        startBeat: 0,
        durationBeats: dur,
        velocity: Math.max(0.05, Math.min(1, note.velocity || 0.8)),
      }, when, dur, routed.voice, this.scalerVoices)
    }
  }

  private stopScalerPreview() {
    for (const src of this.scalerVoices) {
      try { src.stop() } catch { /* already stopped */ }
      try { src.disconnect() } catch { /* already disconnected */ }
    }
    this.scalerVoices = []
    if (this.midiSink) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0
      for (const item of this.scalerMidi) {
        this.midiSink(noteBytes(false, this.midiOutChannel, item.pitch, 0), now)
        this.midiSink(noteBytes(false, this.midiOutChannel, item.pitch, 0), Math.max(now, item.onAt) + 20)
      }
    }
    this.scalerMidi = []
  }

  previewRack(trackId: string, pitch: number, slide = false, hold = false, velocity = 0.9) {
    this.unlock()
    if (this.project) this.sync(this.project, this.assetOf)
    const when = (this.ctx?.currentTime ?? 0) + (hold ? 0 : 0.03)
    const level = Math.max(0.05, Math.min(1, velocity))
    const track = this.project?.tracks.find((item) => item.id === trackId)
    const sampler = samplerInsert(track)
    if (sampler) {
      this.rack.trigger(sampler.id, pitch, level)
      if (!hold) window.setTimeout(() => this.rack.trigger(sampler.id, pitch, 0), 350)
      return
    }
    if (track?.instrument === 'library') {
      if (track.library) {
        this.libraryHost.note(trackId, pitch, level, when)
        if (!hold) this.libraryHost.note(trackId, pitch, 0, when + 0.35)
      }
      return
    }
    this.rackHost.note(trackId, pitch, level, when, slide)
    if (!hold) this.rackHost.note(trackId, pitch, 0, when + 0.35)
  }

  releaseRack(trackId: string, pitch: number) {
    const when = this.ctx?.currentTime ?? 0
    const track = this.project?.tracks.find((item) => item.id === trackId)
    const sampler = samplerInsert(track)
    if (sampler) {
      this.rack.trigger(sampler.id, pitch, 0)
      return
    }
    if (track?.instrument === 'library') {
      this.libraryHost.note(trackId, pitch, 0, when)
      return
    }
    this.rackHost.note(trackId, pitch, 0, when)
  }

  /**
   * Load the samples for one note, then play it.
   * The file is requested only after the preset is on the track, from Hugging Face.
   */
  async auditionLibrary(trackId: string, pitch = 60, velocity = 0.9) {
    this.unlock()
    if (this.project) this.sync(this.project, this.assetOf)
    const track = this.project?.tracks.find((item) => item.id === trackId)
    if (!track?.library || track.instrument !== 'library') return
    const rate = this.ctx?.sampleRate ?? this.sampleRate
    const level = velocity > 0 && velocity <= 1 ? velocity : 0.9
    const ready = await this.libraryHost.prepare(trackId, track, [{ sample: 0, pitch, vel: level }], rate)
    if (ready.missing > 0) throw new Error('That instrument sample is not on Hugging Face yet.')
    if (ready.sounding <= 0) throw new Error('That note is outside this instrument.')
    const when = (this.ctx?.currentTime ?? 0) + 0.05
    this.libraryHost.note(trackId, pitch, level, when)
    this.libraryHost.note(trackId, pitch, 0, when + 1.1)
  }

  holdLibraryPack(trackId: string, pack: SamplePack) {
    this.libraryHost.holdPack(trackId, pack)
  }

  holdLibraryAudio(trackId: string, samples: { id: string; sampleRate: number; channels: Float32Array[] }[]) {
    this.libraryHost.holdAudio(trackId, samples)
  }

  /** Audition a layered patch. `down` starts the note; a lift releases it. A loaded starter instrument plays instead. */
  previewPatch(trackId: string, pitch: number, down: boolean, velocity = 0.85) {
    this.unlock()
    if (this.project) this.sync(this.project, this.assetOf)
    const when = this.ctx?.currentTime ?? 0
    const level = velocity > 0 && velocity <= 1 ? velocity : 0.85
    const track = this.project?.tracks.find((item) => item.id === trackId)
    if (track?.instrument === 'library' && track.library) {
      const key = `${trackId}:${Math.round(pitch)}`
      if (!down) {
        this.libraryHeld.delete(key)
        this.libraryHost.note(trackId, pitch, 0, when)
        return
      }
      this.libraryHeld.add(key)
      const rate = this.ctx?.sampleRate ?? this.sampleRate
      const program = track.library
      void this.libraryHost.prepare(trackId, track, [{ sample: 0, pitch, vel: level }], rate).then((ready) => {
        if (!this.libraryHeld.has(key) || ready.missing > 0 || ready.sounding <= 0) return
        if (this.project?.tracks.find((item) => item.id === trackId)?.library !== program) return
        const at = (this.ctx?.currentTime ?? 0) + 0.02
        this.libraryHost.note(trackId, pitch, level, at)
      }).catch(() => undefined)
      return
    }
    this.patchHost.note(trackId, pitch, down ? level : 0, when)
  }

  setCompareGain(gain: number) {
    this.compareGain = Number.isFinite(gain) && gain > 0 ? Math.min(16, gain) : 1
    this.applyMasterGain()
  }

  /** Play a loudness-matched reference through the speakers and duck the mix. */
  audition(channels: Float32Array[], gain: number) {
    this.stopAudition()
    const ctx = this.ctx
    const leftIn = channels[0]
    if (!ctx || !this.speakerGain || !leftIn?.length) return
    const rate = ctx.sampleRate
    const left = rate === this.sampleRate ? leftIn : linearResample(leftIn, this.sampleRate, rate)
    const rightIn = channels[1] ?? leftIn
    const right = rate === this.sampleRate ? rightIn : linearResample(rightIn, this.sampleRate, rate)
    const buffer = ctx.createBuffer(2, left.length, rate)
    buffer.getChannelData(0).set(left)
    buffer.getChannelData(1).set(right.subarray(0, left.length))
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    const node = ctx.createGain()
    node.gain.value = Number.isFinite(gain) && gain > 0 ? gain : 1
    source.connect(node)
    node.connect(this.speakerGain)
    source.start()
    this.referenceSource = source
    this.referenceGain = node
    this.referenceOn = true
    this.applyMasterGain()
  }

  stopAudition() {
    try { this.referenceSource?.stop() } catch { /* already stopped */ }
    try { this.referenceSource?.disconnect() } catch { /* already gone */ }
    try { this.referenceGain?.disconnect() } catch { /* already gone */ }
    this.referenceSource = null
    this.referenceGain = null
    if (!this.referenceOn) return
    this.referenceOn = false
    this.applyMasterGain()
  }

  masterReading() {
    return this.rack.reading()
  }

  masterScope() {
    return this.rack.scope()
  }

  private applyMasterGain() {
    if (!this.ctx || !this.masterGain || !this.project) return
    const gain = this.referenceOn ? 0 : this.project.masterVolume * this.compareGain
    this.masterGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.015)
  }

  /** CPU load and master loudness. Loudness is read from the master analyser and includes the master fader. */
  mixMeters() {
    this.sampleLoudness()
    return { cpu: this.rack.cpu, lufs: this.lufs, truePeak: this.truePeak }
  }

  spectrum(pluginId: string) {
    return this.rack.spectrum(pluginId)
  }

  previewSample(pluginId: string, note: number, velocity = 0.85) {
    this.unlock()
    if (this.project) this.sync(this.project, this.assetOf)
    if (velocity <= 0) {
      this.rack.trigger(pluginId, note, 0)
      return
    }
    const level = Math.max(0.05, Math.min(1, velocity))
    this.rack.trigger(pluginId, note, level)
  }

  takeLoop(pluginId: string) {
    return this.rack.keptLoop(pluginId)
  }

  /** Restart a playing loop at its first sample. */
  rewindLoop(pluginId: string) {
    this.rack.rewindLoop(pluginId)
  }

  meter(pluginId: string) {
    return this.rack.meter(pluginId)
  }

  trace(pluginId: string) {
    return this.rack.trace(pluginId)
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

  setLaunchAt(map: Record<string, number>) {
    this.launchAt = new Map(Object.entries(map).filter((entry): entry is [string, number] => Number.isFinite(entry[1])))
  }

  setLaunchGen(map: Record<string, number>) {
    this.launchGen = new Map(Object.entries(map).map(([id, value]) => [id, Number(value) || 0]))
  }

  /** performance.now() when the shared timeline reaches `sample`, or null while stopped. */
  perfAtTimeline(sample: number): number | null {
    if (!this.playing || !this.ctx) return null
    const ctxTime = this.playOriginCtx + (sample - this.playOriginSample) / this.sampleRate
    return this.perfForContext(ctxTime)
  }

  kickSession() {
    const ids = new Set([...this.sessionNodes.keys(), ...this.sessionStarted])
    const now = this.ctx?.currentTime ?? 0
    for (const id of ids) {
      const want = this.launches.get(id)
      const gen = this.launchGen.get(id) ?? 0
      const same = !!want && this.sessionClip.get(id) === want && (this.sessionGen.get(id) ?? 0) === gen
      if (same) continue
      const target = want != null ? this.launchAt.get(id) : undefined
      if (this.ctx && target != null && holdUntilGrid({
        sounding: this.sessionStarted.has(id),
        sameGeneration: false,
        nowCtx: now,
        targetSample: target,
        playOriginSample: this.playOriginSample,
        playOriginCtx: this.playOriginCtx,
        sampleRate: this.sampleRate,
      })) continue
      this.stopSessionTrack(id)
    }
    if (this.playing) this.scheduleAhead()
  }

  adoptSession() {
    if (!this.playing) return
    this.mode = 'session'
    this.stopSources()
    this.arrangementScheduled = false
    this.scheduleAhead()
  }

  adoptArrangement() {
    if (!this.playing) return
    this.mode = 'arrangement'
    this.stopSources()
    this.arrangementScheduled = false
    this.scheduleAhead()
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
    if (this.tuneAnalyser) this.localMicSrc.connect(this.tuneAnalyser)
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
    const hear = !this.directMonitor && !this.tuneMuted
    this.localMicGain.gain.value = hear ? 1 : 0
    if (this.monitorSplit) {
      try {
        this.localMicSrc?.disconnect(this.monitorSplit)
      } catch {
        /* noop */
      }
      this.monitorSplit.disconnect()
      this.monitorSplit = null
    }
    if (!hear) return
    const splitCount = Math.max(
      1,
      ...this.project.tracks.map((track) => {
        const match = /^mic:(\d+)$/.exec(track.input)
        return match ? Number(match[1]) + 1 : 1
      }),
    )
    if (splitCount > 1 && this.ctx && this.localMicSrc) {
      this.monitorSplit = this.ctx.createChannelSplitter(splitCount)
      this.localMicSrc.connect(this.monitorSplit)
    }
    for (const track of this.project.tracks) {
      if (!track.monitor) continue
      const strip = this.strips.get(track.id)
      if (!strip) continue
      const match = /^mic:(\d+)$/.exec(track.input)
      if (match && this.monitorSplit) this.monitorSplit.connect(strip.input, Number(match[1]), 0)
      else if (isLocalInput(track.input)) this.localMicGain.connect(strip.input)
    }
  }

  /** Input plus output latency, in samples, used to place a recording on the grid. */
  latencyCompensationSamples() {
    const ctx = this.ctx
    if (!ctx) return 0
    return recordOffsetSamples(ctx.baseLatency || 0, ctx.outputLatency || 0, ctx.sampleRate)
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
    await this.warmUpcomingLibrary(Math.max(0, fromSample), 2.5)
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
    await this.warmUpcomingLibrary(Math.max(0, sample), 2.5)
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
    if (this.playing && this.ctx) {
      this.positionSamples = Math.max(0, Math.round(this.heardSample(this.sampleAt(this.ctx.currentTime))))
    }
    this.playing = false
    this.silenceNow()
    this.arrangementScheduled = false
    this.sessionStarted.clear()
    this.nextLoopCtx = null
    if (this.scheduler && !this.repeatWatch) {
      window.clearInterval(this.scheduler)
      this.scheduler = 0
    }
    if (this.status !== 'stopped') this.status = 'stopped'
    this.emit()
  }

  /** Stop every sounding voice, including notes that were already queued. */
  private silenceNow() {
    this.stopSources()
    this.keysNode?.port.postMessage({ type: 'panic' })
    const now = this.ctx?.currentTime ?? 0
    for (const voice of this.warmVoices) {
      try {
        voice.gain.gain.cancelScheduledValues(now)
        voice.gain.gain.setValueAtTime(0, now)
      } catch { /* the voice is already gone */ }
      voice.busy = false
    }
    for (const voice of this.padVoices) {
      try { voice.gain.gain.setValueAtTime(0.0001, now) } catch { /* ended */ }
      voice.stop(now)
    }
    this.padVoices = []
    for (const shot of this.oneShots) shot.stop()
    this.oneShots = []
    for (const chain of this.chains.values()) chain.panic()
  }

  async beginRecord(opts: {
    fromSample: number
    inputs: RecordInput[]
    countIn: boolean
    hostPerfAtSample?: number
    mode?: 'arrangement' | 'session'
    onPunch?: (info: PunchInfo) => void
  }) {
    await this.resume()
    const punch = () => {
      const ctx = this.ctx!
      this.refreshClockAnchor()
      const ctxTime = opts.hostPerfAtSample != null ? Math.max(this.contextForPerf(opts.hostPerfAtSample), ctx.currentTime + 0.02) : ctx.currentTime + 0.04
      if (opts.mode) {
        const previous = this.mode
        this.mode = opts.mode
        if (this.playing && previous !== opts.mode) {
          this.stopSources()
          this.arrangementScheduled = false
          this.scheduleAhead()
        }
      }
      if (!this.playing) this.armTransport(ctxTime, opts.fromSample)
      const timelineSample = this.playing ? Math.round(this.sampleAt(ctxTime)) : opts.fromSample
      const cueEpochHostPerf = this.perfForContext(ctxTime)
      this.status = 'recording'
      this.armRecorders(opts.inputs, timelineSample, ctxTime)
      opts.onPunch?.({ timelineSample, cueEpochHostPerf, ctxTime })
      this.emit()
    }
    if (opts.countIn && opts.hostPerfAtSample != null && this.project && !this.playing) {
      const go = await this.holdForDownbeat(opts.hostPerfAtSample, tempoAtSample(this.project, opts.fromSample), meterAtSample(this.project, opts.fromSample))
      if (!go) return
      punch()
      return
    }
    if (opts.countIn && this.project?.countIn && !this.playing) await this.runCountIn(punch, opts.fromSample)
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
      key: rec.meta.key,
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
      if (input.channel != null) {
        const splitter = this.ctx.createChannelSplitter(input.channel + 1)
        src.connect(splitter)
        splitter.connect(node, input.channel, 0)
      } else src.connect(node)
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
    const end = Math.max(rate, arrangementEndSample(project))
    const renderedTracks = []
    for (const track of project.tracks) {
      const offline = new OfflineAudioContext(2, end, rate)
      const input = offline.createGain()
      input.connect(offline.destination)
      const strip = { input } as StripNodes
      for (const clip of track.clips) {
        if (clip.slotOnly) continue
        const asset = assets.get(clip.bufferId)
        if (!asset) continue
        const buffer = this.bufferFromAsset(offline, asset)
        this.scheduleAudioClip(offline, strip, buffer, clip, 0, 0, end)
      }
      const heard = this.heardMidi(project, track)
      if (heard.voice.instrument === 'library' && heard.voice.library) {
        const events = []
        for (const item of heard.notes) {
          const start = beatsToSamples(item.startBeat, rate, project.tempo)
          const dur = beatsToSamples(item.note.durationBeats, rate, project.tempo)
          if (start >= end) continue
          events.push({ sample: Math.max(0, start), pitch: item.note.pitch, vel: item.note.velocity, slide: !!item.note.slide })
          events.push({ sample: Math.min(end - 1, start + dur), pitch: item.note.pitch, vel: 0 })
        }
        await this.libraryHost.prepare(heard.voice.id, heard.voice, events, rate)
        const rendered = this.libraryHost.renderOffline(heard.voice.id, heard.voice, events, rate, end)
        const buffer = offline.createBuffer(2, end, rate)
        buffer.getChannelData(0).set(rendered[0])
        buffer.getChannelData(1).set(rendered[1])
        const src = offline.createBufferSource()
        src.buffer = buffer
        src.connect(strip.input)
        src.start(0)
      } else if (samplerInsert(heard.voice)) {
        for (const item of heard.notes) {
          const span = beatSpanSamples(project, item.startBeat, item.note.durationBeats)
          if (span.start >= end) continue
          this.scheduleVoice(offline, strip, item.note, span.start / rate, span.duration / rate, heard.voice)
        }
      } else if (track.instrument === 'scaler' && heard.voice.instrument === 'drum-machine') {
        for (const item of heard.notes) {
          const span = beatSpanSamples(project, item.startBeat, item.note.durationBeats)
          if (span.start >= end) continue
          this.scheduleVoice(offline, strip, item.note, span.start / rate, span.duration / rate, heard.voice)
        }
      } else if (heard.voice.rack) {
        const events = []
        for (const item of heard.notes) {
          const span = beatSpanSamples(project, item.startBeat, item.note.durationBeats)
          if (span.start >= end) continue
          events.push({ sample: Math.max(0, Math.round(span.start)), pitch: item.note.pitch, vel: item.note.velocity, slide: !!item.note.slide })
          events.push({ sample: Math.min(end - 1, Math.round(span.start + span.duration)), pitch: item.note.pitch, vel: 0 })
        }
        const rendered = renderNotes(heard.voice.rack, events, rate, project.tempo, end, assets, rackLanesFor(project, heard.voice.id))
        const buffer = offline.createBuffer(2, end, rate)
        buffer.copyToChannel(rendered[0], 0)
        buffer.copyToChannel(rendered[1], 1)
        const src = offline.createBufferSource()
        src.buffer = buffer
        src.connect(strip.input)
        src.start(0)
      } else {
        for (const item of heard.notes) {
          const span = beatSpanSamples(project, item.startBeat, item.note.durationBeats)
          if (span.start >= end) continue
          this.scheduleVoice(offline, strip, item.note, span.start / rate, span.duration / rate, heard.voice)
        }
      }
      this.schedulePatternClips(offline, strip, project, track.id, 0, 0, end)
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
        soloSafe: track.soloSafe,
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
    const scale = tuneBlockScale(project.scale)
    const graph = renderGraph({
      tracks: renderedTracks,
      masterPlugins: project.masterPlugins,
      masterVolume: project.masterVolume,
      sampleRate: rate,
      tempo: project.tempo,
      tempoMap: project.tempoMap,
      length: end,
      scaleRoot: scale.scaleRoot,
      scaleIntervals: scale.scaleIntervals,
      scaleCents: scale.scaleCents,
      automation: project.automation,
      liveRemote: false,
      create: (pluginId, sampleRate) => peekModule(pluginId)?.create(sampleRate) ?? passthrough(),
    })
    return encodeWav(graph.master, rate, { dither: 'tpdf' })
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

  private async runCountIn(done: () => void, fromSample = this.positionSamples) {
    const ctx = this.ctx!
    const project = this.project!
    const tempo = tempoAtSample(project, fromSample)
    const meter = meterAtSample(project, fromSample)
    const beatSec = samplesPerBeatUnit(this.sampleRate, tempo, meter) / this.sampleRate
    const beats = meter.numerator
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
    this.nextMetroSample = this.project ? clickAtOrAfter(this.project, fromSample) : fromSample
    this.ensureScheduler()
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick())
    this.scheduleAhead()
    this.applyMixerAutomation()
  }

  /** The interval only wakes the scheduler. Notes are placed on the audio clock inside the horizon. */
  private ensureScheduler() {
    if (this.scheduler) return
    this.scheduler = window.setInterval(() => {
      this.scheduleAhead()
      if (this.playing && this.ctx) this.positionSamples = this.heardSample(this.currentTimelineSample())
      const now = performance.now()
      if (now - this.lastUiEmit > 50) {
        this.lastUiEmit = now
        this.emit()
      }
      if (!this.playing && !this.repeatWatch && this.scheduler) {
        window.clearInterval(this.scheduler)
        this.scheduler = 0
      }
    }, 25)
  }

  setBeatPump(pump: ((now: number, horizon: number) => void) | null) {
    this.beatPump = pump
  }

  setRepeatWatch(active: boolean) {
    this.repeatWatch = active
    if (active) this.ensureScheduler()
    else if (!this.playing && this.scheduler) {
      window.clearInterval(this.scheduler)
      this.scheduler = 0
    }
  }

  private sampleAt(ctxTime: number) {
    return this.playOriginSample + (ctxTime - this.playOriginCtx) * this.sampleRate
  }

  /** Playhead every view reads. The loop folds it; the raw clock stays in sampleAt. */
  private heardSample(sample: number) {
    const project = this.project
    const linear = Math.max(0, sample)
    if (
      project &&
      project.loopEnabled &&
      (this.status === 'playing' || (this.status === 'recording' && project.record?.loop))
    ) {
      return transportSample(linear, project)
    }
    return linear
  }

  private tick = () => {
    if (this.playing && this.ctx) {
      const linear = this.sampleAt(this.ctx.currentTime)
      const sample = this.heardSample(linear)
      const project = this.project
      const patternLoop = project && this.status !== 'recording' ? emptyPatternLoopSamples(project) : 0
      this.positionSamples = patternLoop > 1 && linear >= 0 ? linear % patternLoop : sample
      if (patternLoop <= 1 && project && this.mode === 'arrangement' && this.status === 'playing') {
        if (playbackStops(linear, project, arrangementEndSample(project), this.sampleRate)) {
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

  /** Fetch library samples that are about to play so the attack is not silent. */
  private primeLibraryAhead() {
    const now = performance.now()
    if (now - this.libraryWarmAt < 500) return
    this.libraryWarmAt = now
    const sample = this.playing && this.ctx ? Math.max(0, Math.round(this.sampleAt(this.ctx.currentTime))) : this.positionSamples
    void this.warmUpcomingLibrary(sample, 8, false)
  }

  private async warmUpcomingLibrary(fromSample: number, seconds: number, block = true) {
    const project = this.project
    const ctx = this.ctx
    if (!project || !ctx) return
    const end = fromSample + Math.round(this.sampleRate * seconds)
    const jobs: Promise<unknown>[] = []
    for (const track of project.tracks) {
      if (track.type !== 'midi' || track.instrument !== 'library' || !track.library) continue
      const events: { sample: number; pitch: number; vel: number }[] = []
      for (const clip of track.midiClips) {
        if (clip.slotOnly || clip.scene != null) continue
        for (const note of prepareClipNotes(project, track, clip)) {
          if (note.muted || !(note.velocity > 0)) continue
          const span = beatSpanSamples(project, clip.startBeat + note.startBeat, note.durationBeats)
          if (span.start >= end || span.start + span.duration <= fromSample) continue
          events.push({ sample: Math.max(0, Math.round(span.start)), pitch: note.pitch, vel: note.velocity })
        }
      }
      events.sort((a, b) => a.sample - b.sample)
      const upcoming = events.slice(0, block ? 24 : 48)
      if (upcoming.length) jobs.push(this.libraryHost.prepare(track.id, track, upcoming, ctx.sampleRate))
    }
    if (!jobs.length) return
    const work = Promise.all(jobs).then(() => undefined)
    if (!block) {
      void work.catch(() => undefined)
      return
    }
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => window.setTimeout(resolve, 8000)),
    ])
  }

  private scheduleAhead() {
    if (!this.ctx || this.scheduling) return
    this.scheduling = true
    try {
      this.applyLoopAudio()
      if (this.pendingSchedule) this.pendingSchedule = false
      if (!this.ctx) return
      const now = this.ctx.currentTime
      const horizon = now + 0.35
      if (this.beatPump) this.beatPump(now, horizon)
      if (!this.playing || !this.project) return
      this.refreshClockAnchor()
      this.scheduleMetronome(horizon)
      if (this.mode === 'session') this.scheduleSession(horizon)
      else this.scheduleArrangement(horizon)
      if (this.mode === 'arrangement') this.primeLibraryAhead()
    } finally {
      this.scheduling = false
    }
  }

  private scheduleMetronome(horizon: number) {
    const project = this.project
    if (!project?.metronomeEnabled || !this.ctx) return
    const limit = this.playOriginSample + this.sampleRate * 60 * 10
    let guard = 0
    while (this.nextMetroSample < limit && guard++ < 64) {
      const when = this.playOriginCtx + (this.nextMetroSample - this.playOriginSample) / this.sampleRate
      if (when > horizon) break
      if (when >= this.ctx.currentTime - 0.01) this.click(when, clickAccent(project, this.nextMetroSample))
      const next = nextClickAfter(project, this.nextMetroSample)
      if (!(next > this.nextMetroSample + 0.5)) break
      this.nextMetroSample = next
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

  /** Restart arrangement playback at the wrapped playhead so a loop toggle takes effect immediately. */
  private rearmLoop() {
    this.retargetPlayingLoop()
    this.scheduleAhead()
  }

  /** Drop queued arrangement audio and park the clock on the wrapped playhead. Does not schedule. */
  private retargetPlayingLoop() {
    const ctx = this.ctx
    const project = this.project
    if (!ctx || !project || !this.playing) return
    const now = ctx.currentTime + 0.02
    const linear = Math.max(0, this.sampleAt(ctx.currentTime))
    const patternLoop = emptyPatternLoopSamples(project)
    const sample = patternLoop > 1 ? linear % patternLoop : this.heardSample(linear)
    this.stopSources()
    this.playOriginCtx = now
    this.playOriginSample = sample
    this.positionSamples = sample
    this.arrangementScheduled = false
    this.nextLoopCtx = null
    this.loopQueuedUntil = 0
    this.loopQueuedCtx = 0
    this.nextMetroSample = clickAtOrAfter(project, sample)
  }

  /**
   * Follow a loop-bound change on the audio scheduler. Extending schedules only the
   * extra span. Crossing the playhead restarts from the wrapped sample.
   */
  private applyLoopAudio() {
    if (!this.loopAudioDirty || !this.ctx || !this.project || !this.playing) return
    const project = this.project
    if (this.mode !== 'arrangement' || !project.loopEnabled || emptyPatternLoopSamples(project) > 16) {
      this.loopAudioDirty = false
      return
    }
    const nowLinear = Math.max(0, this.sampleAt(this.ctx.currentTime))
    const wrapQueued = this.nextLoopSample === project.loopStartSample
      && this.nextLoopCtx != null
      && this.nextLoopCtx <= this.ctx.currentTime + 0.45
    const plan = planLoopAudio(project, {
      nowLinear,
      scheduledUntil: this.loopQueuedUntil > 0 ? this.loopQueuedUntil : null,
      wrapQueued,
    })
    if (plan.action === 'keep') {
      this.loopAudioDirty = false
      if (this.nextLoopCtx != null) this.nextLoopSample = project.loopStartSample
      return
    }
    if (plan.action === 'extend' && this.loopQueuedCtx > this.ctx.currentTime - 0.02) {
      this.loopAudioDirty = false
      this.scheduleWindow(this.loopQueuedCtx, plan.from, plan.to)
      const added = (plan.to - plan.from) / this.sampleRate
      if (this.nextLoopCtx != null) this.nextLoopCtx += added
      this.loopQueuedCtx += added
      this.loopQueuedUntil = plan.to
      this.nextLoopSample = project.loopStartSample
      return
    }
    const heard = plan.action === 'restart' ? plan.from : transportSample(nowLinear, project)
    const soon = (project.loopEndSample - heard) / this.sampleRate < 0.25
    const outside = plan.action === 'restart' && plan.reason === 'outside'
    if (!outside && !soon && this.ctx.currentTime - this.loopRestartAt < 0.1) return
    this.loopAudioDirty = false
    this.loopRestartAt = this.ctx.currentTime
    this.retargetPlayingLoop()
    this.pendingSchedule = true
  }

  private scheduleArrangement(horizon: number) {
    const project = this.project!
    const patternLoop = this.status === 'recording' ? 0 : emptyPatternLoopSamples(project)
    if (patternLoop > 16) {
      if (this.nextLoopCtx == null) {
        this.nextLoopCtx = this.playOriginCtx
        this.nextLoopSample = ((this.playOriginSample % patternLoop) + patternLoop) % patternLoop
      }
      while (this.nextLoopCtx < horizon) {
        const samples = Math.max(1, patternLoop - this.nextLoopSample)
        this.scheduleWindow(this.nextLoopCtx, this.nextLoopSample, this.nextLoopSample + samples)
        this.nextLoopCtx += samples / this.sampleRate
        this.nextLoopSample = 0
      }
      return
    }
    const end = arrangementEndSample(project)
    const cycleWhileRecording = this.status === 'recording' && project.record?.loop
    if (!project.loopEnabled || (this.status === 'recording' && !cycleWhileRecording)) {
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
      const when = this.nextLoopCtx
      this.scheduleWindow(when, this.nextLoopSample, this.nextLoopSample + samples)
      this.loopQueuedUntil = this.nextLoopSample + samples
      this.loopQueuedCtx = when + samples / this.sampleRate
      this.nextLoopCtx += samples / this.sampleRate
      this.nextLoopSample = project.loopStartSample
    }
  }

  /** Cached tempo-follow. A phone plays the pre-render instead of stretching on each launch. */
  private sessionWarp(buffer: AudioBuffer, audio: AudioClip, sampleRate: number, tempo: number): Float32Array[] {
    const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 520px), (max-height: 520px) and (orientation: landscape)').matches
    const key = `${audio.bufferId}:${audio.offsetSamples}:${audio.durationSamples}:${audio.durationBeats}:${sampleRate}:${tempo}`
    let pcm = this.warpPcm.get(key)
    if (!pcm) {
      const channels: Float32Array[] = []
      for (let index = 0; index < buffer.numberOfChannels; index++) channels.push(buffer.getChannelData(index))
      pcm = renderTempoWarp(channels, audio.offsetSamples, audio.durationSamples, sampleRate, tempo, audio.durationBeats || 0)
      if (this.warpPcm.size >= 8) {
        const oldest = this.warpPcm.keys().next().value
        if (oldest) this.warpPcm.delete(oldest)
      }
      this.warpPcm.set(key, pcm)
    }
    if (preferStretchCache(phone, phone ? 1 : 0)) pcm = this.warpPcm.get(key) ?? pcm
    return pcm
  }

  private scheduleSession(horizon: number) {
    const project = this.project!
    const sr = this.sampleRate
    for (const [trackId, clipId] of this.launches) {
      const gen = this.launchGen.get(trackId) ?? 0
      if (this.sessionStarted.has(trackId) && this.sessionClip.get(trackId) === clipId && (this.sessionGen.get(trackId) ?? 0) === gen) continue
      const track = project.tracks.find((t) => t.id === trackId)
      const strip = this.strips.get(trackId)
      if (!track || !strip || !this.ctx) continue
      const audio = track.clips.find((c) => c.id === clipId)
      const midi = track.midiClips.find((c) => c.id === clipId)
      const clip = audio || midi
      if (!clip) continue
      if (clip.legato && this.sessionStarted.has(trackId)) {
        this.sessionClip.set(trackId, clipId)
        this.sessionGen.set(trackId, gen)
        continue
      }
      const nowSample = Math.max(this.playOriginSample, this.sampleAt(this.ctx.currentTime))
      const quant = clip.quant ?? project.launchQuant ?? '1bar'
      const scheduled = this.launchAt.get(trackId)
      const target = scheduled != null ? scheduled : quantizeSample(nowSample, quant, sr, project.tempo, project.timeSignature)
      const startWhen = sessionStartContext({
        targetSample: target,
        playOriginSample: this.playOriginSample,
        playOriginCtx: this.playOriginCtx,
        sampleRate: sr,
        nowCtx: this.ctx.currentTime,
        horizonSec: horizon - this.ctx.currentTime,
      })
      if (startWhen == null) continue
      this.stopSessionTrack(trackId, startWhen)
      if (audio) {
        const asset = this.assetOf(audio.bufferId)
        if (!asset) continue
        const buffer = this.bufferFromAsset(this.ctx, asset)
        const prepared = this.stretchBuffer(this.ctx, buffer, audio)
        const src = this.ctx.createBufferSource()
        const rate = audio.stretch ? 1 : warpRate(audio.durationSamples, audio.durationBeats, sr, project.tempo, audio.warp !== false)
        let playBuffer = prepared.buffer
        let offset = prepared.clip.offsetSamples / prepared.buffer.sampleRate
        let dur = Math.max(0.01, prepared.clip.durationSamples / sr)
        let playRate = rate
        if (!audio.stretch && audio.durationBeats && Math.abs(rate - 1) > 1e-3) {
          const pcm = this.sessionWarp(buffer, audio, sr, project.tempo)
          playBuffer = this.ctx.createBuffer(Math.max(1, pcm.length), Math.max(1, pcm[0]?.length ?? 1), sr)
          pcm.forEach((channel, index) => playBuffer.copyToChannel(Float32Array.from(channel), index))
          offset = 0
          dur = Math.max(0.01, playBuffer.duration)
          playRate = 1
        }
        src.buffer = playBuffer
        src.playbackRate.value = playRate
        const looping = clipLoops(audio)
        if (looping && dur > 0.01) {
          src.loop = true
          src.loopStart = offset
          src.loopEnd = offset + (playRate === 1 ? dur : audio.durationSamples / buffer.sampleRate)
        }
        const gain = this.ctx.createGain()
        const peak = Math.max(0.0001, audio.gain)
        gain.gain.setValueAtTime(0.0001, startWhen)
        gain.gain.exponentialRampToValueAtTime(peak, startWhen + 0.008)
        src.connect(gain)
        gain.connect(strip.input)
        if (looping) src.start(startWhen, offset)
        else src.start(startWhen, offset, playRate === 1 ? dur : dur / rate)
        this.trackNodes(trackId, {
          stop: (at?: number) => {
            const now = at ?? this.ctx?.currentTime ?? startWhen
            try {
              gain.gain.cancelScheduledValues(now)
              gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now)
              gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.012)
            } catch { /* already stopped */ }
            try { src.stop(now + 0.02) } catch { /* already stopped */ }
          },
          disconnect: () => {
            src.disconnect()
            gain.disconnect()
          },
        })
      } else if (midi) {
        this.scheduleMidiLoop(track, strip, midi.id, startWhen)
      }
      this.sessionStarted.add(trackId)
      this.sessionClip.set(trackId, clipId)
      this.sessionGen.set(trackId, gen)
    }
  }

  private scheduleMidiLoop(track: Track, strip: StripNodes, clipId: string, firstWhen: number) {
    const project = this.project!
    const clip = track.midiClips.find((c) => c.id === clipId)
    if (!clip || !this.ctx) return
    let voice = track
    let out = strip
    if (track.instrument === 'scaler') {
      const routed = routeScaler(project, track)
      voice = routed.voice
      out = this.strips.get(routed.liveStripId) ?? strip
    }
    const sr = this.sampleRate
    const bpm = tempoAtSample(project, this.positionSamples)
    const durSec = Math.max(0.05, beatsToSamples(Math.max(0.25, clip.durationBeats), sr, bpm) / sr)
    const looping = clipLoops(clip)
    if (!this.sessionNodes.has(track.id)) this.sessionNodes.set(track.id, [])
    const token = {}
    this.activeLoop.set(track.id, token)
    const schedulePass = (when: number) => {
      const ctx = this.ctx
      if (!this.playing || !ctx || this.mode !== 'session') return
      const retired = this.retiring.get(track.id)
      const retiredHere = retired?.token === token
      const active = this.activeLoop.get(track.id) === token
      if (!active && !retiredHere) return
      const limit = retiredHere && retired ? retired.until : null
      if (limit != null && when >= limit - 0.001) return
      const bucket = retiredHere && retired ? retired.nodes : this.sessionNodes.get(track.id)
      if (clip.patternId) {
        const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
        const hits = pattern ? renderPattern(pattern, 0, clip.durationBeats) : []
        for (const hit of hits) {
          const noteDelay = beatsToSamples(hit.startBeat, sr, bpm) / sr
          if (limit != null && when + noteDelay >= limit - 0.001) continue
          const out = (hit.output && this.strips.get(hit.output)) || strip
          this.scheduleHit(ctx, out, hit, when + noteDelay)
        }
      }
      for (const note of clip.patternId ? [] : prepareClipNotes(project, track, clip)) {
        const noteDelay = beatsToSamples(note.startBeat, sr, bpm) / sr
        const noteDur = beatsToSamples(note.durationBeats, sr, bpm) / sr
        const start = when + noteDelay
        if (limit != null && start >= limit - 0.001) continue
        const dur = limit != null ? Math.min(noteDur, Math.max(0.02, limit - start)) : noteDur
        this.scheduleVoice(ctx, out, note, start, dur, voice, bucket)
      }
      if (!looping) return
      const nextWhen = when + durSec
      if (limit != null && nextWhen >= limit - 0.001) return
      const timer = window.setTimeout(() => schedulePass(nextWhen), Math.max(20, durSec * 1000 - 200))
      const node: Stoppable = {
        stop: (at?: number) => {
          const kill = () => window.clearTimeout(timer)
          const now = this.ctx?.currentTime ?? 0
          if (at != null && at > now + 0.005) window.setTimeout(kill, (at - now) * 1000)
          else kill()
        },
        disconnect: () => undefined,
      }
      if (retiredHere && retired) retired.nodes.push(node)
      else this.trackNodes(track.id, node)
    }
    schedulePass(firstWhen)
  }

  private trackNodes(trackId: string, node: Stoppable) {
    const list = this.sessionNodes.get(trackId) || []
    list.push(node)
    this.sessionNodes.set(trackId, list)
    this.sources.push(node)
  }

  private stopSessionTrack(trackId: string, when?: number) {
    const now = this.ctx?.currentTime ?? 0
    const later = when != null && when > now + 0.005
    const nodes = this.sessionNodes.get(trackId) || []
    const clipId = this.sessionClip.get(trackId)
    const token = this.activeLoop.get(trackId)
    if (later && clipId && token) {
      const bucket = [...nodes]
      this.retiring.set(trackId, { clipId, until: when, token, nodes: bucket })
      window.setTimeout(() => {
        for (const node of bucket) {
          try { node.stop() } catch { /* already stopped */ }
          try { node.disconnect() } catch { /* already disconnected */ }
          this.sources = this.sources.filter((item) => item !== node)
        }
        const retired = this.retiring.get(trackId)
        if (retired?.token === token) this.retiring.delete(trackId)
      }, Math.max(0, (when - now) * 1000 + 40))
    } else this.retiring.delete(trackId)
    this.activeLoop.delete(trackId)
    this.sessionNodes.delete(trackId)
    this.sessionStarted.delete(trackId)
    this.sessionClip.delete(trackId)
    this.sessionGen.delete(trackId)
    for (const node of nodes) {
      try {
        node.stop(later ? when : undefined)
      } catch {
        /* already stopped */
      }
      if (!later) {
        try { node.disconnect() } catch { /* already disconnected */ }
        this.sources = this.sources.filter((item) => item !== node)
      }
    }
  }

  private scheduleWindow(ctxTime: number, timelineStart: number, timelineEnd: number) {
    const project = this.project
    const ctx = this.ctx
    if (!project || !ctx) return
    for (const track of project.tracks) {
      const strip = this.strips.get(track.id)
      if (!strip) continue
      for (const clip of track.clips) {
        if (clip.slotOnly) continue
        const pieces = clip.folder
          ? compPieces(clip.folder, clip.fadeInSamples, clip.fadeOutSamples).map((piece) => ({ ...clip, folder: undefined, ...piece, gain: clip.gain }))
          : [clip]
        for (const piece of pieces) {
          const asset = this.assetOf(piece.bufferId)
          if (!asset) continue
          const buffer = this.bufferFromAsset(ctx, asset)
          this.scheduleAudioClip(ctx, strip, buffer, piece, ctxTime, timelineStart, timelineEnd)
        }
      }
      for (const group of performancesOn(project, track)) {
        for (const clip of group.clips) {
          if (clip.slotOnly || clip.scene != null) continue
          for (const note of prepareClipNotes(project, group.owner, clip)) {
            const span = beatSpanSamples(project, clip.startBeat + note.startBeat, note.durationBeats)
            if (span.start + span.duration <= timelineStart || span.start >= timelineEnd) continue
            const when = ctxTime + (span.start - timelineStart) / this.sampleRate
            if (when < ctx.currentTime) continue
            this.scheduleVoice(ctx, strip, note, when, span.duration / this.sampleRate, group.voice)
          }
        }
      }
      this.schedulePatternClips(ctx, strip, project, track.id, ctxTime, timelineStart, timelineEnd)
    }
  }

  private schedulePatternClips(
    ctx: BaseAudioContext,
    strip: StripNodes,
    project: Project,
    trackId: string,
    ctxTime: number,
    timelineStart: number,
    timelineEnd: number,
  ) {
    const clips = transportPatternClips(project, ctx === this.ctx)
    const masterPass = trackId === project.tracks[0]?.id
    for (const clip of clips) {
      if (clip.scene != null) continue
      const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
      if (!pattern) continue
      const range = patternPlayRange(clip)
      for (const hit of renderPattern(pattern, range.from, range.to)) {
        const dest = patternHitTrack(project, hit, clip)
        if (dest && dest !== trackId) continue
        if (!dest && !masterPass) continue
        const span = beatSpanSamples(project, clip.startBeat + (hit.startBeat - range.from), hit.durationBeats)
        if (span.start < timelineStart || span.start >= timelineEnd) continue
        const when = ctxTime + (span.start - timelineStart) / this.sampleRate
        const routed = dest ? this.strips.get(dest) : (ctx === this.ctx ? this.patternStrip : this.masterStrip)
        const liveStrip = ctx === this.ctx && hit.output ? this.strips.get(hit.output) : undefined
        const bus = liveStrip || routed || strip
        if (!bus) continue
        this.scheduleHit(ctx, bus, hit, when, span.duration / this.sampleRate)
      }
    }
  }

  private scheduleHit(ctx: BaseAudioContext, strip: StripNodes, hit: RenderedHit, when: number, durationSec?: number) {
    const level = Math.max(0, hit.volume ?? 1)
    if (level <= 0.0001) return
    if (ctx === this.ctx && when < ctx.currentTime - 0.05) return
    if (ctx === this.ctx && when < ctx.currentTime) when = ctx.currentTime + 0.001
    const dur = durationSec ?? Math.max(0.04, beatsToSamples(hit.durationBeats, this.sampleRate, this.project?.tempo || 120) / this.sampleRate)
    if (hit.sampleId) {
      const asset = this.assetOf(hit.sampleId)
      if (asset) {
        const buffer = this.bufferFromAsset(ctx, asset)
        const src = ctx.createBufferSource()
        src.buffer = buffer
        const rate = 2 ** ((hit.pitch - 60 + hit.fine / 100) / 12)
        src.playbackRate.value = rate
        this.envelope(ctx, strip, src, when, Math.max(0.05, dur), hit)
        return
      }
    }
    if (hit.kind === 'note') {
      this.scheduleVoice(ctx, strip, {
        id: hit.channelId,
        pitch: hit.pitch,
        fine: hit.fine,
        pan: hit.pan,
        startBeat: hit.startBeat,
        durationBeats: hit.durationBeats,
        velocity: hit.velocity,
      }, when, Math.max(0.05, dur))
      return
    }
    if (hit.kind === 'kick') {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(160, when)
      osc.frequency.exponentialRampToValueAtTime(48, when + Math.min(0.18, dur))
      this.envelope(ctx, strip, osc, when, Math.min(0.28, dur + 0.05), hit)
      return
    }
    if (hit.kind === 'perc') {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = 440 * 2 ** ((hit.pitch - 69) / 12)
      this.envelope(ctx, strip, osc, when, Math.min(0.16, dur), hit)
      return
    }
    if (hit.kind === 'openhat' || hit.kind === 'tom' || hit.kind === 'cymbal') {
      if (this.playResidentDrum(ctx, strip, hit, when)) return
      if (hit.kind === 'tom') {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        const freq = Math.max(70, 80 * 2 ** ((hit.pitch - 36) / 24))
        osc.frequency.setValueAtTime(freq * 1.4, when)
        osc.frequency.exponentialRampToValueAtTime(Math.max(45, freq), when + 0.18)
        this.envelope(ctx, strip, osc, when, Math.min(0.35, Math.max(0.12, dur * 2)), hit)
        return
      }
      const ring = ctx.createBufferSource()
      ring.buffer = this.noiseBuffer(ctx)
      const filter = ctx.createBiquadFilter()
      filter.type = 'highpass'
      filter.frequency.value = hit.kind === 'cymbal' ? 5000 : 6500
      ring.connect(filter)
      this.envelope(ctx, strip, filter, when, hit.kind === 'cymbal' ? 0.7 : 0.5, hit, ring)
      return
    }
    const noise = ctx.createBufferSource()
    noise.buffer = this.noiseBuffer(ctx)
    if (hit.kind === 'hat') {
      const filter = ctx.createBiquadFilter()
      filter.type = 'highpass'
      filter.frequency.value = 7000
      noise.connect(filter)
      this.envelope(ctx, strip, filter, when, Math.min(0.06, dur), hit, noise)
      return
    }
    if (hit.kind === 'clap') {
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 1400
      noise.connect(filter)
      this.envelope(ctx, strip, filter, when, Math.min(0.18, dur), hit, noise)
      return
    }
    const tone = ctx.createOscillator()
    tone.type = 'triangle'
    tone.frequency.value = 190
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 800
    noise.connect(filter)
    this.envelope(ctx, strip, filter, when, Math.min(0.16, dur), hit, noise)
    this.envelope(ctx, strip, tone, when, 0.08, { ...hit, velocity: hit.velocity * 0.4 })
  }

  private cachedDrum(ctx: BaseAudioContext, pitch: number) {
    let list = this.drumCache.get(ctx)
    if (!list) {
      const drums = residentDrums(ctx.sampleRate)
      list = drums.map((drum) => {
        const buffer = ctx.createBuffer(1, Math.max(1, drum.samples.length), ctx.sampleRate)
        buffer.getChannelData(0).set(drum.samples)
        return buffer
      })
      this.drumCache.set(ctx, list)
    }
    const index = DRUM_PADS.findIndex((pad) => pad.pitch === Math.round(pitch))
    return index >= 0 ? list[index] : null
  }

  /** Designed drum voice. Gate shortens the tail; a normal step plays the whole hit. */
  private playResidentDrum(ctx: BaseAudioContext, strip: StripNodes, hit: RenderedHit, when: number) {
    const buffer = this.cachedDrum(ctx, hit.pitch)
    if (!buffer) return false
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    const peak = Math.max(0.001, 0.22 * hit.velocity * Math.max(0, hit.volume ?? 1))
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.003)
    src.connect(gain)
    const pan = hit.pan || 0
    if (Math.abs(pan) > 0.02 && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner()
      panner.pan.value = Math.max(-1, Math.min(1, pan))
      gain.connect(panner)
      panner.connect(strip.input)
    } else gain.connect(strip.input)
    const gate = Math.max(0.08, Math.min(1, (hit.durationBeats || 0.2) / 0.2))
    src.start(when)
    src.stop(when + Math.max(0.05, buffer.duration * gate))
    if (ctx === this.ctx) this.sources.push(src)
    return true
  }

  private playDrum(ctx: BaseAudioContext, strip: StripNodes, note: MidiNote, when: number, bucket?: Stoppable[]) {
    const buffer = this.cachedDrum(ctx, note.pitch)
    if (!buffer) return false
    if (ctx === this.ctx && when < ctx.currentTime) return true
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    gain.gain.setValueAtTime(Math.max(0.001, note.velocity * 0.9), when)
    src.connect(gain)
    gain.connect(strip.input)
    src.start(when)
    src.stop(when + buffer.duration)
    if (ctx === this.ctx) {
      this.sources.push(src)
      bucket?.push(src)
    }
    return true
  }

  private noiseBuffer(ctx: BaseAudioContext) {
    if (this.noise && this.noise.sampleRate === ctx.sampleRate) return this.noise
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1
    if (ctx === this.ctx) this.noise = buffer
    return buffer
  }

  private envelope(
    ctx: BaseAudioContext,
    strip: StripNodes,
    source: AudioNode,
    when: number,
    dur: number,
    hit: Pick<RenderedHit, 'velocity' | 'pan' | 'volume'>,
    extra?: AudioNode,
  ) {
    const gain = ctx.createGain()
    const peak = Math.max(0.001, 0.22 * hit.velocity * Math.max(0, hit.volume ?? 1))
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.03, dur))
    source.connect(gain)
    const pan = hit.pan || 0
    if (Math.abs(pan) > 0.02 && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner()
      panner.pan.value = Math.max(-1, Math.min(1, pan))
      gain.connect(panner)
      panner.connect(strip.input)
    } else gain.connect(strip.input)
    const startable = source as AudioScheduledSourceNode
    if (typeof startable.start === 'function') {
      startable.start(when)
      startable.stop(when + dur + 0.02)
    }
    extra && typeof (extra as AudioScheduledSourceNode).start === 'function' && (extra as AudioScheduledSourceNode).start(when)
    extra && typeof (extra as AudioScheduledSourceNode).stop === 'function' && (extra as AudioScheduledSourceNode).stop(when + dur + 0.02)
    if (ctx === this.ctx) {
      if (typeof startable.stop === 'function') this.sources.push(startable)
      if (extra && typeof (extra as AudioScheduledSourceNode).stop === 'function') this.sources.push(extra as AudioScheduledSourceNode)
    }
  }

  /**
   * Quantize markers play through the stretch engine. A tight phone reuses the
   * cached render instead of stretching again on the scheduling tick.
   */
  private prepareWarp(ctx: BaseAudioContext, buffer: AudioBuffer, clip: AudioClip): { buffer: AudioBuffer; clip: AudioClip } {
    if (!clip.warpPoints || clip.warpPoints.length < 2) return { buffer, clip }
    const sr = ctx.sampleRate
    const tempo = this.project?.tempo || 120
    const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 520px), (max-height: 520px) and (orientation: landscape)').matches
    const key = `${clip.bufferId}:${clip.offsetSamples}:${clip.durationSamples}:${sr}:${tempo}:${JSON.stringify(clip.warpPoints)}`
    let pcm = this.warpPcm.get(key)
    if (!pcm) {
      const channels: Float32Array[] = []
      for (let index = 0; index < buffer.numberOfChannels; index++) channels.push(buffer.getChannelData(index))
      pcm = renderQuantizedClip(channels, clip, sr, tempo)
      if (this.warpPcm.size >= 8) {
        const oldest = this.warpPcm.keys().next().value
        if (oldest) this.warpPcm.delete(oldest)
      }
      this.warpPcm.set(key, pcm)
    }
    if (preferStretchCache(phone, this.rack.cpu)) pcm = this.warpPcm.get(key) ?? pcm
    const audio = ctx.createBuffer(Math.max(1, pcm.length), Math.max(1, pcm[0]?.length ?? 1), sr)
    pcm.forEach((channel, index) => audio.copyToChannel(Float32Array.from(channel), index))
    return { buffer: audio, clip: { ...clip, offsetSamples: 0, warp: undefined } }
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
    const project = this.project
    if (project && clipNeedsStretch(clip, project) && this.shouldStretchLive(clip) && ctx === this.ctx) {
      try {
        this.scheduleStretchWorklet(ctx, strip, buffer, clip, ctxTime, timelineStart, timelineEnd)
        return
      } catch {
        this.stretchReady = false
      }
    }
    const stretched = this.stretchBuffer(ctx, buffer, clip)
    const prepared = this.prepareWarp(ctx, stretched.buffer, stretched.clip)
    buffer = prepared.buffer
    clip = prepared.clip
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
    const join = this.joining && from <= timelineStart + 8
    gain.gain.setValueAtTime(join ? 0.0001 : env(relFrom), when)
    if (join && !(fadeIn > 0 && relFrom < fadeIn)) {
      gain.gain.linearRampToValueAtTime(Math.max(0.0001, clip.gain), when + Math.min(0.008, dur))
    }
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

  playOrigin(): { context: number; beat: number } {
    const project = this.project
    const beatNow = project ? projectSampleBeat(project, this.positionSamples) : samplesToBeats(this.positionSamples, this.sampleRate, 120)
    const stamp = this.outputStamp()
    if (!this.playing || !this.ctx) return { context: stamp.contextTime, beat: beatNow }
    const origin = project ? projectSampleBeat(project, this.playOriginSample) : samplesToBeats(this.playOriginSample, this.sampleRate, 120)
    return { context: this.playOriginCtx, beat: origin }
  }

  outputStamp(): ClockStamp {
    const ctx = this.ctx
    const now = performance.now()
    if (!ctx) return { contextTime: 0, performanceTime: now }
    const stamp = ctx.getOutputTimestamp?.()
    const contextTime = stamp?.contextTime
    const performanceTime = stamp?.performanceTime
    if (contextTime != null && performanceTime != null && Number.isFinite(contextTime) && Number.isFinite(performanceTime)) {
      // Some WebKit builds report a performanceTime that is not on the performance.now() clock.
      if (Math.abs(performanceTime - now) > 5) return { contextTime, performanceTime: now }
      return { contextTime, performanceTime }
    }
    return { contextTime: ctx.currentTime, performanceTime: now }
  }

  /** Seconds to place a performance where the player heard the click. */
  monitoringOffsetSeconds() {
    const output = this.ctx?.outputLatency || 0
    const base = this.ctx?.baseLatency || 0
    const loop = this.loopbackMs == null ? null : this.loopbackMs / 1000
    return monitoringOffset(output, base, loop)
  }

  clockCompensation() {
    const outputLatency = this.ctx?.outputLatency || 0
    const baseLatency = this.ctx?.baseLatency || 0
    const loop = this.loopbackMs == null ? null : this.loopbackMs / 1000
    return { outputLatency, baseLatency, calibrationSec: calibrationTrim(outputLatency, baseLatency, loop) }
  }

  /** Browser output path plus one render quantum. The speaker cannot be earlier than this. */
  get roundTripMs() {
    const quantum = this.ctx ? (128 / this.ctx.sampleRate) * 1000 : 0
    return this.monitoringOffsetSeconds() * 1000 + quantum
  }

  /**
   * Heard immediately. The worklet already holds decoded drums and idle voices.
   * Falls back to pre-started oscillators only if the worklet is not loaded yet.
   */
  /** Tap-to-render delay inside the graph, plus the device output latency the speaker still adds. */
  async measureLiveHit(): Promise<{ graphMs: number; outputMs: number; roundTripMs: number; contextTime: number; performanceTime: number; eventMs: number; frame: number }> {
    await this.resume()
    const eventMs = performance.now()
    const stamp = this.outputStamp()
    const previous = this.lastOnsetFrame
    this.liveNoteOn(69, 0.2)
    const frame = await new Promise<number>((resolve) => {
      const started = performance.now()
      const check = () => {
        if (this.lastOnsetFrame !== previous && this.lastOnsetFrame >= 0) resolve(this.lastOnsetFrame)
        else if (performance.now() - started > 400) resolve(-1)
        else window.setTimeout(check, 4)
      }
      check()
    })
    const outputMs = ((this.ctx?.outputLatency || 0) + (this.ctx?.baseLatency || 0)) * 1000
    const played = contextTimeForEvent(eventMs, stamp)
    const graphMs = frame < 0 || !this.ctx ? -1 : Math.max(0, (frame / this.ctx.sampleRate - played) * 1000)
    return {
      graphMs,
      outputMs,
      roundTripMs: graphMs < 0 ? outputMs : graphMs + outputMs,
      contextTime: stamp.contextTime,
      performanceTime: stamp.performanceTime,
      eventMs,
      frame,
    }
  }

  /** The open Pads faceplate. Null returns hits to the resident drum path. */
  setPadRoute(trackId: string | null) {
    this.padRouteId = trackId
  }

  private playLivePad(pitch: number, velocity: number, sample: Float32Array | null, color?: PadColor, when?: number): boolean {
    if (!this.padRouteId) return false
    const track = this.project?.tracks.find((item) => item.id === this.padRouteId)
    if (!track || track.instrument !== 'pads') return false
    if (!this.ctx) this.unlock()
    const ctx = this.ctx
    const strip = track.id ? this.strips.get(track.id) : undefined
    if (!ctx || !strip) return false
    this.playPadNote(ctx, strip, track, {
      pitch,
      velocity,
      tune: color?.tune,
      filter: color?.filter,
      decay: color?.decay,
    }, when ?? ctx.currentTime, undefined, sample, false)
    return true
  }

  private playPadNote(
    ctx: BaseAudioContext,
    strip: StripNodes,
    track: Track,
    hit: { pitch: number; velocity: number; tune?: number; filter?: number; decay?: number; pan?: number },
    when: number,
    bucket: Stoppable[] | undefined,
    sample: Float32Array | null | undefined,
    includeLevel: boolean,
  ) {
    const pads = track.padKit?.banks.flat() ?? []
    const pad = pads.find((item) => item.pitch === hit.pitch)
    if (pad?.muted) return
    const bus = pad?.busId && this.strips.has(pad.busId) ? this.strips.get(pad.busId) : undefined
    const dest = bus?.input ?? strip.input
    const start = ctx === this.ctx ? Math.max(when, ctx.currentTime) : Math.max(0, when)
    for (const other of chokeTargets(pads.map((item) => ({ pitch: item.pitch, choke: item.choke })), hit.pitch)) this.fadePadPitch(other, start)
    if (pad?.poly === 'mono') this.fadePadPitch(hit.pitch, start)
    let pcm = sample ?? null
    let rate = ctx.sampleRate
    const bufferId = pad?.layers[0]?.bufferId
    if (bufferId) {
      const asset = this.assetOf(bufferId)
      const channel = asset?.channels[0]
      if (asset && channel?.length) {
        pcm = channel
        rate = asset.sampleRate
      }
    }
    const buffer = pcm?.length && rate > 0
      ? this.cachedPadBuffer(ctx, `${bufferId || hit.pitch}:${pcm.length}:${rate}`, pcm, rate)
      : this.cachedDrum(ctx, hit.pitch)
    if (!buffer) return
    const live = this.padVoices.filter((voice) => voice.until > start - 0.001)
    this.padVoices = live
    while (live.length >= 16) {
      const oldest = live.shift()
      if (oldest) this.fadePadVoice(oldest, start)
    }
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    const tune = hit.tune ?? pad?.tune ?? 0
    src.playbackRate.value = 2 ** (tune / 12)
    const decay = Math.max(0.05, Math.min(1, hit.decay ?? pad?.decay ?? 1))
    const level = Math.max(0.0002, Math.min(1, hit.velocity * (includeLevel ? (pad?.level ?? 1) : 1)))
    const dur = Math.max(0.04, buffer.duration * decay)
    const attack = Math.min(0.003, dur * 0.25)
    gain.gain.setValueAtTime(0.0001, start)
    if (dur > attack + 0.008) {
      gain.gain.exponentialRampToValueAtTime(level, start + attack)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
    } else {
      gain.gain.linearRampToValueAtTime(level, start + dur * 0.4)
      gain.gain.linearRampToValueAtTime(0.0001, start + dur)
    }
    const filterAmount = hit.filter ?? pad?.filter ?? 1
    let node: AudioNode = gain
    src.connect(gain)
    if (filterAmount < 0.98) {
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(Math.max(80, 180 + filterAmount * 8000), start)
      gain.connect(filter)
      node = filter
    }
    const pan = hit.pan ?? pad?.pan ?? 0
    if (Math.abs(pan) > 0.02 && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner()
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), start)
      node.connect(panner)
      panner.connect(dest)
    } else node.connect(dest)
    const stop = (at?: number) => {
      try { src.stop(at) } catch { /* already stopped */ }
    }
    src.start(start)
    src.stop(start + dur + 0.01)
    const voice = { pitch: hit.pitch, gain, stop, born: start, until: start + dur, src }
    this.padVoices.push(voice)
    src.onended = () => {
      this.padVoices = this.padVoices.filter((item) => item.src !== src)
    }
    if (ctx === this.ctx) {
      this.sources.push(src)
      bucket?.push(src)
    }
  }

  private cachedPadBuffer(ctx: BaseAudioContext, key: string, pcm: Float32Array, rate: number) {
    let map = this.padCaches.get(ctx)
    if (!map) {
      map = new Map()
      this.padCaches.set(ctx, map)
    }
    const cached = map.get(key)
    if (cached) return cached
    const buffer = ctx.createBuffer(1, pcm.length, rate)
    buffer.copyToChannel(new Float32Array(pcm), 0)
    if (map.size >= 64) {
      const oldest = map.keys().next().value
      if (oldest) map.delete(oldest)
    }
    map.set(key, buffer)
    return buffer
  }

  private fadePadPitch(pitch: number, when: number) {
    for (const voice of this.padVoices) {
      if (voice.pitch === pitch && voice.until > when) this.fadePadVoice(voice, when)
    }
  }

  private fadePadVoice(voice: { gain: GainNode; stop: (at?: number) => void; until: number }, when: number) {
    const at = Math.max(0, when)
    try {
      voice.gain.gain.cancelScheduledValues(at)
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value || 0.0001), at)
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.008)
    } catch { /* the voice already ended */ }
    voice.stop(at + 0.02)
    voice.until = at
  }

  liveDrum(pitch: number, velocity: number, repeatEverySamples = 0, color?: PadColor) {
    if (this.playLivePad(pitch, velocity, null, color)) return
    const index = this.drumTable.findIndex((drum) => drum.pitch === pitch)
    if (!this.keysNode && index >= 0) {
      this.playResident(index, velocity, color)
      return
    }
    this.liveNoteOn(pitch, velocity, index, repeatEverySamples, color)
  }

  /** A chopped or recorded pad. The buffer is already decoded. */
  playBuffer(samples: Float32Array, pitch: number, velocity: number, color?: PadColor, when?: number) {
    if (this.playLivePad(pitch, velocity, samples, color, when)) return
    if (!this.ctx) this.unlock()
    const ctx = this.ctx
    if (!ctx || !this.speakerGain || !samples.length) return
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
    buffer.copyToChannel(new Float32Array(samples), 0)
    const src = ctx.createBufferSource()
    const filter = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    src.buffer = buffer
    src.playbackRate.value = 2 ** ((color?.tune || 0) / 12)
    filter.type = 'lowpass'
    filter.frequency.value = 180 + (color?.filter == null ? 1 : color.filter) * 8000
    const peak = Math.max(0.05, Math.min(1, velocity))
    src.connect(filter)
    filter.connect(gain)
    gain.connect(this.liveBus ?? this.speakerGain)
    const decay = color?.decay == null ? 1 : Math.max(0.05, color.decay)
    const startAt = when ?? ctx.currentTime
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.004)
    const stopAt = startAt + buffer.duration * decay
    gain.gain.setValueAtTime(peak, Math.max(startAt + 0.006, stopAt - 0.012))
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
    const stop = () => fadeSource(ctx, gain, src)
    this.oneShots.push({ pitch, when: startAt, stop })
    src.onended = () => {
      this.oneShots = this.oneShots.filter((shot) => shot.stop !== stop)
    }
    src.start(startAt)
    src.stop(startAt + buffer.duration * decay + 0.02)
  }

  liveGain(pitch: number, velocity: number) {
    if (!this.keysNode) return
    this.keysNode.port.postMessage({ type: 'gain', pitch, velocity: Math.max(0.05, Math.min(1, velocity)) })
  }

  private playResident(index: number, velocity: number, color?: PadColor, when?: number) {
    const ctx = this.ctx
    const buffer = this.drumBuffers[index]
    if (!ctx || !buffer || !this.speakerGain) return
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    src.playbackRate.value = 2 ** ((color?.tune || 0) / 12)
    const peak = Math.max(0.05, Math.min(1, velocity))
    src.connect(gain)
    gain.connect(this.liveBus ?? this.speakerGain)
    const decay = color?.decay == null ? 1 : Math.max(0.05, color.decay)
    const startAt = when ?? ctx.currentTime
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.004)
    const stopAt = startAt + buffer.duration * decay
    gain.gain.setValueAtTime(peak, Math.max(startAt + 0.006, stopAt - 0.012))
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
    const stop = () => fadeSource(ctx, gain, src)
    this.oneShots.push({ pitch: this.drumTable[index]?.pitch ?? -1, when: startAt, stop })
    src.onended = () => {
      this.oneShots = this.oneShots.filter((shot) => shot.stop !== stop)
    }
    src.start(startAt)
    src.stop(startAt + buffer.duration * decay + 0.02)
  }

  /** Monitor one track through its MIDI effect chain, then the instrument. */
  playThrough(trackId: string, pitch: number, velocity: number) {
    const track = this.project?.tracks.find((item) => item.id === trackId)
    if (track?.instrument === 'library' && track.library) {
      this.previewPatch(trackId, pitch, true, velocity)
      return
    }
    if (samplerInsert(track)) {
      this.previewRack(trackId, pitch, false, true, velocity)
      return
    }
    if (track?.rack && track.instrument !== 'drum-machine' && track.instrument !== '808') {
      this.previewRack(trackId, pitch, false, true, velocity)
      return
    }
    const previous = this.liveTrackId
    this.liveTrackId = trackId
    this.liveNoteOn(pitch, velocity)
    this.liveTrackId = previous
  }

  releaseThrough(trackId: string, pitch: number) {
    const track = this.project?.tracks.find((item) => item.id === trackId)
    if (track?.instrument === 'library' && track.library) {
      this.previewPatch(trackId, pitch, false)
      return
    }
    if (samplerInsert(track) || (track?.rack && track.instrument !== 'drum-machine' && track.instrument !== '808')) {
      this.releaseRack(trackId, pitch)
      return
    }
    const previous = this.liveTrackId
    this.liveTrackId = trackId
    this.liveNoteOff(pitch)
    this.liveTrackId = previous
  }

  liveNoteOn(pitch: number, velocity: number, drumIndex = -1, repeatEverySamples = 0, color?: PadColor) {
    if (this.throughChain(pitch, velocity, drumIndex, repeatEverySamples)) return
    this.emitLive(pitch, velocity, drumIndex, repeatEverySamples, color)
  }

  private throughChain(pitch: number, velocity: number, drumIndex: number, repeatEverySamples: number) {
    if (drumIndex >= 0 || repeatEverySamples > 0 || !this.project || !this.liveTrackId) return false
    const track = this.project.tracks.find((item) => item.id === this.liveTrackId)
    if (!track || !enabledFx(track.midiFx).length) return false
    this.chainFor(track).noteOn(pitch, velocity)
    return true
  }

  private chainFor(track: Track) {
    let chain = this.chains.get(track.id)
    if (!chain) {
      chain = new LiveMidiChain(
        (ms, fn) => {
          const id = window.setTimeout(fn, ms)
          return () => window.clearTimeout(id)
        },
        () => performance.now(),
        {
          on: (pitch, velocity) => this.emitLive(pitch, velocity, -1, 0),
          off: (pitch) => this.emitLiveOff(pitch),
        },
      )
      this.chains.set(track.id, chain)
    }
    const id = track.id
    chain.configure(
      () => this.project?.tracks.find((item) => item.id === id)?.midiFx,
      () => (this.project ? chainContext(this.project, id) : { root: 0, scale: 'ionian', seed: 1 }),
      () => this.project?.tempo || 120,
    )
    return chain
  }

  private emitLive(pitch: number, velocity: number, drumIndex = -1, repeatEverySamples = 0, color?: PadColor) {
    this.sendLiveMidi(pitch, velocity)
    if (!this.ctx) this.unlock()
    const level = Math.max(0.05, Math.min(1, velocity))
    if (this.keysNode) {
      const every = repeatEverySamples > 0 ? repeatEverySamples : 0
      const swing = color?.swing || 0
      if (every > 0 || color || !this.pushSab(1, pitch, level, drumIndex)) {
        this.keysNode.port.postMessage({
          type: every > 0 ? 'repeat' : 'on',
          pitch,
          velocity: level,
          drum: drumIndex,
          every,
          rate: color?.tune ? 2 ** (color.tune / 12) : 1,
          decay: color?.decay,
          attack: color?.attack,
          filter: color?.filter,
          swing,
        })
      }
      return
    }
    this.warmNote(pitch, level, color?.tune || 0)
  }

  /** Grid-locked retrigger. `when` is an AudioContext time, not the moment this method runs. */
  schedulePadHit(when: number, pitch: number, velocity: number, color?: PadColor) {
    if (this.playLivePad(pitch, velocity, null, color, when)) return
    if (!this.ctx) this.unlock()
    const ctx = this.ctx
    if (!ctx) return
    const level = Math.max(0.05, Math.min(1, velocity))
    if (!this.drumTable.length) this.drumTable = residentDrums(ctx.sampleRate)
    const index = this.drumTable.findIndex((drum) => drum.pitch === pitch)
    if (this.keysNode) {
      this.keysNode.port.postMessage({
        type: 'hit',
        atFrame: Math.round(when * ctx.sampleRate),
        pitch,
        velocity: level,
        drum: index,
        rate: color?.tune ? 2 ** (color.tune / 12) : 1,
        decay: color?.decay,
        attack: color?.attack,
        filter: color?.filter,
      })
      return
    }
    if (index >= 0 && this.drumBuffers[index]) this.playResident(index, level, color, when)
    else this.warmNote(pitch, level, 0, when)
  }

  cancelPadHits(pitch: number, afterTime: number) {
    const ctx = this.ctx
    if (!ctx) return
    this.keysNode?.port.postMessage({ type: 'cancel', pitch, afterFrame: Math.round(afterTime * ctx.sampleRate) })
    for (const voice of this.padVoices) {
      if (voice.pitch === pitch && voice.born >= afterTime - 1e-4) voice.stop()
    }
    this.padVoices = this.padVoices.filter((voice) => !(voice.pitch === pitch && voice.born >= afterTime - 1e-4))
    for (const shot of this.oneShots) {
      if (shot.pitch === pitch && shot.when >= afterTime - 1e-4) shot.stop()
    }
    this.oneShots = this.oneShots.filter((shot) => !(shot.pitch === pitch && shot.when >= afterTime - 1e-4))
  }

  /** Silence the current hit. Later grid hits for that pad stay queued. */
  duckPad(pitch: number) {
    const now = this.ctx?.currentTime ?? 0
    this.fadePadPitch(pitch, now)
    this.keysNode?.port.postMessage({ type: 'duck', pitch })
    for (const shot of this.oneShots) {
      if (shot.pitch === pitch && shot.when <= now + 0.005) shot.stop()
    }
    this.oneShots = this.oneShots.filter((shot) => !(shot.pitch === pitch && shot.when <= now + 0.005))
  }

  liveNoteOff(pitch: number) {
    const chain = this.liveTrackId ? this.chains.get(this.liveTrackId) : undefined
    if (chain?.holds(pitch)) {
      chain.noteOff(pitch)
      return
    }
    this.emitLiveOff(pitch)
  }

  private emitLiveOff(pitch: number) {
    if (this.midiSink) this.midiSink(noteBytes(false, this.midiOutChannel, pitch, 0))
    if (this.keysNode) {
      if (!this.pushSab(0, pitch, 0, -1)) this.keysNode.port.postMessage({ type: 'off', pitch })
    }
    for (const shot of this.oneShots) if (shot.pitch === pitch) shot.stop()
    this.oneShots = this.oneShots.filter((shot) => shot.pitch !== pitch)
    for (const voice of this.warmVoices) {
      if (voice.busy && voice.pitch === pitch) {
        voice.gain.gain.setTargetAtTime(0.0001, this.ctx?.currentTime || 0, 0.03)
        voice.busy = false
      }
    }
  }

  private pushSab(type: number, pitch: number, velocity: number, drum: number) {
    const sab = this.keysSab
    if (!sab) return false
    const write = Atomics.load(sab, 0)
    const read = Atomics.load(sab, 1)
    if (write - read >= 8) return false
    const base = 2 + (write % 8) * 4
    Atomics.store(sab, base, type)
    Atomics.store(sab, base + 1, pitch | 0)
    Atomics.store(sab, base + 2, Math.round(velocity * 1000))
    Atomics.store(sab, base + 3, drum | 0)
    Atomics.store(sab, 0, write + 1)
    return true
  }

  private armWarmVoices() {
    const ctx = this.ctx
    const out = this.liveBus ?? this.speakerGain
    if (!ctx || !out || this.warmVoices.length) return
    for (let i = 0; i < 8; i++) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      gain.gain.value = 0
      osc.connect(gain)
      gain.connect(out)
      osc.start()
      this.warmVoices.push({ osc, gain, busy: false, pitch: 60, age: 0 })
    }
  }

  private warmNote(pitch: number, velocity: number, tune = 0, when?: number) {
    for (const voice of this.warmVoices) if (voice.busy) voice.age += 1
    const same = this.warmVoices.find((item) => item.busy && item.pitch === pitch)
    const free = this.warmVoices.find((item) => !item.busy)
    const oldest = this.warmVoices.slice().sort((a, b) => b.age - a.age)[0]
    const voice = same || free || oldest
    if (!voice || !this.ctx) return
    voice.busy = true
    voice.pitch = pitch
    voice.age = 0
    const at = when ?? this.ctx.currentTime
    voice.osc.frequency.setValueAtTime(440 * 2 ** ((pitch + tune - 69) / 12), at)
    const level = Math.max(0.001, velocity * 0.2)
    voice.gain.gain.cancelScheduledValues(at)
    voice.gain.gain.setValueAtTime(0.0001, at)
    voice.gain.gain.exponentialRampToValueAtTime(level, at + 0.004)
  }

  private attachKeys() {
    const ctx = this.ctx
    const out = this.liveBus ?? this.speakerGain
    if (!ctx || this.keysNode || !out) return
    if (!this.drumTable.length) this.drumTable = residentDrums(ctx.sampleRate)
    const node = new AudioWorkletNode(ctx, 'keys-processor', { numberOfOutputs: 1, outputChannelCount: [1] })
    const gain = ctx.createGain()
    gain.gain.value = 0.9
    node.connect(gain)
    gain.connect(out)
    node.port.onmessage = (event) => {
      if (event.data?.type === 'onset') this.lastOnsetFrame = event.data.frame
    }
    node.port.postMessage({ type: 'samples', samples: this.drumTable.map((drum) => drum.samples) })
    if (typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated) {
      const buffer = new SharedArrayBuffer((2 + 8 * 4) * 4)
      this.keysSab = new Int32Array(buffer)
      node.port.postMessage({ type: 'sab', buffer })
    }
    this.keysNode = node
  }

  /** Phone under load replays the cached render instead of stretching on the audio thread. */
  private shouldStretchLive(clip: AudioClip) {
    if (!this.stretchReady || !this.project || !clip.stretch) return false
    if (stretchSlot(stretchCacheKey(clip, this.project))?.quality === 'hq') return false
    const phone = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 520px), (max-height: 520px) and (orientation: landscape)').matches
    if (preferStretchCache(phone, this.rack.cpu)) return false
    if (clip.stretch.followTempo || clip.stretch.markers.length >= 2) return false
    return sourceSamplesOf(clip) <= this.sampleRate * 3
  }

  private stretchBuffer(ctx: BaseAudioContext, buffer: AudioBuffer, clip: AudioClip) {
    const project = this.project
    if (!project || !clipNeedsStretch(clip, project)) return { buffer, clip }
    const pcm = this.cachedStretch(buffer, clip, project, ctx instanceof OfflineAudioContext)
    const length = Math.max(1, pcm[0]?.length ?? 1)
    const audio = ctx.createBuffer(Math.max(1, pcm.length), length, ctx.sampleRate || project.sampleRate)
    pcm.forEach((channel, index) => audio.copyToChannel(new Float32Array(channel), index))
    return { buffer: audio, clip: { ...clip, offsetSamples: 0, durationSamples: length } }
  }

  private cachedStretch(buffer: AudioBuffer, clip: AudioClip, project: Project, committed: boolean) {
    const key = stretchCacheKey(clip, project)
    this.stretchKeys.add(key)
    const channels: Float32Array[] = []
    for (let index = 0; index < buffer.numberOfChannels; index++) channels.push(buffer.getChannelData(index))
    if (committed) {
      const pcm = renderClipChannels(channels, clip, project, 'hq')
      storeStretch(key, pcm)
      return pcm
    }
    return readStretch(key, channels, clip, project)
  }

  /** Replay from the playhead so a finished spectral render is what you hear. */
  private adoptSpectral() {
    void this.dropSpectral
    if (!this.playing || !this.ctx || !this.project) return
    if (this.mode === 'session') {
      this.stopSources()
      this.scheduleAhead()
      return
    }
    this.adoptCommit()
  }

  /** Swap a live preview for the committed render without moving the playhead. */
  private adoptCommit() {
    void this.dropCommit
    const ctx = this.ctx
    const project = this.project
    if (!this.playing || !ctx || !project) return
    const now = Math.max(ctx.currentTime + 0.01, this.playOriginCtx)
    const sample = Math.max(0, Math.round(this.sampleAt(now)))
    this.stopSources()
    this.arrangementScheduled = true
    this.sessionStarted.clear()
    this.nextLoopCtx = now
    this.nextLoopSample = sample
    this.joining = true
    const end = arrangementEndSample(project)
    this.scheduleWindow(now, sample, end)
    this.joining = false
  }

  private scheduleStretchWorklet(
    ctx: BaseAudioContext,
    strip: StripNodes,
    buffer: AudioBuffer,
    clip: AudioClip,
    ctxTime: number,
    timelineStart: number,
    timelineEnd: number,
  ) {
    const project = this.project
    const stretch = clip.stretch
    if (!project || !stretch || ctx !== this.ctx) return
    const sr = ctx.sampleRate
    const duration = timelineSamples(clip, project)
    const clipEnd = clip.startSample + duration
    const from = Math.max(clip.startSample, timelineStart)
    const to = Math.min(clipEnd, timelineEnd)
    if (to - from < 8) return
    const when = ctxTime + (from - timelineStart) / sr
    if (when < ctx.currentTime - 0.02) return
    const source = sourceSamplesOf(clip)
    const channels: Float32Array[] = []
    for (let index = 0; index < buffer.numberOfChannels; index++) {
      const data = buffer.getChannelData(index)
      channels.push(data.slice(clip.offsetSamples, clip.offsetSamples + source))
    }
    const node = new AudioWorkletNode(ctx, 'cueharbor-stretch')
    const gain = ctx.createGain()
    const relFrom = (from - clip.startSample) / sr
    const relTo = (to - clip.startSample) / sr
    const clipDur = duration / sr
    const dur = (to - from) / sr
    const fadeIn = clip.fadeInSamples / sr
    const fadeOut = clip.fadeOutSamples / sr
    const env = (t: number) => {
      let level = clip.gain
      if (fadeIn > 0 && t < fadeIn) level *= t / fadeIn
      if (fadeOut > 0 && t > clipDur - fadeOut) level *= Math.max(0, (clipDur - t) / fadeOut)
      return Math.max(0.0001, level)
    }
    gain.gain.setValueAtTime(env(relFrom), Math.max(when, 0))
    if (fadeIn > 0 && relFrom < fadeIn) gain.gain.linearRampToValueAtTime(Math.max(0.0001, clip.gain), Math.min(Math.max(when, 0) + (fadeIn - relFrom), Math.max(when, 0) + dur))
    if (fadeOut > 0 && relTo > clipDur - fadeOut) {
      const start = Math.max(when, 0) + Math.max(0, clipDur - fadeOut - relFrom)
      gain.gain.setValueAtTime(Math.max(0.0001, clip.gain), start)
      gain.gain.linearRampToValueAtTime(0.0001, Math.max(when, 0) + dur)
    }
    node.connect(gain)
    gain.connect(strip.input)
    node.port.postMessage({
      type: 'stretch',
      channels,
      sampleRate: sr,
      options: {
        ratio: duration / Math.max(1, source),
        semitones: stretch.semitones,
        cents: stretch.cents,
        mode: stretch.mode as StretchMode,
        quality: 'preview' as const,
        formant: stretch.formant,
      },
      startFrame: Math.max(0, Math.round(Math.max(when, 0) * sr)),
      skip: Math.max(0, from - clip.startSample),
      frames: Math.max(1, to - from),
    })
    this.sources.push({
      stop: () => {
        try { node.disconnect() } catch { /* already stopped */ }
      },
      disconnect: () => {
        try { node.disconnect() } catch { /* already disconnected */ }
        try { gain.disconnect() } catch { /* already disconnected */ }
      },
    })
  }

  /** Speaker-only sequence. `at` and `dur` are seconds from now. Never enters the cue. */
  previewSequence(events: { pitch: number; at: number; dur: number; velocity?: number; drum?: boolean; cents?: number }[]) {
    this.stopPreview()
    const ctx = this.ctx
    const out = this.speakerGain
    if (!ctx || !out || !events.length) return
    const now = ctx.currentTime + 0.02
    const bus = ctx.createGain()
    bus.connect(out)
    const cut = () => {
      try { bus.disconnect() } catch { /* already disconnected */ }
    }
    const stops: Stoppable[] = [{ stop: cut, disconnect: cut }]
    for (const event of events) {
      const when = now + Math.max(0, event.at)
      const dur = Math.max(0.05, Math.min(8, event.dur))
      const velocity = Math.max(0.05, Math.min(1, event.velocity ?? 0.7))
      if (event.drum) this.previewHit(ctx, bus, event.pitch, when, dur, velocity, stops)
      else this.previewTone(ctx, bus, event.pitch, event.cents ?? 0, when, dur, velocity, stops)
    }
    this.previewStops = stops
  }

  stopPreview() {
    for (const src of this.previewStops) {
      try { src.stop() } catch { /* already stopped */ }
      try { src.disconnect() } catch { /* already disconnected */ }
    }
    this.previewStops = []
  }

  /** Speaker-only audition. The cue and the arrangement are left alone. */
  previewPcm(channels: Float32Array[], sampleRate?: number) {
    this.stopPreview()
    const ctx = this.unlock()
    const out = this.speakerGain
    const lead = channels[0]
    if (!out || !lead?.length) return
    const rate = sampleRate && sampleRate > 0 ? sampleRate : ctx.sampleRate
    const buffer = ctx.createBuffer(Math.max(1, channels.length), lead.length, rate)
    channels.forEach((channel, index) => {
      const data = new Float32Array(lead.length)
      data.set(channel.subarray(0, Math.min(channel.length, lead.length)))
      buffer.copyToChannel(data, index)
    })
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    gain.gain.value = 0.9
    src.connect(gain)
    gain.connect(out)
    const stop = () => {
      try { src.stop() } catch { /* already stopped */ }
    }
    const disconnect = () => {
      try { src.disconnect() } catch { /* already disconnected */ }
      try { gain.disconnect() } catch { /* already disconnected */ }
    }
    src.onended = () => {
      disconnect()
      this.previewStops = this.previewStops.filter((item) => item.stop !== stop)
    }
    this.previewStops = [{ stop, disconnect }]
    src.start()
  }

  private previewTone(ctx: AudioContext, bus: GainNode, pitch: number, cents: number, when: number, dur: number, velocity: number, stops: Stoppable[]) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = 440 * 2 ** ((Math.round(pitch) + cents / 100 - 69) / 12)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.07 * velocity), when + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    osc.connect(gain)
    gain.connect(bus)
    osc.start(when)
    osc.stop(when + dur + 0.02)
    stops.push(osc)
  }

  private previewHit(ctx: AudioContext, bus: GainNode, pitch: number, when: number, dur: number, velocity: number, stops: Stoppable[]) {
    if (pitch <= 36) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(150, when)
      osc.frequency.exponentialRampToValueAtTime(48, when + Math.min(0.16, dur))
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, when)
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.22 * velocity), when + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(0.28, dur))
      osc.connect(gain)
      gain.connect(bus)
      osc.start(when)
      osc.stop(when + 0.3)
      stops.push(osc)
      return
    }
    const noise = ctx.createBufferSource()
    noise.buffer = this.noiseBuffer(ctx)
    const filter = ctx.createBiquadFilter()
    const hat = pitch === 42 || pitch === 44 || pitch === 46
    const cymbal = pitch >= 49
    filter.type = hat || cymbal ? 'highpass' : 'bandpass'
    filter.frequency.value = hat ? 7000 : cymbal ? 5000 : 1800
    const length = hat ? 0.05 : cymbal ? Math.min(0.7, dur) : 0.12
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.16 * velocity), when + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + length)
    noise.connect(filter)
    filter.connect(gain)
    gain.connect(bus)
    noise.start(when)
    noise.stop(when + length + 0.02)
    stops.push(noise)
  }

  /** Local audition only. Stays on the speaker and never enters the cue or mic path. */
  previewPitches(pitches: number[]) {
    const ctx = this.ctx
    const out = this.speakerGain
    if (!ctx || !out) return
    const unique: { midi: number; cents: number }[] = []
    const seen = new Set<number>()
    for (const pitch of pitches) {
      if (!Number.isFinite(pitch)) continue
      const midi = Math.round(pitch)
      if (midi < 0 || midi > 127) continue
      const cents = Math.round((pitch - midi) * 100)
      const key = midi * 100 + cents
      if (seen.has(key)) continue
      seen.add(key)
      unique.push({ midi, cents })
    }
    if (!unique.length) return
    const now = ctx.currentTime
    const bus = ctx.createGain()
    const level = 0.08 / Math.sqrt(unique.length)
    bus.gain.setValueAtTime(0.0001, now)
    bus.gain.exponentialRampToValueAtTime(level, now + 0.015)
    bus.gain.exponentialRampToValueAtTime(0.0001, now + 0.5)
    bus.connect(out)
    let pending = unique.length
    for (const tone of unique) {
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = 440 * 2 ** ((tone.midi + tone.cents / 100 - 69) / 12)
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

  private sendLiveMidi(pitch: number, velocity: number) {
    if (!this.midiSink) return
    this.midiSink(noteBytes(true, this.midiOutChannel, pitch, midiVelocityByte(velocity)))
  }

  private sendMidiNote(note: MidiNote, when: number, dur: number, ctx: BaseAudioContext) {
    if (ctx !== this.ctx || !this.midiSink) return
    const at = this.perfForContext(when)
    this.midiSink(noteBytes(true, this.midiOutChannel, note.pitch, midiVelocityByte(note.velocity)), at)
    this.midiSink(noteBytes(false, this.midiOutChannel, note.pitch, 0), at + Math.max(0, dur) * 1000)
  }

  private heardMidi(project: Project, track: Track) {
    const groups = performancesOn(project, track)
    const voice = groups[0]?.voice ?? track
    const notes: { note: MidiNote; startBeat: number }[] = []
    for (const group of groups) {
      for (const clip of group.clips) {
        if (clip.slotOnly || clip.scene != null) continue
        for (const note of prepareClipNotes(project, group.owner, clip)) notes.push({ note, startBeat: clip.startBeat + note.startBeat })
      }
    }
    return { voice, notes }
  }

  private scheduleVoice(ctx: BaseAudioContext, strip: StripNodes, note: MidiNote, when: number, dur: number, track?: Track, bucket?: Stoppable[]) {
    if (note.muted) return
    if (track?.instrument === 'scaler' && this.project) {
      const routed = routeScaler(this.project, track)
      track = routed.voice
      strip = this.strips.get(routed.liveStripId) ?? strip
    }
    const sampler = samplerInsert(track)
    if (sampler?.sampler) {
      this.sendMidiNote(note, when, dur, ctx)
      if (ctx === this.ctx) {
        this.rack.schedule(sampler.id, note.pitch, note.velocity, when)
        this.rack.schedule(sampler.id, note.pitch, 0, when + Math.max(0.02, dur))
        return
      }
      const asset = this.assetOf(sampler.sampler.bufferId)
      const channel = asset?.channels[0]
      if (channel?.length) {
        const length = Math.max(1, Math.ceil((dur + 0.3) * ctx.sampleRate))
        const rendered = renderSamplerSpan(sampler, channel, [
          { time: 0, pitch: note.pitch, vel: note.velocity },
          { time: dur, pitch: note.pitch, vel: 0 },
        ], ctx.sampleRate, length)
        const audio = ctx.createBuffer(2, rendered[0].length, ctx.sampleRate)
        audio.copyToChannel(new Float32Array(rendered[0]), 0)
        audio.copyToChannel(new Float32Array(rendered[1]), 1)
        const src = ctx.createBufferSource()
        src.buffer = audio
        src.connect(strip.input)
        src.start(Math.max(0, when))
      }
      return
    }
    this.sendMidiNote(note, when, dur, ctx)
    if (track?.instrument === 'pads') {
      this.playPadNote(ctx, strip, track, {
        pitch: note.pitch,
        velocity: note.velocity,
        tune: note.locks?.tune != null ? note.locks.tune + (note.fine || 0) / 100 : (note.fine ? note.fine / 100 : undefined),
        filter: note.locks?.filter,
        decay: note.locks?.decay,
        pan: note.pan,
      }, when, bucket, null, true)
      return
    }
    if (track?.instrument === 'drum-machine' && this.playDrum(ctx, strip, note, when, bucket)) return
    if (track?.instrument === 'library' && ctx === this.ctx) {
      if (track.library) {
        const voiceId = track.id
        const at = Math.max(when, ctx.currentTime)
        this.libraryHost.note(voiceId, note.pitch, note.velocity, at)
        this.libraryHost.note(voiceId, note.pitch, 0, at + dur)
        this.previewRelease(bucket, () => this.libraryHost.release(voiceId, note.pitch, this.ctx?.currentTime ?? 0))
      }
      return
    }
    if (track?.omniPatch?.enabled) {
      if (ctx === this.ctx) {
        const voiceId = track.id
        const at = Math.max(when, ctx.currentTime)
        this.patchHost.note(voiceId, note.pitch, note.velocity, at)
        this.patchHost.note(voiceId, note.pitch, 0, at + dur)
        this.previewRelease(bucket, () => this.patchHost.release(voiceId, note.pitch))
        return
      }
      this.schedulePatchOffline(ctx, strip, track, note, when, dur)
      return
    }
    if (track?.rack && ctx === this.ctx) {
      const voiceId = track.id
      const at = Math.max(when, ctx.currentTime)
      this.rackHost.note(voiceId, note.pitch, note.velocity, at, !!note.slide)
      this.rackHost.note(voiceId, note.pitch, 0, at + dur)
      this.previewRelease(bucket, () => this.rackHost.release(voiceId, note.pitch, this.ctx?.currentTime ?? 0))
      return
    }
    if (ctx === this.ctx && when < ctx.currentTime) return
    const osc = ctx.createOscillator()
    const filter = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    const tune = (note.locks?.tune ?? 0) + (note.fine || 0) / 100
    osc.frequency.value = 440 * 2 ** ((note.pitch + tune - 69) / 12)
    filter.type = 'lowpass'
    const cut = note.locks?.filter
    filter.frequency.setValueAtTime(cut == null ? 2200 : Math.max(80, 200 + cut * 8000), when)
    filter.frequency.exponentialRampToValueAtTime(900, when + Math.min(0.3, dur))
    const peak = Math.max(0.001, 0.07 * note.velocity)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.05, dur))
    osc.connect(filter)
    filter.connect(gain)
    const pan = note.pan || 0
    if (Math.abs(pan) > 0.02 && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner()
      panner.pan.value = Math.max(-1, Math.min(1, pan))
      gain.connect(panner)
      panner.connect(strip.input)
    } else gain.connect(strip.input)
    osc.start(when)
    osc.stop(when + dur + 0.03)
    if (ctx === this.ctx) {
      this.sources.push(osc)
      bucket?.push(osc)
    }
  }

  private schedulePatchOffline(ctx: BaseAudioContext, strip: StripNodes, track: Track, note: MidiNote, when: number, dur: number) {
    const patch = track.omniPatch
    if (!patch) return
    const buffers = new Map<string, Float32Array>()
    for (const layer of patch.layers) {
      if (!layer.bufferId || buffers.has(layer.bufferId)) continue
      const asset = this.assetOf(layer.bufferId)
      const channel = asset?.channels[0]
      if (!asset || !channel?.length) continue
      const key = `${layer.bufferId}:${asset.sampleRate}:${channel.length}:${ctx.sampleRate}`
      let matched = this.patchRateCache.get(key)
      if (!matched) {
        const next = matchBufferRate(channel, asset.sampleRate, ctx.sampleRate)
        this.patchRateCache.set(key, next)
        matched = next
      }
      buffers.set(layer.bufferId, matched)
    }
    const rendered = renderPatchSpan(patch, buffers, note.pitch, note.velocity, dur, ctx.sampleRate)
    const buffer = ctx.createBuffer(2, rendered.left.length, ctx.sampleRate)
    buffer.copyToChannel(rendered.left, 0)
    buffer.copyToChannel(rendered.right, 1)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(strip.input)
    src.start(Math.max(when, 0))
    if (ctx === this.ctx) this.sources.push(src)
  }

  private previewRelease(bucket: Stoppable[] | undefined, stop: () => void) {
    if (bucket !== this.scalerVoices) return
    bucket.push({ stop, disconnect() {} })
  }

  private stopSources() {
    this.stopPreview()
    this.stopScalerPreview()
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
    this.rackHost.allOff()
    this.libraryHost.allOff()
    this.patchHost.allOff()
    this.sessionNodes.clear()
    this.sessionStarted.clear()
    this.sessionClip.clear()
    this.sessionGen.clear()
    this.activeLoop.clear()
    this.retiring.clear()
  }
}

function samplerInsert(track: Track | undefined) {
  if (!track || track.instrument !== 'sampler') return null
  return track.plugins.find((plugin) => plugin.pluginId === 'sampler' && plugin.enabled && plugin.sampler?.bufferId) ?? null
}

function fadeSource(ctx: AudioContext, gain: GainNode, src: AudioBufferSourceNode) {
  const now = ctx.currentTime
  try {
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.012)
  } catch { /* the node is already gone */ }
  try { src.stop(now + 0.02) } catch { /* already stopped */ }
}

function openContext(sampleRate?: number) {
  const options: AudioContextOptions[] = []
  if (sampleRate) options.push({ latencyHint: 'interactive', sampleRate })
  options.push({ latencyHint: 'interactive' })
  if (sampleRate) options.push({ latencyHint: 'balanced', sampleRate })
  options.push({ latencyHint: 'balanced' })
  let last: unknown
  for (const option of options) {
    try {
      return new AudioContext(option)
    } catch (error) {
      last = error
    }
  }
  throw last instanceof Error ? last : new Error('AudioContext failed')
}

interface PadColor {
  tune?: number
  decay?: number
  attack?: number
  filter?: number
  swing?: number
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
