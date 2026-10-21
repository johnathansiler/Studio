export type TurnProvider = 'none' | 'static' | 'cloudflare' | 'twilio' | 'metered'
export type IcePolicy = 'all' | 'relay'
export type MediaPath = 'unknown' | 'direct' | 'relay'

export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface IceConfig {
  iceServers: IceServer[]
  turn: TurnProvider
  turnError?: string
  iceTransportPolicy: IcePolicy
}

export interface MediaLink {
  connection: string
  ice: string
  path: MediaPath
  ageMs: number
  signaling?: string
  localType?: string
  remoteType?: string
  /** Inbound video RTP bytes. The banner follows this, not a stale connection label. */
  videoBytes?: number
  /** Selected candidate transport, when a pair is nominated. */
  protocol?: string
  relayProtocol?: string
}

/** ICE can be up while connectionState is still waiting on DTLS or the data channel. */
export function mediaUp(link: { connection: string; ice: string }) {
  return link.connection === 'connected' || link.ice === 'connected' || link.ice === 'completed'
}

const STUN: IceServer = { urls: 'stun:stun.l.google.com:19302' }

/** A hung microphone or relay request must not freeze Join. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Port 53 is blocked by browsers. Plain TURN on UDP 443 stalls Safari's gatherer.
 * TCP 80, TCP 443, and TLS 443 stay: a cellular network often blocks UDP and
 * only lets those through.
 */
export function filterBrowserTurnUrls(urls: string[]): string[] {
  return urls.filter((url) => {
    if (/:53(\?|$)/.test(url)) return false
    if (/^turn:/i.test(url) && /:443(?:\?|$)/.test(url) && !/transport=tcp/i.test(url)) return false
    return true
  })
}

const CELLULAR_TURN = [
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:80?transport=tcp',
  'turn:turn.cloudflare.com:443?transport=tcp',
  'turns:turn.cloudflare.com:443?transport=tcp',
]

function urlList(urls: string | string[]) {
  return Array.isArray(urls) ? urls : [urls]
}

/** STUN and TURN over UDP. The initial gather. TCP and TLS are left out so ICE cannot nominate them while a UDP pair exists. */
export function udpIceServers(servers: IceServer[]): IceServer[] {
  const next: IceServer[] = []
  for (const server of servers) {
    const urls = urlList(server.urls).filter((url) => {
      if (/^stun:/i.test(url)) return true
      if (!/^turn:/i.test(url)) return false
      return !/transport=tcp/i.test(url)
    })
    if (!urls.length) continue
    next.push({ ...server, urls: urls.length === 1 ? urls[0] : urls })
  }
  return next
}

export interface RelayGatherState {
  onTcpRelay: boolean
  sawUdpPair: boolean
  tcpFallback: boolean
  udpMisses: number
}

/**
 * UDP stays the gather until it has failed twice with no pair. The first
 * failure is often just TURN UDP being unreachable for a few seconds; replacing
 * it with TCP-only then makes the restart offer a path the carrier is resetting.
 * When TCP is added, UDP stays in the list so a late allocate can still win.
 * A nominated TCP relay goes back to UDP-only on the next restart.
 */
export function nextRelayGather(state: RelayGatherState, failed: boolean, canAddTcp: boolean): { servers: 'udp' | 'both' | 'same'; state: RelayGatherState } {
  if (state.onTcpRelay) {
    return {
      servers: 'udp',
      state: { onTcpRelay: false, sawUdpPair: state.sawUdpPair, tcpFallback: false, udpMisses: 0 },
    }
  }
  if (failed && !state.sawUdpPair && !state.tcpFallback) {
    const udpMisses = state.udpMisses + 1
    if (udpMisses < 2 || !canAddTcp) return { servers: 'same', state: { ...state, udpMisses } }
    return { servers: 'both', state: { ...state, udpMisses, tcpFallback: true } }
  }
  return { servers: 'same', state }
}

/** TCP and TLS on 443 only. Gathered after UDP has failed twice with no pair, not on the first offer. */
export function tcpRelayIceServers(servers: IceServer[]): IceServer[] {
  const next: IceServer[] = []
  for (const server of servers) {
    const urls = urlList(server.urls).filter((url) => /^turns?:/i.test(url) && /transport=tcp/i.test(url) && /:443(?:\?|$)/.test(url))
    if (!urls.length) continue
    next.push({ ...server, urls: urls.length === 1 ? urls[0] : urls })
  }
  return next
}

