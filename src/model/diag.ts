export interface DiagDirection {
  framesPerSecond: number
  framesEncoded?: number
  framesDecoded?: number
  bytes: number
  packetsLost: number
  nackCount: number
  pliCount: number
  qualityLimitationReason?: string
}

export interface DiagPeer {
  id: string
  signaling: string
  ice: string
  connection: string
  gathered: { host: number; srflx: number; relay: number; prflx: number }
  selected: { local: string; remote: string; protocol: string; relayProtocol: string } | null
  outbound: DiagDirection
  inbound: DiagDirection
  availableOutgoingBitrate: number
  currentRoundTripTime: number
  errors: string[]
  offers: number
}

export interface DiagReport {
  at: number
  peerId: string
  role: string
  ua: string
  peers: DiagPeer[]
  /** create, join, leave, evict, or a client session reason. */
  event?: string
  note?: string
}

const CANDIDATE = new Set(['host', 'srflx', 'relay', 'prflx', ''])
const PROTO = new Set(['udp', 'tcp', 'tls', ''])
const LIMIT = new Set(['none', 'cpu', 'bandwidth', 'other', ''])

function clip(value: unknown, max: number) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, max)
}

function count(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(999, Math.round(n))
}

function qty(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(1e15, Math.round(n))
}

function decimal(value: unknown, places: number) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  const scale = 10 ** places
  return Math.round(Math.min(n, 1e12) * scale) / scale
}

function proto(value: unknown) {
  const text = clip(value, 8).toLowerCase()
  return PROTO.has(text) ? text : ''
}

function direction(value: unknown, encoded: boolean): DiagDirection {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const reason = clip(row.qualityLimitationReason, 16)
  const base: DiagDirection = {
    framesPerSecond: decimal(row.framesPerSecond, 2),
    bytes: qty(row.bytes),
    packetsLost: qty(row.packetsLost),
    nackCount: qty(row.nackCount),
    pliCount: qty(row.pliCount),
  }
  if (encoded) {
    base.framesEncoded = qty(row.framesEncoded)
    base.qualityLimitationReason = LIMIT.has(reason) ? reason : ''
  } else {
    base.framesDecoded = qty(row.framesDecoded)
  }
  return base
}

/** Keep a phone's WebRTC snapshot. Drop SDP and credentials. RTP counters stay; media payloads do not. */
export function sanitizeDiag(input: unknown): DiagReport | null {
  if (!input || typeof input !== 'object') return null
  const row = input as Record<string, unknown>
  const peersIn = Array.isArray(row.peers) ? row.peers.slice(0, 8) : []
  const peers: DiagPeer[] = []
  for (const item of peersIn) {
    if (!item || typeof item !== 'object') continue
    const peer = item as Record<string, unknown>
    const gathered = peer.gathered && typeof peer.gathered === 'object' ? (peer.gathered as Record<string, unknown>) : {}
    const selectedIn = peer.selected && typeof peer.selected === 'object' ? (peer.selected as Record<string, unknown>) : null
    const local = clip(selectedIn?.local, 16)
    const remote = clip(selectedIn?.remote, 16)
    const protocol = proto(selectedIn?.protocol)
    const relayProtocol = proto(selectedIn?.relayProtocol)
    const errors = Array.isArray(peer.errors) ? peer.errors.slice(-4).map((entry) => clip(entry, 180)).filter(Boolean) : []
    const selected = selectedIn && (CANDIDATE.has(local) || CANDIDATE.has(remote) || protocol || relayProtocol)
      ? { local, remote, protocol, relayProtocol }
      : null
    peers.push({
      id: clip(peer.id, 80),
      signaling: clip(peer.signaling, 32),
      ice: clip(peer.ice, 32),
      connection: clip(peer.connection, 32),
      gathered: {
        host: count(gathered.host),
        srflx: count(gathered.srflx),
        relay: count(gathered.relay),
        prflx: count(gathered.prflx),
      },
      selected,
      outbound: direction(peer.outbound, true),
      inbound: direction(peer.inbound, false),
      availableOutgoingBitrate: qty(peer.availableOutgoingBitrate),
      currentRoundTripTime: decimal(peer.currentRoundTripTime, 3),
      errors,
      offers: count(peer.offers),
    })
  }
  const at = Number(row.at)
  const event = clip(row.event, 40)
  const note = clip(row.note, 180)
  return {
    at: Number.isFinite(at) ? Math.round(at) : Date.now(),
    peerId: clip(row.peerId, 80),
    role: clip(row.role, 16),
    ua: clip(row.ua, 180),
    peers,
    ...(event ? { event } : {}),
    ...(note ? { note } : {}),
  }
}

export function rememberDiag(log: DiagReport[], entry: DiagReport, limit = 200) {
  const next = [...log, entry]
  if (next.length > limit) next.splice(0, next.length - limit)
  return next
}
