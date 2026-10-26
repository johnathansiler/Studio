import { VIDEO_MAX_FRAMERATE, VIDEO_START_BITRATE, scaleResolutionDownBy, shouldSetVideoCodecPreferences, sendVideoCodecs } from '../model/codecs'
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
  /** Bumped when a failed path is replaced, so an in-flight request cannot keep going. */
  private attempt = 0
  private inflight: AbortController | null = null
  private recovering = false
  /** Safari reports ICE failed while a subscribe answer is still being gathered. Closing then drops the answer. */
  private suppressRevive = false
  private reviveAfterAnswer = false
  /** Last subscribe rows, kind:mid:error, so a phone diag can show an empty camera. */
  private lastPull = ''

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

  /** Counters only. No SDP and no credentials. */
  async mediaFacts() {
    const pc = this.pc
    const facts = {
      sessionId: this.sessionId,
      published: this.published,
      dtls: this.connection,
      ice: this.ice,
      signaling: this.signaling,
      sending: [...this.senders.keys()],
      pulled: [...this.midOf.entries()].map(([mid, row]) => ({ mid, kind: row.kind, peer: row.peerId.slice(0, 8) })),
      pull: this.lastPull,
      selected: null as { local: string; remote: string; protocol: string; relayProtocol: string } | null,
      outAudio: 0,
      outVideo: 0,
      outCodec: '',
      outFrames: 0,
      inAudio: 0,
      inVideo: 0,
      inCodec: '',
      inFrames: 0,
      inReceived: 0,
    }
    if (!pc) return facts
    try {
      const stats = await pc.getStats()
      stats.forEach((report) => {
        const row = report as unknown as Record<string, number | string | boolean>
        if (report.type === 'outbound-rtp' && row.kind === 'audio') facts.outAudio += Number(row.bytesSent || 0)
        if (report.type === 'outbound-rtp' && row.kind === 'video') {
          facts.outVideo += Number(row.bytesSent || 0)
          facts.outFrames += Number(row.framesEncoded || 0)
          const codec = stats.get(String(row.codecId || '')) as { mimeType?: string } | undefined
          if (codec?.mimeType) facts.outCodec = codec.mimeType
        }
        if (report.type === 'inbound-rtp' && row.kind === 'audio') facts.inAudio += Number(row.bytesReceived || 0)
        if (report.type === 'inbound-rtp' && row.kind === 'video') {
          facts.inVideo += Number(row.bytesReceived || 0)
          facts.inFrames += Number(row.framesDecoded || 0)
          facts.inReceived += Number(row.framesReceived || 0)
          const codec = stats.get(String(row.codecId || '')) as { mimeType?: string } | undefined
          if (codec?.mimeType) facts.inCodec = codec.mimeType
        }
        if (report.type !== 'candidate-pair') return
        const chosen = Boolean(row.nominated) || Boolean(row.selected) || row.state === 'succeeded'
        if (!chosen) return
        const local = stats.get(String(row.localCandidateId || '')) as { candidateType?: string; protocol?: string; relayProtocol?: string } | undefined
        const remote = stats.get(String(row.remoteCandidateId || '')) as { candidateType?: string; relayProtocol?: string } | undefined
        facts.selected = {
          local: local?.candidateType || '',
          remote: remote?.candidateType || '',
          protocol: local?.protocol || '',
          relayProtocol: local?.relayProtocol || remote?.relayProtocol || '',
        }
      })
    } catch {
      /* the connection is closing */
    }
    return facts
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
      const code = String((error as { code?: string }).code || '')
      if (code === 'replaced') return
      await this.recover(error)
      return
    }
    await this.pullPending()
  }

  private async recover(error: unknown) {
    if (this.closed || this.recovering) return
    this.recovering = true
    try {
      await this.revive(error)
    } finally {
      this.recovering = false
    }
  }

  private async revive(error: unknown) {
    if (this.closed) return
    const code = String((error as { code?: string }).code || '')
    const message = error instanceof Error ? error.message : 'The media server did not connect.'
    if (code === 'cap' || code === 'disabled' || code === 'replaced' || this.replaced || this.tries >= 2) {
      if (code !== 'replaced') this.host.note(message)
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
    const generation = this.attempt
    const pc = this.openPc(this.replaced)
    const kinds: SfuKind[] = ['music', 'talk', 'camera', 'screen']
    const localTracks = this.host.tracks()
    const sending: SfuKind[] = []
    for (const kind of kinds) {
      const track = localTracks[kind]
      // An empty video section never sends frames. Safari still starts an encoder for it
      // and then fails the whole connection while the subscribe answer is gathered.
      if ((kind === 'camera' || kind === 'screen') && !track) continue
      const transceiver = pc.addTransceiver(track || 'audio', { direction: 'sendonly' })
      this.senders.set(kind, transceiver.sender)
      if (kind === 'music' || kind === 'talk') this.preferOpus(transceiver)
      else this.preferVideo(transceiver)
      sending.push(kind)
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
    if (generation !== this.attempt || this.pc !== pc) throw Object.assign(new Error('The media path was replaced.'), { code: 'replaced' })
    const local = pc.localDescription
    if (!local?.sdp) throw new Error('The media offer was empty.')
    const tracks = sending.map((kind) => {
      const mid = [...pc.getTransceivers()].find((item) => item.sender === this.senders.get(kind))?.mid || ''
      return { location: 'local', mid, trackName: trackName(this.host.peerId, kind) }
    })
    this.localMids = tracks.map((track) => track.mid).filter(Boolean)
    const created = await this.post('/api/sfu/session', { code: this.host.code, peerId: this.host.peerId })
    const sessionId = String(created.sessionId || '')
    if (!sessionId) throw new Error(created.error || 'The media server did not open a session.')
    this.sessionId = sessionId
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
    const announced = sending.filter((kind) => kind === 'music' || kind === 'talk' || localTracks[kind])
    this.host.sendPub({
      peerId: this.host.peerId,
      sessionId,
      tracks: announced.map((kind) => ({ trackName: trackName(this.host.peerId, kind), kind })),
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
      const code = String((error as { code?: string }).code || '')
      // The socket may be down for a few seconds. The next announcement retries.
      if (code === 'unreachable' || code === 'forbidden' || code === 'replaced' || error instanceof TypeError) return
      await this.recover(error)
      return
    }
    if (this.pc == null) return
    const remote = response.tracks || []
    this.lastPull = remote.map((row) => `${String(row.trackName || '').split(':').pop() || ''}:${row.mid || ''}:${row.errorCode || ''}`).join(',').slice(0, 240)
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
      const code = String((error as { code?: string }).code || '')
      if (code === 'unreachable' || code === 'forbidden' || code === 'replaced' || error instanceof TypeError) return
      await this.recover(error)
      return
    }
    this.emitState()
  }

  private async answerOffer(pc: RTCPeerConnection, description: RTCSessionDescriptionInit) {
    // A subscribed track is added to a connection that is already up. Safari
    // marks that ICE check failed while the answer is gathered, and tearing
    // the connection down here throws the answer away. Hold the replacement
    // until Cloudflare has the answer. The bundled transport already exists.
    this.suppressRevive = true
    try {
      await pc.setRemoteDescription(description)
      this.deliverRemote()
      const answer = await pc.createAnswer()
      const munged = mungeOpusSdp(answer.sdp || '', this.host.opus || DEFAULT_OPUS)
      try {
        await pc.setLocalDescription({ type: 'answer', sdp: munged })
      } catch {
        await pc.setLocalDescription(answer)
      }
      await waitGather(pc, 2000)
      if (this.pc !== pc || this.closed) throw Object.assign(new Error('The media path was replaced.'), { code: 'replaced' })
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
      this.deliverRemote()
    } finally {
      this.suppressRevive = false
      const retry = this.reviveAfterAnswer
      this.reviveAfterAnswer = false
      if (retry && this.pc === pc) this.queueRevive(pc)
    }
  }

  /** Safari often fires ontrack before transceiver.mid is filled in. The mid map is already known. */
  private deliverRemote() {
    const pc = this.pc
    if (!pc) return
    for (const transceiver of pc.getTransceivers()) {
      const mid = transceiver.mid || ''
      const mapped = mid ? this.midOf.get(mid) : undefined
      if (!mapped) continue
      const track = transceiver.receiver.track
      if (!track || track.readyState === 'ended') continue
      const want = mapped.kind === 'music' || mapped.kind === 'talk' ? 'audio' : 'video'
      if (track.kind !== want) continue
      this.host.onTrack(mapped.peerId, mapped.kind, track)
    }
  }

  private openPc(wide: boolean) {
    const servers = wide ? this.host.iceServers : udpIceServers(this.host.iceServers)
    const list = (servers.length ? servers : this.host.iceServers) as RTCIceServer[]
    const relay = list.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
      return urls.some((url) => /^turns?:/i.test(String(url)))
    })
    const pc = new RTCPeerConnection({
      iceServers: list,
      iceTransportPolicy: relay ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })
    this.pc = pc
    pc.ontrack = (event) => {
      const mid = event.transceiver.mid || ''
      const mapped = mid ? this.midOf.get(mid) : undefined
      if (mapped) {
        this.host.onTrack(mapped.peerId, mapped.kind, event.track)
        return
      }
      queueMicrotask(() => this.deliverRemote())
    }
    pc.onconnectionstatechange = () => {
      this.emitState()
      this.queueRevive(pc)
    }
    pc.oniceconnectionstatechange = () => {
      this.emitState()
      this.queueRevive(pc)
    }
    pc.onsignalingstatechange = () => this.emitState()
    return pc
  }

  private queueRevive(pc: RTCPeerConnection) {
    if (this.recovering || this.replaced || this.closed || this.pc !== pc) return
    if (pc.connectionState !== 'failed' && pc.iceConnectionState !== 'failed') return
    if (this.suppressRevive) {
      this.reviveAfterAnswer = true
      return
    }
    // Drop the subscribe that is still in flight, then replace on the same queue
    // so the new session is not negotiated at the same time as the old one.
    this.recovering = true
    this.attempt += 1
    this.inflight?.abort()
    // Closing the failed connection releases a gather that is still waiting,
    // so the replacement queued below is not stuck behind it.
    this.reset()
    const error = Object.assign(new Error('The media path failed.'), { code: 'ice' })
    void this.enqueue(async () => {
      try {
        await this.revive(error)
      } finally {
        this.recovering = false
      }
    })
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
    const pc = this.pc
    const added: SfuKind[] = []
    for (const kind of ['music', 'talk', 'camera', 'screen'] as const) {
      const track = tracks[kind]
      let sender = this.senders.get(kind)
      if (!sender && track && pc && (kind === 'camera' || kind === 'screen')) {
        const transceiver = pc.addTransceiver(track, { direction: 'sendonly' })
        this.senders.set(kind, transceiver.sender)
        this.preferVideo(transceiver)
        sender = transceiver.sender
        added.push(kind)
      }
      if (!sender || sender.track === track) continue
      try {
        await sender.replaceTrack(track)
      } catch {
        /* the next publish retry attaches it */
      }
    }
    await this.tune()
    if (added.length && this.published && this.sessionId && pc) await this.publishAdded(pc, added)
  }

  /** The camera can open after the first offer. One new offer publishes it. */
  private async publishAdded(pc: RTCPeerConnection, kinds: SfuKind[]) {
    const offer = await pc.createOffer()
    const munged = mungeOpusSdp(offer.sdp || '', this.host.opus || DEFAULT_OPUS)
    try {
      await pc.setLocalDescription({ type: 'offer', sdp: munged })
    } catch {
      await pc.setLocalDescription(offer)
    }
    await waitGather(pc, 2000)
    if (this.pc !== pc || this.closed) return
    const local = pc.localDescription
    if (!local?.sdp || !this.sessionId) return
    const tracks = kinds.map((kind) => {
      const mid = [...pc.getTransceivers()].find((item) => item.sender === this.senders.get(kind))?.mid || ''
      return { location: 'local' as const, mid, trackName: trackName(this.host.peerId, kind) }
    }).filter((track) => track.mid)
    if (!tracks.length) return
    this.localMids = [...new Set([...this.localMids, ...tracks.map((track) => track.mid)])]
    const answer = await this.post('/api/sfu/tracks', {
      code: this.host.code,
      peerId: this.host.peerId,
      sessionId: this.sessionId,
      sessionDescription: { type: local.type, sdp: local.sdp },
      tracks,
    })
    const refused = (answer.tracks || []).find((track) => track.errorCode)
    if (refused || !answer.sessionDescription?.sdp || this.pc !== pc) return
    if (answer.sessionDescription.type === 'offer' || answer.requiresImmediateRenegotiation) await this.answerOffer(pc, answer.sessionDescription)
    else await pc.setRemoteDescription(answer.sessionDescription)
    const current = this.host.tracks()
    this.host.sendPub({
      peerId: this.host.peerId,
      sessionId: this.sessionId,
      tracks: (['music', 'talk', 'camera', 'screen'] as const)
        .filter((kind) => this.senders.has(kind) && (kind === 'music' || kind === 'talk' || current[kind]))
        .map((kind) => ({ trackName: trackName(this.host.peerId, kind), kind })),
    })
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
    const ordered = sendVideoCodecs(caps.codecs)
    if (!ordered.length) return
    try {
      transceiver.setCodecPreferences(ordered)
    } catch {
      /* browser default */
    }
  }

  private async post(path: string, body: unknown, attempt = 0): Promise<SfuBody> {
    const generation = this.attempt
    const controller = new AbortController()
    this.inflight = controller
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (generation !== this.attempt) throw Object.assign(new Error('The media path was replaced.'), { code: 'replaced' })
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
    } catch (error) {
      const code = String((error as { code?: string }).code || '')
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      if (generation !== this.attempt || code === 'replaced' || aborted) {
        throw Object.assign(new Error('The media path was replaced.'), { code: 'replaced' })
      }
      const reset = error instanceof TypeError || code === 'unreachable'
      if (reset && attempt < 8) {
        await pause(1500)
        if (generation !== this.attempt) throw Object.assign(new Error('The media path was replaced.'), { code: 'replaced' })
        return this.post(path, body, attempt + 1)
      }
      throw error
    }
  }
}

function pause(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
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
      if (pc.connectionState === 'closed' || pc.iceGatheringState === 'complete') finish()
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
  if (!sender || !track) return
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