/** Cloudflare credentials work on every Cloudflare TURN port. Add the cellular TCP/TLS fallbacks if any Cloudflare URL is present. */
export function ensureCellularTurn(urls: string[]): string[] {
  const kept = filterBrowserTurnUrls(urls)
  if (!urls.some((url) => /turn\.cloudflare\.com/i.test(url))) return kept
  return [...new Set([...kept, ...CELLULAR_TURN])]
}

export function staticTurnServer(url: string, username: string, credential: string): IceServer {
  const urls = filterBrowserTurnUrls(url.split(',').map((item) => item.trim()).filter(Boolean))
  return { urls: urls.length === 1 ? urls[0] : urls, username, credential }
}

export function normalizeIceServers(servers: IceServer[]): IceServer[] {
  return servers
    .map((server) => {
      const urls = ensureCellularTurn(Array.isArray(server.urls) ? server.urls : [server.urls])
      if (!urls.length) return null
      return { ...server, urls: urls.length === 1 ? urls[0] : urls }
    })
    .filter((server): server is IceServer => Boolean(server))
}

export function baseIceConfig(partial: Partial<IceConfig> = {}): IceConfig {
  return {
    iceServers: partial.iceServers?.length ? normalizeIceServers(partial.iceServers) : [STUN],
    turn: partial.turn || 'none',
    turnError: partial.turnError,
    iceTransportPolicy: partial.iceTransportPolicy === 'relay' ? 'relay' : 'all',
  }
}

export function withStun(servers: IceServer[], turn: TurnProvider, turnError?: string, policy: IcePolicy = 'all'): IceConfig {
  const iceServers = normalizeIceServers([STUN, ...servers])
  return { iceServers, turn: iceServers.length > 1 ? turn : 'none', turnError, iceTransportPolicy: policy }
}

/** Candidates that arrive before the remote description must be kept, not dropped. */
export function queueIceCandidate<T>(remoteReady: boolean, pending: T[], candidate: T): { pending: T[]; apply: T[] } {
  if (!remoteReady) return { pending: [...pending, candidate], apply: [] }
  return { pending: [], apply: [...pending, candidate] }
}

const STILL_TRYING = "Video isn’t connected yet. You’re still in the room, and we’ll keep trying."

export function mediaStatus(input: { turn: TurnProvider; turnError?: string; links: MediaLink[]; live: boolean }): { tone: 'good' | 'warn' | 'bad'; text: string } | null {
  if (!input.live) return null
  const videoFlowing = input.links.some((link) => (link.videoBytes || 0) > 0)
  const connected = input.links.some((link) => mediaUp(link))
  // Bytes win over a stale "disconnected" label, and a live path wins over a relay warning.
  if (videoFlowing || connected) return { tone: 'good', text: 'Video and audio are connected.' }
  if (input.turnError) return { tone: 'bad', text: STILL_TRYING }
  if (!input.links.length) {
    return input.turn === 'none'
      ? { tone: 'warn', text: 'Video may take a moment to appear. You’re still in the room.' }
      : { tone: 'warn', text: 'Connecting video and audio…' }
  }
  const failed = input.links.some((link) => link.connection === 'failed' || link.ice === 'failed')
  const stalled = input.links.some((link) => link.ageMs > 30000 && !mediaUp(link) && link.ice !== 'checking' && link.ice !== 'new')
  if (failed || stalled) return { tone: 'bad', text: STILL_TRYING }
  return { tone: 'warn', text: 'Connecting video and audio…' }
}

/** A take this quiet is a flat line, not a vocal. */
export const SILENT_PEAK = 0.001

export function peakAbs(channels: ArrayLike<number>[]): number {
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 8) {
      const sample = Math.abs(channel[i] || 0)
      if (sample > peak) peak = sample
    }
  }
  return peak
}

export function isSilentTake(channels: ArrayLike<number>[]): boolean {
  return peakAbs(channels) < SILENT_PEAK
}
