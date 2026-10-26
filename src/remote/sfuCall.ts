import { VIDEO_MAX_FRAMERATE, VIDEO_START_BITRATE, scaleResolutionDownBy, shouldSetVideoCodecPreferences, outboundVideoCodecs } from '../model/codecs'
import { udpIceServers, type IceServer } from '../model/media'
import { DEFAULT_OPUS, mungeOpusSdp, type OpusOptions } from '../model/sdp'

export type SfuKind = 'music' | 'talk' | 'camera' | 'screen'

export interface SfuPublication {
  peerId: string
  sessionId: string
  tracks: Array<{ trackName: string; kind: SfuKind }>
}

export interface SfuHost {
  iceServers: IceServer[]
  code: string
  peerId: string
  opus: OpusOptions
  tracks(): Record<SfuKind, MediaStreamTrack | null>
  onTrack(peerId: string, kind: SfuKind, track: MediaStreamTrack): void
  onState(state: { connection: string; ice: string; signaling: string }): void
  note(text: string): void
  sendPub(publication: SfuPublication): void
}

interface RemoteTrack {
  mid?: string
  trackName?: string
  errorCode?: string
  errorDescription?: string
}

interface SfuBody {
  sessionId?: string
  sessionDescription?: RTCSessionDescriptionInit
  tracks?: RemoteTrack[]
  requiresImmediateRenegotiation?: boolean
  error?: string
  errorCode?: string
  errorDescription?: string
  code?: string
}

/**
 * One PeerConnection to the Cloudflare Realtime SFU.
 * Publish local tracks, then pull each remote publication.
 * A failed publish or pull replaces the connection once, then stops.
 */
export class SfuCall {
  pc: RTCPeerConnection | null = null
  sessionId = ''
  /** True only after local tracks exist on this session. Announcements wait for this. */
  published = false
  connection = 'new'
  ice = 'new'
  signaling = 'stable'
  outboundVideo = 0
  outboundAudio = 0
  private closed = false
  private tries = 0
  private replaced = false
  private lane: Promise<void> = Promise.resolve()
  private pending: SfuPublication[] = []
  private pulled = new Set<string>()
  private midOf = new Map<string, { peerId: string; kind: SfuKind }>()
  private senders = new Map<SfuKind, RTCRtpSender>()
  private localMids: string[] = []

  constructor(private host: SfuHost) {}

  start() {
    return this.enqueue(() => this.establish())
  }

  pull(publication: SfuPublication) {
    if (!publication.sessionId || publication.peerId === this.host.peerId) return Promise.resolve()
    const previous = this.pending.find((item) => item.peerId === publication.peerId)
    if (!previous || previous.sessionId !== publication.sessionId) {
      for (const track of publication.tracks) this.pulled.delete(track.trackName)
    }
    this.pending = this.pending.filter((item) => item.peerId !== publication.peerId).concat(publication)
    return this.enqueue(async () => {
      if (!this.sessionId || !this.pc) return
      await this.pullPending()
    })
  }

  refreshTracks() {
    return this.enqueue(async () => {
      if (!this.pc) return
      await this.attachLocal()
    })
  }

  async cloudflareBytes() {
    const pc = this.pc
    if (!pc) return 0
    const stats = await pc.getStats()
    let pulls = 0
    let relay = 0
    stats.forEach((report) => {
      const row = report as unknown as Record<string, number | string>
      if (report.type === 'inbound-rtp') pulls += Number(row.bytesReceived || 0)
      if (report.type === 'outbound-rtp' && row.kind === 'video') this.outboundVideo = Math.max(this.outboundVideo, Number(row.bytesSent || 0))
      if (report.type === 'outbound-rtp' && row.kind === 'audio') this.outboundAudio = Math.max(this.outboundAudio, Number(row.bytesSent || 0))
      if (report.type !== 'candidate-pair') return
      const selected = Boolean(row.nominated) || Boolean(row.selected) || row.state === 'succeeded'
      if (!selected) return
      const local = stats.get(String(row.localCandidateId || '')) as { candidateType?: string } | undefined
      if (local?.candidateType !== 'relay') return
      relay += Number(row.bytesSent || 0) + Number(row.bytesReceived || 0)
    })
    return pulls + relay
  }

