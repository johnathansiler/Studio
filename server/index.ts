import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { currentIce, type IceConfig } from './ice.ts'
import { sfuCall, sfuConfigured } from './sfu.ts'
import { createUsageLedger } from './usage.ts'
import { rememberDiag, sanitizeDiag, type DiagReport } from '../src/model/diag.ts'
import { sessionHello } from '../src/model/negotiate.ts'
import { CAP_NOTICE, type UsageSnapshot } from '../src/model/usage.ts'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

const usage = createUsageLedger()

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const MAX_PARTY = 6
const STATIC_ROOT = path.resolve(process.env.STATIC_DIR || 'dist')
const SERVE_STATIC = process.env.NODE_ENV === 'production' || process.env.SERVE_STATIC === '1'

interface Participant {
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
  /** Changes when that browser reloads. A live socket keeps the same id. */
  instanceId?: string
}

interface ChatMessage {
  id: string
  from: string
  name: string
  text: string
  at: number
}

interface Client {
  ws: WebSocket
  id: string
  name: string
  sessionCode?: string
  bytesIn: number
  bytesOut: number
  lastInType: string
  /** peer means the browser or the network closed it. Anything else is this process. */
  closeBy: string
}

interface Session {
  code: string
  hostId: string
  participants: Map<string, Participant>
  /** Disconnected people keep their id and role until the empty room expires. */
  held: Map<string, Participant>
  clients: Map<string, Client>
  chat: ChatMessage[]
  diag: DiagReport[]
  /** Finished project audio, fetched by guests over HTTP. */
  assets: Map<string, { name: string; sampleRate: number; wav: Buffer }>
  /** SFU publications announced by admitted peers. Replayed to a rejoining socket. */
  pubs: Map<string, SfuPublication>
  /** Session ids this room asked Cloudflare to open, so the egress ledger can close them. */
  sfuSessions: Map<string, string>
  emptyAt?: number
}

interface SfuPublication {
  peerId: string
  sessionId: string
  tracks: Array<{ trackName: string; kind: string }>
}

const sessions = new Map<string, Session>()
const sockets = new WeakMap<WebSocket, Client>()
const TAKE_LIMIT = 32 * 1024 * 1024
const uploads = new Map<string, { total: number; seen: Set<number>; bytes: number }>()
const ASSET_CHUNK_LIMIT = 16 * 1024
const ASSET_LIMIT = 8 * 1024 * 1024
const assetUploads = new Map<string, { total: number; name: string; sampleRate: number; chunks: Map<number, Buffer> }>()
/** Same cadence as the client ping. A missed pong does not close the socket. */
const KEEPALIVE_MS = 5000

function send(ws: WebSocket, payload: unknown) {
  const text = JSON.stringify(payload)
  if (ws.readyState !== ws.OPEN) return
  ws.send(text)
  const client = sockets.get(ws)
  if (client) client.bytesOut += Buffer.byteLength(text)
}

function codeAlphabet() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let value = ''
  for (let i = 0; i < 6; i++) value += alphabet[Math.floor(Math.random() * alphabet.length)]
  return value
}

function freshCode() {
  let code = codeAlphabet()
  while (sessions.has(code)) code = codeAlphabet()
  return code
}

function roster(session: Session) {
  return [...session.participants.values()]
}

function broadcast(session: Session, payload: unknown, except?: string) {
  for (const client of session.clients.values()) {
    if (client.id === except) continue
    send(client.ws, payload)
  }
}

function emitRoster(session: Session) {
  broadcast(session, { t: 'roster', participants: roster(session) })
}

function publicSession(session: Session, self: Participant, ice: IceConfig, snap: UsageSnapshot, reason?: string) {
  const sfu = sfuConfigured(process.env) && !snap.blocked
  return {
    t: 'welcome',
    id: self.id,
    role: self.role,
    code: session.code,
    iceServers: ice.iceServers,
    turn: ice.turn,
    turnError: ice.turnError,
    iceTransportPolicy: ice.iceTransportPolicy,
    participants: roster(session),
    chat: session.chat.slice(-80),
    reason: reason || '',
    sfu,
    usage: {
      month: snap.month,
      bytes: snap.bytes,
      gigabytes: snap.gigabytes,
      capGigabytes: snap.capGigabytes,
      blocked: snap.blocked,
      notice: snap.blocked ? CAP_NOTICE : '',
    },
  }
}

