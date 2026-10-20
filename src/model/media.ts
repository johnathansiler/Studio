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
}

const STUN: IceServer = { urls: 'stun:stun.l.google.com:19302' }

/** Browsers block TURN on port 53, and that URL only adds a timeout. */
export function filterBrowserTurnUrls(urls: string[]): string[] {
  return urls.filter((url) => !/:53(\?|$)/.test(url))
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

export function mediaStatus(input: { turn: TurnProvider; turnError?: string; links: MediaLink[]; live: boolean }): { tone: 'good' | 'warn' | 'bad'; text: string } | null {
  if (!input.live) return null
  if (input.turnError) {
    return { tone: 'bad', text: `TURN credentials failed (${input.turnError}). Video and guest takes need a working relay.` }
  }
  if (!input.links.length) {
    return input.turn === 'none'
      ? { tone: 'warn', text: 'No TURN server is configured. A guest on another network may connect signaling and still get no video or take.' }
      : { tone: 'warn', text: 'Opening the media path…' }
  }
  const connected = input.links.filter((link) => link.connection === 'connected')
  if (connected.length) {
    const relay = connected.some((link) => link.path === 'relay')
    return relay
      ? { tone: 'good', text: 'Media connected through TURN.' }
      : { tone: 'good', text: 'Media connected directly.' }
  }
  const failed = input.links.some((link) => link.connection === 'failed' || link.ice === 'failed' || link.connection === 'disconnected')
  const stalled = input.links.some((link) => link.ageMs > 12000 && link.connection !== 'connected')
  if (failed || stalled) {
    if (input.turn === 'none') {
      return {
        tone: 'bad',
        text: 'Media is not connected. Signaling works, but there is no TURN relay, so video and the guest take have no path across this network.',
      }
    }
    return { tone: 'bad', text: 'Media failed to connect. TURN is configured; check the credentials and that UDP 3478 or TCP 443 is allowed.' }
  }
  return { tone: 'warn', text: 'Waiting for the media path…' }
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