  close() {
    this.closed = true
    const sessionId = this.sessionId
    const tracks = this.trackClosures()
    this.pc?.close()
    this.pc = null
    this.sessionId = ''
    this.published = false
    this.localMids = []
    this.abandon(sessionId, tracks)
  }

  private trackClosures() {
    const mids = new Set<string>()
    for (const mid of this.localMids) if (mid) mids.add(mid)
    for (const mid of this.midOf.keys()) if (mid) mids.add(mid)
    return [...mids].map((mid) => ({ mid }))
  }

  private abandon(sessionId: string, tracks: Array<{ mid: string }>) {
    if (!sessionId) return
    void fetch('/api/sfu/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: this.host.code, peerId: this.host.peerId, sessionId, tracks, force: true }),
    }).catch(() => undefined)
  }

  private enqueue(job: () => Promise<void>) {
    const run = this.lane.then(job, job)
    this.lane = run.then(() => undefined, () => undefined)
    return run
  }

  private async establish() {
    if (this.closed) return
    this.tries += 1
    try {
      await this.publish()
    } catch (error) {
      await this.recover(error)
      return
    }
    await this.pullPending()
  }

  private async recover(error: unknown) {
    if (this.closed) return
    const code = String((error as { code?: string }).code || '')
    const message = error instanceof Error ? error.message : 'The media server did not connect.'
    if (code === 'cap' || code === 'disabled' || this.replaced || this.tries >= 2) {
      this.host.note(message)
      return
    }
    this.replaced = true
    this.host.note('Reconnecting media once.')
    this.reset()
    await this.establish()
  }

  private reset() {
    const abandoned = this.sessionId
    const tracks = this.trackClosures()
    this.pc?.close()
    this.pc = null
    this.sessionId = ''
    this.published = false
    this.localMids = []
    this.pulled.clear()
    this.midOf.clear()
    this.senders.clear()
    this.abandon(abandoned, tracks)
  }

  private async publish() {
    const created = await this.post('/api/sfu/session', { code: this.host.code, peerId: this.host.peerId })
    const sessionId = String(created.sessionId || '')
    if (!sessionId) throw new Error(created.error || 'The media server did not open a session.')
    this.sessionId = sessionId
    const pc = this.openPc(this.replaced)
    const kinds: SfuKind[] = ['music', 'talk', 'camera', 'screen']
    const localTracks = this.host.tracks()
    for (const kind of kinds) {
      const media = localTracks[kind] || (kind === 'camera' || kind === 'screen' ? 'video' : 'audio')
      const transceiver = pc.addTransceiver(media, { direction: 'sendonly' })
      this.senders.set(kind, transceiver.sender)
      if (kind === 'music' || kind === 'talk') this.preferOpus(transceiver)
      else this.preferVideo(transceiver)
    }
    await this.attachLocal()
    const offer = await pc.createOffer()
    const munged = mungeOpusSdp(offer.sdp || '', this.host.opus || DEFAULT_OPUS)
    try {
      await pc.setLocalDescription({ type: 'offer', sdp: munged })
    } catch {
      await pc.setLocalDescription(offer)
    }
    await waitGather(pc, 12000)
    const local = pc.localDescription
    if (!local?.sdp) throw new Error('The media offer was empty.')
    const tracks = kinds.map((kind) => {
      const mid = [...pc.getTransceivers()].find((item) => item.sender === this.senders.get(kind))?.mid || ''
      return { location: 'local', mid, trackName: trackName(this.host.peerId, kind) }
    })
    this.localMids = tracks.map((track) => track.mid).filter(Boolean)
    const answer = await this.post('/api/sfu/tracks', {
      code: this.host.code,
      peerId: this.host.peerId,
      sessionId,
      sessionDescription: { type: local.type, sdp: local.sdp },
      tracks,
    })
    const refused = (answer.tracks || []).find((track) => track.errorCode)
    if (refused) throw new Error(refused.errorDescription || 'A media track was refused.')
    if (!answer.sessionDescription?.sdp) throw new Error(answer.error || 'The media server did not answer the publish.')
    if (answer.sessionDescription.type === 'offer' || answer.requiresImmediateRenegotiation) await this.answerOffer(pc, answer.sessionDescription)
    else await pc.setRemoteDescription(answer.sessionDescription)
    await this.tune()
    this.published = true
    this.host.sendPub({
      peerId: this.host.peerId,
      sessionId,
      tracks: kinds.map((kind) => ({ trackName: trackName(this.host.peerId, kind), kind })),
    })
    this.emitState()
  }

  private async pullPending() {
    const pubs = this.pending.slice()
    const tracks: Array<{ location: 'remote'; sessionId: string; trackName: string; peerId: string; kind: SfuKind }> = []
    for (const pub of pubs) {
      for (const track of pub.tracks) {
        if (this.pulled.has(track.trackName)) continue
        tracks.push({ location: 'remote', sessionId: pub.sessionId, trackName: track.trackName, peerId: pub.peerId, kind: track.kind })
      }
    }
    if (!tracks.length || !this.pc || !this.sessionId) return
    let response: SfuBody
    try {
      response = await this.post('/api/sfu/tracks', {
        code: this.host.code,
        peerId: this.host.peerId,
        sessionId: this.sessionId,
        tracks: tracks.map((track) => ({ location: 'remote', sessionId: track.sessionId, trackName: track.trackName })),
      })
    } catch (error) {
      await this.recover(error)
      return
    }
    const remote = response.tracks || []
    let accepted = 0
    remote.forEach((row, index) => {
      const asked = tracks.find((item) => item.trackName === row.trackName) || tracks[index]
      if (!asked || row.errorCode || !row.mid) return
      this.midOf.set(row.mid, { peerId: asked.peerId, kind: asked.kind })
      this.pulled.add(asked.trackName)
      accepted += 1
    })
    // A publication that is still being created is not a failed connection.
    // The next announcement tries those track names again.
    if (!accepted || !response.sessionDescription?.sdp || !this.pc) return
    try {
      await this.answerOffer(this.pc, response.sessionDescription)
    } catch (error) {
      await this.recover(error)
      return
    }
    this.emitState()
  }

  private async answerOffer(pc: RTCPeerConnection, description: RTCSessionDescriptionInit) {
    await pc.setRemoteDescription(description)
    const answer = await pc.createAnswer()
    const munged = mungeOpusSdp(answer.sdp || '', this.host.opus || DEFAULT_OPUS)
    try {
      await pc.setLocalDescription({ type: 'answer', sdp: munged })
    } catch {
      await pc.setLocalDescription(answer)
    }
    await waitGather(pc, 2000)
    const local = pc.localDescription
    if (!local?.sdp) throw new Error('The media answer was empty.')
    const accepted = await this.post('/api/sfu/renegotiate', {
      code: this.host.code,
      peerId: this.host.peerId,
      sessionId: this.sessionId,
      sessionDescription: { type: local.type, sdp: local.sdp },
    })
    if (accepted.errorCode || accepted.code === 'cap' || accepted.code === 'disabled') {
      throw Object.assign(new Error(accepted.errorDescription || accepted.error || 'The media answer was refused.'), { code: accepted.errorCode || accepted.code })
    }
  }

  private openPc(wide: boolean) {
    const servers = wide ? this.host.iceServers : udpIceServers(this.host.iceServers)
    const pc = new RTCPeerConnection({
      iceServers: (servers.length ? servers : this.host.iceServers) as RTCIceServer[],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })
    this.pc = pc
    pc.ontrack = (event) => {
      const mid = event.transceiver.mid || ''
      const mapped = this.midOf.get(mid)
      if (!mapped) return
      this.host.onTrack(mapped.peerId, mapped.kind, event.track)
    }
    pc.onconnectionstatechange = () => this.emitState()
    pc.oniceconnectionstatechange = () => this.emitState()
    pc.onsignalingstatechange = () => this.emitState()
    return pc
  }

  private emitState() {
    const pc = this.pc
    if (!pc) return
    this.connection = pc.connectionState
    this.ice = pc.iceConnectionState
    this.signaling = pc.signalingState
    this.host.onState({ connection: this.connection, ice: this.ice, signaling: this.signaling })
  }

  private async attachLocal() {
    const tracks = this.host.tracks()
    for (const kind of ['music', 'talk', 'camera', 'screen'] as const) {
      const sender = this.senders.get(kind)
      if (!sender || sender.track === tracks[kind]) continue
      try {
        await sender.replaceTrack(tracks[kind])
      } catch {
        /* the next publish retry attaches it */
      }
    }
    await this.tune()
  }

  private async tune() {
    const tracks = this.host.tracks()
    await tuneAudio(this.senders.get('music'), 510_000)
    await tuneAudio(this.senders.get('talk'), 64_000)
    await tuneVideo(this.senders.get('camera'), tracks.camera)
    await tuneVideo(this.senders.get('screen'), tracks.screen)
  }

  private preferOpus(transceiver: RTCRtpTransceiver) {
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
      /* browser default */
    }
  }

  private preferVideo(transceiver: RTCRtpTransceiver) {
    if (!shouldSetVideoCodecPreferences(navigator.userAgent)) return
    const caps = RTCRtpSender.getCapabilities?.('video')
    if (!caps) return
    const ordered = outboundVideoCodecs(caps.codecs)
    if (!ordered.length) return
    try {
      transceiver.setCodecPreferences(ordered)
    } catch {
      /* browser default */
    }
  }

  private async post(path: string, body: unknown): Promise<SfuBody> {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let parsed: SfuBody = {}
    try {
      parsed = (await response.json()) as SfuBody
    } catch {
      parsed = {}
    }
    if (!response.ok) {
      const message = parsed.error || parsed.errorDescription || 'The media server refused the request.'
      const error = new Error(message) as Error & { code?: string }
      error.code = parsed.code || parsed.errorCode
      throw error
    }
    return parsed
  }
}

