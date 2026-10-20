export interface DiagPeer {
  id: string
  signaling: string
  ice: string
  connection: string
  gathered: { host: number; srflx: number; relay: number; prflx: number }
  selected: { local: string; remote: string } | null
  errors: string[]
}

export interface DiagReport {
  at: number
  peerId: string
  role: string
  ua: string
  peers: DiagPeer[]
}

const CANDIDATE = new Set(['host', 'srflx', 'relay', 'prflx', ''])

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

/** Keep a phone's WebRTC snapshot. Drop SDP, credentials, and media bytes. */
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
    const errors = Array.isArray(peer.errors) ? peer.errors.slice(-4).map((entry) => clip(entry, 180)).filter(Boolean) : []
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
      selected: selectedIn && (CANDIDATE.has(local) || CANDIDATE.has(remote)) ? { local, remote } : null,
      errors,
    })
  }
  const at = Number(row.at)
  return {
    at: Number.isFinite(at) ? Math.round(at) : Date.now(),
    peerId: clip(row.peerId, 80),
    role: clip(row.role, 16),
    ua: clip(row.ua, 180),
    peers,
  }
}

export function rememberDiag(log: DiagReport[], entry: DiagReport, limit = 200) {
  const next = [...log, entry]
  if (next.length > limit) next.splice(0, next.length - limit)
  return next
}