async function welcomeIce() {
  const snap = await usage.view()
  const ice = await currentIce(process.env, fetch, { stunOnly: snap.blocked })
  return { snap, ice }
}

function releaseHost(session: Session, resumeId: string) {
  const previous = session.clients.get(resumeId)
  if (previous) {
    previous.closeBy = 'release'
    previous.sessionCode = undefined
    session.clients.delete(resumeId)
    try {
      previous.ws.close()
    } catch {
      /* the socket may already be gone */
    }
  }
  const person = session.participants.get(resumeId)
  if (person) {
    session.participants.delete(resumeId)
    session.held.set(resumeId, person)
  }
  if (session.hostId === resumeId) session.hostId = ''
  record(session, 'leave', `${resumeId} started a new session; this room stays open until it has been empty for 10 minutes`, resumeId)
  if (session.clients.size === 0) session.emptyAt = Date.now()
  else {
    session.emptyAt = undefined
    broadcast(session, { t: 'peer-left', id: resumeId })
    emitRoster(session)
    broadcast(session, { t: 'host-away' })
  }
}

function hostedBy(resumeId: string) {
  if (!resumeId) return undefined
  for (const session of sessions.values()) {
    if (session.hostId === resumeId) return session
  }
  return undefined
}

function record(session: Session, event: string, note: string, peerId = '') {
  console.log(`[session ${session.code}] ${event}: ${note}`)
  const entry = sanitizeDiag({ at: Date.now(), peerId, role: 'server', ua: 'server', event, note, peers: [] })
  if (entry) session.diag = rememberDiag(session.diag, entry, 200)
}

function partySize(session: Session) {
  const ids = new Set<string>()
  for (const person of session.participants.values()) if (person.admitted) ids.add(person.id)
  for (const person of session.held.values()) if (person.admitted) ids.add(person.id)
  return ids.size
}