export function trackName(peerId: string, kind: SfuKind) {
  return `${peerId}:${kind}`
}

function hasUdpRelay(sdp: string) {
  return sdp.split('\n').some((line) => line.startsWith('a=candidate:') && line.includes(' udp ') && line.includes(' typ relay'))
}

function waitGather(pc: RTCPeerConnection, ms: number) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  if (hasUdpRelay(pc.localDescription?.sdp || '')) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let finished = false
    let quiet = 0
    const finish = () => {
      if (finished) return
      finished = true
      window.clearTimeout(cap)
      window.clearTimeout(quiet)
      pc.removeEventListener('icegatheringstatechange', onState)
      pc.removeEventListener('icecandidate', onCandidate)
      resolve()
    }
    const cap = window.setTimeout(finish, ms)
    const onState = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) return finish()
      const text = event.candidate.candidate || ''
      if (!/ typ relay /.test(text) || !/ udp /.test(text)) return
      window.clearTimeout(quiet)
      quiet = window.setTimeout(finish, 400)
    }
    pc.addEventListener('icegatheringstatechange', onState)
    pc.addEventListener('icecandidate', onCandidate)
  })
}

async function tuneAudio(sender: RTCRtpSender | undefined, maxBitrate: number) {
  if (!sender) return
  const params = sender.getParameters()
  if (!params.encodings?.length) return
  params.encodings[0].maxBitrate = maxBitrate
  params.encodings[0].priority = 'high'
  try {
    await sender.setParameters(params)
  } catch {
    /* before the description is applied */
  }
}

async function tuneVideo(sender: RTCRtpSender | undefined, track: MediaStreamTrack | null) {
  if (!sender) return
  const params = sender.getParameters()
  if (!params.encodings?.length) return
  const settings = track?.getSettings() || {}
  params.encodings[0].maxBitrate = VIDEO_START_BITRATE
  params.encodings[0].maxFramerate = VIDEO_MAX_FRAMERATE
  params.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy(settings.width || 0, settings.height || 0, 240)
  params.encodings[0].priority = 'medium'
  params.degradationPreference = 'maintain-framerate'
  for (let index = 1; index < params.encodings.length; index++) params.encodings[index].active = false
  try {
    await sender.setParameters(params)
  } catch {
    /* before the description is applied */
  }
}
