import type { AudioEngine } from '../audio/engine'
import {
  alignedRecordWindow,
  bestClockSample,
  decodePcmFrame,
  encodePcmFrame,
  estimateCueOneWayMs,
  matchPingDelay,
  median,
  ntpOffset,
  shiftPlacementForLateBuffer,
  type TimedPeak,
} from '../model/latency'
import { DEFAULT_OPUS, markOutboundVideo, mungeOpusSdp, sectionDirections, videoDirectionsFromSdp, type OpusOptions } from '../model/sdp'
import { cameraAttempts, DEFAULT_VIDEO_BITRATE, legalDirection, musicCaptureAttempts, outboundVideoCodecs, scaleResolutionDownBy, shouldSetVideoCodecPreferences, VIDEO_BITRATES, videoDirection } from '../model/codecs'
import { iceRetryPlan, isSilentTake, mediaUp, queueIceCandidate, withTimeout, type IcePolicy, type MediaLink, type MediaPath, type TurnProvider } from '../model/media'
import { iceUfrag, politePeer, remoteDescriptionPlan, sessionHello, signalingReconnectPlan, socketMayOpen } from '../model/negotiate'
import { sanitizeDiag } from '../model/diag'
import { arrangementDigest, guestMayRequest, referencedBufferIds } from '../model/sessionSync'
import { decodeWavPCM, encodeWav } from '../model/wav'
import { base64ToBytes, bytesToBase64 } from '../storage/idb'
import { clearActiveSession, deviceParticipantId, readIdentity } from '../storage/identity'
import type { AudioAsset, Project } from '../model/types'

export interface Participant {
  id: string
  name: string
  role: 'host' | 'guest'
  admitted: boolean
  hand: boolean
  music: boolean
  talk: boolean
  video: boolean
  screen: boolean
  mutedByHost: boolean
  instanceId?: string
}

export interface ChatMessage {
  id: string
  from: string
  name: string
  text: string
  at: number
}

export interface PeerLatency {
  rttMs: number | null
  jitterMs: number | null
  packetLossPct: number | null
  jitterBufferMs: number | null
  oneWayMs: number | null
  oneWaySource: string
  uncertaintyMs: number
  clockOffsetMs: number | null
  clockRttMs: number | null
  pcmNetworkMs: number | null
  audioLevel: number
}

export interface SessionState {
  status: 'idle' | 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'rejected' | 'removed' | 'error'
  error?: string
  code?: string
  selfId?: string
  role?: 'host' | 'guest'
  name: string
  participants: Participant[]
  chat: ChatMessage[]
  musicOn: boolean
  talkOn: boolean
  camOn: boolean
  screenOn: boolean
  hand: boolean
  monitorMode: 'opus' | 'pcm'
  jamEnabled: boolean
  jamDelayMs: number
  opus: OpusOptions
  videoBitrate: number
  devices: { deviceId: string; label: string; kind: MediaDeviceKind }[]
  micId: string
  camId: string
  outId: string
  latency: Record<string, PeerLatency>
  loopbackMs: number | null
  audioPingMs: number | null
  takeProgress: number | null
  activeSpeakerId: string | null
  reactions: Record<string, { emoji: string; at: number }>
  log: string[]
  /** Guest is playing the host arrangement locally instead of the delayed cue. */
  preferLocalBacking: boolean
  syncLabel: string
  turn: TurnProvider
  turnError?: string
  iceTransportPolicy: IcePolicy
  media: Record<string, MediaLink>
  mediaTick: number
  /** What this browser is actually sending, including the camera direction Safari negotiated. */
  localSend: string
  /** iOS needs another tap before the microphone and camera can start again. */
  audioLocked: boolean
  /** The host left this room. The project stays; the call does not. */
  hostLeft?: boolean
}

export interface IncomingTake {
  peerId: string
  peerName: string
  takeId: string
  placeAtSample: number
  sampleRate: number
  channels: Float32Array[]
  compensationMs: number
  detail: string
  silent?: boolean
}

interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

interface PeerLink {
  pc: RTCPeerConnection
  musicSender?: RTCRtpTransceiver
  talkSender?: RTCRtpTransceiver
  camSender?: RTCRtpTransceiver
  screenSender?: RTCRtpTransceiver
  music: MediaStream
  talk: MediaStream
  camera: MediaStream
  screen: MediaStream
  clock?: RTCDataChannel
  takes?: RTCDataChannel
  pcm?: RTCDataChannel
  remoteMinusLocal: number | null
  clockSamples: { rtt: number; offset: number }[]
  pcmNet: number[]
  pcmTarget: number
  pendingIce: RTCIceCandidateInit[]
  openedAt: number
  caller: boolean
  camRetry?: string
  gathered: { host: number; srflx: number; relay: number; prflx: number }
  errors: string[]
  restartedAt?: number
  makingOffer: boolean
  pendingAnswer: string | null
  offerSentAt: number
  firstOfferAt: number
  offers: number
  needsRenegotiate: boolean
  seenCandidates: Set<string>
  askedRestart: boolean
  remoteInstance?: string
  appliedCam?: string
  appliedScreen?: string
  take?: {
    takeId: string
    total: number
    parts: Uint8Array[]
    meta: Record<string, unknown>
  }
}

const PCM_MIN_TARGET = 18

function senderKey(link: PeerLink) {
  return [link.musicSender, link.talkSender, link.camSender, link.screenSender].map((item) => item?.sender.track?.id || '').join()
}

export class SessionClient {
  state: SessionState
  private connectOpts: { name: string; create?: boolean; code?: string; fresh?: boolean } | null = null
  private ws: WebSocket | null = null
  /** One id per page load. A reload mints another so the other side can renegotiate. */
  private instanceId = crypto.randomUUID()
  private peers = new Map<string, PeerLink>()
  private ice: IceServer[] = []
  private listeners = new Set<() => void>()
  private musicStream: MediaStream | null = null
  private talkStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private preview: MediaStream | null = null
  private left = false
  private backoff = 400
  private clockTimer = 0
  private statsTimer = 0
  private iceTimer = 0
  private joinTimer = 0
  private reconnectTimer = 0
  private beatTimer = 0
  private iceStamp = ''
  private iceFreshUntil = 0
  private primedMusic: Promise<MediaStream | null> | null = null
  private primedCamera: Promise<MediaStream | null> | null = null
  private deferMedia = false
  private punch: {
    takeId: string
    recordStartSample: number
    cueEpochHostPerfMs: number
    hostSampleRate: number
    oneWayMs: number
  } | null = null
  private pingPeaks: TimedPeak[] = []
  private pingExpected: number[] = []
  private detachPing: (() => void) | null = null
  private pcmSeq = 1
  private relayBins = new Map<string, { take?: NonNullable<PeerLink['take']> }>()
  private onTake: ((take: IncomingTake) => void) | null = null
  private onControl: ((cmd: Record<string, unknown>) => void) | null = null
  private onArrangement: ((project: Project, assets: Map<string, AudioAsset>, ready: boolean) => void) | null = null
  private arrangementStore: { project: Project; buffers: Map<string, AudioAsset> } | null = null
  private sentAssets = new Set<string>()
  private lastDigest = ''
  private arrangementRev = 0
  private incomingRev = 0
  private incomingProject: Project | null = null
  private incomingAssets = new Map<string, AudioAsset>()
  private resumeId = ''
  /** null until the session view reports which tiles are on screen. Kept for the panel; it does not change SDP. */
  private incomingVideo: Set<string> | null = null
  private signalLane = new Map<string, Promise<void>>()
  private inSignal = new Set<string>()
  private lastDiag = 0
  private pendingAnswers = new Map<string, string>()
  private deviceJob: Promise<void> | null = null

  constructor(private engine: AudioEngine) {
    const saved = readIdentity()
    this.state = {
      status: 'idle',
      name: saved?.name || localStorage.getItem('cueharbor-name') || 'Engineer',
      participants: [],
      chat: [],
      musicOn: saved?.musicOn ?? true,
      talkOn: true,
      camOn: saved?.camOn ?? true,
      screenOn: false,
      hand: false,
      monitorMode: saved?.monitorMode || 'opus',
      jamEnabled: saved?.jamEnabled ?? false,
      jamDelayMs: saved?.jamDelayMs ?? 40,
      opus: { ...DEFAULT_OPUS },
      videoBitrate: DEFAULT_VIDEO_BITRATE,
      devices: [],
      micId: saved?.micId || '',
      camId: '',
      outId: saved?.outId || '',
      latency: {},
      loopbackMs: null,
      audioPingMs: null,
      takeProgress: null,
      activeSpeakerId: null,
      reactions: {},
      log: [],
      preferLocalBacking: false,
      syncLabel: '',
      turn: 'none',
      iceTransportPolicy: 'all',
      media: {},
      mediaTick: 0,
      localSend: 'Camera has not joined the peer connection yet.',
      audioLocked: false,
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this.onPageVisibility())
    }
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  setTakeHandler(fn: (take: IncomingTake) => void) {
    this.onTake = fn
  }

  remoteMusic(peerId: string) {
    const link = this.peers.get(peerId)
    if (!link) return null
    this.adoptReceiverTrack(link.music, link.musicSender)
    return link.music
  }

  localPerformanceStream() {
    return this.musicStream
  }