function leave(client: Client, announce = false) {
  if (!client.sessionCode) return
  const session = sessions.get(client.sessionCode)
  if (!session) return
  const current = session.clients.get(client.id)
  if (current && current.ws !== client.ws) return
  session.clients.delete(client.id)
  client.sessionCode = undefined
  // A carrier reset is not someone leaving. Keep the roster and the peer connection.
  if (!announce) {
    record(session, 'socket-drop', `${client.id} signaling dropped; the peer connection stays up`, client.id)
    if (session.clients.size === 0) session.emptyAt = Date.now()
    else session.emptyAt = undefined
    return
  }
  const person = session.participants.get(client.id)
  if (person) {
    session.participants.delete(client.id)
    session.held.set(client.id, person)
  }
  record(session, 'leave', `${client.id} left; the room is kept until it has been empty for 10 minutes`, client.id)
  releaseMedia(session, client.id)
  if (client.id) broadcast(session, { t: 'peer-left', id: client.id })
  if (session.clients.size === 0) {
    session.emptyAt = Date.now()
  } else {
    session.emptyAt = undefined
    emitRoster(session)
    if (client.id === session.hostId) {
      broadcast(session, { t: 'host-away' })
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  if (url.pathname === '/api/health') return json(res, { ok: true, service: 'cueharbor', sessions: sessions.size })
  if (url.pathname === '/api/usage' && req.method === 'GET') return json(res, await usage.view())
  if (url.pathname === '/api/usage' && req.method === 'POST') return reportUsage(req, res)
  if (url.pathname === '/api/sfu/session' && req.method === 'POST') return openSfuSession(req, res)
  if (url.pathname === '/api/sfu/tracks' && req.method === 'POST') return proxySfu(req, res, 'tracks')
  if (url.pathname === '/api/sfu/renegotiate' && req.method === 'POST') return proxySfu(req, res, 'renegotiate')
  if (url.pathname === '/api/sfu/close' && req.method === 'POST') return proxySfu(req, res, 'close')
  if (url.pathname === '/api/ice') {
    const { ice } = await welcomeIce()
    return json(res, ice)
  }
  const diag = url.pathname.match(/^\/api\/diag\/([A-Za-z0-9]{4,12})$/)
  if (diag && (req.method === 'GET' || req.method === 'POST')) return handleDiag(req, res, diag[1].toUpperCase())
  if (url.pathname === '/api/takes' && req.method === 'POST') return acceptTake(req, res)
  if (url.pathname === '/api/assets' && req.method === 'POST') return acceptAsset(req, res)
  if (url.pathname === '/api/assets' && req.method === 'GET') return serveAsset(url, res)
  if (SERVE_STATIC) {
    await serveStatic(url.pathname, res)
    return
  }
  json(res, { error: 'CueHarbor signaling server. The app is served by Vite in development.' }, 404)
})

const TRACK_KINDS = new Set(['music', 'talk', 'camera', 'screen'])

function sanitizePublication(peerId: string, msg: Record<string, unknown>): SfuPublication | null {
  const sessionId = String(msg.sessionId || '')
  if (!sessionId || sessionId.length > 80) return null
  const listed = Array.isArray(msg.tracks) ? msg.tracks : []
  const tracks = listed.slice(0, 8).map((item) => {
    const row = item as { trackName?: string; kind?: string }
    const kind = TRACK_KINDS.has(String(row.kind)) ? String(row.kind) : ''
    const trackName = String(row.trackName || '').slice(0, 120)
    return kind && trackName ? { trackName, kind } : null
  }).filter((item): item is { trackName: string; kind: string } => Boolean(item))
  if (!tracks.length) return null
  return { peerId, sessionId, tracks }
}

function liveMember(code: string, peerId: string) {
  const session = sessions.get(code)
  if (!session) return null
  const person = session.participants.get(peerId)
  if (!person?.admitted || !session.clients.has(peerId)) return null
  return session
}

async function readJson(req: IncomingMessage, limit = 200_000) {
  try {
    return JSON.parse(await readBody(req, limit)) as Record<string, unknown>
  } catch {
    return null
  }
}

async function reportUsage(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req, 4000)
  if (!body) return json(res, { error: 'Usage report was unreadable.' }, 400)
  const code = String(body.code || '').toUpperCase()
  const peerId = String(body.peerId || '')
  if (!liveMember(code, peerId)) return json(res, { error: 'Join the session before reporting usage.' }, 403)
  const bytes = Number(body.bytes)
  const floor = Number(body.floor)
  if (Number.isFinite(floor) && floor > 0) await usage.applyFloor(floor)
  const key = String(body.key || `peer:${peerId}`).slice(0, 120)
  if (!Number.isFinite(bytes) || bytes < 0) return json(res, await usage.view())
  return json(res, await usage.report(key, bytes))
}

async function openSfuSession(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req, 4000)
  if (!body) return json(res, { error: 'The media request was unreadable.', code: 'bad-request' }, 400)
  const code = String(body.code || '').toUpperCase()
  const peerId = String(body.peerId || '')
  const session = liveMember(code, peerId)
  if (!session) return json(res, { error: 'Join the session before opening media.', code: 'forbidden' }, 403)
  if (!sfuConfigured(process.env)) return json(res, { error: 'Cloudflare Realtime is not configured.', code: 'disabled' }, 403)
  if (await usage.blocked()) return json(res, { error: CAP_NOTICE, code: 'cap' }, 403)
  const result = await sfuCall(process.env, '/sessions/new', 'POST', null)
  const opened = result.body as { sessionId?: string; error?: string; code?: string }
  if (!result.ok || !opened?.sessionId) return json(res, opened || { error: 'The media server did not open a session.', code: 'sfu' }, result.status || 502)
  session.sfuSessions.set(peerId, opened.sessionId)
  await usage.openSession(opened.sessionId, 1, admittedOthers(session, peerId))
  return json(res, { sessionId: opened.sessionId })
}

