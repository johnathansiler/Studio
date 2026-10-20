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
import { DEFAULT_OPUS, mungeOpusSdp, type OpusOptions } from '../model/sdp'
import { decodeWavPCM, encodeWav } from '../model/wav'

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
  take?: {
    takeId: string
    total: number
    parts: Uint8Array[]
    meta: Record<string, unknown>
  }
  restarting?: boolean
}

const PCM_MIN_TARGET = 18

export class SessionClient {
  state: SessionState
  private connectOpts: { name: string; create?: boolean; code?: string } | null = null
  private ws: WebSocket | null = null
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
  private onTake: ((take: IncomingTake) => void) | null = null
  private resumeId = ''

  constructor(private engine: AudioEngine) {
    this.state = {
      status: 'idle',
      name: localStorage.getItem('cueharbor-name') || 'Engineer',
      participants: [],
      chat: [],
      musicOn: true,
      talkOn: true,
      camOn: true,
      screenOn: false,
      hand: false,
      monitorMode: 'opus',
      jamEnabled: false,
      jamDelayMs: 40,
      opus: { ...DEFAULT_OPUS },
      devices: [],
      micId: '',
      camId: '',
      outId: '',
      latency: {},
      loopbackMs: null,
      audioPingMs: null,
      takeProgress: null,
      activeSpeakerId: null,
      reactions: {},
      log: [],
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

  connect(opts: { name: string; create?: boolean; code?: string }) {
    this.left = false
    this.state.name = opts.name.trim() || 'Guest'
    localStorage.setItem('cueharbor-name', this.state.name)
    this.state.status = 'connecting'
    this.state.error = undefined
    this.connectOpts = opts
    const key = `cueharbor-resume:${opts.create ? 'new' : opts.code}`
    if (!opts.create) this.resumeId = sessionStorage.getItem(key) || ''
    this.emit()
    this.openSocket()
  }

  leave() {
    this.left = true
    this.send({ t: 'leave' })
    this.teardown()
    this.state.status = 'idle'
    this.state.code = undefined
    this.state.participants = []
    this.emit()
  }

  private teardown() {
    window.clearInterval(this.clockTimer)
    window.clearInterval(this.statsTimer)
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
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 400
      this.send({
        t: 'hello',
        name: this.state.name,
        create: Boolean(opts.create),
        code: opts.code?.toUpperCase(),
        resumeId: this.resumeId || undefined,
      })
    }
    ws.onmessage = (event) => {
      void this.onServer(JSON.parse(String(event.data)))
    }
    ws.onclose = () => {
      if (this.left || this.ws !== ws) return
      this.state.status = 'reconnecting'
      this.note('Signaling dropped. Reconnecting…')
      this.emit()
      window.setTimeout(() => this.openSocket(), this.backoff)
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
      this.ice = msg.iceServers || []
      this.resumeId = msg.id
      sessionStorage.setItem(`cueharbor-resume:${msg.code}`, msg.id)
      this.state.status = msg.role === 'host' || this.selfAdmitted() ? 'live' : 'waiting'
      this.note(`${msg.role === 'host' ? 'Hosting' : 'Joined'} ${msg.code}`)
      this.emit()
      await this.openDevices()
      this.syncMesh()
      this.startMaintenance()
      return
    }
    if (msg.t === 'roster') {
      this.state.participants = msg.participants
      const admitted = this.selfAdmitted()
      this.state.status = this.state.role === 'host' || admitted ? 'live' : 'waiting'
      this.emit()
      this.syncMesh()
      this.routeTalk()
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
      await this.onSignal(msg.from, msg.data)
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
    if (on && !this.talkStream?.getVideoTracks().length) await this.openDevices()
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
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false })
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

  private async openDevices() {
    await this.engine.resume()
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48000,
      latency: 0,
      googEchoCancellation: false,
      googNoiseSuppression: false,
      googAutoGainControl: false,
      googHighpassFilter: false,
      deviceId: this.state.micId ? { exact: this.state.micId } : undefined,
    }
    try {
      this.musicStream?.getTracks().forEach((track) => track.stop())
      this.musicStream = await navigator.mediaDevices.getUserMedia({ audio: audio as MediaTrackConstraints, video: false })
      const track = this.musicStream.getAudioTracks()[0]
      if (track) {
        track.contentHint = 'music'
        try {
          await track.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 })
        } catch {
          this.note('Browser kept some mic processing on. The take is still recorded locally.')
        }
      }
      this.engine.setLocalMic(this.musicStream)
      if (this.state.role === 'guest') await this.engine.startRolling(this.musicStream)
    } catch {
      this.note('Microphone permission is blocked. You can still listen.')
    }
    try {
      this.talkStream?.getAudioTracks().forEach((track) => track.stop())
      this.talkStream?.getVideoTracks().forEach((track) => track.stop())
      const video = this.state.camOn
        ? {
            width: 1280,
            height: 720,
            frameRate: 24,
            deviceId: this.state.camId ? { exact: this.state.camId } : undefined,
          }
        : false
      this.talkStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId: this.state.micId ? { exact: this.state.micId } : undefined,
        },
        video,
      })
      const talk = this.talkStream.getAudioTracks()[0]
      if (talk) talk.contentHint = 'speech'
      this.preview = new MediaStream(this.talkStream.getVideoTracks())
    } catch {
      this.note('Talkback/camera failed. Performance mic is still available.')
      if (!this.talkStream && this.musicStream) this.talkStream = this.musicStream
    }
    const listed = await navigator.mediaDevices.enumerateDevices()
    this.state.devices = listed.map((device) => ({ deviceId: device.deviceId, label: device.label || device.kind, kind: device.kind }))
    this.applySendTracks()
    this.applyMonitor()
    this.emit()
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

  private startMaintenance() {
    window.clearInterval(this.clockTimer)
    window.clearInterval(this.statsTimer)
    this.clockTimer = window.setInterval(() => this.pingClocks(), 800)
    this.statsTimer = window.setInterval(() => void this.pollStats(), 1000)
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
    for (const peer of this.remoteAdmitted()) {
      if (!this.peers.has(peer.id) && this.state.selfId && this.state.selfId < peer.id) {
        void this.createPeer(peer.id, true)
      } else if (!this.peers.has(peer.id)) {
        void this.createPeer(peer.id, false)
      }
    }
  }

  private remoteAdmitted() {
    return this.state.participants.filter((p) => p.admitted && p.id !== this.state.selfId)
  }

  private async createPeer(id: string, caller: boolean) {
    if (this.peers.has(id)) return this.peers.get(id)!
    const pc = new RTCPeerConnection({ iceServers: this.ice })
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
    }
    link.musicSender = pc.addTransceiver('audio', { direction: 'sendrecv' })
    link.talkSender = pc.addTransceiver('audio', { direction: 'sendrecv' })
    link.camSender = pc.addTransceiver('video', { direction: 'sendrecv' })
    link.screenSender = pc.addTransceiver('video', { direction: 'sendrecv' })
    this.preferOpus(link.musicSender)
    this.preferOpus(link.talkSender)
    this.peers.set(id, link)
    pc.onicecandidate = (event) => {
      if (event.candidate) this.send({ t: 'signal', to: id, data: { kind: 'ice', candidate: event.candidate.toJSON() } })
    }
    pc.ontrack = (event) => {
      const index = pc.getTransceivers().indexOf(event.transceiver)
      const bucket =
        index === 0 ? link.music : index === 1 ? link.talk : index === 2 ? link.camera : index === 3 ? link.screen : null
      const target =
        bucket ??
        (event.track.kind === 'audio' ? (link.music.getAudioTracks().length ? link.talk : link.music) : link.camera.getVideoTracks().length ? link.screen : link.camera)
      this.tuneReceiver(event.receiver, target === link.music)
      if (!target.getTracks().includes(event.track)) target.addTrack(event.track)
      const routed = target === link.music ? 0 : target === link.talk ? 1 : target === link.camera ? 2 : 3
      this.routeIncoming(id, routed)
    }
    pc.ondatachannel = (event) => this.bindChannel(id, link, event.channel)
    pc.onconnectionstatechange = () => {
      this.note(`${this.nameOf(id)} ${pc.connectionState}`)
      if (pc.connectionState === 'failed') this.recover(id)
      this.emit()
    }
    if (caller) {
      link.clock = pc.createDataChannel('clock', { ordered: true })
      link.takes = pc.createDataChannel('takes', { ordered: true })
      link.pcm = pc.createDataChannel('pcm', { ordered: false, maxRetransmits: 0 })
      this.bindChannel(id, link, link.clock)
      this.bindChannel(id, link, link.takes)
      this.bindChannel(id, link, link.pcm)
      await this.offer(id, link, false)
    }
    await this.attachSenders(link)
    this.emit()
    return link
  }

  private preferOpus(transceiver: RTCRtpTransceiver) {
    const caps = RTCRtpSender.getCapabilities?.('audio')
    if (!caps) return
    const opus = caps.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'audio/opus')
    const rest = caps.codecs.filter((codec) => codec.mimeType.toLowerCase() !== 'audio/opus')
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
    const offer = await link.pc.createOffer({ iceRestart })
    offer.sdp = mungeOpusSdp(offer.sdp || '', this.state.opus)
    await link.pc.setLocalDescription(offer)
    this.send({ t: 'signal', to: id, data: { kind: 'offer', sdp: offer.sdp } })
  }

  private async onSignal(from: string, data: any) {
    if (!data) return
    if (data.kind === 'restart') {
      if (this.state.selfId && this.state.selfId < from) {
        const link = this.peers.get(from) || (await this.createPeer(from, true))
        await this.offer(from, link, true)
      }
      return
    }
    let link = this.peers.get(from)
    if (!link || link.pc.connectionState === 'closed') link = await this.createPeer(from, false)
    if (data.kind === 'offer') {
      const sdp = mungeOpusSdp(data.sdp, this.state.opus)
      await link.pc.setRemoteDescription({ type: 'offer', sdp })
      const answer = await link.pc.createAnswer()
      answer.sdp = mungeOpusSdp(answer.sdp || '', this.state.opus)
      await link.pc.setLocalDescription(answer)
      this.send({ t: 'signal', to: from, data: { kind: 'answer', sdp: answer.sdp } })
      await this.tuneSenders(link)
    } else if (data.kind === 'answer') {
      if (link.pc.signalingState === 'have-local-offer') {
        await link.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
        await this.tuneSenders(link)
      }
    } else if (data.kind === 'ice' && data.candidate) {
      try {
        await link.pc.addIceCandidate(data.candidate)
      } catch {
        /* candidate raced the description */
      }
    }
  }

  private async tuneSenders(link: PeerLink) {
    const sender = link.musicSender?.sender
    if (!sender) return
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    params.encodings[0].maxBitrate = this.state.opus.maxAverageBitrate
    params.encodings[0].priority = 'high'
    ;(params.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: string }).networkPriority = 'high'
    try {
      await sender.setParameters(params)
    } catch {
      /* ignore */
    }
  }

  private recover(id: string) {
    const link = this.peers.get(id)
    if (!link || link.restarting) return
    link.restarting = true
    link.pc.close()
    this.peers.delete(id)
    if (this.state.selfId && this.state.selfId < id) void this.createPeer(id, true)
    else this.send({ t: 'signal', to: id, data: { kind: 'restart' } })
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

  private async attachSenders(link: PeerLink) {
    await link.musicSender?.sender.replaceTrack(this.performanceTrack())
    const talk = this.state.talkOn ? this.talkStream?.getAudioTracks()[0] || null : null
    await link.talkSender?.sender.replaceTrack(talk)
    const cam = this.state.camOn ? this.talkStream?.getVideoTracks()[0] || null : null
    await link.camSender?.sender.replaceTrack(cam)
    await link.screenSender?.sender.replaceTrack(this.state.screenOn ? this.screenStream?.getVideoTracks()[0] || null : null)
    this.enableTrack(link.musicSender, this.state.musicOn)
    this.enableTrack(link.talkSender, this.state.talkOn)
    this.enableTrack(link.camSender, this.state.camOn)
  }

  private enableTrack(transceiver: RTCRtpTransceiver | undefined, on: boolean) {
    const track = transceiver?.sender.track
    if (track) track.enabled = on
  }

  private applySendTracks() {
    for (const link of this.peers.values()) void this.attachSenders(link)
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
        this.engine.setCueAudible(this.state.monitorMode === 'opus')
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

  private applyMonitor() {
    const pcm = this.state.monitorMode === 'pcm'
    this.engine.setCueAudible(!pcm)
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
        if (report.type === 'candidate-pair' && row.state === 'succeeded' && typeof row.currentRoundTripTime === 'number') {
          rtt = row.currentRoundTripTime * 1000
        }
        if (report.type === 'remote-inbound-rtp' && row.kind === 'audio' && typeof row.roundTripTime === 'number') {
          rtt = row.roundTripTime * 1000
        }
      })
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
        oneWayMs: estimate?.ms ?? payload.oneWayHintMs ?? 30,
      }
      this.note(`Recording locally against the host grid (−${this.punch.oneWayMs.toFixed(0)} ms compensation armed).`)
      this.emit()
      return
    }
    if (payload.action === 'record-stop' && this.punch && payload.takeId === this.punch.takeId) {
      void this.finishLocalTake(payload.timelineSample)
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
    const placeAt = shiftPlacementForLateBuffer(
      window.placeAtSample,
      window.guestPerfStart,
      sliced.actualPerfStart,
      punch.hostSampleRate,
    )
    const wav = encodeWav([sliced.audio], this.engine.sampleRate)
    const detail = `compensated ${window.compensationMs.toFixed(1)} ms via ${this.state.monitorMode}`
    await this.sendTake(link, {
      takeId: punch.takeId,
      placeAtSample: placeAt,
      sampleRate: this.engine.sampleRate,
      compensationMs: window.compensationMs,
      detail,
      wav,
    })
  }

  private async sendTake(
    link: PeerLink,
    take: { takeId: string; placeAtSample: number; sampleRate: number; compensationMs: number; detail: string; wav: ArrayBuffer },
  ) {
    const channel = await this.waitForTakes(link)
    if (!channel) {
      this.note('Direct channel is not open, so the full-quality take could not upload.')
      this.emit()
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

  private onTakeData(id: string, link: PeerLink, data: string | ArrayBuffer) {
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

  private finishIncoming(id: string, link: PeerLink) {
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
    this.onTake?.({
      peerId: id,
      peerName: this.nameOf(id),
      takeId: String(meta.takeId),
      placeAtSample: Number(meta.placeAtSample),
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      compensationMs: Number(meta.compensationMs),
      detail: String(meta.detail || ''),
    })
    this.note(`${this.nameOf(id)} take aligned (${Number(meta.compensationMs).toFixed(0)} ms removed).`)
    this.emit()
  }

  videoStream(peerId: string, kind: 'camera' | 'screen' | 'self') {
    if (kind === 'self') return this.preview
    const link = this.peers.get(peerId)
    if (!link) return null
    const stream = kind === 'camera' ? link.camera : link.screen
    return stream.getVideoTracks().length ? stream : null
  }

  private nameOf(id: string) {
    return this.state.participants.find((p) => p.id === id)?.name || 'Guest'
  }
}