  localCameraStream() {
    return this.talkStream
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  note(text: string) {
    this.state.log = [...this.state.log.slice(-11), text]
    this.emit()
  }

  connect(opts: { name: string; create?: boolean; code?: string; fresh?: boolean }) {
    if (opts.fresh) this.leave()
    else if (this.ws && !socketMayOpen(this.ws.readyState)) return
    this.left = false
    this.state.name = opts.name.trim() || 'Guest'
    localStorage.setItem('cueharbor-name', this.state.name)
    this.state.status = 'connecting'
    this.state.error = undefined
    this.state.hostLeft = false
    this.connectOpts = opts
    this.resumeId = deviceParticipantId()
    this.emit()
    this.openSocket()
    window.clearTimeout(this.joinTimer)
    this.joinTimer = window.setTimeout(() => {
      if (this.left || this.state.status !== 'connecting') return
      this.state.status = 'error'
      this.state.error = 'The session did not answer. Check the code and try Join again.'
      this.note(this.state.error)
      this.emit()
    }, 8000)
  }

  /**
   * iOS only grants the microphone when getUserMedia runs in the tap turn.
   * Every attempt starts now, before any await. A rejected stereo/48 kHz request
   * falls through to the relaxed one that was already in flight.
   */
  holdMediaForGesture() {
    this.deferMedia = true
  }

  async resumeAudio() {
    this.deferMedia = false
    this.state.audioLocked = false
    this.emit()
    try {
      await withTimeout(this.openDevices(), 12000, 'Microphone')
    } catch (error) {
      this.state.audioLocked = true
      this.note(error instanceof Error ? error.message : 'Audio did not start.')
    }
    this.applySendTracks()
    this.emit()
  }

  primeMediaFromGesture() {
    this.primedMusic = this.gestureCapture(
      musicCaptureAttempts(this.state.micId).map((audio) => () => navigator.mediaDevices.getUserMedia({ audio, video: false })),
    )
    if (this.state.camOn) this.primeCameraFromGesture()
  }

  primeCameraFromGesture() {
    this.primedCamera = this.gestureCapture(
      cameraAttempts(this.state.camId).map((video) => () => navigator.mediaDevices.getUserMedia({ audio: false, video })),
    )
  }

  private gestureCapture(starts: Array<() => Promise<MediaStream>>): Promise<MediaStream | null> {
    const pending = starts.map((start) => {
      try {
        return withTimeout(start(), 8000, 'Microphone or camera').catch(() => null)
      } catch {
        return Promise.resolve(null)
      }
    })
    return (async () => {
      const settled: Array<MediaStream | null> = []
      for (const item of pending) settled.push(await item)
      const chosen = settled.find((stream) => stream?.getTracks().some((track) => track.readyState === 'live')) || null
      for (const stream of settled) {
        if (stream && stream !== chosen) stream.getTracks().forEach((track) => track.stop())
      }
      return chosen
    })()
  }

  leave() {
    this.left = true
    clearActiveSession()
    this.send({ t: 'leave' })
    this.stopLocalTracks()
    this.teardown()
    this.state.status = 'idle'
    this.state.code = undefined
    this.state.role = undefined
    this.state.participants = []
    this.state.media = {}
    this.state.hostLeft = false
    this.emit()
  }

  private stopLocalTracks() {
    for (const stream of [this.musicStream, this.talkStream, this.screenStream, this.preview]) {
      stream?.getTracks().forEach((track) => track.stop())
    }
    this.musicStream = null
    this.talkStream = null
    this.screenStream = null
    this.preview = null
  }

  private teardown() {
    window.clearInterval(this.clockTimer)
    window.clearInterval(this.statsTimer)
    window.clearInterval(this.iceTimer)
    window.clearInterval(this.beatTimer)
    window.clearTimeout(this.joinTimer)
    window.clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
    for (const link of this.peers.values()) link.pc.close()
    this.peers.clear()
    this.engine.stopRolling()
    this.engine.stopPcmTap()
    this.detachPing?.()
  }

  private openSocket() {
    const opts = this.connectOpts
    if (!opts) return
    // Never replace a socket that is still opening or open. Reconnect runs from onclose only.
    if (!socketMayOpen(this.ws ? this.ws.readyState : null)) return
    window.clearTimeout(this.reconnectTimer)
    // Same origin as the page, so https://host/?session=CODE uses wss://host/ws.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 400
      const code = opts.fresh ? '' : opts.code || this.state.code
      const decision = sessionHello({ create: Boolean(opts.create), fresh: Boolean(opts.fresh), requestedCode: code })
      this.send({
        t: 'hello',
        name: this.state.name,
        create: decision.action === 'create',
        fresh: Boolean(opts.fresh),
        code: decision.code,
        resumeId: this.resumeId || undefined,
        instanceId: this.instanceId,
      })
    }
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg?.t === 'signal' && msg.data?.kind === 'answer') this.stashAnswer(String(msg.from || ''), String(msg.data.sdp || ''))
      void this.onServer(msg)
    }
    ws.onclose = () => {
      if (this.left || this.ws !== ws) return
      this.ws = null
      this.state.status = 'reconnecting'
      this.note('Signaling dropped. Reconnecting…')
      this.emit()
      this.reconnectTimer = window.setTimeout(() => this.openSocket(), this.backoff)
      this.backoff = Math.min(4000, this.backoff * 2)
    }
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  private async onServer(msg: Record<string, any>) {
    if (msg.t === 'error') {
      this.state.status = 'error'
      this.state.error = msg.message
      this.emit()
      return
    }
    if (msg.t === 'welcome') {
      this.state.selfId = msg.id
      this.state.role = msg.role
      this.state.code = msg.code
      this.state.participants = msg.participants
      this.state.chat = msg.chat || []
      this.rememberIce(msg.iceServers || [], msg.turn || 'none', msg.turnError, msg.iceTransportPolicy)
      this.resumeId = msg.id
      sessionStorage.setItem(`cueharbor-resume:${msg.code}`, msg.id)
      const askedCreate = Boolean(this.connectOpts?.create)
      this.connectOpts = { name: this.state.name, create: false, code: msg.code }
      this.state.status = msg.role === 'host' || this.selfAdmitted() ? 'live' : 'waiting'
      const reason = String(msg.reason || '')
      if (askedCreate && reason.startsWith('new session created')) {
        this.note(reason)
        this.postDiagEvent('create', reason)
      } else if (reason) {
        this.note(reason)
        this.postDiagEvent('join', reason)
      } else {
        this.note(`${msg.role === 'host' ? 'Hosting' : 'Joined'} ${msg.code}`)
      }
      this.state.error = undefined
      this.state.hostLeft = false
      window.clearTimeout(this.joinTimer)
      this.emit()
      const keepMedia = Boolean(this.musicStream || this.talkStream)
      const needsTap = !keepMedia && (this.deferMedia || (this.iosDevice() && !this.primedMusic && !navigator.userActivation?.isActive))
      this.deferMedia = false
      if (keepMedia) {
        // The signaling socket came back. A connected peer connection stays up.
      } else if (needsTap) {
        this.state.audioLocked = true
        this.note('Tap to reconnect audio.')
        this.emit()
      } else {
        try {
          await withTimeout(this.openDevices(), 12000, 'Microphone')
        } catch (error) {
          this.state.audioLocked = true
          this.note(error instanceof Error ? `${error.message}. You are still in the room.` : 'Microphone setup did not finish. You are still in the room.')
        }
      }
      this.adoptRemoteInstances()
      this.syncMesh()
      this.startMaintenance()
      return
    }
    if (msg.t === 'roster') {
      this.state.participants = msg.participants
      if (msg.participants.some((person: Participant) => person.role === 'host')) this.state.hostLeft = false
      const admitted = this.selfAdmitted()
      this.state.status = this.state.role === 'host' || admitted ? 'live' : 'waiting'
      this.emit()
      this.adoptRemoteInstances()
      this.syncMesh()
      this.routeTalk()
      return
    }
    if (msg.t === 'host-away') {
      this.state.hostLeft = true
      this.note('The host left this session.')
      this.emit()
      return
    }
    if (msg.t === 'rejected') {
      this.state.status = 'rejected'
      this.emit()
      this.teardown()
      return
    }
    if (msg.t === 'removed') {
      this.state.status = 'removed'
      this.emit()
      this.teardown()
      return
    }
    if (msg.t === 'chat') {
      this.state.chat = [...this.state.chat, msg.message]
      this.emit()
      return
    }
    if (msg.t === 'reaction') {
      this.state.reactions = { ...this.state.reactions, [msg.from]: { emoji: msg.emoji, at: Date.now() } }
      this.emit()
      window.setTimeout(() => {
        const next = { ...this.state.reactions }
        delete next[msg.from]
        this.state.reactions = next
        this.emit()
      }, 2400)
      return
    }
    if (msg.t === 'force-mute') {
      this.state.musicOn = !msg.muted
      this.state.talkOn = !msg.muted
      this.applySendTracks()
      this.presence()
      this.note(msg.muted ? 'The host muted you.' : 'The host unmuted you.')
      this.emit()
      return
    }
    if (msg.t === 'signal') {
      await this.enqueueSignal(String(msg.from || ''), () => this.onSignal(msg.from, msg.data))
      return
    }
    if (msg.t === 'clock') {
      this.onClock(msg.from, msg.payload, 'ws')
      return
    }
    if (msg.t === 'transport') {
      this.onTransport(msg.payload)
      return
    }
    if (msg.t === 'transport-request') {
      const payload = msg.payload as Record<string, unknown>
      if (this.state.role === 'host' && payload && guestMayRequest(String(payload.action || ''))) this.onControl?.(payload)
      return
    }
    if (msg.t === 'project' && this.state.role === 'guest') {
      this.incomingRev = Number(msg.rev) || this.incomingRev
      this.incomingProject = msg.project as Project
      this.applyIncomingArrangement()
      return
    }
    if (msg.t === 'project-asset' && this.state.role === 'guest') {
      this.takeAsset(msg.asset as { id: string; name: string; sampleRate: number; wav: string })
      return
    }
    if (msg.t === 'take-relay' && this.state.role === 'host') {
      this.acceptRelayTake(String(msg.from || ''), msg.body)
      return
    }
  }

  private selfAdmitted() {
    return this.state.participants.find((p) => p.id === this.state.selfId)?.admitted
  }

  private hostId() {
    return this.state.participants.find((p) => p.role === 'host')?.id
  }

  admit(id: string) {
    this.send({ t: 'admit', id })
  }
  reject(id: string) {
    this.send({ t: 'reject', id })
  }
  remove(id: string) {
    this.send({ t: 'remove', id })
  }
  forceMute(id: string, muted: boolean) {
    this.send({ t: 'force-mute', id, muted })
  }
  sendChat(text: string) {
    this.send({ t: 'chat', text })
  }
  react(emoji: string) {
    this.send({ t: 'reaction', emoji })
  }
  setHand(raised: boolean) {
    this.state.hand = raised
    this.presence()
    this.emit()
  }

  async setMusic(on: boolean) {
    this.state.musicOn = on
    this.applySendTracks()
    this.presence(true)
    this.emit()
  }
  async setTalk(on: boolean) {
    this.state.talkOn = on
    this.applySendTracks()
    this.presence(true)
    this.emit()
  }
  async setCam(on: boolean) {
    this.state.camOn = on
    if (!on) {
      for (const track of this.preview?.getVideoTracks() || []) track.enabled = false
    }
    if (on && !this.preview?.getVideoTracks().some((track) => track.readyState === 'live')) {
      this.primeCameraFromGesture()
      await this.openDevices()
    }
    this.applySendTracks()
    this.presence()
    this.emit()
  }

  async setScreen(on: boolean) {
    if (!on) {
      this.screenStream?.getTracks().forEach((track) => track.stop())
      this.screenStream = null
      this.state.screenOn = false
      this.applySendTracks()
      this.presence()
      this.emit()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 15 }, width: { max: 426 }, height: { max: 240 } }, audio: false })
      this.screenStream = stream
      this.state.screenOn = true
      const track = stream.getVideoTracks()[0]
      track.onended = () => void this.setScreen(false)
      this.applySendTracks()
      this.presence()
      this.note('Sharing your screen.')
      this.emit()
    } catch {
      this.note('Screen share was cancelled.')
      this.emit()
    }
  }

  async setDevices(patch: { micId?: string; camId?: string; outId?: string }) {
    if (patch.micId != null) this.state.micId = patch.micId
    if (patch.camId != null) this.state.camId = patch.camId
    if (patch.outId != null) {
      this.state.outId = patch.outId
      await this.engine.setOutputDevice(patch.outId)
    }
    if (patch.micId != null || patch.camId != null) await this.openDevices()
    this.emit()
  }

  setVideoBitrate(bitrate: number) {
    this.state.videoBitrate = (VIDEO_BITRATES as readonly number[]).includes(bitrate) ? bitrate : DEFAULT_VIDEO_BITRATE
    for (const link of this.peers.values()) void this.tuneSenders(link)
    this.emit()
  }

  /** Remember which tiles are on screen. Receiving video stays on so a phone below the fold still connects. */
  setIncomingVideo(peerIds: string[]) {
    this.incomingVideo = new Set(peerIds.filter((id) => id && id !== this.state.selfId))
  }

  setOpus(patch: Partial<OpusOptions>) {
    this.state.opus = { ...this.state.opus, ...patch }
    this.emit()
    this.note('Opus settings apply on the next reconnect or renegotiation.')
  }

  async renegotiate() {
    for (const [id, link] of this.peers) {
      if (this.state.selfId && this.state.selfId < id) await this.offer(id, link, true)
    }
  }

  setMonitorMode(mode: 'opus' | 'pcm') {
    this.state.monitorMode = mode
    this.applyMonitor()
    this.note(mode === 'pcm' ? 'PCM monitor: skips Opus, adds a tiny playout buffer.' : 'Opus monitor: 10ms frames, FEC on, DTX off.')
    this.emit()
  }

  setJam(enabled: boolean, delayMs?: number) {
    this.state.jamEnabled = enabled
    if (delayMs != null) this.state.jamDelayMs = delayMs
    this.applyJam()
    this.emit()
  }

  private presence(clearForceMute = false) {
    this.send({
      t: 'presence',
      hand: this.state.hand,
      music: this.state.musicOn,
      talk: this.state.talkOn,
      video: this.state.camOn,
      screen: this.state.screenOn,
      clearForceMute,
    })
  }

  private iosDevice() {
    const ua = navigator.userAgent
    return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  }

  private openDevices() {
    if (this.deviceJob) return this.deviceJob
    const job = this.captureDevices().finally(() => {
      if (this.deviceJob === job) this.deviceJob = null
      this.syncMesh()
    })
    this.deviceJob = job
    return job
  }

  private async captureDevices() {
    try {
      await withTimeout(this.engine.resume(), 4000, 'Audio')
    } catch {
      this.note('Audio is locked until the next tap. The camera still opens.')
    }
    const primedMusic = this.primedMusic
    const primedCamera = this.primedCamera
    this.primedMusic = null
    this.primedCamera = null
    try {
      this.musicStream?.getTracks().forEach((track) => track.stop())
      const stream = primedMusic
        ? await primedMusic
        : await this.gestureCapture(musicCaptureAttempts(this.state.micId).map((audio) => () => navigator.mediaDevices.getUserMedia({ audio, video: false })))
      if (!stream) throw new Error('no microphone')
      this.musicStream = stream
      const track = this.musicStream.getAudioTracks()[0]
      if (track) {
        track.contentHint = 'music'
        try {
          await track.applyConstraints({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: { ideal: 2 },
            sampleRate: { ideal: 48000 },
          })
        } catch {
          this.note('Browser kept some mic processing on. The take is still recorded locally.')
        }
      }
      this.engine.setLocalMic(this.musicStream)
      if (this.state.role === 'guest') {
        try {
          await withTimeout(this.engine.startRolling(this.musicStream), 4000, 'Recording')
        } catch {
          this.note('Local recording did not start. You are still in the room.')
        }
      }
      this.state.audioLocked = false
    } catch {
      this.state.audioLocked = true
      this.note('Microphone permission is blocked. You can still listen.')
    }
    if (this.talkStream && this.talkStream !== this.musicStream) this.talkStream.getTracks().forEach((track) => track.stop())
    let videoTracks: MediaStreamTrack[] = []
    if (this.state.camOn) {
      const camera = primedCamera
        ? await primedCamera
        : await this.gestureCapture(cameraAttempts(this.state.camId).map((video) => () => navigator.mediaDevices.getUserMedia({ audio: false, video })))
      videoTracks = camera?.getVideoTracks() || []
    }
    let talk: MediaStreamTrack | null = null
    try {
      const spoken = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            deviceId: this.state.micId ? { ideal: this.state.micId } : undefined,
          },
          video: false,
        }),
        8000,
        'Talkback',
      )
      talk = spoken.getAudioTracks()[0] || null
      if (talk) talk.contentHint = 'speech'
    } catch {
      this.note('Talkback mic failed. The performance mic is still available.')
    }
    if (!videoTracks.length && this.state.camOn) this.note('Camera failed. Check the browser camera permission.')
    this.talkStream = new MediaStream([...(talk ? [talk] : []), ...videoTracks])
    this.preview = new MediaStream(videoTracks)
    for (const track of videoTracks) {
      track.onended = () => {
        if (this.state.camOn && document.visibilityState === 'visible') void this.openDevices()
      }
    }
    const listed = await navigator.mediaDevices.enumerateDevices()
    this.state.devices = listed.map((device) => ({ deviceId: device.deviceId, label: device.label || device.kind, kind: device.kind }))
    this.state.mediaTick += 1
    this.applySendTracks()
    this.applyMonitor()
    this.emit()
  }

  /** iOS suspends the camera in the background. A visible page asks for it again if the track ended. */
  reviveMedia() {
    void this.engine.resume()
    const video = this.preview?.getVideoTracks()[0]
    if (this.state.camOn && (!video || video.readyState === 'ended')) void this.openDevices()
  }

  async calibrate() {
    if (!this.musicStream) await this.openDevices()
    if (!this.musicStream) return
    this.note('Play the click near your mic, or use a loopback cable. Headphones will read near zero.')
    const ms = await this.engine.calibrateLoopback(this.musicStream)
    this.state.loopbackMs = ms
    this.note(`Device loopback ${ms.toFixed(1)} ms. Input estimate ${this.engine.inputLatencyMs.toFixed(1)} ms.`)
    this.emit()
  }

  async measureOpusPath() {
    if (this.state.role !== 'host') {
      this.note('The host starts the cue ping. You will see the result here.')
      return
    }
    this.broadcastTransport({ action: 'ping-arm' })
    await this.engine.resume()
    const ctx = this.engine.ctx!
    for (let i = 0; i < 5; i++) {
      const at = ctx.currentTime + 0.35 + i * 0.4
      this.engine.playCuePing(at)
      this.broadcastTransport({ action: 'ping', hostPerf: this.engine.perfForContext(at) })
    }
    this.note('Cue pings sent. The artist’s browser will report the Opus path.')
  }

  broadcastTransport(payload: Record<string, unknown>) {
    if (this.state.role !== 'host') return
    this.send({ t: 'transport', payload })
  }

  requestTransport(payload: Record<string, unknown>) {
    if (!guestMayRequest(String(payload.action || ''))) return
    this.send({ t: 'transport-request', payload })
  }

  setControlHandler(fn: (cmd: Record<string, unknown>) => void) {
    this.onControl = fn
  }

  setArrangementHandler(fn: (project: Project, assets: Map<string, AudioAsset>, ready: boolean) => void) {
    this.onArrangement = fn
  }

  bindArrangement(store: { project: Project; buffers: Map<string, AudioAsset> }) {
    this.arrangementStore = store
  }

  hostOffsetMs() {
    const id = this.hostId()
    if (!id) return null
    return this.peers.get(id)?.remoteMinusLocal ?? null
  }

  /** Host pushes the arrangement and any audio the guest does not have yet. */
  publishArrangement() {
    const store = this.arrangementStore
    if (!store || this.state.role !== 'host' || this.state.status !== 'live') return
    const project = store.project
    for (const id of referencedBufferIds(project)) {
      if (this.sentAssets.has(id)) continue
      const asset = store.buffers.get(id)
      if (!asset) continue
      this.sentAssets.add(id)
      const wav = bytesToBase64(new Uint8Array(encodeWav(asset.channels, asset.sampleRate)))
      this.send({ t: 'project-asset', asset: { id: asset.id, name: asset.name, sampleRate: asset.sampleRate, wav } })
    }
    const digest = arrangementDigest(project)
    if (digest === this.lastDigest) return
    this.lastDigest = digest
    this.arrangementRev += 1
    this.send({ t: 'project', rev: this.arrangementRev, project })
    this.state.syncLabel = 'Host · guests follow'
    this.emit()
  }

  private takeAsset(asset: { id: string; name: string; sampleRate: number; wav: string } | undefined) {
    if (!asset?.id || !asset.wav) return
    try {
      const decoded = decodeWavPCM(base64ToBytes(asset.wav).buffer as ArrayBuffer)
      this.incomingAssets.set(asset.id, {
        id: asset.id,
        name: asset.name || 'Audio',
        sampleRate: decoded.sampleRate || asset.sampleRate,
        channels: decoded.channels,
      })
    } catch {
      this.note('An arrangement file could not be read.')
    }
    this.applyIncomingArrangement()
  }

  private applyIncomingArrangement() {
    const project = this.incomingProject
    if (!project) return
    const assets = new Map(this.incomingAssets)
    const ids = referencedBufferIds(project)
    const ready = ids.every((id) => assets.has(id))
    this.state.preferLocalBacking = ready
    this.state.syncLabel = ready ? 'Following host' : 'Receiving arrangement'
    this.refreshCue()
    this.onArrangement?.(project, assets, ready)
    this.emit()
  }

  private startMaintenance() {
    window.clearInterval(this.clockTimer)
    window.clearInterval(this.statsTimer)
    window.clearInterval(this.iceTimer)
    window.clearInterval(this.beatTimer)
    this.clockTimer = window.setInterval(() => this.pingClocks(), 800)
    this.statsTimer = window.setInterval(() => void this.pollStats(), 1000)
    this.iceTimer = window.setInterval(() => void this.retryUnhealthy(), 5000)
    this.beatTimer = window.setInterval(() => this.send({ t: 'beat' }), 3000)
  }

  /** Drop a peer connection only when that browser reloaded or the path has failed. */
  private adoptRemoteInstances() {
    for (const person of this.state.participants) {
      const link = this.peers.get(person.id)
      if (!link || !person.instanceId) continue
      const plan = signalingReconnectPlan({
        connection: link.pc.connectionState,
        ice: link.pc.iceConnectionState,
        remoteInstance: person.instanceId,
        previousInstance: link.remoteInstance || person.instanceId,
      })
      if (!link.remoteInstance) {
        link.remoteInstance = person.instanceId
        continue
      }
      if (plan === 'renegotiate') {
        link.pc.close()
        this.peers.delete(person.id)
        this.engine.setRemoteMusic(person.id, null)
        this.engine.setTalk(person.id, null, false)
      }
    }
  }

  private pingClocks() {
    const id = Math.random().toString(36).slice(2, 8)
    const payload = { t: 'ping', id, t0: performance.now() }
    for (const peer of this.remoteAdmitted()) {
      const link = this.peers.get(peer.id)
      if (link?.clock?.readyState === 'open') link.clock.send(JSON.stringify(payload))
      else this.send({ t: 'clock', to: peer.id, payload })
    }
  }

  private onClock(from: string, payload: any, via: 'ws' | 'dc') {
    if (!payload) return
    if (payload.t === 'ping') {
      const reply = { t: 'pong', id: payload.id, t0: payload.t0, t1: performance.now(), t2: performance.now() }
      const link = this.peers.get(from)
      if (via === 'dc' && link?.clock?.readyState === 'open') link.clock.send(JSON.stringify(reply))
      else this.send({ t: 'clock', to: from, payload: reply })
      return
    }
    if (payload.t === 'pong') {
      const sample = ntpOffset(payload.t0, payload.t1, payload.t2, performance.now())
      if (sample.rtt < 0 || sample.rtt > 2000) return
      const link = this.peers.get(from)
      if (!link) return
      link.clockSamples = [...link.clockSamples, sample].slice(-12)
      const best = bestClockSample(link.clockSamples.filter((s) => (via === 'dc' ? s.rtt < 150 : true))) || bestClockSample(link.clockSamples)
      if (best) link.remoteMinusLocal = best.offset
      return
    }
    if (payload.t === 'ping-result') {
      this.state.audioPingMs = payload.ms
      this.note(`Opus audio path ${payload.ms.toFixed(1)} ms (tap to playout, before speakers).`)
      this.emit()
    }
  }

  private syncMesh() {
    const wanted = new Set(this.remoteAdmitted().map((p) => p.id))
    for (const [id, link] of this.peers) {
      if (!wanted.has(id)) {
        link.pc.close()
        this.peers.delete(id)
        this.engine.setRemoteMusic(id, null)
        this.engine.setTalk(id, null, false)
      }
    }
    if (this.state.status !== 'live') return
    // A roster can arrive while the camera is still opening. Offering then
    // publishes recvonly video and the phone never sends a picture.
    if (this.deviceJob) return
    for (const peer of this.remoteAdmitted()) {
      if (this.peers.has(peer.id)) continue
      const caller = Boolean(this.state.selfId && this.state.selfId < peer.id)
      void this.enqueueSignal(peer.id, async () => {
        if (!this.peers.has(peer.id)) await this.createPeer(peer.id, caller)
      })
    }
  }

  private enqueueSignal(id: string, job: () => Promise<void>) {
    if (!id) return Promise.resolve()
    const prev = this.signalLane.get(id) || Promise.resolve()
    const run = prev.catch(() => undefined).then(async () => {
      this.inSignal.add(id)
      try {
        await job()
      } catch (error) {
        const link = this.peers.get(id)
        if (link) this.notePeerError(link, error)
      } finally {
        this.inSignal.delete(id)
      }
    })
    this.signalLane.set(id, run)
    return run
  }

  private remoteAdmitted() {
    return this.state.participants.filter((p) => p.admitted && p.id !== this.state.selfId)
  }

  private async createPeer(id: string, caller: boolean) {
    if (this.peers.has(id)) return this.peers.get(id)!
    // One transport for every m-line. Cloudflare TURN stays in iceServers and is
    // allocated once; host candidates are not gathered again for each section.
    const pc = new RTCPeerConnection({
      iceServers: this.ice,
      iceTransportPolicy: this.state.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })
    const link: PeerLink = {
      pc,
      music: new MediaStream(),
      talk: new MediaStream(),
      camera: new MediaStream(),
      screen: new MediaStream(),
      remoteMinusLocal: null,
      clockSamples: [],
      pcmNet: [],
      pcmTarget: PCM_MIN_TARGET,
      pendingIce: [],
      openedAt: Date.now(),
      caller,
      gathered: { host: 0, srflx: 0, relay: 0, prflx: 0 },
      errors: [],
      makingOffer: false,
      pendingAnswer: this.pendingAnswers.get(id) || null,
      offerSentAt: 0,
      firstOfferAt: 0,
      offers: 0,
      needsRenegotiate: false,
      seenCandidates: new Set(),
      askedRestart: false,
    }
    // The offerer chooses the m-lines. The answerer waits for the offer so Chrome
    // does not keep a second recvonly set and answer send-only.
    if (caller) {
      link.musicSender = pc.addTransceiver('audio', { direction: 'sendrecv' })
      link.talkSender = pc.addTransceiver('audio', { direction: 'sendrecv' })
      link.camSender = pc.addTransceiver('video', { direction: 'sendrecv' })
      link.screenSender = pc.addTransceiver('video', { direction: 'sendrecv' })
      this.preferOpus(link.musicSender)
      this.preferVideo(link.camSender)
      this.preferVideo(link.screenSender)
      this.preferOpus(link.talkSender)
    }
    this.peers.set(id, link)
    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      const line = event.candidate.candidate
      if (!link.seenCandidates.has(line)) {
        link.seenCandidates.add(line)
        const kind = line.match(/typ (host|srflx|relay|prflx)/)?.[1] as 'host' | 'srflx' | 'relay' | 'prflx' | undefined
        if (kind) link.gathered[kind] += 1
      }
      this.send({ t: 'signal', to: id, data: { kind: 'ice', candidate: event.candidate.toJSON() } })
    }
    pc.ontrack = (event) => {
      const transceivers = pc.getTransceivers()
      let index = transceivers.indexOf(event.transceiver)
      if (index < 0 && event.transceiver.mid) index = transceivers.findIndex((item) => item.mid === event.transceiver.mid)
      const track = event.track
      const fresh = new MediaStream([track])
      if (index === 0) link.music = fresh
      else if (index === 1) link.talk = fresh
      else if (index === 2) link.camera = fresh
      else if (index === 3) link.screen = fresh
      else if (track.kind === 'audio') {
        if (!link.music.getAudioTracks().length) {
          link.music = fresh
          index = 0
        } else {
          link.talk = fresh
          index = 1
        }
      } else if (!link.camera.getVideoTracks().length) {
        link.camera = fresh
        index = 2
      } else {
        link.screen = fresh
        index = 3
      }
      this.tuneReceiver(event.receiver, index === 0)
      track.onunmute = () => {
        this.state.mediaTick += 1
        this.emit()
      }
      this.state.mediaTick += 1
      this.routeIncoming(id, index)
    }
    pc.ondatachannel = (event) => this.bindChannel(id, link, event.channel)
    pc.onconnectionstatechange = () => {
      this.noteMedia(id, link)
      if (pc.connectionState === 'failed') void this.recover(id)
      this.emit()
    }
    pc.oniceconnectionstatechange = () => {
      this.noteMedia(id, link)
      if (pc.iceConnectionState === 'failed') void this.recover(id)
      this.emit()
    }
    if (caller) {
      link.clock = pc.createDataChannel('clock', { ordered: true })
      link.takes = pc.createDataChannel('takes', { ordered: true })
      link.pcm = pc.createDataChannel('pcm', { ordered: false, maxRetransmits: 0 })
      this.bindChannel(id, link, link.clock)
      this.bindChannel(id, link, link.takes)
      this.bindChannel(id, link, link.pcm)
    }
    await this.attachSenders(id, link)
    if (caller) await this.offer(id, link, false)
    this.emit()
    return link
  }

  /** Point the four slots at the m-lines the remote description actually negotiated. */
  private adoptTransceivers(link: PeerLink) {
    const live = link.pc.getTransceivers().filter((tr) => tr.direction !== 'stopped' && tr.mid)
    const audio = live.filter((tr) => tr.receiver.track.kind === 'audio')
    const video = live.filter((tr) => tr.receiver.track.kind === 'video')
    if (audio[0]) link.musicSender = audio[0]
    if (audio[1]) link.talkSender = audio[1]
    if (video[0]) link.camSender = video[0]
    if (video[1]) link.screenSender = video[1]
    for (const tr of link.pc.getTransceivers()) {
      if (!tr.mid && tr.direction !== 'stopped') {
        try {
          tr.stop()
        } catch {
          /* an unused transceiver can stay stopped */
        }
      }
    }
  }

  private preferVideo(transceiver?: RTCRtpTransceiver) {
    if (!transceiver || !shouldSetVideoCodecPreferences(navigator.userAgent)) return
    const caps = RTCRtpSender.getCapabilities?.('video')
    if (!caps) return
    const ordered = outboundVideoCodecs(caps.codecs)
    if (!ordered.length) return
    if (!ordered.some((codec) => codec.mimeType.toLowerCase() === 'video/h264') && caps.codecs.some((codec) => codec.mimeType.toLowerCase() === 'video/h264')) return
    try {
      transceiver.setCodecPreferences(ordered)
    } catch {
      /* keep the browser default, which still includes H.264 when the device has it */
    }
  }

  private preferOpus(transceiver?: RTCRtpTransceiver) {
    if (!transceiver) return
    const caps = RTCRtpSender.getCapabilities?.('audio')
    if (!caps) return
    const opus = caps.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'audio/opus')
    const rest = caps.codecs.filter((codec) => {
      const name = codec.mimeType.toLowerCase()
      return name !== 'audio/opus' && name !== 'audio/red' && name !== 'audio/ulpfec'
    })
    try {
      transceiver.setCodecPreferences([...opus, ...rest])
    } catch {
      /* not supported */
    }
  }

  private tuneReceiver(receiver: RTCRtpReceiver, music: boolean) {
    try {
      if (music) {
        receiver.playoutDelayHint = 0
        receiver.jitterBufferTarget = 0
      } else if ('jitterBufferTarget' in receiver) {
        receiver.jitterBufferTarget = 20
      }
    } catch {
      /* older browsers */
    }
  }

  private bindChannel(id: string, link: PeerLink, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer'
    if (channel.label === 'clock') link.clock = channel
    if (channel.label === 'takes') link.takes = channel
    if (channel.label === 'pcm') link.pcm = channel
    channel.onmessage = (event) => {
      if (channel.label === 'clock' && typeof event.data === 'string') this.onClock(id, JSON.parse(event.data), 'dc')
      else if (channel.label === 'takes') this.onTakeData(id, link, event.data)
      else if (channel.label === 'pcm' && event.data instanceof ArrayBuffer) this.onPcm(id, link, event.data)
    }
  }

  private async offer(id: string, link: PeerLink, iceRestart: boolean) {
    if (link.makingOffer) {
      link.needsRenegotiate = true
      return
    }
    if (link.pc.signalingState === 'closed' || link.pc.connectionState === 'closed') return
    if (!iceRestart && link.pc.signalingState !== 'stable') {
      link.needsRenegotiate = true
      return
    }
    const now = Date.now()
    if (!link.firstOfferAt || now - link.firstOfferAt > 20000) {
      link.firstOfferAt = now
      link.offers = 0
    }
    if (link.offers >= 6) {
      this.notePeerError(link, 'stopped a repeated offer')
      link.needsRenegotiate = false
      return
    }
    let settled = false
    link.makingOffer = true
    try {
      const signalingBefore = link.pc.signalingState
      await this.applyPendingAnswer(id, link)
      settled = signalingBefore === 'have-local-offer' && link.pc.signalingState === 'stable'
      if (!settled && link.pc.signalingState === 'have-local-offer') {
        try {
          await link.pc.setLocalDescription({ type: 'rollback' })
        } catch (error) {
          this.notePeerError(link, error)
          settled = true
        }
      }
      if (!settled && link.pc.signalingState === 'stable') {
        link.gathered = { host: 0, srflx: 0, relay: 0, prflx: 0 }
        link.seenCandidates.clear()
        const created = await link.pc.createOffer({ iceRestart })
        const original = created.sdp || ''
        const munged = markOutboundVideo(mungeOpusSdp(original, this.state.opus), this.videoSendFlags(link))
        // The local description is published as soon as it is set. Gathering,
        // including Cloudflare TURN, keeps running and must not delay the answer.
        try {
          await link.pc.setLocalDescription({ type: 'offer', sdp: munged })
        } catch (error) {
          this.notePeerError(link, error)
          await link.pc.setLocalDescription({ type: 'offer', sdp: original })
        }
        link.offers += 1
        link.offerSentAt = Date.now()
        this.send({ t: 'signal', to: id, data: { kind: 'offer', sdp: link.pc.localDescription?.sdp || munged } })
        await this.applyPendingAnswer(id, link)
      }
    } finally {
      link.makingOffer = false
    }
    if (link.needsRenegotiate && link.pc.signalingState === 'stable' && this.peers.get(id) === link) {
      link.needsRenegotiate = false
      await this.offer(id, link, false)
    }
  }

  /** Munge the local description only. If Safari rejects the edit, keep the browser SDP. */
  private async commitLocal(link: PeerLink, created: RTCSessionDescriptionInit) {
    const original = created.sdp || ''
    const munged = markOutboundVideo(mungeOpusSdp(original, this.state.opus), this.videoSendFlags(link))
    try {
      await link.pc.setLocalDescription({ type: created.type, sdp: munged })
    } catch (error) {
      this.notePeerError(link, error)
      await link.pc.setLocalDescription({ type: created.type, sdp: original })
    }
  }

  private videoSendFlags(link: PeerLink): boolean[] {
    const offerDirs = link.pc.signalingState === 'have-remote-offer' ? videoDirectionsFromSdp(link.pc.remoteDescription?.sdp || '') : []
    const wants = [Boolean(this.cameraTrack()), Boolean(this.screenTrack())]
    return wants.map((want, index) => {
      if (!want) return false
      const offer = offerDirs[index]
      if (!offer) return true
      return offer === 'sendrecv' || offer === 'recvonly'
    })
  }

  private wantsIncomingVideo() {
    return !this.pageHidesVideo()
  }

  onScreenCount() {
    return this.incomingVideo ? this.incomingVideo.size : null
  }

  private pageHidesVideo() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  private onPageVisibility() {
    const send = !this.pageHidesVideo() && this.state.camOn
    for (const track of this.preview?.getVideoTracks() || []) track.enabled = send
    this.applySendTracks()
  }

  private stashAnswer(from: string, sdp: string) {
    if (!from || !sdp) return
    const link = this.peers.get(from)
    if (link?.pc.signalingState === 'stable' && link.pc.remoteDescription && !link.makingOffer) return
    if (link) link.pendingAnswer = sdp
    else this.pendingAnswers.set(from, sdp)
  }

  private async applyPendingAnswer(id: string, link: PeerLink) {
    if (!link.pendingAnswer && this.pendingAnswers.has(id)) link.pendingAnswer = this.pendingAnswers.get(id) || null
    const sdp = link.pendingAnswer
    if (!sdp) return
    const plan = remoteDescriptionPlan({
      polite: politePeer(this.state.selfId || '', id),
      signaling: link.pc.signalingState,
      kind: 'answer',
      makingOffer: link.makingOffer,
      ice: link.pc.iceConnectionState,
      offerAgeMs: link.offerSentAt ? Date.now() - link.offerSentAt : 0,
      localUfrag: iceUfrag(link.pc.localDescription?.sdp || ''),
      remoteUfrag: iceUfrag(sdp),
    })
    if (plan === 'queue-answer') return
    this.pendingAnswers.delete(id)
    link.pendingAnswer = null
    if (plan === 'ignore-answer') {
      this.notePeerError(link, `ignored answer while ${link.pc.signalingState}`)
      return
    }
    await link.pc.setRemoteDescription({ type: 'answer', sdp })
    await this.flushIce(link)
    await this.tuneSenders(link)
    await this.attachSenders(id, link)
  }

  private async onSignal(from: string, data: any) {
    if (!data) return
    if (data.kind === 'restart') {
      const existing = this.peers.get(from)
      if (existing && signalingReconnectPlan({
        connection: existing.pc.connectionState,
        ice: existing.pc.iceConnectionState,
        remoteInstance: existing.remoteInstance || '',
        previousInstance: existing.remoteInstance || '',
      }) === 'keep') return
      const link = existing || (await this.createPeer(from, !politePeer(this.state.selfId || '', from)))
      await this.applyPendingAnswer(from, link)
      const failed = link.pc.iceConnectionState === 'failed' || link.pc.connectionState === 'failed'
      const unanswered = link.pc.signalingState === 'have-local-offer' && (link.pc.iceConnectionState === 'new' || link.pc.iceConnectionState === 'checking')
      if ((failed || unanswered) && !politePeer(this.state.selfId || '', from)) await this.offer(from, link, true)
      return
    }
    let link = this.peers.get(from)
    if (!link || link.pc.connectionState === 'closed') link = await this.createPeer(from, false)
    if (data.kind === 'offer') {
      const plan = remoteDescriptionPlan({
        polite: politePeer(this.state.selfId || '', from),
        signaling: link.pc.signalingState,
        kind: 'offer',
        makingOffer: link.makingOffer,
        ice: link.pc.iceConnectionState,
        offerAgeMs: link.offerSentAt ? Date.now() - link.offerSentAt : 0,
        localUfrag: iceUfrag(link.pc.localDescription?.sdp || ''),
        remoteUfrag: iceUfrag(String(data.sdp || '')),
      })
      if (plan === 'ignore-offer') return
      if (plan === 'rollback-offer' && link.pc.signalingState === 'have-local-offer') {
        try {
          await link.pc.setLocalDescription({ type: 'rollback' })
        } catch (error) {
          this.notePeerError(link, error)
        }
      }
      try {
        await link.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
      } catch (error) {
        this.notePeerError(link, error)
        return
      }
      await this.flushIce(link)
      this.adoptTransceivers(link)
      await this.attachSenders(from, link)
      const answer = await link.pc.createAnswer()
      await this.commitLocal(link, answer)
      this.send({ t: 'signal', to: from, data: { kind: 'answer', sdp: link.pc.localDescription?.sdp || answer.sdp } })
      await this.tuneSenders(link)
      if (link.needsRenegotiate && link.pc.signalingState === 'stable') {
        link.needsRenegotiate = false
        if (link.caller) await this.offer(from, link, false)
        else this.send({ t: 'signal', to: from, data: { kind: 'restart' } })
      }
    } else if (data.kind === 'answer') {
      if (!(link.pc.signalingState === 'stable' && link.pc.remoteDescription)) this.stashAnswer(from, String(data.sdp || ''))
      try {
        await this.applyPendingAnswer(from, link)
      } catch (error) {
        this.notePeerError(link, error)
      }
    } else if (data.kind === 'ice' && data.candidate) {
      const queued = queueIceCandidate(Boolean(link.pc.remoteDescription), link.pendingIce, data.candidate as RTCIceCandidateInit)
      link.pendingIce = queued.pending.slice(-64)
      for (const candidate of queued.apply) {
        try {
          await link.pc.addIceCandidate(candidate)
        } catch {
          /* a stale candidate after an ICE restart */
        }
      }
    }
  }

  private async flushIce(link: PeerLink) {
    const queued = link.pendingIce.splice(0)
    for (const candidate of queued) {
      try {
        await link.pc.addIceCandidate(candidate)
      } catch {
        /* ignore */
      }
    }
  }

  private noteMedia(id: string, link: PeerLink) {
    const previous = this.state.media[id]
    this.state.media = {
      ...this.state.media,
      [id]: {
        connection: link.pc.connectionState,
        ice: link.pc.iceConnectionState,
        signaling: link.pc.signalingState,
        path: previous?.path || 'unknown',
        localType: previous?.localType || '',
        remoteType: previous?.remoteType || '',
        ageMs: Date.now() - link.openedAt,
        videoBytes: previous?.videoBytes || 0,
      },
    }
    this.state.mediaTick += 1
    const state = link.pc.connectionState
    const ice = link.pc.iceConnectionState
    if (mediaUp({ connection: state, ice })) link.askedRestart = false
    if ((state === 'failed' || state === 'disconnected' || ice === 'failed') && previous?.connection !== state) {
      this.note(`${this.nameOf(id)} is still in the room. Video will keep trying to connect.`)
    }
  }

  private rememberIce(servers: IceServer[], turn: TurnProvider, turnError: string | undefined, policy: string | undefined) {
    this.ice = servers
    this.state.turn = turn
    this.state.turnError = turnError
    this.state.iceTransportPolicy = policy === 'relay' ? 'relay' : 'all'
    this.iceStamp = `${JSON.stringify(servers)}|${turn}|${this.state.iceTransportPolicy}`
    this.iceFreshUntil = Date.now() + (turn === 'none' ? 4000 : 30000)
  }

  /** Re-read /api/ice so a relay added on the server is used without leaving the room. */
  private async refreshIce(): Promise<boolean> {
    if (Date.now() < this.iceFreshUntil) return false
    this.iceFreshUntil = Date.now() + (this.state.turn === 'none' ? 4000 : 30000)
    let body: { iceServers?: IceServer[]; turn?: TurnProvider; turnError?: string; iceTransportPolicy?: IcePolicy }
    try {
      const response = await withTimeout(fetch('/api/ice', { cache: 'no-store', signal: AbortSignal.timeout(5000) }), 6000, 'Relay')
      if (!response.ok) return false
      body = await response.json()
    } catch {
      return false
    }
    const servers = Array.isArray(body.iceServers) ? body.iceServers : []
    const turn = body.turn || 'none'
    const policy = body.iceTransportPolicy === 'relay' ? 'relay' : 'all'
    const stamp = `${JSON.stringify(servers)}|${turn}|${policy}`
    const gained = this.state.turn === 'none' && turn !== 'none'
    const changed = stamp !== this.iceStamp
    this.ice = servers
    this.state.turn = turn
    this.state.turnError = body.turnError
    this.state.iceTransportPolicy = policy
    this.iceStamp = stamp
    this.iceFreshUntil = Date.now() + (turn === 'none' ? 4000 : 30000)
    if (changed) {
      for (const link of this.peers.values()) {
        if (link.pc.connectionState === 'closed' || link.pc.signalingState !== 'stable' || link.makingOffer) continue
        try {
          link.pc.setConfiguration({ iceServers: this.ice, iceTransportPolicy: policy })
        } catch {
          /* the next offer still carries the new servers when the peer is recreated */
        }
      }
    }
    this.emit()
    return gained || changed
  }

  private async retryUnhealthy() {
    if (this.left || (this.state.status !== 'live' && this.state.status !== 'waiting' && this.state.status !== 'reconnecting')) return
    const previousTurn = this.state.turn
    await this.refreshIce()
    for (const [id, link] of this.peers) {
      const plan = iceRetryPlan({
        connection: link.pc.connectionState,
        ice: link.pc.iceConnectionState,
        ageMs: Date.now() - link.openedAt,
        turn: this.state.turn,
        previousTurn,
        signaling: link.pc.signalingState,
        offerAgeMs: link.offerSentAt ? Date.now() - link.offerSentAt : 0,
      })
      if (plan === 'wait') continue
      void this.recover(id)
    }
  }

  private async tuneSenders(link: PeerLink) {
    await this.tuneAudio(link.musicSender?.sender, this.state.opus.maxAverageBitrate)
    await this.tuneAudio(link.talkSender?.sender, 64_000)
    await this.tuneVideo(link.camSender?.sender, this.cameraTrack())
    await this.tuneVideo(link.screenSender?.sender, this.screenTrack())
  }

  private async tuneAudio(sender: RTCRtpSender | undefined, maxBitrate: number) {
    if (!sender) return
    const params = sender.getParameters()
    if (!params.encodings?.length) return
    params.encodings[0].maxBitrate = maxBitrate
    params.encodings[0].priority = 'high'
    ;(params.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType }).networkPriority = 'high'
    try {
      await sender.setParameters(params)
    } catch {
      /* ignore */
    }
  }

  private async tuneVideo(sender: RTCRtpSender | undefined, track: MediaStreamTrack | null) {
    if (!sender) return
    const params = sender.getParameters()
    if (!params.encodings?.length) return
    const settings = track?.getSettings() || {}
    params.encodings[0].maxBitrate = this.state.videoBitrate
    params.encodings[0].maxFramerate = 15
    params.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy(settings.width || 0, settings.height || 0)
    params.encodings[0].priority = 'very-low'
    ;(params.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType }).networkPriority = 'very-low'
    for (let index = 1; index < params.encodings.length; index++) params.encodings[index].active = false
    params.degradationPreference = 'maintain-framerate'
    try {
      await sender.setParameters(params)
    } catch {
      /* ignore */
    }
  }

  private async recover(id: string) {
    return this.enqueueSignal(id, () => this.recoverNow(id))
  }

  private async recoverNow(id: string) {
    const link = this.peers.get(id)
    if (!link || this.left) return
    if (link.pc.connectionState === 'closed' || link.pc.signalingState === 'closed') {
      this.peers.delete(id)
      this.syncMesh()
      return
    }
    await this.applyPendingAnswer(id, link)
    if (link.pc.signalingState === 'have-remote-offer') return
    const plan = iceRetryPlan({
      connection: link.pc.connectionState,
      ice: link.pc.iceConnectionState,
      ageMs: Date.now() - link.openedAt,
      turn: this.state.turn,
      previousTurn: this.state.turn,
      signaling: link.pc.signalingState,
      offerAgeMs: link.offerSentAt ? Date.now() - link.offerSentAt : 0,
    })
    if (plan === 'wait') return
    if (link.restartedAt && Date.now() - link.restartedAt < 15000) return
    link.restartedAt = Date.now()
    link.openedAt = Date.now()
    try {
      // A slow /api/ice refresh must not sit in front of the repair.
      void this.refreshIce()
      const pc = link.pc
      if (pc.connectionState === 'closed' || this.peers.get(id) !== link) return
      if (pc.signalingState === 'stable') {
        try {
          pc.setConfiguration({ iceServers: this.ice, iceTransportPolicy: this.state.iceTransportPolicy })
        } catch {
          /* keep the current servers and still restart */
        }
      }
      try {
        pc.restartIce()
      } catch {
        /* older browsers restart through the next offer */
      }
      const polite = politePeer(this.state.selfId || '', id)
      if (!polite || link.askedRestart) await this.offer(id, link, true)
      else {
        link.askedRestart = true
        this.send({ t: 'signal', to: id, data: { kind: 'restart' } })
      }
    } catch (error) {
      this.notePeerError(link, error)
    }
  }

  private notePeerError(link: PeerLink, error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    link.errors = [...link.errors, message.replace(/\s+/g, ' ').slice(0, 180)].slice(-6)
  }

  private adoptReceiverTrack(bucket: MediaStream, transceiver?: RTCRtpTransceiver) {
    const track = transceiver?.receiver.track
    if (!track || track.readyState === 'ended') return
    if (!bucket.getTracks().includes(track)) bucket.addTrack(track)
  }

  private performanceTrack() {
    if (!this.state.musicOn) return null
    if (this.state.role === 'host') {
      const track = this.engine.cueStream?.getAudioTracks()[0] || null
      if (track) track.contentHint = 'music'
      return track
    }
    return this.musicStream?.getAudioTracks()[0] || null
  }

  /** The self-view plays this track. The peer connection must send this same object, not a second capture. */
  private cameraTrack() {
    if (!this.state.camOn || this.pageHidesVideo()) return null
    const track = this.preview?.getVideoTracks().find((item) => item.readyState === 'live') || this.talkStream?.getVideoTracks().find((item) => item.readyState === 'live') || null
    if (track) track.enabled = true
    return track
  }

  private screenTrack() {
    if (!this.state.screenOn || this.pageHidesVideo()) return null
    const track = this.screenStream?.getVideoTracks().find((item) => item.readyState === 'live') || null
    return track
  }

  private async attachSenders(id: string, link: PeerLink) {
    const before = senderKey(link)
    const directionBefore = link.camSender?.currentDirection || ''
    if (link.pc.signalingState === 'have-remote-offer') {
      const audioOffer = sectionDirections(link.pc.remoteDescription?.sdp || '', 'audio')
      if (link.musicSender) link.musicSender.direction = legalDirection('sendrecv', audioOffer[0] || null)
      if (link.talkSender) link.talkSender.direction = legalDirection('sendrecv', audioOffer[1] || null)
    }
    await link.musicSender?.sender.replaceTrack(this.performanceTrack())
    const talk = this.state.talkOn ? this.talkStream?.getAudioTracks()[0] || null : null
    await link.talkSender?.sender.replaceTrack(talk)
    const recv = this.wantsIncomingVideo()
    const cam = this.cameraTrack()
    const offerDirs = link.pc.signalingState === 'have-remote-offer' ? videoDirectionsFromSdp(link.pc.remoteDescription?.sdp || '') : []
    const camDir = legalDirection(videoDirection(Boolean(cam), recv), offerDirs[0] || null)
    const prevCam = link.appliedCam
    if (link.camSender) link.camSender.direction = camDir
    await link.camSender?.sender.replaceTrack(cam)
    const screen = this.screenTrack()
    const screenDir = legalDirection(videoDirection(Boolean(screen), recv), offerDirs[1] || null)
    const prevScreen = link.appliedScreen
    if (link.screenSender) link.screenSender.direction = screenDir
    link.appliedCam = camDir
    link.appliedScreen = screenDir
    await link.screenSender?.sender.replaceTrack(screen)
    this.enableTrack(link.musicSender, this.state.musicOn)
    this.enableTrack(link.talkSender, this.state.talkOn)
    if (cam) cam.enabled = true
    const mic = this.performanceTrack()
    const after = senderKey(link)
    let directionStale = Boolean(cam) && (directionBefore === 'recvonly' || directionBefore === 'inactive')
    if (directionStale && cam && link.camRetry === cam.id) directionStale = false
    if (directionStale && cam) link.camRetry = cam.id
    this.state.localSend = cam
      ? `Sending the self-view camera (${cam.readyState}${cam.muted ? ', waiting for frames' : ''}, ${link.camSender?.direction || 'no transceiver'}). Mic ${mic ? mic.readyState : 'missing'}.`
      : `Camera is not on the peer connection. Mic ${mic ? mic.readyState : 'missing'}.`
    const directionChanged = prevCam !== undefined && (prevCam !== camDir || prevScreen !== screenDir)
    if ((before !== after || directionStale || directionChanged) && link.pc.localDescription) {
      if (link.pc.signalingState !== 'stable' || link.makingOffer) link.needsRenegotiate = true
      else if (link.caller) await this.offer(id, link, false)
      else this.send({ t: 'signal', to: id, data: { kind: 'restart' } })
    }
    if (link.pc.localDescription) await this.tuneSenders(link)
    this.state.mediaTick += 1
  }

  private enableTrack(transceiver: RTCRtpTransceiver | undefined, on: boolean) {
    const track = transceiver?.sender.track
    if (track) track.enabled = on
  }

  private applySendTracks() {
    for (const id of this.peers.keys()) {
      void this.enqueueSignal(id, async () => {
        const link = this.peers.get(id)
        if (link) await this.attachSenders(id, link)
      })
    }
  }

  private routeIncoming(id: string, index: number) {
    const link = this.peers.get(id)
    if (!link) return
    const person = this.state.participants.find((p) => p.id === id)
    if (index === 0) {
      if (person?.role === 'host' && this.state.role === 'guest') {
        this.engine.setCueReturn(link.music)
        this.detachPing?.()
        this.detachPing = this.engine.attachPing(link.music, (frame, mag) => {
          this.pingPeaks.push({ perf: this.engine.perfForContext(frame / this.engine.sampleRate), mag })
          this.finishPing()
        }) || null
        this.refreshCue()
      } else {
        this.engine.setRemoteMusic(id, link.music)
      }
    }
    if (index === 1) this.routeTalk()
    this.emit()
  }

  private routeTalk() {
    for (const [id, link] of this.peers) {
      const person = this.state.participants.find((p) => p.id === id)
      if (!person) continue
      const audible = person.role === 'host' || !person.music
      this.engine.setTalk(id, link.talk.getAudioTracks().length ? link.talk : null, audible && !person.mutedByHost)
    }
  }

  private refreshCue() {
    const pcm = this.state.monitorMode === 'pcm'
    this.engine.setCueAudible(!pcm && !this.state.preferLocalBacking)
  }

  private applyMonitor() {
    const pcm = this.state.monitorMode === 'pcm'
    this.refreshCue()
    void this.engine.ensurePcmPlayer()
    if (!pcm) {
      this.engine.stopPcmTap()
      return
    }
    if (this.state.role === 'host') {
      void this.engine.startPcmTap((samples, frame) => this.sendPcm(samples, frame))
    } else if (this.musicStream) {
      void this.engine.startMicPcmTap(this.musicStream, (samples, frame) => this.sendPcm(samples, frame))
    }
  }

  private sendPcm(samples: Float32Array, frame: number) {
    this.engine.refreshClockAnchor()
    const packet = encodePcmFrame(this.pcmSeq++, this.engine.perfForContext(frame / this.engine.sampleRate), samples)
    for (const link of this.peers.values()) {
      if (link.pcm?.readyState === 'open' && link.pcm.bufferedAmount < 200000) link.pcm.send(packet)
    }
  }

  private onPcm(_id: string, link: PeerLink, data: ArrayBuffer) {
    const frame = decodePcmFrame(data)
    if (!frame || link.remoteMinusLocal == null) return
    const localSent = frame.senderPerfMs - link.remoteMinusLocal
    const network = performance.now() - localSent
    if (network > 0 && network < 500) {
      link.pcmNet = [...link.pcmNet, network].slice(-30)
      const med = median(link.pcmNet) ?? network
      link.pcmTarget = Math.max(PCM_MIN_TARGET, med + 8)
    }
    const playAt = localSent + link.pcmTarget
    void this.engine.ensurePcmPlayer().then(() => {
      this.engine.writePcm(this.engine.frameForPerf(playAt), frame.samples)
    })
  }

  private applyJam() {
    const oneWay = this.primaryOneWay()
    this.engine.setJam(this.state.jamEnabled, this.state.jamDelayMs, oneWay?.ms ?? this.state.jamDelayMs)
  }

  primaryOneWay() {
    const host = this.state.role === 'guest' ? this.hostId() : this.state.participants.find((p) => p.role === 'guest' && p.admitted)?.id
    if (!host && this.state.role === 'host') return null
    const id = this.state.role === 'guest' ? this.hostId() : host
    if (!id) return null
    return this.estimateFor(id)
  }

  estimateFor(peerId: string) {
    const link = this.peers.get(peerId)
    const latency = this.state.latency[peerId]
    const pcmNet = median(link?.pcmNet || [])
    return estimateCueOneWayMs({
      rttMs: latency?.rttMs ?? link?.clockSamples.at(-1)?.rtt ?? 40,
      jitterBufferMs: latency?.jitterBufferMs ?? 0,
      ptimeMs: this.state.opus.ptimeMs,
      outputLatencyMs: this.engine.outputLatencyMs,
      audioPingMs: this.state.monitorMode === 'opus' ? this.state.audioPingMs : null,
      pcmNetworkMs: pcmNet,
      pcmTargetMs: link?.pcmTarget ?? PCM_MIN_TARGET,
      mode: this.state.monitorMode,
    })
  }

  private async pollStats() {
    let loudest = 0
    let speaker: string | null = null
    const local = this.engine.levels().input
    if (local > loudest) {
      loudest = local
      speaker = this.state.selfId || null
    }
    for (const [id, link] of this.peers) {
      const stats = await link.pc.getStats()
      let rtt: number | null = null
      let jitter: number | null = null
      let loss: number | null = null
      let jb: number | null = null
      let level = 0
      let bestAudioBytes = -1
      let videoBytes = 0
      stats.forEach((report) => {
        const row = report as unknown as Record<string, number | string>
        if (report.type === 'inbound-rtp' && row.kind === 'audio') {
          const bytes = Number(row.bytesReceived || 0)
          if (bytes < bestAudioBytes) return
          bestAudioBytes = bytes
          if (typeof row.jitter === 'number') jitter = row.jitter * 1000
          if (typeof row.packetsLost === 'number' && typeof row.packetsReceived === 'number') {
            const total = row.packetsLost + row.packetsReceived
            loss = total ? (row.packetsLost / total) * 100 : 0
          }
          if (typeof row.jitterBufferDelay === 'number' && Number(row.jitterBufferEmittedCount) > 0) {
            jb = (Number(row.jitterBufferDelay) / Number(row.jitterBufferEmittedCount)) * 1000
          }
          if (typeof row.audioLevel === 'number') level = row.audioLevel
        }
        if (report.type === 'inbound-rtp' && row.kind === 'video') videoBytes += Number(row.bytesReceived || 0)
        if (report.type === 'candidate-pair' && row.state === 'succeeded' && typeof row.currentRoundTripTime === 'number') {
          rtt = row.currentRoundTripTime * 1000
        }
        if (report.type === 'remote-inbound-rtp' && row.kind === 'audio' && typeof row.roundTripTime === 'number') {
          rtt = row.roundTripTime * 1000
        }
      })
      let path: MediaPath = this.state.media[id]?.path || 'unknown'
      let localCandidateId = ''
      let remoteCandidateId = ''
      stats.forEach((report) => {
        const row = report as unknown as { nominated?: boolean; selected?: boolean; state?: string; localCandidateId?: string; remoteCandidateId?: string }
        if (report.type === 'candidate-pair' && row.state === 'succeeded' && (row.nominated || row.selected) && row.localCandidateId) {
          localCandidateId = row.localCandidateId
          remoteCandidateId = row.remoteCandidateId || ''
        }
      })
      let localType = ''
      let remoteType = ''
      if (localCandidateId) {
        const local = stats.get(localCandidateId) as { candidateType?: string } | undefined
        const remote = remoteCandidateId ? (stats.get(remoteCandidateId) as { candidateType?: string } | undefined) : undefined
        localType = local?.candidateType || ''
        remoteType = remote?.candidateType || ''
        path = localType === 'relay' ? 'relay' : localType ? 'direct' : path
      }
      this.state.media = {
        ...this.state.media,
        [id]: {
          connection: link.pc.connectionState,
          ice: link.pc.iceConnectionState,
          signaling: link.pc.signalingState,
          path,
          localType,
          remoteType,
          ageMs: Date.now() - link.openedAt,
          videoBytes,
        },
      }
      const estimate = this.estimateFor(id)
      const best = bestClockSample(link.clockSamples)
      this.state.latency[id] = {
        rttMs: rtt ?? best?.rtt ?? null,
        jitterMs: jitter,
        packetLossPct: loss,
        jitterBufferMs: jb,
        oneWayMs: estimate.ms,
        oneWaySource: estimate.source,
        uncertaintyMs: estimate.uncertaintyMs,
        clockOffsetMs: link.remoteMinusLocal,
        clockRttMs: best?.rtt ?? null,
        pcmNetworkMs: median(link.pcmNet),
        audioLevel: level,
      }
      if (level > loudest) {
        loudest = level
        speaker = id
      }
    }
    this.state.activeSpeakerId = loudest > 0.02 ? speaker : this.state.activeSpeakerId
    this.state.loopbackMs = this.engine.loopbackMs
    this.applyJam()
    this.emit()
    this.postDiag()
  }

  private postDiag() {
    const code = this.state.code
    if (!code || this.left) return
    if (this.state.status !== 'live' && this.state.status !== 'waiting' && this.state.status !== 'reconnecting') return
    const now = Date.now()
    if (now - this.lastDiag < 3000) return
    this.lastDiag = now
    const report = sanitizeDiag({
      at: now,
      peerId: this.state.selfId || '',
      role: this.state.role || '',
      ua: navigator.userAgent,
      peers: [...this.peers.entries()].map(([id, link]) => ({
        id,
        signaling: link.pc.signalingState,
        ice: link.pc.iceConnectionState,
        connection: link.pc.connectionState,
        gathered: link.gathered,
        offers: link.offers,
        selected: this.state.media[id]?.localType ? { local: this.state.media[id].localType, remote: this.state.media[id].remoteType || '' } : null,
        errors: link.errors,
      })),
    })
    if (!report) return
    this.sendDiag(code, report)
  }

  private postDiagEvent(event: string, note: string) {
    const code = this.state.code
    if (!code || this.left) return
    const report = sanitizeDiag({
      at: Date.now(),
      peerId: this.state.selfId || this.resumeId || '',
      role: this.state.role || '',
      ua: navigator.userAgent,
      event,
      note,
      peers: [],
    })
    if (report) this.sendDiag(code, report)
  }

  private sendDiag(code: string, report: unknown) {
    void fetch(`/api/diag/${encodeURIComponent(code)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    }).catch(() => undefined)
  }

  private onTransport(payload: any) {
    if (!payload || this.state.role !== 'guest') return
    if (payload.action === 'record-start') {
      const estimate = this.hostId() ? this.estimateFor(this.hostId()!) : null
      this.punch = {
        takeId: payload.takeId,
        recordStartSample: payload.timelineSample,
        cueEpochHostPerfMs: payload.cueEpochHostPerfMs,
        hostSampleRate: payload.sampleRate,
        oneWayMs: this.state.preferLocalBacking ? 0 : (estimate?.ms ?? payload.oneWayHintMs ?? 30),
      }
      this.note(`Recording locally against the host grid (−${this.punch.oneWayMs.toFixed(0)} ms compensation armed).`)
      this.emit()
      return
    }
    if (payload.action === 'record-stop' && this.punch && payload.takeId === this.punch.takeId) {
      void this.finishLocalTake(payload.timelineSample)
      return
    }
    if (payload.action === 'play' || payload.action === 'stop' || payload.action === 'seek') {
      this.onControl?.(payload)
      return
    }
    if (payload.action === 'ping-arm') {
      this.pingPeaks = []
      this.pingExpected = []
      return
    }
    if (payload.action === 'ping') {
      const link = this.hostId() ? this.peers.get(this.hostId()!) : undefined
      const offset = link?.remoteMinusLocal ?? 0
      this.pingExpected.push(payload.hostPerf - offset)
      this.finishPing()
    }
  }

  private finishPing() {
    const delay = matchPingDelay(this.pingPeaks, this.pingExpected)
    if (delay == null || !this.hostId()) return
    this.state.audioPingMs = delay
    const link = this.peers.get(this.hostId()!)
    const payload = { t: 'ping-result', ms: delay }
    if (link?.clock?.readyState === 'open') link.clock.send(JSON.stringify(payload))
    else this.send({ t: 'clock', to: this.hostId(), payload })
    this.note(`Heard the cue ping ${delay.toFixed(1)} ms after it left the host.`)
    this.emit()
  }

  private async finishLocalTake(endSample: number) {
    const punch = this.punch
    this.punch = null
    if (!punch || !this.hostId()) return
    const link = this.peers.get(this.hostId()!)
    const offset = link?.remoteMinusLocal
    if (!link || offset == null) {
      this.note('Take kept locally but not uploaded: clock sync has no sample yet.')
      this.emit()
      return
    }
    const window = alignedRecordWindow({
      recordStartSample: punch.recordStartSample,
      recordEndSample: endSample,
      sampleRate: punch.hostSampleRate,
      cueEpochHostPerfMs: punch.cueEpochHostPerfMs,
      cueEpochTimelineSample: punch.recordStartSample,
      oneWayCueMs: punch.oneWayMs,
      guestInputLatencyMs: this.engine.inputLatencyMs,
      clockOffsetMs: offset,
    })
    const sliced = this.engine.sliceRolling(window.guestPerfStart, window.guestPerfEnd)
    if (!sliced) {
      this.note('No local audio in the record window. Is the performance mic open?')
      this.emit()
      return
    }
    const channels = sliced.right ? [sliced.audio, sliced.right] : [sliced.audio]
    const silent = isSilentTake(channels)
    if (silent) this.note('The local take looks silent. Check that the performance mic is the one you are singing into.')
    const placeAt = shiftPlacementForLateBuffer(
      window.placeAtSample,
      window.guestPerfStart,
      sliced.actualPerfStart,
      punch.hostSampleRate,
    )
    const wav = encodeWav(channels, this.engine.sampleRate)
    const detail = `compensated ${window.compensationMs.toFixed(1)} ms via ${this.state.monitorMode}`
    await this.sendTake(link, {
      takeId: punch.takeId,
      placeAtSample: placeAt,
      sampleRate: this.engine.sampleRate,
      compensationMs: window.compensationMs,
      detail,
      silent,
      wav,
    })
  }

  private async sendTake(
    link: PeerLink,
    take: { takeId: string; placeAtSample: number; sampleRate: number; compensationMs: number; detail: string; silent: boolean; wav: ArrayBuffer },
  ) {
    const channel = await this.waitForTakes(link)
    if (!channel) {
      await this.sendTakeHttp(take)
      return
    }
    const bytes = new Uint8Array(take.wav)
    const chunkSize = 16 * 1024
    const total = Math.ceil(bytes.byteLength / chunkSize)
    channel.send(
      JSON.stringify({
        t: 'begin',
        takeId: take.takeId,
        placeAtSample: take.placeAtSample,
        sampleRate: take.sampleRate,
        compensationMs: take.compensationMs,
        detail: take.detail,
        silent: take.silent,
        total,
        bytes: bytes.byteLength,
      }),
    )
    for (let index = 0; index < total; index++) {
      while (channel.bufferedAmount > 1_000_000) await new Promise((resolve) => window.setTimeout(resolve, 20))
      const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize)
      const packet = new Uint8Array(8 + slice.byteLength)
      const view = new DataView(packet.buffer)
      view.setUint32(0, index)
      view.setUint32(4, total)
      packet.set(slice, 8)
      channel.send(packet)
      this.state.takeProgress = (index + 1) / total
      this.emit()
    }
    channel.send(JSON.stringify({ t: 'end', takeId: take.takeId }))
    this.state.takeProgress = null
    this.note('Full-quality take delivered to the host timeline.')
    this.emit()
  }

  private async waitForTakes(link: PeerLink) {
    for (let i = 0; i < 20; i++) {
      if (link.takes?.readyState === 'open') return link.takes
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
    return null
  }

  private async sendTakeHttp(take: { takeId: string; placeAtSample: number; sampleRate: number; compensationMs: number; detail: string; silent: boolean; wav: ArrayBuffer }) {
    const bytes = new Uint8Array(take.wav)
    if (bytes.byteLength > 32 * 1024 * 1024) {
      this.note('The take is over 32 MB, so it was not uploaded.')
      this.emit()
      return
    }
    const chunkSize = 48 * 1024
    const total = Math.ceil(bytes.byteLength / chunkSize) || 1
    const meta = {
      t: 'begin',
      takeId: take.takeId,
      placeAtSample: take.placeAtSample,
      sampleRate: take.sampleRate,
      compensationMs: take.compensationMs,
      detail: `${take.detail}; via server`,
      silent: take.silent,
      total,
      bytes: bytes.byteLength,
    }
    try {
      for (let index = 0; index < total; index++) {
        const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize)
        const response = await fetch('/api/takes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            code: this.state.code,
            from: this.state.selfId,
            takeId: take.takeId,
            index,
            total,
            chunk: bytesToBase64(slice),
            meta,
          }),
        })
        if (!response.ok) {
          const text = await response.text()
          this.note(`Take upload through the server failed (${response.status}). ${text.slice(0, 140)}`)
          this.emit()
          return
        }
        this.state.takeProgress = (index + 1) / total
        this.emit()
      }
    } catch {
      this.note('Take upload through the server failed. The direct channel was also closed.')
      this.emit()
      return
    }
    this.state.takeProgress = null
    this.note(take.silent ? 'Silent take delivered through the server. Check the performance mic.' : 'Full-quality take delivered through the server.')
    this.emit()
  }

  private acceptRelayTake(from: string, body: any) {
    if (!body || typeof body !== 'object') return
    const bin = this.relayBins.get(from) || { take: undefined }
    this.relayBins.set(from, bin)
    if (Number(body.index) === 0 && body.meta) this.onTakeData(from, bin, JSON.stringify(body.meta))
    if (body.chunk) {
      const raw = base64ToBytes(String(body.chunk))
      const packet = new Uint8Array(8 + raw.byteLength)
      const view = new DataView(packet.buffer)
      view.setUint32(0, Number(body.index) || 0)
      view.setUint32(4, Number(body.total) || 1)
      packet.set(raw, 8)
      this.onTakeData(from, bin, packet.buffer)
    }
    if (Number(body.index) + 1 >= Number(body.total)) this.onTakeData(from, bin, JSON.stringify({ t: 'end', takeId: body.takeId }))
  }

  private onTakeData(id: string, link: { take?: NonNullable<PeerLink['take']> }, data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data)
      if (msg.t === 'begin') {
        link.take = { takeId: msg.takeId, total: msg.total, parts: [], meta: msg }
      } else if (msg.t === 'end' && link.take) {
        this.finishIncoming(id, link)
      }
      return
    }
    if (!link.take) return
    const view = new DataView(data)
    const index = view.getUint32(0)
    link.take.parts[index] = new Uint8Array(data.slice(8))
    this.state.takeProgress = link.take.parts.filter(Boolean).length / link.take.total
    this.emit()
  }

  private finishIncoming(id: string, link: { take?: NonNullable<PeerLink['take']> }) {
    const incoming = link.take
    link.take = undefined
    if (!incoming) return
    const size = incoming.parts.reduce((sum, part) => sum + (part?.byteLength || 0), 0)
    const wav = new Uint8Array(size)
    let offset = 0
    for (const part of incoming.parts) {
      if (!part) {
        this.note('Take upload was missing a chunk.')
        return
      }
      wav.set(part, offset)
      offset += part.byteLength
    }
    const decoded = decodeWavPCM(wav.buffer)
    const meta = incoming.meta
    this.state.takeProgress = null
    const silent = Boolean(meta.silent) || isSilentTake(decoded.channels)
    this.onTake?.({
      peerId: id,
      peerName: this.nameOf(id),
      takeId: String(meta.takeId),
      placeAtSample: Number(meta.placeAtSample),
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      compensationMs: Number(meta.compensationMs),
      detail: String(meta.detail || ''),
      silent,
    })
    this.note(
      silent
        ? `${this.nameOf(id)} take is silent. The file arrived, but it has no signal.`
        : `${this.nameOf(id)} take aligned (${Number(meta.compensationMs).toFixed(0)} ms removed).`,
    )
    this.emit()
  }

  videoStream(peerId: string, kind: 'camera' | 'screen' | 'self') {
    if (kind === 'self') return this.preview?.getVideoTracks().length ? this.preview : null
    const link = this.peers.get(peerId)
    if (!link) return null
    const stream = kind === 'camera' ? link.camera : link.screen
    return stream.getVideoTracks().length ? stream : null
  }

  private nameOf(id: string) {
    return this.state.participants.find((p) => p.id === id)?.name || 'Guest'
  }
}
