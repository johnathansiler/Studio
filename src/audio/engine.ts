import { clipNeedsStretch, preferStretchCache, renderClipChannels, sourceSamplesOf, timelineSamples } from './stretch/engine'
import { assembleTimedChunks } from './capture'
import { crossfadeLoopRegion } from './clipEdge'
import { clickVoice } from './metroClick'
import { onSpectralCommit } from './spectral/job'
import { followClockToken, onStretchCommit, readStretch, storeStretch, stretchCacheKey, stretchSlot } from './stretch/commit'
import type { StretchMode } from './stretch/engine'
import { analyserRms, applyInserts, createStrip, releaseStrip, type StripNodes } from './strips'
import { midiLit, pruneMidiMarks, type MidiMark } from '../model/midiActivity'
import { compPieces } from '../model/comp'
import { quantizeSample, renderTempoWarp, warpRate } from '../model/launch'
import { clipLoops, holdUntilGrid, sessionStartContext } from '../model/sessionSlots'
import { DRUM_PADS, residentDrums, type ResidentDrum } from '../model/drums'
import { calibrationTrim, contextTimeForEvent, monitoringOffset, type ClockStamp } from '../model/midiClock'
import { isLocalInput, type AudioAsset, type AudioClip, type MidiNote, type Project, type Track } from '../model/types'
import { arrangementEndSample, beatSpanSamples, clickAccent, clickAtOrAfter, meterAtSample, nextClickAfter, projectSampleBeat, tempoAtSample } from '../model/tempoMap'
import { planLoopAudio } from '../model/loopEdit'
import { playbackStops, transportSample } from '../model/transportSync'
import { beatsToSamples, countInBarsOf, samplesPerBeatUnit, samplesToBeats } from '../model/time'
import { matchBufferRate, PatchHost, renderPatchSpan } from '../instruments/patch'
import { performancesOn, routeScaler } from '../instruments/scaler/model'
import { planLive, playTargets, stepNotes, trackHasScaler } from '../instruments/scaler/route'
import { chokeTargets, normalizePadKit, padRegion } from '../model/padMachine'
import { hitRoute, padPitchForKey } from '../instruments/mpc/model'
import { padSendGain, renderPadVoice } from '../instruments/mpc/render'
import { RackHost } from './rack/host'
import { PadHost } from './voices/host'
import { graphPlugins, renderArrangeInputs } from './arrangeSources'
import { LibraryHost } from './multisample/host'
import '../library/instrumentsApi'
import type { SamplePack } from './multisample/types'
import { publishInstrumentVoice, type NoteSurface } from '../harbor/surfaces'
import { renderQuantizedClip } from '../model/quantize'
import { emptyPatternLoopSamples, patternHitTrack, rackPlayMode, transportPatternClips } from '../model/channelRack'
import { findStepChannel, stepPatternOwner } from '../model/stepPlugin'
import { patternPlayRange, renderPattern, type RenderedHit } from '../model/steps'
import { findPeakOffset, jamDelays, perfAtContextTime, type SliceChunk, sliceChunksByPerf } from '../model/latency'
import { encodeWav, linearResample } from '../model/wav'
import { tuneBlockScale } from './plugins/autoTune'
import { audibleIds } from '../model/audible'
import { automationSchedule, channelAutomationMode, laneFor, valueAtMappedSample } from '../model/automation'
import { notePanGains } from './level'
import { applyRamps, smoothParam } from './paramCurve'
import { channelRoute } from '../model/sharedMix'
import { chainContext, enabledFx, LiveMidiChain, midiPanicMessages, midiVelocityByte, noteBytes, prepareClipNotes } from '../model/midiTools'
import { LiveRack } from './liveRack'
import { audioStateOf, planInterruption, planRecovery, type RecoveryAction } from './core/session'
import { publishNotice } from './core/notice'
import { deviceKind, initialBufferHint, recordingAlignmentSamples, resumeNeedsGesture, routeChangePlan, routeOf, type RouteSnapshot } from './core/driver'
import { bufferHintOf, formatLatencyReadout, latencyHintOrder, writeBufferHint, type BufferHint } from './core/buffer'
import { ATTACK_SEC, LATE_SLIP_SEC, MAX_SCHEDULE_PASSES, RELEASE_SEC, SCHEDULER_HORIZON_SEC, advanceLoopCursor, builtinLevel, clipSliceEnvelope, drumLevel, liveWhen, nextTimelineSample, placeNoteTime, scheduleDelaySeconds } from './liveStage'
import { normalizePeak, safetyCurve } from './level'
import { fileDither } from './master/ditherPlan'
import { holdFullScale, SAFETY_LOOK } from './master/safety'
import { sampleLoadFault } from './sampleLoadBus'
import { renderSamplerSpan } from './plugins/sampler'
import { renderGraphParallel } from './parallelRender'
import { loadModule, peekModule } from './plugins/registry'
import { loadProcessors } from './plugins/loadProcessors'
import { createLoudness, measureLoudness, type LoudnessState } from './plugins/dsp'
import type { Processor } from './plugins/types'

function preloadWasmInserts() {
  return loadProcessors().then((mod) => mod.preloadWasmInserts())
}

void loadProcessors()

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
  splitter?: ChannelSplitterNode
  chunks: { frame: number; left: Float32Array; right: Float32Array | null }[]
  meta: RecordInput
  timelineSample: number
  anchorCtx: number
}

interface Stoppable {
  stop: (when?: number) => void
  disconnect: () => void
  /** Fade across a reschedule instead of cutting the waveform. */
  release?: (when: number) => void
  /** Audio-clock time after which the voice can leave the graph. */
  endAt?: number
  /** Session-loop timer. Replaced on the next pass instead of piling up. */
  loopTimer?: boolean
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
  private liveBuiltins: { key: string; gain: GainNode; src: AudioScheduledSourceNode; entry: Stoppable }[] = []
  /** Pad voices that actually started. The phone tests read this after a tap. */
  heardPads: { pitch: number; velocity: number; when: number }[] = []
  /** While the Pads faceplate is open, hits go to that track's mixer channel. */
  private padRouteId: string | null = null
  private padVoices: { pitch: number; trackId: string; gain: GainNode; level: GainNode; pan: StereoPannerNode; stop: (at?: number) => void; born: number; until: number; src: AudioBufferSourceNode }[] = []
  private drumTrims = new Map<string, { gain: GainNode; pan: StereoPannerNode; dest: AudioNode }>()
  private padCaches = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>()
  private drumCache = new WeakMap<BaseAudioContext, AudioBuffer[]>()

  private project: Project | null = null
  private assetOf: (id: string) => AudioAsset | undefined = () => undefined
  private audioBuffers = new Map<string, AudioBuffer>()
  private strips = new Map<string, StripNodes>()
  private masterStrip: StripNodes | null = null
  /** Unrouted drum hits. Solo closes this gain; the master still passes what remains. */
  private patternStrip: StripNodes | null = null
  /** Live drums and keys. Parked into the sounding track so they cannot skip the fader. */
  private liveBus: GainNode | null = null
  private liveParked: AudioNode | null = null
  /** Notes that should light an arrange MIDI indicator, in audio-clock seconds. */
  private midiMarks: MidiMark[] = []
  /** Keys still held on a track. The indicator stays on until the last one releases. */
  private midiHeld = new Map<string, number>()
  /** Post master-fader meter. The strip analyser is after the track fader and mute. */
  private masterMeter: AnalyserNode | null = null
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
  /** Last-ditch shaper until the lookahead limiter worklet is installed. */
  private safety: WaveShaperNode | null = null
  /** Lookahead limiter in front of the meters, the cue, and the speakers. */
  private safetyNode: AudioWorkletNode | null = null
  private safetyReady = false
  /**
   * Matches the limiter delay for inputs that join at the speakers
   * (remote, talk, cue return, previews). Zero until the worklet is in.
   */
  private sideDelay: DelayNode | null = null
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
  private readonly padHost = new PadHost()
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
  private remoteStreams = new Map<string, MediaStream>()
  private micStream: MediaStream | null = null
  private talkGains = new Map<string, GainNode>()

  private sources: Stoppable[] = []
  private previewStops: Stoppable[] = []
  /** Notes from the last Scaler preview, so the next chord can cut them. */
  private scalerVoices: Stoppable[] = []
  private scalerMidi: { pitch: number; onAt: number }[] = []
  private warpPcm = new Map<string, Float32Array[]>()
  private scheduler = 0
  /** Bumped by play, seek, and stop so a late async start cannot revive transport. */
  private commandEpoch = 0
  /** Non-zero while play() or beginRecord() is waiting on the device. */
  private launchTicket = 0
  private reaped = 0
  private schedulerSkips = 0
  /** Largest gap between scheduler wakes, in seconds. */
  schedulerGapSec = 0
  private lastWakeCtx = 0
  /** Beat repeat is armed, so the look-ahead pump stays up while transport is stopped. */
  private repeatWatch = false
  private beatPump: ((now: number, horizon: number) => void) | null = null
  private raf = 0
  private playing = false
  private sessionWatch: (() => void) | null = null
  private sessionBusy = false
  private heldPlaying = false
  private heldPosition = 0
  private heldMode: 'arrangement' | 'session' = 'arrangement'
  /** One rebuild per interruption. A still-busy device is not torn down on every tap. */
  private rebuiltUntilRunning = false
  private playOriginCtx = 0
  private playOriginSample = 0
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
  private bufferHint: BufferHint = initialBufferHint(hintStorage(), typeof navigator === 'undefined' ? '' : navigator.userAgent)
  /** Set from the first tap. iOS will not resume a suspended context before this. */
  private hadGesture = false
  private routeSnap: RouteSnapshot | null = null
  private routeWatch: (() => void) | null = null
  private pageWatch: (() => void) | null = null
  /** Takes assembled when a call, lock, or background tab interrupted the recorder. */
  private keptTakes: CaptureResult[] = []
  /** Status line text. Empty when audio is running. */
  sessionNotice = ''
  private stretchReady = false
  private readonly stretchKeys = new Set<string>()
  private followClock = ''
  private followReady = false
  private followRearm = 0
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
  private countPlan: { tempo: number; numerator: number; denominator: number; bars: number } | null = null
  private noise: AudioBuffer | null = null
  private lastUiEmit = 0
  private pcmTap: AudioWorkletNode | null = null
  private pcmTapSilent: GainNode | null = null
  private pcmPlayer: AudioWorkletNode | null = null
  private listeners = new Set<() => void>()
  /** Instrument track whose effects sit in front of on-screen notes. */
  liveTrackId: string | null = null
  private readonly liveOnAt = new Map<string, number>()
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

  /** Lowest, Balanced, or Playback. The running context uses this hint. */
  get latencyChoice() {
    return this.bufferHint
  }

  latencyReadout() {
    if (!this.ctx) return formatLatencyReadout(null, null)
    return formatLatencyReadout(this.baseLatencyMs, this.deviceLatencyMs)
  }

  /**
   * Switch the device buffer. A running context is rebuilt so the new hint
   * applies. The project and playhead stay.
   */
  async setLatencyChoice(hint: BufferHint) {
    const next = bufferHintOf(hint)
    this.bufferHint = next
    writeBufferHint(next, hintStorage())
    if (!this.ctx) return this.latencyReadout()
    this.rememberTransport()
    const project = this.project
    const position = this.heldPosition
    const wasPlaying = this.heldPlaying
    const mode = this.heldMode
    try {
      this.stop()
    } catch {
      this.playing = false
    }
    this.dropGraph()
    try {
      await this.resume(project?.sampleRate || this.sampleRate || 48000, false)
    } catch {
      /* This environment has no audio device. The choice is still saved. */
    }
    if (project && this.ctx) this.sync(project, this.assetOf)
    this.positionSamples = position
    const running = (this.ctx?.state as string | undefined) === 'running'
    if (wasPlaying && running) void this.play(position, mode)
    this.emit()
    return this.latencyReadout()
  }

  /** Device output latency, not including the audio graph's baseLatency. */
  get deviceLatencyMs() {
    return (this.ctx?.outputLatency || 0) * 1000
  }

  /**
   * Scheduling delay of a note triggered at currentTime.
   * This is the engine's added wait, on top of baseLatency and outputLatency.
   */
  liveLatencyProbe() {
    const now = this.ctx?.currentTime ?? 0
    const when = liveWhen(now)
    return {
      scheduleDelayMs: scheduleDelaySeconds(when, now) * 1000,
      baseLatencyMs: this.baseLatencyMs,
      outputLatencyMs: this.deviceLatencyMs,
      quantum: 128,
    }
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
    const safetyMs = direct ? 0 : this.safetyLatencySeconds() * 1000
    return {
      ms: direct ? (this.ctx?.outputLatency || 0) * 1000 : device + chain + safetyMs,
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
    void preloadWasmInserts()
    this.hadGesture = true
    if (!this.ctx) {
      this.ctx = openContext(48000, this.bufferHint)
      this.buildMaster()
      this.bindAudioSession(this.ctx)
      if (this.project) this.sync(this.project, this.assetOf)
    }
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined)
    return this.ctx
  }