async function proxySfu(req: IncomingMessage, res: ServerResponse, op: 'tracks' | 'renegotiate' | 'close') {
  const body = await readJson(req)
  if (!body) return json(res, { error: 'The media request was unreadable.', code: 'bad-request' }, 400)
  const code = String(body.code || '').toUpperCase()
  const peerId = String(body.peerId || '')
  const sessionId = String(body.sessionId || '')
  if (!liveMember(code, peerId)) return json(res, { error: 'Join the session before opening media.', code: 'forbidden' }, 403)
  if (!sfuConfigured(process.env)) return json(res, { error: 'Cloudflare Realtime is not configured.', code: 'disabled' }, 403)
  if (op !== 'close' && await usage.blocked()) return json(res, { error: CAP_NOTICE, code: 'cap' }, 403)
  if (!sessionId || sessionId.length > 80) return json(res, { error: 'The media session id was missing.', code: 'bad-request' }, 400)
  const path = op === 'tracks' ? `/sessions/${encodeURIComponent(sessionId)}/tracks/new` : op === 'renegotiate' ? `/sessions/${encodeURIComponent(sessionId)}/renegotiate` : `/sessions/${encodeURIComponent(sessionId)}/tracks/close`
  const method = op === 'tracks' ? 'POST' : 'PUT'
  const forwarded = op === 'close'
    ? { tracks: Array.isArray(body.tracks) ? body.tracks : [], force: true }
    : op === 'renegotiate'
      ? { sessionDescription: body.sessionDescription }
      : {
          ...(body.sessionDescription ? { sessionDescription: body.sessionDescription } : {}),
          tracks: body.tracks,
        }
  const result = await sfuCall(process.env, path, method, forwarded)
  return json(res, result.body, result.ok ? 200 : result.status || 502)
}

async function handleDiag(req: IncomingMessage, res: ServerResponse, code: string) {
  const session = sessions.get(code)
  if (!session) return json(res, { error: 'That invite is no longer live.' }, 404)
  if (req.method === 'GET') return json(res, { code, entries: session.diag.slice(-200) })
  let body: unknown
  try {
    body = JSON.parse(await readBody(req, 24_000))
  } catch {
    return json(res, { error: 'Diagnostic was unreadable.' }, 400)
  }
  const entry = sanitizeDiag(body)
  if (!entry) return json(res, { error: 'Diagnostic was empty.' }, 400)
  session.diag = rememberDiag(session.diag, entry, 200)
  return json(res, { ok: true, kept: session.diag.length })
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body))
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const filePath = path.resolve(STATIC_ROOT, relative)
  const rootWithSep = STATIC_ROOT.endsWith(path.sep) ? STATIC_ROOT : STATIC_ROOT + path.sep
  if (filePath !== STATIC_ROOT && !filePath.startsWith(rootWithSep)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  try {
    const info = await stat(filePath)
    const finalPath = info.isDirectory() ? path.join(filePath, 'index.html') : filePath
    const data = await readFile(finalPath)
    const headers: Record<string, string> = { 'content-type': contentType(finalPath) }
    headers['cache-control'] = finalPath.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    res.writeHead(200, headers)
    res.end(data)
  } catch {
    if (path.extname(relative)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    try {
      const data = await readFile(path.join(STATIC_ROOT, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('Build the app first: npm run build')
    }
  }
}

function contentType(file: string) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.json')) return 'application/json'
  if (file.endsWith('.wav')) return 'audio/wav'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.webp')) return 'image/webp'
  if (file.endsWith('.ico')) return 'image/x-icon'
  if (file.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

// No idle timeout and the default 100 MB payload cap. This process does not
// close a socket for silence or for message size. Render's proxy is not asked
// to either; a 6–15s 1006 on one cellular client is the carrier resetting TCP.
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  const client: Client = { ws, id: '', name: 'Guest', bytesIn: 0, bytesOut: 0, lastInType: '', closeBy: 'peer' }
  sockets.set(ws, client)
  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.ping()
      } catch {
        /* already closing */
      }
    }
  }, KEEPALIVE_MS)
  ws.on('message', (raw) => {
    const size = typeof raw === 'string'
      ? Buffer.byteLength(raw)
      : Array.isArray(raw)
        ? raw.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        : raw.byteLength
    client.bytesIn += size
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(raw))
    } catch {
      client.lastInType = 'unparsed'
      return
    }
    client.lastInType = String(msg.t || '')
    if (size >= 64 * 1024) {
      const session = client.sessionCode ? sessions.get(client.sessionCode) : undefined
      const note = `inbound ${client.lastInType} ${size} bytes`
      if (session) record(session, 'large', note, client.id)
      else console.log(`[ws] ${note}`)
    }
    void handle(client, msg)
  })
  ws.on('error', (error) => {
    if (client.closeBy === 'peer') client.closeBy = 'error'
    const session = client.sessionCode ? sessions.get(client.sessionCode) : undefined
    const note = `error ${error.message} last=${client.lastInType} in=${client.bytesIn} out=${client.bytesOut}`
    if (session) record(session, 'socket-error', note, client.id)
    else console.log(`[ws] ${note}`)
  })
  ws.on('close', (code, reason) => {
    clearInterval(heartbeat)
    const session = client.sessionCode ? sessions.get(client.sessionCode) : undefined
    const note = `code=${code} reason=${reason.toString()} by=${client.closeBy} last=${client.lastInType} in=${client.bytesIn} out=${client.bytesOut}`
    if (session) record(session, 'socket-close', note, client.id)
    else console.log(`[ws] close before hello ${note}`)
    leave(client)
  })
})

