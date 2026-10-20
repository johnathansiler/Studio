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

const STILL_TRYING = "Video isn’t connected yet. You’re still in the room, and we’ll keep trying."

export function mediaStatus(input: { turn: TurnProvider; turnError?: string; links: MediaLink[]; live: boolean }): { tone: 'good' | 'warn' | 'bad'; text: string } | null {
  if (!input.live) return null
  if (input.turnError) return { tone: 'bad', text: STILL_TRYING }
  if (!input.links.length) {
    return input.turn === 'none'
      ? { tone: 'warn', text: 'Video may take a moment to appear. You’re still in the room.' }
      : { tone: 'warn', text: 'Connecting video and audio…' }
  }
  const connected = input.links.filter((link) => link.connection === 'connected')
  if (connected.length) return { tone: 'good', text: 'Video and audio are connected.' }
  const failed = input.links.some((link) => link.connection === 'failed' || link.ice === 'failed' || link.connection === 'disconnected')
  const stalled = input.links.some((link) => link.ageMs > 12000 && link.connection !== 'connected')
  if (failed || stalled) return { tone: 'bad', text: STILL_TRYING }
  return { tone: 'warn', text: 'Connecting video and audio…' }
}

/** Keep the room. Restart media when the path is down, or as soon as a relay appears. */
export function iceRetryPlan(input: {
  connection: string
  ice: string
  ageMs: number
  turn: TurnProvider
  previousTurn: TurnProvider
}): 'restart' | 'wait' {
  const gainedRelay = input.previousTurn === 'none' && input.turn !== 'none'
  if (gainedRelay && input.connection !== 'connected') return 'restart'
  const down = input.connection === 'failed' || input.connection === 'disconnected' || input.ice === 'failed' || input.ice === 'disconnected'
  const stalled = input.connection !== 'connected' && input.ageMs > 12000
  if (down || stalled) return 'restart'
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
