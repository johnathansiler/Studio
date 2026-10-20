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
 * Browsers block TURN on port 53. Port 80 and plain TURN on UDP 443 also stall
 * Safari's gatherer, so ICE never finishes nominating the relay that does work.
 */
export function filterBrowserTurnUrls(urls: string[]): string[] {
  return urls.filter((url) => {
    if (/:53(\?|$)/.test(url)) return false
    if (/^turns?:/i.test(url) && /:80(\?|$)/.test(url)) return false
    if (/^turn:/i.test(url) && /:443(\?|$)/.test(url)) return false
    return true
  })
}

export function staticTurnServer(url: string, username: string, credential: string): IceServer {
  const urls = filterBrowserTurnUrls(url.split(',').map((item) => item.trim()).filter(Boolean))
  return { urls: urls.length === 1 ? urls[0] : urls, username, credential }
}

export function normalizeIceServers(servers: IceServer[]): IceServer[] {
  return servers
    .map((server) => {
      const urls = filterBrowserTurnUrls(Array.isArray(server.urls) ? server.urls : [server.urls])
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

/**
 * Keep the room. Restart when the path has failed.
 * An offer that is still waiting for its answer stays in place, including
 * while ICE is connected and the signaling state has not caught up.
 * A relay that shows up must not abort a direct check that is already running.
 */
export function iceRetryPlan(input: {
  connection: string
  ice: string
  ageMs: number
  turn: TurnProvider
  previousTurn: TurnProvider
  signaling?: string
  offerAgeMs?: number
}): 'restart' | 'wait' {
  if (mediaUp(input)) return 'wait'
  const failed = input.connection === 'failed' || input.ice === 'failed'
  if (failed) return 'restart'
  // An outstanding offer is still the offer the other side may be answering.
  // Replacing it at a few seconds races that answer and leaves both sides offering.
  if (input.signaling === 'have-local-offer') return 'wait'
  const gainedRelay = input.previousTurn === 'none' && input.turn !== 'none'
  const checking = input.ice === 'checking'
  if (gainedRelay && input.signaling !== 'have-local-offer' && !checking) return 'restart'
  // A disconnect often recovers on its own. Leave that peer connection alone.
  if (input.ageMs < 30000) return 'wait'
  if (input.ageMs > 30000) return 'restart'
  return 'wait'
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