async function acceptTake(req: IncomingMessage, res: ServerResponse) {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req, 200_000)) as Record<string, unknown>
  } catch {
    return json(res, { error: 'Take chunk was unreadable.' }, 400)
  }
  const code = String(body.code || '')
  const from = String(body.from || '')
  const takeId = String(body.takeId || '')
  const index = Number(body.index)
  const total = Number(body.total)
  const session = sessions.get(code)
  const person = session?.participants.get(from)
  const host = session ? session.clients.get(session.hostId) : undefined
  if (!session || !person?.admitted || person.role !== 'guest' || !host || !takeId || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total) {
    return json(res, { error: 'Take upload was rejected.' }, 403)
  }
  const chunk = typeof body.chunk === 'string' ? body.chunk : ''
  const raw = Buffer.from(chunk, 'base64')
  if (!raw.byteLength || raw.byteLength > 64 * 1024) return json(res, { error: 'Take chunk is the wrong size.' }, 413)
  const key = `${code}:${from}:${takeId}`
  const upload = uploads.get(key) || { total, seen: new Set<number>(), bytes: 0 }
  if (upload.seen.has(index)) return json(res, { ok: true, duplicate: true })
  if (upload.bytes + raw.byteLength > TAKE_LIMIT) {
    uploads.delete(key)
    return json(res, { error: 'Take is over 32 MB.' }, 413)
  }
  upload.total = total
  upload.seen.add(index)
  upload.bytes += raw.byteLength
  uploads.set(key, upload)
  send(host.ws, { t: 'take-relay', from, body })
  if (upload.seen.size >= total) uploads.delete(key)
  return json(res, { ok: true, received: upload.seen.size, total })
}

function assetIdOk(id: string) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id)
}

/** The host uploads project audio in small chunks. Guests download the finished wav. It never rides the signaling socket. */
async function acceptAsset(req: IncomingMessage, res: ServerResponse) {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(await readBody(req, 48_000)) as Record<string, unknown>
  } catch {
    return json(res, { error: 'Asset chunk was unreadable.' }, 400)
  }
  const code = String(body.code || '')
  const from = String(body.from || '')
  const id = String(body.id || '')
  const index = Number(body.index)
  const total = Number(body.total)
  const sampleRate = Number(body.sampleRate)
  const session = sessions.get(code)
  const person = session?.participants.get(from)
  if (!session || !person?.admitted || person.role !== 'host' || person.id !== session.hostId || !assetIdOk(id)) {
    return json(res, { error: 'Asset upload was rejected.' }, 403)
  }
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 2048 || index < 0 || index >= total) {
    return json(res, { error: 'Asset chunk was rejected.' }, 400)
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    return json(res, { error: 'Asset sample rate was rejected.' }, 400)
  }
  const chunk = typeof body.chunk === 'string' ? body.chunk : ''
  const raw = Buffer.from(chunk, 'base64')
  if (!raw.byteLength || raw.byteLength > ASSET_CHUNK_LIMIT) return json(res, { error: 'Asset chunk is the wrong size.' }, 413)
  const key = `${code}:${id}`
  const upload = assetUploads.get(key) || { total, name: String(body.name || 'Audio').slice(0, 80), sampleRate, chunks: new Map<number, Buffer>() }
  upload.total = total
  upload.name = String(body.name || upload.name).slice(0, 80)
  upload.sampleRate = sampleRate
  const previous = upload.chunks.get(index)
  const nextBytes = [...upload.chunks.values()].reduce((sum, part) => sum + part.byteLength, 0) - (previous?.byteLength || 0) + raw.byteLength
  if (nextBytes > ASSET_LIMIT) {
    assetUploads.delete(key)
    return json(res, { error: 'Asset is over 8 MB.' }, 413)
  }
  upload.chunks.set(index, raw)
  let complete = upload.chunks.size >= total
  if (complete) {
    for (let i = 0; i < total; i++) {
      if (!upload.chunks.has(i)) complete = false
    }
  }
  if (!complete) {
    assetUploads.set(key, upload)
    return json(res, { ok: true, received: upload.chunks.size, total, complete: false })
  }
  const parts: Buffer[] = []
  for (let i = 0; i < total; i++) parts.push(upload.chunks.get(i)!)
  const wav = Buffer.concat(parts)
  assetUploads.delete(key)
  session.assets.set(id, { name: upload.name, sampleRate: upload.sampleRate, wav })
  broadcast(session, {
    t: 'asset-ready',
    asset: { id, name: upload.name, sampleRate: upload.sampleRate, bytes: wav.byteLength },
  }, session.hostId)
  return json(res, { ok: true, received: total, total, complete: true })
}