  async resume(preferredRate = 48000, settle = true) {
    const wasmReady = preloadWasmInserts()
    const fresh = !this.ctx
    if (!this.ctx) {
      this.ctx = openContext(preferredRate, this.bufferHint)
      this.buildMaster()
    }
    this.bindAudioSession(this.ctx)
    if (fresh && this.project) this.sync(this.project, this.assetOf)
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume()
      } catch {
        /* iOS rejects resume outside a tap. The camera must still open. */
      }
    }
    await wasmReady
    await this.ensureWorklets()
    this.refreshClockAnchor()
    if (settle) await this.finishSession()
    return this.ctx
  }

  /** Put the lookahead limiter ahead of the meter so the cue and the speakers share it. */
  private installSafety() {
    const ctx = this.ctx
    if (!ctx || !this.masterGain || !this.masterMeter || !this.speakerGain || this.safetyNode) return
    let node: AudioWorkletNode
    try {
      node = new AudioWorkletNode(ctx, 'cueharbor-safety', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      })
    } catch {
      return
    }
    try { this.masterGain.disconnect(this.masterMeter) } catch { /* the meter is being rewired */ }
    this.masterGain.connect(node)
    node.connect(this.masterMeter)
    this.safetyNode = node
    if (this.safety) {
      try { this.speakerGain.disconnect(this.safety) } catch { /* the shaper is leaving the graph */ }
      try { this.safety.disconnect() } catch { /* already disconnected */ }
      this.speakerGain.connect(ctx.destination)
    }
    this.alignSideDelay()
  }

  /** Samples the installed lookahead adds. The waveshaper fallback adds none. */
  private safetyLatencySamples() {
    return this.safetyNode ? SAFETY_LOOK : 0
  }

  private safetyLatencySeconds() {
    const rate = this.sampleRate
    return rate > 0 ? this.safetyLatencySamples() / rate : 0
  }

  /** Keep speaker-only inputs on the same delay as the limited mix. */
  private alignSideDelay() {
    const ctx = this.ctx
    if (!ctx || !this.sideDelay || !this.safetyNode) return
    const seconds = SAFETY_LOOK / ctx.sampleRate
    try {
      this.sideDelay.delayTime.setValueAtTime(seconds, ctx.currentTime)
    } catch {
      this.sideDelay.delayTime.value = seconds
    }
  }

  /** Where talk, remote, cue return, and previews join the speakers. */
  private speakerSide(): AudioNode | null {
    return this.sideDelay ?? this.speakerGain
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
    if (!this.safetyReady) {
      try {
        await this.ctx.audioWorklet.addModule('/worklets/safety.js')
        this.safetyReady = true
      } catch {
        this.safetyReady = false
      }
    }
    if (this.safetyReady) this.installSafety()
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
    this.masterMeter = ctx.createAnalyser()
    this.masterMeter.fftSize = 256
    this.masterMeter.smoothingTimeConstant = 0.35
    this.masterGain.connect(this.masterMeter)
    this.masterMeter.connect(this.cueDest)
    this.masterMeter.connect(this.monitorDelay)
    this.monitorDelay.connect(this.speakerGain)
    this.sideDelay = ctx.createDelay(1)
    this.sideDelay.delayTime.value = 0
    this.sideDelay.connect(this.speakerGain)
    this.remoteBus.connect(this.remoteDelay)
    this.remoteDelay.connect(this.sideDelay)
    this.talkBus.connect(this.talkAnalyser)
    this.talkAnalyser.connect(this.sideDelay)
    this.safety = ctx.createWaveShaper()
    this.safety.curve = safetyCurve()
    this.safety.oversample = 'none'
    this.speakerGain.connect(this.safety)
    this.safety.connect(ctx.destination)
    try {
      const dest = ctx.destination
      if (dest.maxChannelCount >= 2) {
        dest.channelCount = 2
        dest.channelCountMode = 'explicit'
        dest.channelInterpretation = 'speakers'
      }
    } catch { /* the destination channel count is fixed on this device */ }
    this.metroGain.connect(this.localBus)
    this.patternStrip = createStrip(ctx)
    applyInserts(ctx, this.patternStrip, [])
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
        const strip = this.strips.get(id)
        if (strip) releaseStrip(strip)
        this.strips.delete(id)
      }
    }
    for (const id of [...this.chains.keys()]) {
      if (project.tracks.some((track) => track.id === id)) continue
      this.chains.get(id)?.panic()
      this.chains.delete(id)
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
    this.padHost.sync(this.ctx, project, this.strips, assetOf)
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
    const follow = followClockToken(project)
    if (this.followReady && follow !== this.followClock && this.playing && this.status !== 'recording') this.queueFollowRearm()
    this.followClock = follow
    this.followReady = true
  }

  /** Collapse a tempo drag into one reschedule. The latest project is what plays. */
  private queueFollowRearm() {
    if (this.followRearm) return
    this.followRearm = window.setTimeout(() => {
      this.followRearm = 0
      if (!this.playing || !this.ctx || !this.project || this.status === 'recording') return
      if (this.mode === 'session') {
        for (const id of [...this.sessionStarted]) this.stopSessionTrack(id)
        this.scheduleAhead()
        return
      }
      this.retargetPlayingLoop()
      this.scheduleAhead()
    }, 40)
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
    const anySolo = project.tracks.some((track) => track.solo)
    if (this.patternStrip) this.patternStrip.mute.gain.setTargetAtTime(anySolo ? 0 : 1, now, 0.01)
    if (this.liveBus && !this.liveParked) this.liveBus.gain.setTargetAtTime(anySolo ? 0 : 1, now, 0.01)
    for (const track of project.tracks) {
      const strip = this.strips.get(track.id)
      if (!strip) continue
      const follow = channelAutomationMode(project, track.id) !== 'off'
      strip.mute.gain.setTargetAtTime(heard.has(track.id) ? 1 : 0, now, 0.01)
      this.scheduleControl(strip.fader.gain, follow ? laneFor(project.automation, track.id, 'volume')?.points : undefined, track.volume, sample, now, end)
      this.scheduleControl(strip.pan.pan, follow ? laneFor(project.automation, track.id, 'pan')?.points : undefined, track.pan, sample, now, end)
    }
    this.applyDrumTrims(now)
    this.applyPadLevels(now)
    this.rack.applyAutomation(project, this.playing, sample, now, end)
    const originBeat = projectSampleBeat(project, this.playing ? this.playOriginSample : sample)
    const originTime = this.playing ? this.playOriginCtx : now
    const originSample = this.playing ? this.playOriginSample : sample
    this.rackHost.setTransport(project, originTime, originBeat)
    this.rack.setPerformanceClock(this.playing, originTime, originSample, project.tempo)
    this.parkLive(this.padRouteId || this.liveTrackId)
  }

  private scheduleControl(param: AudioParam, points: { beat: number; value: number }[] | undefined, fallback: number, sample: number, now: number, end: number) {
    const project = this.project
    if (!project) return
    if (!this.playing || !points?.length) {
      const value = points?.length ? valueAtMappedSample(points, project, sample, fallback) : fallback
      smoothParam(param, value, now)
      return
    }
    applyRamps(param, automationSchedule(points, fallback, project, sample, now, end), now)
  }

  /** Keep a drum-row fader and pan on nodes that already exist, so a drag is heard immediately. */
  private applyDrumTrims(now: number) {
    const project = this.project
    const ctx = this.ctx
    if (!project || !ctx || !this.masterStrip) return
    const patterns = project.beats?.patterns ?? []
    for (const pattern of patterns) {
      const solo = pattern.channels.some((channel) => channel.solo)
      for (const channel of pattern.channels) {
        const destId = channelRoute(project, channel)
        const dest = (destId ? this.strips.get(destId)?.input : undefined) ?? this.masterStrip.input
        this.throughDrum(channel.id, dest)
        const trim = this.drumTrims.get(channel.id)
        if (!trim) continue
        const heard = !channel.mute && (!solo || channel.solo)
        smoothParam(trim.gain.gain, heard ? Math.max(0, channel.volume) : 0, now)
        smoothParam(trim.pan.pan, channel.pan || 0, now)
      }
    }
    const liveIds = new Set<string>()
    for (const pattern of patterns) for (const channel of pattern.channels) liveIds.add(channel.id)
    for (const id of [...this.drumTrims.keys()]) {
      if (liveIds.has(id)) continue
      const trim = this.drumTrims.get(id)
      try { trim?.pan.disconnect() } catch { /* already gone */ }
      try { trim?.gain.disconnect() } catch { /* already gone */ }
      this.drumTrims.delete(id)
    }
  }

  private applyPadLevels(now: number) {
    const project = this.project
    if (!project) return
    for (const voice of this.padVoices) {
      const pad = project.tracks.find((track) => track.id === voice.trackId)?.padKit?.banks.flat().find((item) => item.pitch === voice.pitch)
      if (!pad) continue
      smoothParam(voice.level.gain, pad.muted ? 0 : pad.level, now)
      smoothParam(voice.pan.pan, pad.pan || 0, now)
    }
  }

  private throughDrum(channelId: string, dest: AudioNode): AudioNode {
    const ctx = this.ctx
    if (!ctx) return dest
    let trim = this.drumTrims.get(channelId)
    if (!trim || trim.dest !== dest) {
      try { trim?.pan.disconnect() } catch { /* first connection */ }
      try { trim?.gain.disconnect() } catch { /* first connection */ }
      const gain = ctx.createGain()
      const pan = ctx.createStereoPanner()
      const mix = this.drumMix(channelId)
      gain.gain.value = mix.volume
      pan.pan.value = mix.pan
      gain.connect(pan)
      pan.connect(dest)
      trim = { gain, pan, dest }
      this.drumTrims.set(channelId, trim)
    }
    return trim.gain
  }

  private drumMix(channelId: string) {
    const channel = this.project ? findStepChannel(this.project, channelId) : null
    return { volume: Math.max(0, channel?.volume ?? 1), pan: channel?.pan || 0 }
  }

  /** Step Sequencer hits always enter that track's strip, then the master. */
  private scheduleStepSequencers(
    ctx: BaseAudioContext,
    project: Project,
    ctxTime: number,
    timelineStart: number,
    timelineEnd: number,
  ) {
    const fromBeat = projectSampleBeat(project, timelineStart)
    const toBeat = projectSampleBeat(project, timelineEnd)
    for (const track of project.tracks) {
      const plugin = track.plugins.find((item) => item.pluginId === 'steps' && item.enabled && item.steps?.patterns.length)
      if (!plugin?.steps) continue
      const strip = this.strips.get(track.id)
      if (!strip) continue
      const song = (plugin.params.song ?? 0) >= 0.5
      const owned = new Set(plugin.steps.patterns.map((pattern) => pattern.id))
      const clips = (project.patternClips ?? []).filter((clip) => (
        clip.scene == null
        && !clip.suppressed
        && owned.has(clip.patternId)
        && (!clip.trackId || clip.trackId === track.id)
      ))
      if (song && clips.length) {
        for (const clip of clips) {
          const pattern = plugin.steps.patterns.find((item) => item.id === clip.patternId)
          if (!pattern) continue
          const range = patternPlayRange(clip)
          for (const hit of renderPattern(pattern, range.from, range.to)) {
            this.fireStep(ctx, strip, track.id, project, hit, clip.startBeat + (hit.startBeat - range.from), ctxTime, timelineStart, timelineEnd)
          }
        }
        continue
      }
      const pattern = plugin.steps.patterns.find((item) => item.id === plugin.steps!.activeId) ?? plugin.steps.patterns[0]
      if (!pattern) continue
      for (const hit of renderPattern(pattern, fromBeat, toBeat)) {
        this.fireStep(ctx, strip, track.id, project, hit, hit.startBeat, ctxTime, timelineStart, timelineEnd)
      }
    }
  }

  private fireStep(
    ctx: BaseAudioContext,
    strip: StripNodes,
    trackId: string,
    project: Project,
    hit: RenderedHit,
    startBeat: number,
    ctxTime: number,
    timelineStart: number,
    timelineEnd: number,
  ) {
    const span = beatSpanSamples(project, startBeat, hit.durationBeats)
    if (span.start < timelineStart || span.start >= timelineEnd) return
    const when = ctxTime + (span.start - timelineStart) / this.sampleRate
    if (ctx === this.ctx) this.markMidi(trackId, when, Math.max(0.08, span.duration / this.sampleRate))
    const owner = project.tracks.find((item) => item.id === trackId)
    if (owner && trackHasScaler(owner)) {
      const shaped = stepNotes(project, owner, hit.pitch, hit.velocity, Math.max(0.05, hit.durationBeats), Math.floor(startBeat / 4)) ?? []
      for (const note of shaped) {
        const dest = project.tracks.find((item) => item.id === note.trackId) ?? owner
        const destStrip = this.strips.get(note.trackId) ?? strip
        const dur = beatSpanSamples(project, startBeat, note.durationBeats).duration / this.sampleRate
        const voice = {
          id: `step:${startBeat}:${note.pitch}`,
          pitch: note.pitch,
          fine: note.fine,
          startBeat: 0,
          durationBeats: note.durationBeats,
          velocity: note.velocity,
        }
        if (note.hear === 'midi') this.sendMidiNote(voice, when, dur, ctx)
        else this.scheduleVoice(ctx, destStrip, voice, when, dur, routeScaler(project, dest).voice, undefined, note.hear === 'audio')
      }
      return
    }
    this.scheduleHit(ctx, strip, { ...hit, output: null }, when, span.duration / this.sampleRate)
  }

  /** Play Scaler notes through the track's chosen sound. The previous preview chord is released first. */
  auditionScaler(trackId: string, notes: { pitch: number; fine?: number; delay: number; duration: number; velocity: number }[], output: 'audio' | 'midi' | 'both' = 'both') {
    this.unlock()
    if (!notes.length) return
    this.stopScalerPreview()
    if (this.project) this.sync(this.project, this.assetOf)
    const track = this.project?.tracks.find((item) => item.id === trackId)
    const strip = track ? this.strips.get(track.id) : undefined
    const ctx = this.ctx
    if (!track || !strip || !ctx || !this.project) return
    const now = liveWhen(ctx.currentTime)
    const wantAudio = output !== 'midi'
    const wantMidi = output !== 'audio'
    const targets = playTargets(this.project, track)
    for (const destId of targets) {
      const dest = this.project.tracks.find((item) => item.id === destId) ?? track
      const voiceTrack = routeScaler(this.project, dest).voice
      const out = this.strips.get(destId) ?? strip
      for (const note of notes) {
        const dur = Math.max(0.05, note.duration)
        const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)))
        const when = now + Math.max(0, note.delay)
        const voice = {
          id: 'scaler',
          pitch,
          fine: note.fine,
          startBeat: 0,
          durationBeats: dur,
          velocity: Math.max(0.05, Math.min(1, note.velocity || 0.8)),
        }
        if (wantMidi) this.scalerMidi.push({ pitch, onAt: this.perfForContext(when) })
        if (wantAudio) this.scheduleVoice(ctx, out, voice, when, dur, voiceTrack, this.scalerVoices, !wantMidi)
        else if (wantMidi) this.sendMidiNote(voice, when, dur, ctx)
      }
    }
  }

  /** Live MIDI out for a keyboard chord, without starting a new audio preview. */
  pulseMidi(notes: { pitch: number; velocity: number; duration: number }[]) {
    if (!this.midiSink || !notes.length) return
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    for (const note of notes) {
      const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)))
      const dur = Math.max(0.05, note.duration)
      this.midiSink(noteBytes(true, this.midiOutChannel, pitch, midiVelocityByte(note.velocity)), now)
      this.midiSink(noteBytes(false, this.midiOutChannel, pitch, 0), now + dur * 1000)
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
    const ctx = this.unlock()
    const when = liveWhen(ctx.currentTime)
    if (hold && !this.acceptLive(trackId, pitch, when)) return
    const level = Math.max(0.05, Math.min(1, velocity))
    const track = this.project?.tracks.find((item) => item.id === trackId)
    const sampler = samplerInsert(track)
    if (sampler) {
      this.rack.trigger(sampler.id, pitch, level)
      if (!hold) window.setTimeout(() => this.rack.trigger(sampler.id, pitch, 0), 350)
      return
    }
    if (track?.instrument === 'library') {
      this.voiceNote('mini', trackId, pitch, level, when)
      if (!hold) this.voiceNote('mini', trackId, pitch, 0, when + 0.35)
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
      this.voiceNote('mini', trackId, pitch, 0, when)
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
    const when = liveWhen(this.ctx?.currentTime ?? 0)
    this.libraryHost.note(trackId, pitch, level, when)
    this.libraryHost.note(trackId, pitch, 0, when + 1.1)
  }

  holdLibraryPack(trackId: string, pack: SamplePack) {
    this.libraryHost.holdPack(trackId, pack)
  }

  holdLibraryAudio(trackId: string, samples: { id: string; sampleRate: number; channels: Float32Array[] }[]) {
    this.libraryHost.holdAudio(trackId, samples)
  }

  /**
   * One multi-sample voice for every note surface.
   * Keyboard, mini keys, pads, both piano rolls, Arrange, recording, Scaler, and hardware MIDI call this.
   */
  voiceNote(surface: NoteSurface, trackId: string, pitch: number, velocity: number, when?: number) {
    publishInstrumentVoice({ surface, trackId, pitch, velocity, down: velocity > 0, when })
    const track = this.project?.tracks.find((item) => item.id === trackId)
    if (!(track?.instrument === 'library' && track.library)) return false
    this.queueLibrary(trackId, pitch, velocity, when)
    return true
  }

  /**
   * Download the pressed note and the roots next to it, then play through the track.
   * A note that is still downloading stays quiet and reports the failure. It does not pretend to sound.
   */
  private queueLibrary(trackId: string, pitch: number, velocity: number, when?: number) {
    const key = `${trackId}:${Math.round(pitch)}`
    if (!(velocity > 0)) {
      this.libraryHeld.delete(key)
      const at = when ?? liveWhen(this.ctx?.currentTime ?? 0)
      this.libraryHost.note(trackId, pitch, 0, at)
      return
    }
    let ctx: AudioContext
    try {
      ctx = this.unlock()
    } catch {
      sampleLoadFault('Audio is not available on this device yet.')
      return
    }
    if (this.project) this.sync(this.project, this.assetOf)
    const track = this.project?.tracks.find((item) => item.id === trackId)
    const program = track?.library
    if (!track || track.instrument !== 'library' || !program) {
      sampleLoadFault('Load an instrument onto this track first.')
      return
    }
    this.libraryHeld.add(key)
    const level = velocity <= 1 ? velocity : Math.max(0.05, Math.min(1, velocity / 127))
    const midi = Math.round(pitch)
    const roots = new Set<number>([midi])
    for (const zone of program.zones) {
      if (zone.trigger === 'release') continue
      if (Math.abs(zone.root - midi) <= 2) roots.add(Math.round(zone.root))
    }
    const events = [...roots].slice(0, 6).map((note, index) => ({ sample: index, pitch: note, vel: level }))
    const rate = ctx.sampleRate || this.sampleRate
    void this.libraryHost.prepare(trackId, track, events, rate).then((ready) => {
      if (!this.libraryHeld.has(key)) return
      if (this.project?.tracks.find((item) => item.id === trackId)?.library !== program) return
      if (ready.sounding <= 0) {
        sampleLoadFault('That note is outside this instrument.')
        return
      }
      if (ready.missing > 0) {
        sampleLoadFault('That sample did not load.')
        return
      }
      sampleLoadFault('')
      const now = this.ctx?.currentTime ?? 0
      const at = when != null && when > now ? when : liveWhen(now)
      this.libraryHost.note(trackId, pitch, level, at)
    }).catch((error: unknown) => {
      sampleLoadFault(error instanceof Error ? error.message : 'Could not load that note.')
    })
  }

  /** Audition a layered patch. `down` starts the note; a lift releases it. A loaded starter instrument plays instead. */
  previewPatch(trackId: string, pitch: number, down: boolean, velocity = 0.85) {
    const ctx = this.unlock()
    const when = liveWhen(ctx.currentTime)
    if (down && !this.acceptLive(trackId, pitch, when)) return
    if (!down) this.clearLive(trackId, pitch)
    const level = velocity > 0 && velocity <= 1 ? velocity : 0.85
    const track = this.project?.tracks.find((item) => item.id === trackId)
    if (track?.instrument === 'library' && track.library) {
      this.queueLibrary(trackId, pitch, down ? level : 0)
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
    node.connect(this.speakerSide() ?? this.speakerGain)
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
    smoothParam(this.masterGain.gain, gain, this.ctx.currentTime)
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
    this.scheduleAhead()
  }

  adoptArrangement() {
    if (!this.playing) return
    this.mode = 'arrangement'
    this.stopSources()
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
    this.micStream = stream
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
    return recordingAlignmentSamples(ctx.baseLatency || 0, ctx.outputLatency || 0, ctx.sampleRate) + this.safetyLatencySamples()
  }

  setRemoteMusic(peerId: string, stream: MediaStream | null) {
    if (stream) this.remoteStreams.set(peerId, stream)
    else this.remoteStreams.delete(peerId)
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
      this.cueReturnGain.connect(this.speakerSide() ?? this.speakerGain)
    }
    this.cueReturnSrc = this.ctx.createMediaStreamSource(stream)
    this.cueReturnSrc.connect(this.cueReturnGain)
  }

  setCueAudible(on: boolean) {
    if (this.cueReturnGain && this.ctx) this.cueReturnGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02)
  }

  /** Remember a MIDI note on this track so the arrange header can light up. */
  markMidi(trackId: string | null | undefined, when?: number, dur = 0.16) {
    if (!trackId) return
    const now = this.ctx?.currentTime ?? 0
    const from = when ?? now
    this.midiMarks.push({ id: trackId, from, until: from + Math.max(0.08, dur) })
    if (this.midiMarks.length > 512) this.midiMarks.splice(0, this.midiMarks.length - 256)
  }

  /** A held key, pad, or incoming MIDI note. Pair +1 with a later -1. */
  holdMidi(trackId: string | null | undefined, delta: 1 | -1) {
    if (!trackId) return
    const next = (this.midiHeld.get(trackId) ?? 0) + delta
    if (next <= 0) this.midiHeld.delete(trackId)
    else this.midiHeld.set(trackId, next)
    if (delta > 0) this.markMidi(trackId)
  }

  /** Tracks with MIDI sounding right now. Playback, keys, pads, hardware, and Note Repeat share this. */
  midiActivity(): Record<string, boolean> {
    const now = this.ctx?.currentTime ?? 0
    const lit = midiLit(this.midiMarks, new Set(this.midiHeld.keys()), now)
    this.midiMarks = pruneMidiMarks(this.midiMarks, now)
    return lit
  }

  levels() {
    const tracks: Record<string, number> = {}
    for (const [id, strip] of this.strips) tracks[id] = analyserRms(strip.analyser, this.meterScratch)
    return {
      master: this.masterMeter
        ? analyserRms(this.masterMeter, this.meterScratch)
        : this.masterStrip
          ? analyserRms(this.masterStrip.analyser, this.meterScratch)
          : 0,
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
    if (this.playing || this.launchTicket) {
      void this.play(next, this.mode)
      return
    }
    this.positionSamples = next
    this.emit()
  }

  async play(fromSample: number, mode: 'arrangement' | 'session' = 'arrangement') {
    const ticket = ++this.commandEpoch
    this.launchTicket = ticket
    try {
      await this.resume()
      if (ticket !== this.commandEpoch || !this.ctx) return
      await this.warmUpcomingLibrary(Math.max(0, fromSample), 2.5)
      if (ticket !== this.commandEpoch || !this.ctx) return
      const startAt = this.ctx.currentTime + 0.05
      this.startTransport(startAt, fromSample, mode)
    } finally {
      if (this.launchTicket === ticket) this.launchTicket = 0
    }
  }

  /**
   * Start so the playhead is at `sample` when performance.now() reaches `perfMs`.
   * A late call skips ahead instead of starting the downbeat in the past.
   */
  /** Clicks land on the beats before the next playAtPerf downbeat. */
  armCountIn(tempo: number, signature: { numerator: number; denominator: number }, bars = 1) {
    this.countPlan = { tempo, numerator: signature.numerator, denominator: signature.denominator, bars: bars === 2 ? 2 : 1 }
  }

  async playAtPerf(sample: number, perfMs: number, mode: 'arrangement' | 'session' = 'arrangement') {
    const ticket = ++this.commandEpoch
    this.launchTicket = ticket
    try {
      await this.resume()
      if (ticket !== this.commandEpoch || !this.ctx) return
      await this.warmUpcomingLibrary(Math.max(0, sample), 2.5)
      if (ticket !== this.commandEpoch || !this.ctx) return
      this.refreshClockAnchor()
      const ctx = this.ctx
      let startAt = this.contextForPerf(perfMs)
      let from = Math.max(0, sample)
      const earliest = ctx.currentTime + 0.02
      if (startAt < earliest) {
        from += Math.round((earliest - startAt) * this.sampleRate)
        startAt = earliest
      }
      const plan = this.countPlan
      this.countPlan = null
      if (plan) this.scheduleCountClicks(startAt, plan.tempo, plan, plan.bars)
      this.startTransport(startAt, from, mode)
      if (plan && startAt > ctx.currentTime + 0.05) {
        this.status = 'counting-in'
        const wait = Math.max(0, (startAt - ctx.currentTime) * 1000)
        window.clearTimeout(this.countTimer)
        this.countTimer = window.setTimeout(() => {
          if (ticket === this.commandEpoch && this.playing && this.status === 'counting-in') {
            this.status = 'playing'
            this.emit()
          }
        }, wait)
        this.emit()
      }
    } finally {
      if (this.launchTicket === ticket) this.launchTicket = 0
    }
  }

  private startTransport(startAt: number, fromSample: number, mode: 'arrangement' | 'session') {
    this.stopSources()
    this.mode = mode
    this.armTransport(startAt, Math.max(0, fromSample))
    this.status = 'playing'
    this.emit()
  }

  stop(opts?: { internal?: boolean; keepHold?: boolean }) {
    clearTimeout(this.countTimer)
    this.countPlan = null
    this.countWait?.()
    this.countWait = null
    if (!opts?.internal) {
      this.commandEpoch += 1
      this.launchTicket = 0
    }
    if (!opts?.keepHold && !opts?.internal) this.heldPlaying = false
    if (this.playing && this.ctx) {
      this.positionSamples = Math.max(0, Math.round(this.heardSample(this.sampleAt(this.ctx.currentTime))))
    }
    this.playing = false
    this.silenceNow()
    if (this.followRearm) {
      window.clearTimeout(this.followRearm)
      this.followRearm = 0
    }
    this.sessionStarted.clear()
    this.nextLoopCtx = null
    if (this.scheduler && !this.repeatWatch) {
      window.clearInterval(this.scheduler)
      this.scheduler = 0
    }
    if (this.status !== 'stopped') this.status = 'stopped'
    this.emit()
  }

  /**
   * Stop the performance and clear stuck audio without touching the project.
   * A closed or interrupted context is rebuilt. A suspended one is resumed.
   */
  async panic() {
    this.discardCapture()
    this.stop()
    this.positionSamples = 0
    this.liveOnAt.clear()
    this.sendMidiPanic()
    const rebuild = this.contextBroken()
    if (rebuild) this.dropGraph()
    else this.flushLiveAudio()
    await this.recoverContext()
    if (rebuild) this.reattachInputs()
    if (this.project && this.ctx && this.localBus && this.masterStrip) this.sync(this.project, this.assetOf)
    this.playing = false
    this.positionSamples = 0
    this.status = 'stopped'
    this.refreshClockAnchor()
    if (this.ctx?.state === 'running') this.workletError = ''
    this.emit()
  }

  private contextBroken() {
    if (!this.ctx) return true
    const state = this.ctx.state as string
    return state === 'closed' || state === 'interrupted'
  }

  private pageVisible() {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  }

  private bindAudioSession(ctx: AudioContext) {
    this.unbindAudioSession()
    const onState = () => {
      const state = audioStateOf(String(ctx.state))
      const kind = deviceKind(typeof navigator === 'undefined' ? '' : navigator.userAgent)
      if (resumeNeedsGesture(kind, state, this.hadGesture)) {
        this.postNotice('Tap Play to resume audio.')
        return
      }
      const visible = this.pageVisible()
      const plan = planInterruption({
        state,
        visible,
        hiddenKind: this.hiddenKind(visible),
        ios: kind === 'ios-safari',
        recording: this.status === 'recording',
      })
      if (plan.notice) this.postNotice(plan.notice)
      if (plan.finalizeTake) void this.holdTake()
      const action = planRecovery(state, visible)
      if (action === 'none') return
      void this.recoverAudioSession(action)
    }
    ctx.addEventListener('statechange', onState)
    this.sessionWatch = () => ctx.removeEventListener('statechange', onState)
    this.bindPage()
    this.bindRoute()
  }

  private unbindAudioSession() {
    this.sessionWatch?.()
    this.sessionWatch = null
    this.routeWatch?.()
    this.routeWatch = null
  }

  private hiddenKind(visible: boolean): 'tab' | 'lock' | undefined {
    if (visible) return undefined
    const kind = deviceKind(typeof navigator === 'undefined' ? '' : navigator.userAgent)
    return kind === 'ios-safari' || kind === 'android-chrome' ? 'lock' : 'tab'
  }

  private postNotice(text: string) {
    this.sessionNotice = text
    publishNotice(text)
    this.emit()
  }

  private bindPage() {
    if (this.pageWatch || typeof document === 'undefined') return
    const onVis = () => {
      void this.onVisibility(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', onVis)
    this.pageWatch = () => document.removeEventListener('visibilitychange', onVis)
  }

  private bindRoute() {
    if (this.routeWatch || typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return
    const onDevice = () => {
      void this.noteRoute()
    }
    navigator.mediaDevices.addEventListener('devicechange', onDevice)
    this.routeWatch = () => navigator.mediaDevices.removeEventListener('devicechange', onDevice)
    void this.noteRoute()
  }

  private async noteRoute() {
    const ctx = this.ctx
    if (!ctx) return
    let label = ''
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      label = list.filter((device) => device.kind === 'audiooutput').map((device) => device.label).join(' ')
    } catch {
      label = ''
    }
    const next: RouteSnapshot = {
      sampleRate: ctx.sampleRate,
      route: routeOf(label),
      outputLatency: ctx.outputLatency || 0,
    }
    const plan = routeChangePlan(this.routeSnap, next)
    const first = this.routeSnap == null
    this.routeSnap = next
    if (first) return
    if (plan === 'rebuild') void this.recoverAudioSession('rebuild')
    else if (plan === 'resume' && (ctx.state as string) !== 'running') void ctx.resume().catch(() => undefined)
  }

  private async onVisibility(visible: boolean) {
    const kind = deviceKind(typeof navigator === 'undefined' ? '' : navigator.userAgent)
    const plan = planInterruption({
      state: audioStateOf(this.ctx ? String(this.ctx.state) : 'missing'),
      visible,
      hiddenKind: this.hiddenKind(visible),
      ios: kind === 'ios-safari',
      recording: this.status === 'recording',
    })
    if (plan.notice) this.postNotice(plan.notice)
    if (plan.finalizeTake) await this.holdTake()
    if (!visible && plan.pause && this.playing) {
      this.rememberTransport()
      this.heldPlaying = true
      try {
        this.stop({ keepHold: true })
      } catch {
        this.playing = false
      }
      this.heldPosition = this.positionSamples
      this.emit()
      return
    }
    if (visible && this.heldPlaying && !this.playing) {
      const ticket = this.commandEpoch
      const mode = this.heldMode
      if (plan.notice) this.postNotice('')
      await this.finishSession()
      const running = (this.ctx?.state as string | undefined) === 'running'
      if (this.heldPlaying && ticket === this.commandEpoch && !this.playing && running) void this.play(this.positionSamples, mode)
    }
  }

  private rememberTransport() {
    if (this.playing) this.heldPlaying = true
    this.heldMode = this.mode
      try {
        if (this.playing && this.ctx && (this.ctx.state as string) !== 'closed') {
          this.heldPosition = Math.max(0, Math.round(this.heardSample(this.sampleAt(this.ctx.currentTime))))
        } else if (!this.heldPlaying) {
          this.heldPosition = this.positionSamples
        }
      } catch {
        this.heldPosition = this.positionSamples
      }
    }

  /** Resume or rebuild the device. The project and playhead stay. */
  private async finishSession() {
    if (!this.ctx || this.sessionBusy) return
    const action = planRecovery(audioStateOf(String(this.ctx.state)), this.pageVisible())
    if (action === 'none') return
    await this.recoverAudioSession(action)
  }

  private async recoverAudioSession(action: RecoveryAction) {
    if (this.sessionBusy) return
    this.sessionBusy = true
    try {
      if (this.status === 'recording') await this.holdTake()
      this.rememberTransport()
      const project = this.project
      if (this.ctx && (this.ctx.state as string) === 'running') this.rebuiltUntilRunning = false
      if (action === 'resume' && this.ctx && (this.ctx.state as string) !== 'closed') {
        try {
          await this.ctx.resume()
        } catch {
          /* Fall through and rebuild if the device will not resume. */
        }
        if (this.ctx && (this.ctx.state as string) === 'running') {
          this.rebuiltUntilRunning = false
          this.refreshClockAnchor()
          if (project) this.sync(project, this.assetOf)
          this.emit()
          return
        }
      }
      if (this.rebuiltUntilRunning && (this.ctx?.state as string | undefined) !== 'closed') return
      this.rebuiltUntilRunning = true
      const rate = project?.sampleRate || this.sampleRate || 48000
      const position = this.heldPosition
      const wasPlaying = this.heldPlaying
      const mode = this.heldMode
      try {
        this.stop({ internal: true })
      } catch {
        this.playing = false
      }
      this.dropGraph()
      await this.resume(rate, false)
      if (project && this.ctx) this.sync(project, this.assetOf)
      this.positionSamples = position
      const running = (this.ctx?.state as string | undefined) === 'running'
      if (running) this.rebuiltUntilRunning = false
      if (wasPlaying && running) void this.play(position, mode)
      this.emit()
    } finally {
      this.sessionBusy = false
    }
  }

  private flushLiveAudio() {
    this.rack.resetAll()
    this.audioBuffers.clear()
    this.warpPcm.clear()
    this.noise = null
    this.patchRateCache.clear()
  }

  private async recoverContext() {
    const rate = this.project?.sampleRate || 48000
    try {
      await this.resume(rate)
    } catch {
      this.dropGraph()
      try {
        await this.resume(rate)
      } catch {
        /* This environment has no audio device. The playhead is still home. */
      }
    }
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume()
      } catch {
        /* A later tap resumes a context the browser is holding. */
      }
    }
    if (this.ctx && (this.ctx.state as string) === 'closed') {
      this.dropGraph()
      try {
        await this.resume(rate)
      } catch {
        /* Still unavailable. */
      }
    }
  }

  private reattachInputs() {
    if (!this.ctx) return
    if (this.micStream) this.setLocalMic(this.micStream)
    for (const [peerId, stream] of this.remoteStreams) this.setRemoteMusic(peerId, stream)
  }

  private dropGraph() {
    this.unbindAudioSession()
    this.rack.dispose()
    this.libraryHost.dispose()
    this.patchHost.dispose()
    this.rackHost.dispose()
    this.padHost.dispose()
    const dead = this.ctx
    this.ctx = null
    try {
      void dead?.close()
    } catch {
      /* Already closed. */
    }
    this.localBus = null
    this.remoteBus = null
    this.monitorDelay = null
    this.remoteDelay = null
    this.sideDelay = null
    this.masterGain = null
    this.speakerGain = null
    this.safety = null
    this.safetyNode = null
    this.safetyReady = false
    this.talkBus = null
    this.metroGain = null
    this.cueDest = null
    this.recordSink = null
    this.inputAnalyser = null
    this.tuneAnalyser = null
    this.talkAnalyser = null
    this.cueReturnGain = null
    this.cueReturnSrc = null
    this.masterStrip = null
    this.masterMeter = null
    this.patternStrip = null
    this.liveBus = null
    this.liveParked = null
    this.localMicGain = null
    this.localMicSrc = null
    this.monitorSplit = null
    this.strips.clear()
    this.remoteGains.clear()
    this.talkGains.clear()
    this.audioBuffers.clear()
    this.warpPcm.clear()
    this.noise = null
    this.patchRateCache.clear()
    this.drumBuffers = []
    this.drumTable = []
    this.warmVoices = []
    this.keysNode = null
    this.keysSab = null
    this.workletsReady = false
    this.stretchReady = false
    this.pcmTap = null
    this.pcmTapSilent = null
    this.pcmPlayer = null
    this.rollingNode = null
    this.rollingSrc = null
    this.rollingSilent = null
    this.sources = []
    this.oneShots = []
    this.padVoices = []
    this.liveBuiltins = []
  }

  private discardCapture() {
    clearTimeout(this.countTimer)
    this.countPlan = null
    const release = this.countWait
    this.countWait = null
    release?.()
    for (const rec of this.recorders.values()) this.releaseRecorder(rec)
    this.recorders.clear()
    this.dropPending()
    try { this.stopRolling() } catch { /* the rolling tap is already gone */ }
  }

  private sendMidiPanic() {
    const sink = this.midiSink
    if (!sink) return
    for (const bytes of midiPanicMessages()) sink(bytes)
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
    const ticket = ++this.commandEpoch
    this.launchTicket = ticket
    try {
      await this.resume()
      if (ticket !== this.commandEpoch || !this.ctx) return
      const punch = () => {
        if (ticket !== this.commandEpoch || !this.ctx) return
        const ctx = this.ctx
        this.refreshClockAnchor()
        const ctxTime = opts.hostPerfAtSample != null ? Math.max(this.contextForPerf(opts.hostPerfAtSample), ctx.currentTime + 0.02) : ctx.currentTime + 0.04
        if (opts.mode) {
          const previous = this.mode
          this.mode = opts.mode
          if (this.playing && previous !== opts.mode) {
            this.stopSources()
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
        const bars = Math.max(1, countInBarsOf(this.project))
        const go = await this.holdForDownbeat(opts.hostPerfAtSample, tempoAtSample(this.project, opts.fromSample), meterAtSample(this.project, opts.fromSample), bars)
        if (!go || ticket !== this.commandEpoch) return
        punch()
        return
      }
      if (opts.countIn && this.project?.countIn && !this.playing) await this.runCountIn(punch, opts.fromSample)
      else punch()
    } finally {
      if (this.launchTicket === ticket) this.launchTicket = 0
    }
  }

  async finishRecording(): Promise<CaptureResult[]> {
    const fresh = await this.drainRecorders()
    const kept = this.keptTakes.splice(0)
    return kept.concat(fresh)
  }

  /** Assemble whatever has already reached the recorder, then keep it for the next stop. */
  private async holdTake() {
    const fresh = await this.drainRecorders()
    if (fresh.length) this.keptTakes.push(...fresh)
  }

  private async drainRecorders(): Promise<CaptureResult[]> {
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
    this.dropPending()
    const results: CaptureResult[] = []
    for (const rec of this.recorders.values()) {
      const built = this.assemble(rec)
      if (built) results.push(built)
      this.releaseRecorder(rec)
    }
    this.recorders.clear()
    if (this.status === 'recording') this.status = this.playing ? 'playing' : 'stopped'
    this.emit()
    return results
  }

  private assemble(rec: ActiveRec): CaptureResult | null {
    if (!rec.chunks.length) return null
    const sr = this.sampleRate
    const first = rec.chunks.reduce((earliest, chunk) => (chunk.frame < earliest.frame ? chunk : earliest))
    const startSample = Math.round(rec.timelineSample + (first.frame / sr - rec.anchorCtx) * sr)
    const placed = assembleTimedChunks(rec.chunks)
    if (!placed) return null
    const left = placed.left
    const right = placed.right
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

  private releaseRecorder(rec: ActiveRec) {
    try { rec.node.port.postMessage({ type: 'stop' }) } catch { /* already stopped */ }
    try { rec.source.disconnect() } catch { /* already gone */ }
    try { rec.splitter?.disconnect() } catch { /* already gone */ }
    try { rec.node.disconnect() } catch { /* already gone */ }
    try { rec.silent.disconnect() } catch { /* already gone */ }
  }

  private dropPending(key?: string) {
    const kept: typeof this.pendingRecorders = []
    for (const pending of this.pendingRecorders) {
      if (key != null && pending.key !== key) {
        kept.push(pending)
        continue
      }
      try { pending.stream.removeEventListener('addtrack', pending.handler) } catch { /* already gone */ }
    }
    this.pendingRecorders = kept
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
          this.dropPending(input.key)
          if (this.status === 'recording') this.armRecorders([input], timelineSample, anchorCtx)
        }
        this.dropPending(input.key)
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
      let splitter: ChannelSplitterNode | undefined
      if (input.channel != null) {
        splitter = this.ctx.createChannelSplitter(input.channel + 1)
        src.connect(splitter)
        splitter.connect(node, input.channel, 0)
      } else src.connect(node)
      node.connect(silent)
      silent.connect(this.recordSink ?? this.ctx.destination)
      const rec: ActiveRec = {
        node,
        source: src,
        silent,
        splitter,
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
    node.connect(this.speakerSide() ?? this.speakerGain)
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
    const rate = project.sampleRate || this.sampleRate
    const end = Math.max(rate, arrangementEndSample(project))
    const inputs = await renderArrangeInputs(project, assets, 0, end, end)
    const renderedTracks = project.tracks.map((track) => ({
      id: track.id,
      type: track.type,
      input: track.input,
      buffer: inputs.get(track.id) ?? [new Float32Array(end), new Float32Array(end)],
      volume: track.volume,
      pan: track.pan,
      mute: track.mute,
      solo: track.solo,
      soloSafe: track.soloSafe,
      plugins: graphPlugins(track),
      sends: track.sends,
      output: track.output,
      groupId: track.groupId,
    }))
    const ids = new Set<string>()
    for (const track of project.tracks) for (const plugin of track.plugins) ids.add(plugin.pluginId)
    for (const plugin of project.masterPlugins) ids.add(plugin.pluginId)
    await Promise.all([...ids].map((id) => loadModule(id)))
    const processors = await loadProcessors()
    await processors.preloadWasmInserts()
    const scale = tuneBlockScale(project.scale)
    const graph = await renderGraphParallel({
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
      create: (pluginId, sampleRate) => processors.createProcessor(pluginId, sampleRate) ?? peekModule(pluginId)?.create(sampleRate) ?? passthrough(),
    })
    return encodeWav(holdFullScale(graph.master), rate, { dither: fileDither(project, 16, 'tpdf') })
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

  private scheduleCountClicks(startAt: number, tempo: number, signature: { numerator: number; denominator: number }, bars = 1) {
    if (!this.ctx) return
    const beatSec = samplesPerBeatUnit(this.sampleRate, tempo, signature) / this.sampleRate
    const perBar = Math.max(1, signature.numerator)
    const total = perBar * (bars === 2 ? 2 : 1)
    for (let i = 0; i < total; i++) {
      const when = startAt - (total - i) * beatSec
      if (when >= this.ctx.currentTime - 0.02) this.click(when, i % perBar === 0, true)
    }
  }

  /** Play the count-in and resolve at the downbeat. Stop during the wait resolves false. */
  private async holdForDownbeat(downbeatPerf: number, tempo: number, signature: { numerator: number; denominator: number }, bars = 1) {
    await this.resume()
    this.refreshClockAnchor()
    const ctx = this.ctx!
    const startAt = Math.max(this.contextForPerf(downbeatPerf), ctx.currentTime + 0.02)
    this.scheduleCountClicks(startAt, tempo, signature, bars)
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
    const perBar = Math.max(1, meter.numerator)
    const beats = perBar * (countInBarsOf(project) === 2 ? 2 : 1)
    const start = ctx.currentTime + 0.06
    for (let i = 0; i < beats; i++) this.click(start + i * beatSec, i % perBar === 0, true)
    this.status = 'counting-in'
    this.emit()
    const runAt = start + beats * beatSec
    await new Promise<void>((resolve) => {
      this.countWait = resolve
      this.countTimer = window.setTimeout(() => {
        this.countWait = null
        resolve()
      }, Math.max(0, (runAt - ctx.currentTime) * 1000))
    })
    if (this.status !== 'counting-in') return
    done()
  }

  private armTransport(startAt: number, fromSample: number) {
    this.playing = true
    this.playOriginCtx = startAt
    this.playOriginSample = fromSample
    this.positionSamples = fromSample
    this.sessionStarted.clear()
    this.nextLoopCtx = null
    this.schedulerGapSec = 0
    this.lastWakeCtx = 0
    this.schedulerSkips = 0
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
      this.wakeTransport()
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

  /**
   * One scheduler wake. Notes are placed on the audio clock, finished voices leave the graph,
   * and the playhead is pulled from that same clock so the two cannot drift apart.
   */
  wakeTransport() {
    const now = this.ctx?.currentTime
    if (now != null) {
      if (this.lastWakeCtx > 0) this.schedulerGapSec = Math.max(this.schedulerGapSec, now - this.lastWakeCtx)
      this.lastWakeCtx = now
    }
    this.scheduleAhead()
    if (this.playing && this.ctx) this.positionSamples = this.heardSample(this.currentTimelineSample())
  }

  /** Counts kept for the stress tests. Playback does not read this. */
  stability() {
    return {
      sources: this.sources.length,
      padVoices: this.padVoices.length,
      oneShots: this.oneShots.length,
      drumTrims: this.drumTrims.size,
      chains: this.chains.size,
      strips: this.strips.size,
      liveBuiltins: this.liveBuiltins.length,
      reaped: this.reaped,
      schedulerSkips: this.schedulerSkips,
      schedulerGapSec: this.schedulerGapSec,
      commandEpoch: this.commandEpoch,
      playing: this.playing,
      heldPlaying: this.heldPlaying,
      recorders: this.recorders.size,
      pendingRecorders: this.pendingRecorders.length,
    }
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
      this.reapSources()
      this.applyLoopAudio()
      if (this.pendingSchedule) this.pendingSchedule = false
      if (!this.ctx) return
      const now = this.ctx.currentTime
      const horizon = now + SCHEDULER_HORIZON_SEC
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

  private click(when: number, accent: boolean, countIn = false) {
    if (!this.ctx || !this.metroGain) return
    const voice = clickVoice(accent, countIn)
    const at = Math.max(when, this.ctx.currentTime)
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.type = voice.type
    osc.frequency.setValueAtTime(voice.frequency, at)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, voice.peak), at + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.045)
    let tail: AudioNode = osc
    if (voice.lowpass != null) {
      const filter = this.ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(voice.lowpass, at)
      filter.Q.setValueAtTime(0.7, at)
      osc.connect(filter)
      tail = filter
    }
    tail.connect(gain)
    gain.connect(this.metroGain)
    osc.start(at)
    osc.stop(at + 0.05)
    const chain: AudioNode[] = [osc, gain]
    if (tail !== osc) chain.push(tail)
    this.holdVoice(at + 0.08, chain)
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
    this.joining = true
    this.stopSources(now)
    this.playOriginCtx = now
    this.playOriginSample = sample
    this.positionSamples = sample
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

  /** Samples to schedule on this pass. Never more than the horizon, and never past `remain`. */
  private horizonSamples(remain: number) {
    const cap = Math.max(1, Math.ceil(SCHEDULER_HORIZON_SEC * this.sampleRate))
    if (!(remain > 0)) return 0
    return Math.min(remain, cap)
  }

  /**
   * A stalled wake used to schedule every missed cycle on the main thread.
   * Jump the cursor to now instead, and count it so the stress test can see the gap.
   */
  private realignCursor(mode: 'loop' | 'pattern' | 'linear', cycleSamples: number) {
    const ctx = this.ctx
    const project = this.project
    if (!ctx || !project || this.nextLoopCtx == null) return
    const cycleSec = Math.max(cycleSamples, 1) / this.sampleRate
    const moved = advanceLoopCursor(this.nextLoopCtx, ctx.currentTime, cycleSec)
    if (!moved.jumped) return
    this.schedulerSkips += 1
    this.nextLoopCtx = moved.cursor
    const linear = Math.max(0, this.sampleAt(ctx.currentTime))
    if (mode === 'pattern') {
      const cycle = Math.max(1, cycleSamples)
      this.nextLoopSample = ((Math.round(linear) % cycle) + cycle) % cycle
    } else if (mode === 'loop') {
      this.nextLoopSample = Math.round(transportSample(linear, project))
    } else {
      this.nextLoopSample = Math.min(arrangementEndSample(project), Math.round(linear))
    }
  }

  private scheduleArrangement(horizon: number) {
    const project = this.project!
    const patternLoop = this.status === 'recording' ? 0 : emptyPatternLoopSamples(project)
    if (patternLoop > 16) {
      if (this.nextLoopCtx == null) {
        this.nextLoopCtx = this.playOriginCtx
        this.nextLoopSample = ((this.playOriginSample % patternLoop) + patternLoop) % patternLoop
      }
      this.realignCursor('pattern', patternLoop)
      let passes = 0
      while (this.nextLoopCtx != null && this.nextLoopCtx < horizon && passes < MAX_SCHEDULE_PASSES) {
        if (this.nextLoopSample >= patternLoop) {
          this.nextLoopSample = 0
          continue
        }
        const samples = this.horizonSamples(patternLoop - this.nextLoopSample)
        if (!(samples > 0)) break
        const started = this.nextLoopSample
        this.scheduleWindow(this.nextLoopCtx, started, started + samples)
        this.nextLoopCtx += samples / this.sampleRate
        this.nextLoopSample = nextTimelineSample(started, samples, patternLoop, 0)
        passes += 1
      }
      return
    }
    const end = arrangementEndSample(project)
    const cycleWhileRecording = this.status === 'recording' && project.record?.loop
    if (!project.loopEnabled || (this.status === 'recording' && !cycleWhileRecording)) {
      if (this.nextLoopCtx == null) {
        this.nextLoopCtx = this.playOriginCtx
        this.nextLoopSample = this.playOriginSample
      }
      this.realignCursor('linear', Math.ceil(SCHEDULER_HORIZON_SEC * this.sampleRate))
      let passes = 0
      while (this.nextLoopCtx != null && this.nextLoopCtx < horizon && this.nextLoopSample < end && passes < MAX_SCHEDULE_PASSES) {
        const samples = this.horizonSamples(end - this.nextLoopSample)
        if (!(samples > 0)) break
        this.scheduleWindow(this.nextLoopCtx, this.nextLoopSample, this.nextLoopSample + samples)
        this.nextLoopCtx += samples / this.sampleRate
        this.nextLoopSample += samples
        passes += 1
      }
      return
    }
    const loopLen = project.loopEndSample - project.loopStartSample
    if (loopLen < 16) return
    if (this.nextLoopCtx == null) {
      this.nextLoopCtx = this.playOriginCtx
      this.nextLoopSample = this.playOriginSample
    }
    this.realignCursor('loop', loopLen)
    let passes = 0
    while (this.nextLoopCtx != null && this.nextLoopCtx < horizon && passes < MAX_SCHEDULE_PASSES) {
      if (this.nextLoopSample >= project.loopEndSample) {
        this.nextLoopSample = project.loopStartSample
        continue
      }
      const samples = this.horizonSamples(project.loopEndSample - this.nextLoopSample)
      if (!(samples > 0)) break
      const when = this.nextLoopCtx
      const started = this.nextLoopSample
      this.scheduleWindow(when, started, started + samples)
      this.loopQueuedUntil = started + samples
      this.loopQueuedCtx = when + samples / this.sampleRate
      this.nextLoopCtx += samples / this.sampleRate
      this.nextLoopSample = nextTimelineSample(started, samples, project.loopEndSample, project.loopStartSample)
      passes += 1
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
        const looping = clipLoops(audio)
        if (looping && playRate === 1 && playBuffer.length > 32) {
          const startFrame = Math.max(0, Math.round(offset * playBuffer.sampleRate))
          const endFrame = Math.min(playBuffer.length, Math.round((offset + dur) * playBuffer.sampleRate))
          const faded = this.ctx.createBuffer(playBuffer.numberOfChannels, playBuffer.length, playBuffer.sampleRate)
          for (let channel = 0; channel < playBuffer.numberOfChannels; channel++) {
            faded.copyToChannel(crossfadeLoopRegion(playBuffer.getChannelData(channel), startFrame, endFrame, 128), channel)
          }
          playBuffer = faded
        }
        src.buffer = playBuffer
        src.playbackRate.value = playRate
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
        const playDur = playRate === 1 ? dur : dur / rate
        if (looping) src.start(startWhen, offset)
        else src.start(startWhen, offset, playDur)
        this.trackNodes(trackId, {
          endAt: looping ? undefined : startWhen + playDur + 0.08,
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
        loopTimer: true,
        endAt: nextWhen + 0.05,
        stop: (at?: number) => {
          const kill = () => window.clearTimeout(timer)
          const now = this.ctx?.currentTime ?? 0
          if (at != null && at > now + 0.005) window.setTimeout(kill, (at - now) * 1000)
          else kill()
        },
        disconnect: () => undefined,
      }
      if (retiredHere && retired) retired.nodes.push(node)
      else {
        const previous = this.sessionNodes.get(track.id) || []
        const stale = new Set(previous.filter((item) => item.loopTimer))
        const list = previous.filter((item) => !item.loopTimer)
        list.push(node)
        this.sessionNodes.set(track.id, list)
        if (stale.size) this.sources = this.sources.filter((item) => !stale.has(item))
        this.sources.push(node)
      }
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
    const handoff = this.joining
    if (!project || !ctx) return
    this.scheduleStepSequencers(ctx, project, ctxTime, timelineStart, timelineEnd)
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
            if (span.start < timelineStart || span.start >= timelineEnd) continue
            const rawWhen = ctxTime + (span.start - timelineStart) / this.sampleRate
            const when = ctx === this.ctx ? placeNoteTime(rawWhen, ctx.currentTime) : rawWhen
            if (when == null) continue
            this.scheduleVoice(ctx, strip, note, when, span.duration / this.sampleRate, group.voice)
          }
        }
      }
      this.schedulePatternClips(ctx, strip, project, track.id, ctxTime, timelineStart, timelineEnd)
    }
    if (handoff) this.joining = false
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
      if (clip.scene != null || clip.suppressed) continue
      if (clip.id === 'live-pattern') continue
      if (stepPatternOwner(project, clip.patternId)) continue
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
        const routed = dest ? this.strips.get(dest) : this.ownedStrip(ctx)
        const liveStrip = ctx === this.ctx && hit.output ? this.strips.get(hit.output) : undefined
        const bus = liveStrip || routed || strip
        if (!bus) continue
        this.scheduleHit(ctx, bus, hit, when, span.duration / this.sampleRate)
      }
    }
  }

  private scheduleHit(ctx: BaseAudioContext, strip: StripNodes, hit: RenderedHit, when: number, durationSec?: number) {
    const live = ctx === this.ctx
    const level = Math.max(0, hit.volume ?? 1)
    if (!live && level <= 0.0001) return
    if (live && when < ctx.currentTime - 0.05) return
    if (live && when < ctx.currentTime) when = ctx.currentTime + 0.001
    const dur = durationSec ?? Math.max(0.04, beatsToSamples(hit.durationBeats, this.sampleRate, this.project?.tempo || 120) / this.sampleRate)
    const routed = live && hit.output != null
    const mix = routed ? this.drumMix(hit.channelId) : null
    const shaped = mix ? { ...hit, volume: 1, pan: Math.max(-1, Math.min(1, (hit.pan || 0) - mix.pan)) } : hit
    const into = routed ? this.throughDrum(hit.channelId, strip.input) : strip.input
    if (hit.sampleId) {
      const asset = this.assetOf(hit.sampleId)
      if (asset) {
        const buffer = this.bufferFromAsset(ctx, asset)
        const src = ctx.createBufferSource()
        src.buffer = buffer
        const rate = 2 ** ((hit.pitch - 60 + hit.fine / 100) / 12)
        src.playbackRate.value = rate
        this.envelope(ctx, strip, src, when, Math.max(0.05, dur), shaped, undefined, into)
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
      osc.frequency.exponentialRampToValueAtTime(48, when + Math.max(0.02, Math.min(0.18, dur)))
      this.envelope(ctx, strip, osc, when, Math.min(0.28, dur + 0.05), shaped, undefined, into)
      return
    }
    if (hit.kind === 'perc') {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = 440 * 2 ** ((hit.pitch - 69) / 12)
      this.envelope(ctx, strip, osc, when, Math.min(0.16, dur), shaped, undefined, into)
      return
    }
    if (hit.kind === 'openhat' || hit.kind === 'tom' || hit.kind === 'cymbal') {
      if (this.playResidentDrum(ctx, strip, shaped, when, into)) return
      if (hit.kind === 'tom') {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        const freq = Math.max(70, 80 * 2 ** ((hit.pitch - 36) / 24))
        osc.frequency.setValueAtTime(freq * 1.4, when)
        osc.frequency.exponentialRampToValueAtTime(Math.max(45, freq), when + 0.18)
        this.envelope(ctx, strip, osc, when, Math.min(0.35, Math.max(0.12, dur * 2)), shaped, undefined, into)
        return
      }
      const ring = ctx.createBufferSource()
      ring.buffer = this.noiseBuffer(ctx)
      const filter = ctx.createBiquadFilter()
      filter.type = 'highpass'
      filter.frequency.value = hit.kind === 'cymbal' ? 5000 : 6500
      ring.connect(filter)
      this.envelope(ctx, strip, filter, when, hit.kind === 'cymbal' ? 0.7 : 0.5, shaped, ring, into)
      return
    }
    const noise = ctx.createBufferSource()
    noise.buffer = this.noiseBuffer(ctx)
    if (hit.kind === 'hat') {
      const filter = ctx.createBiquadFilter()
      filter.type = 'highpass'
      filter.frequency.value = 7000
      noise.connect(filter)
      this.envelope(ctx, strip, filter, when, Math.min(0.06, dur), shaped, noise, into)
      return
    }
    if (hit.kind === 'clap') {
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = 1400
      noise.connect(filter)
      this.envelope(ctx, strip, filter, when, Math.min(0.18, dur), shaped, noise, into)
      return
    }
    const tone = ctx.createOscillator()
    tone.type = 'triangle'
    tone.frequency.value = 190
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 800
    noise.connect(filter)
    this.envelope(ctx, strip, filter, when, Math.min(0.16, dur), shaped, noise, into)
    this.envelope(ctx, strip, tone, when, 0.08, { ...shaped, velocity: shaped.velocity * 0.4 }, undefined, into)
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
  private playResidentDrum(ctx: BaseAudioContext, strip: StripNodes, hit: RenderedHit, when: number, into?: AudioNode) {
    const buffer = this.cachedDrum(ctx, hit.pitch)
    if (!buffer) return false
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    const peak = Math.max(0.001, 0.22 * hit.velocity * Math.max(0, hit.volume ?? 1))
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.003)
    src.connect(gain)
    const panNodes = connectNotePan(ctx, gain, into ?? strip.input, hit.pan || 0)
    const gate = Math.max(0.08, Math.min(1, (hit.durationBeats || 0.2) / 0.2))
    src.start(when)
    const end = when + Math.max(0.05, buffer.duration * gate)
    src.stop(end)
    if (ctx === this.ctx) this.holdVoice(end + 0.03, [src, gain, ...panNodes])
    return true
  }

  private playDrum(ctx: BaseAudioContext, strip: StripNodes, note: MidiNote, when: number, bucket?: Stoppable[]) {
    const buffer = this.cachedDrum(ctx, note.pitch)
    if (!buffer) return false
    if (ctx === this.ctx && when < ctx.currentTime - 0.05) return true
    const start = ctx === this.ctx ? Math.max(when, ctx.currentTime) : Math.max(0, when)
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    const peak = drumLevel(note.velocity)
    const tune = (note.fine || 0) / 100
    if (tune) src.playbackRate.value = 2 ** tune
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(peak, start + ATTACK_SEC)
    src.connect(gain)
    gain.connect(strip.input)
    src.start(start)
    src.stop(start + buffer.duration)
    if (ctx === this.ctx) {
      const entry = this.holdVoice(start + buffer.duration + 0.03, [src, gain])
      bucket?.push(entry)
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
    into?: AudioNode,
  ) {
    const gain = ctx.createGain()
    const peak = Math.max(0.001, 0.22 * hit.velocity * Math.max(0, hit.volume ?? 1))
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.03, dur))
    source.connect(gain)
    const panNodes = connectNotePan(ctx, gain, into ?? strip.input, hit.pan || 0)
    const startable = source as AudioScheduledSourceNode
    const end = when + dur + 0.02
    if (typeof startable.start === 'function') {
      startable.start(when)
      startable.stop(end)
    }
    extra && typeof (extra as AudioScheduledSourceNode).start === 'function' && (extra as AudioScheduledSourceNode).start(when)
    extra && typeof (extra as AudioScheduledSourceNode).stop === 'function' && (extra as AudioScheduledSourceNode).stop(end)
    if (ctx === this.ctx) {
      const chain: AudioNode[] = [source, gain, ...panNodes]
      if (extra && extra !== source) chain.push(extra)
      this.holdVoice(end + 0.03, chain)
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
    const live = ctx === this.ctx
    if (live && when < ctx.currentTime - LATE_SLIP_SEC) return
    const slip = live ? Math.max(0, ctx.currentTime - when) : 0
    const at = Math.max(0, when + slip)
    const dur = (to - from) / sr
    const playDur = dur - slip
    if (playDur * sr < 8) return
    const offset = (clip.offsetSamples + (from - clip.startSample)) / buffer.sampleRate + slip
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const gain = ctx.createGain()
    const relFrom = (from - clip.startSample) / sr + slip
    const relTo = (to - clip.startSample) / sr
    const clipDur = clip.durationSamples / sr
    const fadeIn = clip.fadeInSamples / sr
    const fadeOut = clip.fadeOutSamples / sr
    const join = this.joining && from <= timelineStart + 8
    const points = clipSliceEnvelope({
      at,
      dur: playDur,
      relFrom,
      relTo,
      clipGain: clip.gain,
      fadeInSec: fadeIn,
      fadeOutSec: fadeOut,
      clipDurSec: clipDur,
      join,
    })
    const [first, ...rest] = points
    if (first) gain.gain.setValueAtTime(first.value, first.at)
    for (const point of rest) gain.gain.linearRampToValueAtTime(point.value, point.at)
    src.connect(gain)
    gain.connect(strip.input)
    src.start(at, Math.max(0, offset), playDur)
    if (live) {
      this.sources.push({
        endAt: at + playDur + 0.05,
        stop: (whenStop?: number) => {
          try { src.stop(whenStop) } catch { /* already stopped */ }
        },
        disconnect: () => {
          try { src.disconnect() } catch { /* already disconnected */ }
          try { gain.disconnect() } catch { /* already disconnected */ }
        },
        release: (at: number) => {
          const start = Math.max(ctx.currentTime, at - 0.008)
          try {
            gain.gain.cancelScheduledValues(start)
            gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), start)
            gain.gain.linearRampToValueAtTime(0.0001, at + 0.008)
            src.stop(at + 0.012)
          } catch { /* already stopped */ }
        },
      })
    }
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
    return monitoringOffset(output, base, loop) + this.safetyLatencySeconds()
  }

  clockCompensation() {
    const outputLatency = this.ctx?.outputLatency || 0
    const baseLatency = this.ctx?.baseLatency || 0
    const loop = this.loopbackMs == null ? null : this.loopbackMs / 1000
    return { outputLatency, baseLatency, calibrationSec: calibrationTrim(outputLatency, baseLatency, loop) + this.safetyLatencySeconds() }
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
    const outputMs = ((this.ctx?.outputLatency || 0) + (this.ctx?.baseLatency || 0)) * 1000 + this.safetyLatencySeconds() * 1000
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

  /** The open Pads faceplate. Null returns hits to the selected track. */
  setPadRoute(trackId: string | null) {
    this.padRouteId = trackId
    this.parkLive(trackId || this.liveTrackId)
  }

  /** Keep live keys and drums inside the selected track's fader, mute, and inserts. */
  followTrack(trackId: string | null) {
    if (this.padRouteId) {
      this.parkLive(this.padRouteId)
      return
    }
    if (trackId && this.project?.tracks.some((track) => track.id === trackId)) this.liveTrackId = trackId
    else if (!trackId) this.liveTrackId = null
    this.parkLive(this.liveTrackId)
  }

  private ownedStrip(ctx: BaseAudioContext): StripNodes | null {
    const id = this.padRouteId || this.liveTrackId || this.project?.tracks.find((track) => this.strips.has(track.id))?.id
    const strip = id ? this.strips.get(id) : undefined
    if (strip) return strip
    return ctx === this.ctx ? this.patternStrip : this.masterStrip
  }

  /** Move the shared live bus onto a track input. Sources already plugged into the bus follow. */
  private parkLive(trackId?: string | null) {
    const bus = this.liveBus
    if (!bus) return
    const id = trackId || this.padRouteId || this.liveTrackId || this.project?.tracks.find((track) => this.strips.has(track.id))?.id || null
    const dest = id ? this.strips.get(id)?.input ?? null : null
    if (!dest || dest === this.liveParked) return
    try { bus.disconnect() } catch { /* the bus was only connected inside buildMaster */ }
    bus.connect(dest)
    this.liveParked = dest
    bus.gain.value = 1
  }

  private notePad(pitch: number, velocity: number, when: number) {
    this.heardPads.push({ pitch, velocity, when })
    if (this.heardPads.length > 64) this.heardPads.splice(0, this.heardPads.length - 64)
  }

  private playLivePad(pitch: number, velocity: number, sample: Float32Array | null, color?: PadColor, when?: number): boolean {
    if (!this.padRouteId) return false
    const track = this.project?.tracks.find((item) => item.id === this.padRouteId)
    if (!track || track.instrument !== 'pads') return false
    const ctx = this.unlock()
    const strip = track.id ? this.strips.get(track.id) : undefined
    if (!ctx || !strip) return false
    this.markMidi(track.id, when, 0.2)
    const kit = normalizePadKit(track.padKit)
    const pad = kit.banks.flat().find((item) => item.pitch === pitch)
    const route = hitRoute(kit, pad ?? { muted: false })
    const at = when ?? ctx.currentTime
    if (route.audio) {
      this.playPadNote(ctx, strip, track, {
        pitch,
        velocity,
        tune: color?.tune,
        filter: color?.filter,
        decay: color?.decay,
      }, at, undefined, sample)
      for (const extra of pad?.chord ?? []) {
        if (extra !== pitch) this.playPadNote(ctx, strip, track, { pitch: extra, velocity, tune: color?.tune, filter: color?.filter, decay: color?.decay }, at, undefined, null)
      }
    }
    if (route.midi) {
      this.sendLiveMidi(pitch, velocity)
      for (const extra of pad?.chord ?? []) if (extra !== pitch) this.sendLiveMidi(extra, velocity)
      this.forwardMpc(track, pitch, velocity, at)
    }
    return true
  }

  /** Drive another instrument from a pad. The routed call does not bounce back. */
  private forwardMpc(track: Track, pitch: number, velocity: number, when: number) {
    const targetId = track.padKit?.midiTrackId
    if (!targetId || targetId === track.id || !this.ctx) return
    const other = this.project?.tracks.find((item) => item.id === targetId && item.type === 'midi')
    const strip = other ? this.strips.get(other.id) : undefined
    if (!other || !strip) return
    this.scheduleVoice(this.ctx, strip, { id: 'mpc', pitch, startBeat: 0, durationBeats: 0.25, velocity }, when, 0.25, other, undefined, true)
  }

  private playPadNote(
    ctx: BaseAudioContext,
    strip: StripNodes,
    track: Track,
    hit: { pitch: number; velocity: number; tune?: number; filter?: number; decay?: number; attack?: number; pan?: number },
    when: number,
    bucket: Stoppable[] | undefined,
    sample: Float32Array | null | undefined,
  ) {
    const pads = track.padKit?.banks.flat() ?? []
    const pad = pads.find((item) => item.pitch === hit.pitch)
    if (pad?.muted) return
    const route = hitRoute(normalizePadKit(track.padKit), pad ?? { muted: false })
    const bus = route.busId && this.strips.has(route.busId) ? this.strips.get(route.busId) : undefined
    const dest = bus?.input ?? strip.input
    const start = ctx === this.ctx ? Math.max(when, ctx.currentTime) : Math.max(0, when)
    if (this.ctx && ctx === this.ctx && this.padHost.hit(this.ctx, track, dest, this.assetOf, this.project?.tempo || 120, {
      pitch: hit.pitch,
      velocity: hit.velocity,
      time: start,
      tune: hit.tune,
      filter: hit.filter,
    })) {
      for (const other of chokeTargets(pads.map((item) => ({ pitch: item.pitch, choke: item.choke })), hit.pitch)) this.fadePadPitch(other, start)
      if (pad?.poly === 'mono') this.fadePadPitch(hit.pitch, start)
      this.notePad(hit.pitch, hit.velocity, start)
      return
    }
    for (const other of chokeTargets(pads.map((item) => ({ pitch: item.pitch, choke: item.choke })), hit.pitch)) this.fadePadPitch(other, start)
    if (pad?.poly === 'mono') this.fadePadPitch(hit.pitch, start)
    const layer = pad?.layers.find((item) => item.bufferId) ?? pad?.layers[0]
    const kit = normalizePadKit(track.padKit)
    const voiced = pad
      ? {
        ...pad,
        tune: hit.tune ?? pad.tune,
        filter: hit.filter ?? pad.filter,
        decay: hit.decay ?? pad.decay,
        attack: hit.attack ?? pad.attack,
      }
      : null
    const buffers = new Map<string, { sampleRate: number; samples: Float32Array }>()
    for (const item of kit.banks.flat()) {
      const id = (item.layers.find((entry) => entry.bufferId) ?? item.layers[0])?.bufferId
      const asset = id ? this.assetOf(id) : undefined
      const channel = asset?.channels[0]
      if (id && asset && channel?.length) buffers.set(id, { sampleRate: asset.sampleRate, samples: channel })
    }
    if (sample?.length && layer?.bufferId && !buffers.has(layer.bufferId)) {
      buffers.set(layer.bufferId, { sampleRate: ctx.sampleRate, samples: sample })
    }
    const baked = voiced
      ? renderPadVoice({
        sampleRate: ctx.sampleRate,
        tempo: this.project?.tempo || 120,
        pad: voiced,
        buffers,
        vintage: kit.vintage,
        chop: kit.chop,
        velocity: 1,
        resident: (this.drumTable.length ? this.drumTable : residentDrums(ctx.sampleRate)).map((drum) => ({
          pitch: drum.pitch,
          samples: drum.samples,
          sampleRate: ctx.sampleRate,
        })),
      }).left
      : null
    const region = padRegion(pad)
    const buffer = voiced && baked?.length
      ? this.cachedPadBuffer(ctx, bakedKey(voiced, kit), baked, ctx.sampleRate)
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
    const tune = (hit.tune ?? pad?.tune ?? 0) + (layer?.tune ?? 0)
    src.playbackRate.value = baked?.length ? 1 : 2 ** (tune / 12)
    if (!baked?.length && region.loop && buffer.duration > 0.02) {
      const span = Math.max(0.0001, region.end - region.start)
      const loopStart = Math.max(0, Math.min(0.98, (region.loopStart - region.start) / span))
      const loopEnd = Math.max(loopStart + 0.01, Math.min(1, (region.loopEnd - region.start) / span))
      src.loop = true
      src.loopStart = buffer.duration * loopStart
      src.loopEnd = Math.min(buffer.duration, Math.max(src.loopStart + 0.01, buffer.duration * loopEnd))
    }
    const decay = baked?.length ? 1 : Math.max(0.05, Math.min(1, hit.decay ?? pad?.decay ?? 1))
    const peak = Math.max(0.0002, Math.min(1, hit.velocity))
    const dur = Math.max(0.04, buffer.duration * decay)
    const attack = Math.min(0.003, dur * 0.25)
    gain.gain.setValueAtTime(0.0001, start)
    if (dur > attack + 0.008) {
      gain.gain.exponentialRampToValueAtTime(peak, start + attack)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
    } else {
      gain.gain.linearRampToValueAtTime(peak, start + dur * 0.4)
      gain.gain.linearRampToValueAtTime(0.0001, start + dur)
    }
    const level = ctx.createGain()
    level.gain.value = pad?.muted ? 0 : (pad?.level ?? 1)
    const filterAmount = hit.filter ?? pad?.filter ?? 1
    let node: AudioNode = gain
    src.connect(gain)
    if (!baked?.length && filterAmount < 0.98) {
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(Math.max(80, 180 + filterAmount * 8000), start)
      gain.connect(filter)
      node = filter
    }
    node.connect(level)
    const panner = ctx.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, hit.pan ?? pad?.pan ?? 0))
    level.connect(panner)
    panner.connect(dest)
    const chain: AudioNode[] = [src, gain, level, panner]
    if (node !== gain) chain.push(node)
    for (const send of track.sends ?? []) {
      const amount = padSendGain(pad?.send ?? 0, send.gain, send.enabled)
      if (amount <= 0.0001) continue
      const bus = this.strips.get(send.busId)
      if (!bus) continue
      const tap = ctx.createGain()
      tap.gain.value = amount
      panner.connect(tap)
      tap.connect(bus.input)
      chain.push(tap)
    }
    const stop = (at?: number) => {
      try { src.stop(at) } catch { /* already stopped */ }
    }
    const end = start + dur + 0.01
    src.start(start)
    src.stop(end)
    this.notePad(hit.pitch, hit.velocity, start)
    const voice = { pitch: hit.pitch, trackId: track.id, gain, level, pan: panner, stop, born: start, until: start + dur, src }
    this.padVoices.push(voice)
    const releaseChain = () => {
      this.padVoices = this.padVoices.filter((item) => item.src !== src)
      for (const item of chain) {
        try { item.disconnect() } catch { /* already disconnected */ }
      }
    }
    src.onended = releaseChain
    if (ctx === this.ctx) {
      const entry = this.holdVoice(end + 0.04, chain)
      bucket?.push(entry)
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

  liveDrum(pitch: number, velocity: number, repeatEverySamples = 0, color?: PadColor, when?: number) {
    if (this.playLivePad(pitch, velocity, null, color, when)) return
    const ctx = this.ctx ?? this.unlock()
    const at = when ?? liveWhen(ctx.currentTime)
    const trackId = this.liveTrackId || 'drums'
    if (!this.acceptLive(trackId, pitch, at)) return
    if (!this.drumTable.length) this.drumTable = residentDrums(ctx.sampleRate)
    const index = this.drumTable.findIndex((drum) => drum.pitch === pitch)
    const strip = this.liveTrackId ? this.strips.get(this.liveTrackId) : undefined
    this.parkLive(this.liveTrackId)
    const dest = strip?.input ?? this.liveBus
    if (index >= 0 && dest && this.playResident(index, velocity, color, at, dest)) return
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
    const peak = drumLevel(velocity)
    src.connect(filter)
    filter.connect(gain)
    this.parkLive(this.padRouteId || this.liveTrackId)
    const into = this.liveBus ?? this.masterStrip?.input
    if (!into) return
    gain.connect(into)
    const decay = color?.decay == null ? 1 : Math.max(0.05, color.decay)
    const startAt = when ?? ctx.currentTime
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.004)
    const stopAt = startAt + buffer.duration * decay
    gain.gain.setValueAtTime(peak, Math.max(startAt + 0.006, stopAt - 0.012))
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
    const stop = () => fadeSource(ctx, gain, src)
    this.oneShots.push({ pitch, when: startAt, stop })
    const end = startAt + buffer.duration * decay + 0.02
    src.onended = () => {
      this.oneShots = this.oneShots.filter((shot) => shot.stop !== stop)
      try { src.disconnect() } catch { /* already disconnected */ }
      try { filter.disconnect() } catch { /* already disconnected */ }
      try { gain.disconnect() } catch { /* already disconnected */ }
    }
    src.start(startAt)
    src.stop(end)
    this.holdVoice(end + 0.04, [src, filter, gain])
  }

  liveGain(pitch: number, velocity: number) {
    if (!this.keysNode) return
    this.keysNode.port.postMessage({ type: 'gain', pitch, velocity: Math.max(0.05, Math.min(1, velocity)) })
  }

  private playResident(index: number, velocity: number, color?: PadColor, when?: number, dest?: AudioNode) {
    const ctx = this.ctx
    const buffer = this.drumBuffers[index]
    const out = dest ?? this.liveBus
    if (!ctx || !buffer || !out) return false
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    src.playbackRate.value = 2 ** ((color?.tune || 0) / 12)
    const peak = drumLevel(velocity)
    src.connect(gain)
    gain.connect(out)
    const decay = color?.decay == null ? 1 : Math.max(0.05, color.decay)
    const startAt = when == null ? ctx.currentTime : Math.max(when, ctx.currentTime)
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + ATTACK_SEC)
    const stopAt = startAt + buffer.duration * decay
    gain.gain.setValueAtTime(peak, Math.max(startAt + 0.006, stopAt - 0.012))
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
    const stop = () => fadeSource(ctx, gain, src)
    this.oneShots.push({ pitch: this.drumTable[index]?.pitch ?? -1, when: startAt, stop })
    const end = startAt + buffer.duration * decay + 0.02
    src.onended = () => {
      this.oneShots = this.oneShots.filter((shot) => shot.stop !== stop)
      try { src.disconnect() } catch { /* already disconnected */ }
      try { gain.disconnect() } catch { /* already disconnected */ }
    }
    src.start(startAt)
    src.stop(end)
    this.holdVoice(end + 0.04, [src, gain])
    return true
  }

  /** The same voice a pad hit uses, including the kit sample, tune, and level. */
  triggerPad(trackId: string, pitch: number, velocity: number) {
    this.markMidi(trackId, undefined, 0.22)
    const savedRoute = this.padRouteId
    const savedLive = this.liveTrackId
    this.padRouteId = trackId
    this.liveTrackId = trackId
    const played = this.playLivePad(pitch, velocity, null)
    if (!played) this.liveDrum(pitch, velocity)
    this.padRouteId = savedRoute
    this.liveTrackId = savedLive
  }

  /**
   * Monitor one track through its MIDI effect chain, then the instrument.
   * `shaped` is set when Scaler already turned the key into notes, so this call plays the sound and does not enter Scaler again.
   */
  playThrough(trackId: string, pitch: number, velocity: number, fine = 0, shaped = false, surface: NoteSurface = 'keyboard') {
    const library = this.project?.tracks.find((item) => item.id === trackId)
    if (library?.instrument === 'library' && library.library) {
      this.voiceNote(surface, trackId, pitch, velocity)
      return
    }
    if (!shaped && this.project) {
      const plan = planLive(this.project, trackId, pitch, velocity)
      if (plan) {
        if (plan.output !== 'midi') {
          for (const note of plan.play) this.playThrough(note.trackId, note.pitch, note.velocity, note.fine ?? 0, true)
        }
        if (plan.output !== 'audio' && plan.play.length) {
          this.pulseMidi(plan.play.map((note) => ({ pitch: note.pitch, velocity: note.velocity, duration: 0.6 })))
        }
        return
      }
    }
    this.holdMidi(trackId, 1)
    const ctx = this.unlock()
    const when = liveWhen(ctx.currentTime)
    const track = this.project?.tracks.find((item) => item.id === trackId)
    if (samplerInsert(track)) {
      this.previewRack(trackId, pitch, false, true, velocity)
      return
    }
    if (track?.instrument === 'pads') {
      const strip = this.strips.get(trackId)
      const kit = normalizePadKit(track.padKit)
      const bank = kit.banks[Math.min(kit.banks.length - 1, Math.max(0, kit.activeBank || 0))] ?? []
      const played = padPitchForKey(bank, pitch)
      if (!strip || !this.acceptLive(trackId, played, when)) {
        this.holdMidi(trackId, -1)
        return
      }
      this.playPadNote(ctx, strip, track, { pitch: played, velocity, tune: fine / 100 }, when, undefined, null)
      return
    }
    if (track?.instrument === 'drum-machine') {
      if (!this.acceptLive(trackId, pitch, when)) {
        this.holdMidi(trackId, -1)
        return
      }
      const strip = this.strips.get(trackId)
      if (strip) this.playDrum(ctx, strip, { id: 'live', pitch, startBeat: 0, durationBeats: 0.25, velocity, fine }, when)
      return
    }
    if (track?.rack) {
      this.previewRack(trackId, pitch, false, true, velocity)
      return
    }
    if (!this.acceptLive(trackId, pitch, when)) {
      this.holdMidi(trackId, -1)
      return
    }
    const previous = this.liveTrackId
    this.liveTrackId = trackId
    const strip = track ? this.strips.get(track.id) : undefined
    if (strip) this.startBuiltin(ctx, strip, trackId, pitch, velocity, fine / 100)
    else this.liveNoteOn(pitch, velocity, -1, 0, fine ? { tune: fine / 100 } : undefined)
    this.liveTrackId = previous
  }

  releaseThrough(trackId: string, pitch: number, surface: NoteSurface = 'keyboard') {
    this.holdMidi(trackId, -1)
    this.clearLive(trackId, pitch)
    const when = this.ctx?.currentTime ?? 0
    this.stopBuiltin(`${trackId}:${Math.round(pitch)}`, when)
    const track = this.project?.tracks.find((item) => item.id === trackId)
    if (track?.instrument === 'library' && track.library) {
      this.voiceNote(surface, trackId, pitch, 0)
      return
    }
    if (samplerInsert(track) || (track?.rack && track.instrument !== 'drum-machine')) {
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

  private acceptLive(trackId: string, pitch: number, time: number) {
    const key = `${trackId}:${Math.round(pitch)}`
    const prev = this.liveOnAt.get(key)
    if (prev != null && time >= prev && time - prev < 0.008) return false
    this.liveOnAt.set(key, time)
    return true
  }

  private clearLive(trackId: string, pitch: number) {
    this.liveOnAt.delete(`${trackId}:${Math.round(pitch)}`)
  }

  private startBuiltin(ctx: AudioContext, strip: StripNodes, trackId: string, pitch: number, velocity: number, tune = 0) {
    const when = liveWhen(ctx.currentTime)
    const key = `${trackId}:${Math.round(pitch)}`
    this.stopBuiltin(key, when)
    while (this.liveBuiltins.length >= 16) {
      const oldest = this.liveBuiltins.shift()
      if (oldest) this.stopBuiltin(oldest.key, when)
    }
    const osc = ctx.createOscillator()
    const filter = ctx.createBiquadFilter()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(440 * 2 ** ((pitch + tune - 69) / 12), when)
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(2200, when)
    filter.frequency.exponentialRampToValueAtTime(900, when + 0.3)
    const peak = builtinLevel(velocity)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + ATTACK_SEC)
    osc.connect(filter)
    filter.connect(gain)
    gain.connect(strip.input)
    osc.start(when)
    const entry = this.holdVoice(Number.POSITIVE_INFINITY, [osc, filter, gain])
    this.liveBuiltins.push({ key, gain, src: osc, entry })
  }

  private stopBuiltin(key: string, when: number) {
    const keep: typeof this.liveBuiltins = []
    for (const voice of this.liveBuiltins) {
      if (voice.key !== key) {
        keep.push(voice)
        continue
      }
      try {
        voice.gain.gain.cancelScheduledValues(when)
        voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value || 0.0001), when)
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, when + RELEASE_SEC)
        voice.src.stop(when + RELEASE_SEC + 0.02)
      } catch { /* already stopped */ }
      voice.entry.endAt = when + RELEASE_SEC + 0.05
    }
    this.liveBuiltins = keep
  }

  private emitLive(pitch: number, velocity: number, drumIndex = -1, repeatEverySamples = 0, color?: PadColor) {
    this.markMidi(this.padRouteId || this.liveTrackId, undefined, repeatEverySamples > 0 ? 0.2 : 0.12)
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
    this.markMidi(this.padRouteId || this.liveTrackId, when, 0.14)
    if (this.playLivePad(pitch, velocity, null, color, when)) return
    if (!this.ctx) this.unlock()
    const ctx = this.ctx
    if (!ctx) return
    const level = Math.max(0.05, Math.min(1, velocity))
    if (!this.drumTable.length) this.drumTable = residentDrums(ctx.sampleRate)
    const index = this.drumTable.findIndex((drum) => drum.pitch === pitch)
    const strip = this.liveTrackId ? this.strips.get(this.liveTrackId) : undefined
    this.parkLive(this.padRouteId || this.liveTrackId)
    const dest = strip?.input ?? this.liveBus ?? undefined
    if (index >= 0 && dest && this.playResident(index, level, color, when, dest)) return
    this.warmNote(pitch, level, color?.tune || 0, when)
  }

  cancelPadHits(pitch: number, afterTime: number) {
    this.padHost.cancel(pitch, afterTime)
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
    this.padHost.duck(pitch, now)
    this.fadePadPitch(pitch, now)
    this.keysNode?.port.postMessage({ type: 'duck', pitch })
    for (const shot of this.oneShots) {
      if (shot.pitch === pitch && shot.when <= now + 0.005) shot.stop()
    }
    this.oneShots = this.oneShots.filter((shot) => !(shot.pitch === pitch && shot.when <= now + 0.005))
  }

  /**
   * End the hardware note for a drum one-shot.
   * The sample keeps ringing. liveNoteOff would also stop that buffer.
   */
  releaseMidi(pitch: number) {
    if (!this.midiSink) return
    this.midiSink(noteBytes(false, this.midiOutChannel, pitch, 0))
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
    const routed = this.padRouteId
    const liveId = this.liveTrackId
    const liveIsPads = liveId ? this.project?.tracks.some((track) => track.id === liveId && track.instrument === 'pads') : false
    this.padHost.release(routed || (liveIsPads ? liveId : null), pitch, this.ctx?.currentTime ?? 0)
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
    const level = builtinLevel(velocity)
    voice.gain.gain.cancelScheduledValues(at)
    voice.gain.gain.setValueAtTime(0.0001, at)
    voice.gain.gain.exponentialRampToValueAtTime(level, at + 0.004)
  }

  private attachKeys() {
    const ctx = this.ctx
    const out = this.liveBus ?? this.speakerGain
    if (!ctx || this.keysNode || !out) return
    if (!this.drumTable.length) this.drumTable = residentDrums(ctx.sampleRate)
    const node = new AudioWorkletNode(ctx, 'keys-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
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
    this.joining = true
    this.stopSources(now)
    this.sessionStarted.clear()
    this.nextLoopCtx = now
    this.nextLoopSample = sample
    this.loopQueuedUntil = 0
    this.loopQueuedCtx = 0
    this.scheduleAhead()
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
    if (when < ctx.currentTime - LATE_SLIP_SEC) return
    const slip = Math.max(0, ctx.currentTime - when)
    const at = when + slip
    const playFrom = from + Math.round(slip * sr)
    const playDur = (to - playFrom) / sr
    if (to - playFrom < 8) return
    const source = sourceSamplesOf(clip)
    const channels: Float32Array[] = []
    for (let index = 0; index < buffer.numberOfChannels; index++) {
      const data = buffer.getChannelData(index)
      channels.push(data.slice(clip.offsetSamples, clip.offsetSamples + source))
    }
    const node = new AudioWorkletNode(ctx, 'cueharbor-stretch')
    const gain = ctx.createGain()
    const relFrom = (playFrom - clip.startSample) / sr
    const relTo = (to - clip.startSample) / sr
    const clipDur = duration / sr
    const fadeIn = clip.fadeInSamples / sr
    const fadeOut = clip.fadeOutSamples / sr
    const points = clipSliceEnvelope({
      at,
      dur: playDur,
      relFrom,
      relTo,
      clipGain: clip.gain,
      fadeInSec: fadeIn,
      fadeOutSec: fadeOut,
      clipDurSec: clipDur,
      join: false,
    })
    const [first, ...rest] = points
    if (first) gain.gain.setValueAtTime(first.value, first.at)
    for (const point of rest) gain.gain.linearRampToValueAtTime(point.value, point.at)
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
      startFrame: Math.max(0, Math.round(at * sr)),
      skip: Math.max(0, playFrom - clip.startSample),
      frames: Math.max(1, to - playFrom),
    })
    this.sources.push({
      endAt: at + playDur + 0.05,
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
    const out = this.speakerSide()
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

  private previewClock: { start: number; duration: number; loop: boolean } | null = null

  stopPreview() {
    for (const src of this.previewStops) {
      try { src.stop() } catch { /* already stopped */ }
      try { src.disconnect() } catch { /* already disconnected */ }
    }
    this.previewStops = []
    this.previewClock = null
  }

  /** Playhead across the current preview, from the audio clock. Loops wrap. */
  previewHead(now?: number) {
    const clock = this.previewClock
    const ctx = this.ctx
    if (!clock || !ctx || !(clock.duration > 0)) return null
    const time = now ?? ctx.currentTime
    const elapsed = Math.max(0, time - clock.start)
    const wrapped = clock.loop ? elapsed % clock.duration : Math.min(elapsed, clock.duration)
    return {
      ratio: wrapped / clock.duration,
      loop: clock.loop,
      duration: clock.duration,
      done: !clock.loop && elapsed >= clock.duration - 0.001,
    }
  }

  /** Decode with the playback context so a second AudioContext does not suspend it. */
  async decodeLibrary(bytes: ArrayBuffer) {
    const ctx = this.unlock()
    if (ctx.state !== 'running') await ctx.resume()
    const decoded = await ctx.decodeAudioData(bytes.slice(0))
    if (ctx.state !== 'running') await ctx.resume()
    return {
      sampleRate: decoded.sampleRate,
      channels: Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice()),
    }
  }

  /** Speaker-only audition. The cue and the arrangement are left alone. */
  previewPcm(channels: Float32Array[], sampleRate?: number, loop = false) {
    this.stopPreview()
    const ctx = this.unlock()
    const out = this.speakerSide()
    const lead = channels[0]
    if (!out || !lead?.length) return
    const shaped = normalizePeak(channels)
    const shapedLead = shaped[0]
    if (!shapedLead?.length) return
    const rate = sampleRate && sampleRate > 0 ? sampleRate : ctx.sampleRate
    const buffer = ctx.createBuffer(Math.max(1, shaped.length), shapedLead.length, rate)
    shaped.forEach((channel, index) => {
      const data = new Float32Array(shapedLead.length)
      data.set(channel.subarray(0, Math.min(channel.length, shapedLead.length)))
      buffer.copyToChannel(data, index)
    })
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    src.loop = loop
    gain.gain.value = 0.8
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
      if (!loop) this.previewClock = null
    }
    this.previewStops = [{ stop, disconnect }]
    const arm = () => {
      this.previewClock = { start: ctx.currentTime, duration: buffer.duration, loop }
      try { src.start() } catch { /* context closed */ }
    }
    if (ctx.state === 'running') arm()
    else void ctx.resume().then(() => { if (this.previewStops.some((item) => item.stop === stop)) arm() })
  }

  private previewTone(ctx: AudioContext, bus: GainNode, pitch: number, cents: number, when: number, dur: number, velocity: number, stops: Stoppable[]) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = 440 * 2 ** ((Math.round(pitch) + cents / 100 - 69) / 12)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(builtinLevel(velocity), when + ATTACK_SEC)
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
  previewPitches(pitches: number[], trackId?: string, surface: NoteSurface = 'roll') {
    if (trackId && this.project?.tracks.some((track) => track.id === trackId && track.instrument === 'library' && track.library)) {
      for (const pitch of pitches) this.voiceNote(surface, trackId, pitch, 0.8)
      return
    }
    const ctx = this.ctx
    const out = this.speakerSide()
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

  private scheduleVoice(ctx: BaseAudioContext, strip: StripNodes, note: MidiNote, when: number, dur: number, track?: Track, bucket?: Stoppable[], routed = false) {
    if (note.muted) return
    if (ctx === this.ctx && track) this.markMidi(track.id, when, dur)
    if (track?.instrument === 'scaler' && this.project) {
      const routed = routeScaler(this.project, track)
      track = routed.voice
      strip = this.strips.get(routed.liveStripId) ?? strip
    }
    const sampler = samplerInsert(track)
    if (sampler?.sampler) {
      if (!routed) this.sendMidiNote(note, when, dur, ctx)
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
    if (track?.instrument === 'pads') {
      const kit = normalizePadKit(track.padKit)
      const pad = kit.banks.flat().find((item) => item.pitch === note.pitch)
      const route = hitRoute(kit, pad ?? { muted: Boolean(note.muted) })
      if (route.midi && !routed) this.sendMidiNote(note, when, dur, ctx)
      if (route.audio) {
        this.playPadNote(ctx, strip, track, {
          pitch: note.pitch,
          velocity: note.velocity,
          tune: note.locks?.tune != null ? note.locks.tune + (note.fine || 0) / 100 : (note.fine ? note.fine / 100 : undefined),
          filter: note.locks?.filter,
          decay: note.locks?.decay,
          pan: note.pan,
        }, when, bucket, null)
      }
      if (!routed && route.midi) this.forwardMpc(track, note.pitch, note.velocity, when)
      return
    }
    if (!routed) this.sendMidiNote(note, when, dur, ctx)
    if (track?.instrument === 'drum-machine' && this.playDrum(ctx, strip, note, when, bucket)) return
    if (track?.instrument === 'library' && ctx === this.ctx) {
      if (track.library) {
        const voiceId = track.id
        const at = Math.max(when, ctx.currentTime)
        const surface: NoteSurface = note.id === 'mpc' ? 'pads' : 'arrange'
        this.voiceNote(surface, voiceId, note.pitch, note.velocity, at)
        this.voiceNote(surface, voiceId, note.pitch, 0, at + dur)
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
    const peak = builtinLevel(note.velocity)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(peak, when + ATTACK_SEC)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.05, dur))
    osc.connect(filter)
    filter.connect(gain)
    const panNodes = connectNotePan(ctx, gain, strip.input, note.pan || 0)
    const end = when + dur + 0.03
    osc.start(when)
    osc.stop(end)
    if (ctx === this.ctx) {
      const entry = this.holdVoice(end + 0.02, [osc, filter, gain, ...panNodes])
      bucket?.push(entry)
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
    const at = Math.max(when, 0)
    src.start(at)
    if (ctx === this.ctx) this.holdVoice(at + buffer.duration + 0.05, [src])
  }

  private previewRelease(bucket: Stoppable[] | undefined, stop: () => void) {
    if (bucket !== this.scalerVoices) return
    bucket.push({ stop, disconnect() {} })
  }

  /** Keep a voice until `endAt`, then drop every node it created. */
  private holdVoice(endAt: number, nodes: AudioNode[], release?: (when: number) => void): Stoppable {
    const entry: Stoppable = {
      endAt,
      stop: (when?: number) => {
        for (const node of nodes) {
          const src = node as Partial<AudioScheduledSourceNode>
          if (typeof src.stop !== 'function') continue
          try { src.stop(when) } catch { /* already stopped */ }
        }
      },
      disconnect: () => {
        for (const node of nodes) {
          try { node.disconnect() } catch { /* already disconnected */ }
        }
      },
      release,
    }
    this.sources.push(entry)
    return entry
  }

  /** Finished one-shots must not stay connected for the rest of the session. */
  private reapSources() {
    const now = this.ctx?.currentTime
    if (now == null) return
    const keep: Stoppable[] = []
    for (const src of this.sources) {
      if (src.endAt != null && now >= src.endAt) {
        try { src.disconnect() } catch { /* already disconnected */ }
        this.reaped += 1
        continue
      }
      keep.push(src)
    }
    if (keep.length !== this.sources.length) this.sources = keep
    if (this.sessionNodes.size) {
      for (const [id, list] of this.sessionNodes) {
        const next = list.filter((node) => node.endAt == null || now < node.endAt)
        if (next.length !== list.length) this.sessionNodes.set(id, next)
      }
    }
    if (this.padVoices.length) {
      this.padVoices = this.padVoices.filter((voice) => now < voice.until + 0.05)
    }
  }

  private stopSources(fadeAt?: number) {
    this.stopPreview()
    this.stopScalerPreview()
    const fading = fadeAt != null
    for (const src of this.sources) {
      if (fading && src.release) {
        src.release(fadeAt)
        continue
      }
      try {
        src.stop(fading ? fadeAt : undefined)
      } catch {
        /* already stopped */
      }
      if (!fading) {
        try {
          src.disconnect()
        } catch {
          /* already disconnected */
        }
      } else {
        const node = src
        const delay = Math.max(20, ((fadeAt - (this.ctx?.currentTime ?? fadeAt)) * 1000) + 40)
        window.setTimeout(() => {
          try { node.disconnect() } catch { /* already disconnected */ }
        }, delay)
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

/**
 * One-shot pan. Exact center connects straight through, matching a project
 * that never had a note panner. Anywhere else uses `notePanGains`, so the
 * first step off center does not drop 3 dB under that direct connection.
 * A context without a merger (test doubles) keeps a stereo panner.
 */
function connectNotePan(ctx: BaseAudioContext, source: AudioNode, dest: AudioNode, pan: number): AudioNode[] {
  const gains = notePanGains(pan)
  if (gains.left === 1 && gains.right === 1) {
    source.connect(dest)
    return []
  }
  if (typeof ctx.createChannelMerger === 'function' && typeof ctx.createGain === 'function') {
    const left = ctx.createGain()
    const right = ctx.createGain()
    left.channelCountMode = 'explicit'
    right.channelCountMode = 'explicit'
    left.channelCount = 1
    right.channelCount = 1
    left.gain.value = gains.left
    right.gain.value = gains.right
    const merge = ctx.createChannelMerger(2)
    source.connect(left)
    source.connect(right)
    left.connect(merge, 0, 0)
    right.connect(merge, 0, 1)
    merge.connect(dest)
    return [left, right, merge]
  }
  if (typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0))
    source.connect(panner)
    panner.connect(dest)
    return [panner]
  }
  source.connect(dest)
  return []
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

function hintStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function openContext(sampleRate: number | undefined, hint: BufferHint) {
  const options: AudioContextOptions[] = []
  for (const item of latencyHintOrder(hint)) {
    options.push({ latencyHint: item })
    if (sampleRate) options.push({ latencyHint: item, sampleRate })
  }
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

function bakedKey(
  pad: {
    pitch: number
    tune: number
    tuneCents?: number
    pitchMode?: string
    filter: number
    highpass?: number
    decay: number
    attack: number
    choke: number
    layers: { bufferId?: string; tune: number }[]
    region?: { start: number; end: number; reverse: boolean; loop: boolean }
  },
  kit: {
    vintage?: { macro: number; presetName: string; table: { bits: { amount: number }; rate: { amount: number }; wow: { amount: number }; crackle: { amount: number }; lowpass: { amount: number } } }
    chop?: { bufferId: string; semitones: number; cents: number; pitchMode: string; highpass: number }
  },
) {
  const layer = pad.layers.find((item) => item.bufferId) ?? pad.layers[0]
  const region = pad.region
  const vintage = kit.vintage
  const table = vintage?.table
  const chop = kit.chop
  return [
    pad.pitch,
    layer?.bufferId || '',
    layer?.tune || 0,
    pad.tune,
    pad.tuneCents || 0,
    pad.pitchMode || 'vinyl',
    pad.filter,
    pad.highpass || 0,
    pad.decay,
    pad.attack,
    pad.choke,
    region?.start ?? 0,
    region?.end ?? 1,
    region?.reverse ? 1 : 0,
    region?.loop ? 1 : 0,
    vintage?.macro ?? 0,
    table ? [table.bits.amount, table.rate.amount, table.wow.amount, table.crackle.amount, table.lowpass.amount].join(',') : '',
    chop?.bufferId ?? '',
    chop?.semitones ?? 0,
    chop?.cents ?? 0,
    chop?.pitchMode ?? '',
    chop?.highpass ?? 0,
  ].join(':')
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