function serveAsset(url: URL, res: ServerResponse) {
  const code = url.searchParams.get('code') || ''
  const id = url.searchParams.get('id') || ''
  const from = url.searchParams.get('from') || ''
  const session = sessions.get(code)
  const person = session?.participants.get(from)
  const asset = session && assetIdOk(id) ? session.assets.get(id) : undefined
  if (!session || !person?.admitted || !asset) {
    return json(res, { error: 'Asset was not found.' }, 404)
  }
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': asset.wav.byteLength,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(asset.wav)
}

function readBody(req: IncomingMessage, limit: number) {
  return new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

async function handle(client: Client, msg: Record<string, unknown>) {
  if (msg.t === 'hello') {
    await hello(client, msg)
    return
  }
  if (msg.t === 'ping') {
    if (!msg.ack) send(client.ws, { t: 'ping', ack: true })
    return
  }
  if (msg.t === 'leave') {
    client.closeBy = 'leave'
    leave(client, true)
    try {
      client.ws.close()
    } catch {
      /* already closing */
    }
    return
  }
  const session = client.sessionCode ? sessions.get(client.sessionCode) : undefined
  if (!session) {
    send(client.ws, { t: 'error', message: 'Join a session first.' })
    return
  }
  const self = session.participants.get(client.id)
  if (!self) return

  if (msg.t === 'admit' && self.role === 'host') {
    const person = session.participants.get(String(msg.id))
    if (!person) return
    const admittedCount = partySize(session)
    if (admittedCount >= MAX_PARTY) {
      send(client.ws, { t: 'error', message: `Mesh limit is ${MAX_PARTY} people. Remove someone first.` })
      return
    }
    person.admitted = true
    emitRoster(session)
    const target = session.clients.get(person.id)
    if (target) {
      for (const publication of session.pubs.values()) {
        if (publication.peerId === person.id) continue
        send(target.ws, { t: 'sfu-pub', publication })
      }
    }
    void shapeRoom(session)
    return
  }
  if (msg.t === 'reject' && self.role === 'host') {
    drop(session, String(msg.id), 'rejected')
    return
  }
  if (msg.t === 'remove' && self.role === 'host') {
    drop(session, String(msg.id), 'removed')
    return
  }
  if (msg.t === 'sfu-pub' && self.admitted) {
    const publication = sanitizePublication(client.id, msg)
    if (!publication) return
    session.pubs.set(client.id, publication)
    if (!session.sfuSessions.has(client.id)) session.sfuSessions.set(client.id, publication.sessionId)
    broadcast(session, { t: 'sfu-pub', publication }, client.id)
    void shapeRoom(session)
    return
  }
  if (msg.t === 'signal') {
    // A replaced socket keeps its session code until its close handler runs, and that
    // handler leaves the new socket in place. An offer already read here still forwards.
    const target = session.clients.get(String(msg.to))
    const from = session.participants.get(client.id)
    const to = session.participants.get(String(msg.to))
    if (!target || !from?.admitted || !to?.admitted) return
    send(target.ws, { t: 'signal', from: client.id, data: msg.data })
    return
  }
  if (msg.t === 'chat') {
    const text = String(msg.text || '').slice(0, 2000).trim()
    if (!text) return
    const message: ChatMessage = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      from: client.id,
      name: self.name,
      text,
      at: Date.now(),
    }
    session.chat.push(message)
    if (session.chat.length > 200) session.chat.shift()
    broadcast(session, { t: 'chat', message })
    return
  }
  if (msg.t === 'presence') {
    self.hand = Boolean(msg.hand)
    self.music = Boolean(msg.music)
    self.talk = Boolean(msg.talk)
    self.video = Boolean(msg.video)
    self.screen = Boolean(msg.screen)
    if (msg.clearForceMute) self.mutedByHost = false
    emitRoster(session)
    return
  }
  if (msg.t === 'reaction') {
    broadcast(session, { t: 'reaction', from: client.id, emoji: String(msg.emoji || '').slice(0, 8) })
    return
  }
  if (msg.t === 'force-mute' && self.role === 'host') {
    const person = session.participants.get(String(msg.id))
    if (!person) return
    person.mutedByHost = Boolean(msg.muted)
    emitRoster(session)
    const target = session.clients.get(person.id)
    if (target) send(target.ws, { t: 'force-mute', muted: person.mutedByHost })
    return
  }
  if (msg.t === 'transport' && self.role === 'host') {
    broadcast(session, { t: 'transport', from: client.id, payload: msg.payload }, client.id)
    return
  }
  if (msg.t === 'transport-request' && self.admitted && self.role === 'guest') {
    const host = session.clients.get(session.hostId)
    if (host) send(host.ws, { t: 'transport-request', from: client.id, name: self.name, payload: msg.payload })
    return
  }
  if ((msg.t === 'project' || msg.t === 'project-asset') && self.role === 'host') {
    broadcast(session, { t: msg.t, from: client.id, project: msg.project, asset: msg.asset, rev: msg.rev }, client.id)
    return
  }
  if (msg.t === 'clock') {
    const target = session.clients.get(String(msg.to))
    if (!target) return
    send(target.ws, { t: 'clock', from: client.id, payload: msg.payload })
  }
}

async function hello(client: Client, msg: Record<string, unknown>) {
  const name = String(msg.name || 'Guest').slice(0, 40)
  const resumeId = msg.resumeId ? String(msg.resumeId) : ''
  const hosted = hostedBy(resumeId)
  const decision = sessionHello({
    create: Boolean(msg.create),
    fresh: Boolean(msg.fresh),
    requestedCode: msg.code ? String(msg.code) : '',
    hostedCode: hosted?.code,
  })
  if (decision.action === 'create') {
    if (msg.fresh && hosted && resumeId) releaseHost(hosted, resumeId)
    const code = freshCode()
    const id = resumeId || crypto.randomUUID()
    const session: Session = {
      code,
      hostId: id,
      participants: new Map(),
      held: new Map(),
      clients: new Map(),
      chat: [],
      diag: [],
      assets: new Map(),
      pubs: new Map(),
      sfuSessions: new Map(),
    }
    const person: Participant = {
      id,
      name,
      role: 'host',
      admitted: true,
      hand: false,
      music: true,
      talk: true,
      video: true,
      screen: false,
      mutedByHost: false,
      instanceId: String(msg.instanceId || '').slice(0, 80),
    }
    session.participants.set(id, person)
    session.clients.set(id, client)
    client.id = id
    client.name = name
    client.sessionCode = code
    sessions.set(code, session)
    const reason = `new session created because ${decision.reason}`
    record(session, 'create', reason, id)
    await sendWelcome(session, client, person, reason)
    return
  }
  const code = decision.code || ''
  const session = code ? sessions.get(code) : undefined
  if (!session) {
    const message = code ? `Could not rejoin ${code}. That invite is no longer live.` : 'Could not rejoin the session. Create an invite again.'
    console.log(`[session] join failed: ${code || 'no code'} is not live`)
    send(client.ws, { t: 'error', message })
    return
  }
  const existing = resumeId ? session.participants.get(resumeId) || session.held.get(resumeId) : undefined
  if (resumeId && existing) {
    const instanceId = String(msg.instanceId || '').slice(0, 80)
    if (instanceId) existing.instanceId = instanceId
    const previous = session.clients.get(resumeId)
    if (previous && previous.ws !== client.ws) {
      // Leave sessionCode set so a signal already read on the old socket still forwards.
      previous.closeBy = 'replace'
      record(session, 'replace', `closed the previous socket for ${resumeId}`, resumeId)
      try {
        previous.ws.close()
      } catch {
        /* already closed */
      }
    }
    session.held.delete(resumeId)
    session.participants.set(resumeId, existing)
    existing.name = name || existing.name
    session.clients.set(resumeId, client)
    client.id = resumeId
    client.name = existing.name
    client.sessionCode = code
    session.emptyAt = undefined
    if (resumeId === session.hostId) existing.role = 'host'
    record(session, 'join', decision.reason, resumeId)
    await sendWelcome(session, client, existing, decision.reason)
    emitRoster(session)
    // Candidates trickled at the old socket are gone. Peers send that generation again.
    broadcast(session, { t: 'peer-resumed', id: resumeId }, resumeId)
    return
  }
  const id = resumeId && !session.participants.has(resumeId) && !session.held.has(resumeId) ? resumeId : crypto.randomUUID()
  const person: Participant = {
    id,
    name,
    role: 'guest',
    admitted: false,
    hand: false,
    music: true,
    talk: true,
    video: true,
    screen: false,
    mutedByHost: false,
    instanceId: String(msg.instanceId || '').slice(0, 80),
  }
  session.participants.set(id, person)
  session.clients.set(id, client)
  client.id = id
  client.name = name
  client.sessionCode = code
  record(session, 'join', decision.reason, id)
  await sendWelcome(session, client, person, decision.reason)
  emitRoster(session)
}

async function sendWelcome(session: Session, client: Client, person: Participant, reason?: string) {
  const { snap, ice } = await welcomeIce()
  send(client.ws, publicSession(session, person, ice, snap, reason))
  for (const publication of session.pubs.values()) {
    if (publication.peerId === person.id) continue
    send(client.ws, { t: 'sfu-pub', publication })
  }
  const sfu = sfuConfigured(process.env) && !snap.blocked
  if (!sfu && !snap.blocked && ice.turn !== 'none' && person.admitted) {
    await usage.openSession(`peer:${person.id}`, 1, admittedOthers(session, person.id))
  }
}

function admittedOthers(session: Session, id: string) {
  let count = 0
  for (const person of session.participants.values()) if (person.admitted && person.id !== id) count += 1
  return count
}

async function shapeRoom(session: Session) {
  for (const [peerId, sessionId] of session.sfuSessions) {
    await usage.setShape(sessionId, 1, admittedOthers(session, peerId))
  }
  for (const person of session.participants.values()) {
    if (!person.admitted) continue
    await usage.setShape(`peer:${person.id}`, 1, admittedOthers(session, person.id))
  }
}

function releaseMedia(session: Session, id: string) {
  const sfuId = session.sfuSessions.get(id)
  session.sfuSessions.delete(id)
  session.pubs.delete(id)
  if (sfuId) void usage.closeSession(sfuId)
  void usage.closeSession(`peer:${id}`)
  void shapeRoom(session)
}

function drop(session: Session, id: string, event: 'rejected' | 'removed') {
  const target = session.clients.get(id)
  session.participants.delete(id)
  session.held.delete(id)
  session.clients.delete(id)
  releaseMedia(session, id)
  broadcast(session, { t: 'peer-left', id })
  if (target) {
    target.sessionCode = undefined
    send(target.ws, { t: event })
  }
  emitRoster(session)
}

setInterval(() => {
  const now = Date.now()
  for (const [code, session] of sessions) {
    if (session.clients.size === 0 && session.emptyAt && now - session.emptyAt > 10 * 60 * 1000) {
      for (const id of [...session.sfuSessions.keys()]) releaseMedia(session, id)
      sessions.delete(code)
      for (const key of uploads.keys()) {
        if (key.startsWith(`${code}:`)) uploads.delete(key)
      }
      for (const key of assetUploads.keys()) {
        if (key.startsWith(`${code}:`)) assetUploads.delete(key)
      }
    }
  }
}, 30_000).unref?.()

server.listen(PORT, HOST, () => {
  console.log(`CueHarbor on http://${HOST}:${PORT} (static ${SERVE_STATIC ? STATIC_ROOT : 'off'})`)
})
