import { createServer, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

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
}

interface Session {
  code: string
  hostId: string
  participants: Map<string, Participant>
  clients: Map<string, Client>
  chat: ChatMessage[]
  emptyAt?: number
}

const sessions = new Map<string, Session>()

function iceServers() {
  const servers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: 'stun:stun.l.google.com:19302' },
  ]
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    })
  }
  return servers
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
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

function publicSession(session: Session, self: Participant) {
  return {
    t: 'welcome',
    id: self.id,
    role: self.role,
    code: session.code,
    iceServers: iceServers(),
    participants: roster(session),
    chat: session.chat.slice(-80),
  }
}

function leave(client: Client) {
  if (!client.sessionCode) return
  const session = sessions.get(client.sessionCode)
  if (!session) return
  session.clients.delete(client.id)
  session.participants.delete(client.id)
  client.sessionCode = undefined
  if (session.clients.size === 0) {
    session.emptyAt = Date.now()
  } else {
    emitRoster(session)
    if (client.id === session.hostId) {
      broadcast(session, { t: 'host-away' })
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  if (url.pathname === '/api/health') return json(res, { ok: true, service: 'cueharbor', sessions: sessions.size })
  if (url.pathname === '/api/ice') return json(res, { iceServers: iceServers() })
  if (SERVE_STATIC) {
    await serveStatic(url.pathname, res)
    return
  }
  json(res, { error: 'CueHarbor signaling server. The app is served by Vite in development.' }, 404)
})

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

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  const client: Client = { ws, id: '', name: 'Guest' }
  ws.on('message', (raw) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    handle(client, msg)
  })
  ws.on('close', () => leave(client))
})

function handle(client: Client, msg: Record<string, unknown>) {
  if (msg.t === 'hello') {
    hello(client, msg)
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
    const admittedCount = [...session.participants.values()].filter((p) => p.admitted).length
    if (admittedCount >= MAX_PARTY) {
      send(client.ws, { t: 'error', message: `Mesh limit is ${MAX_PARTY} people. Remove someone first.` })
      return
    }
    person.admitted = true
    emitRoster(session)
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
  if (msg.t === 'signal') {
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

function hello(client: Client, msg: Record<string, unknown>) {
  const name = String(msg.name || 'Guest').slice(0, 40)
  const resumeId = msg.resumeId ? String(msg.resumeId) : ''
  if (msg.create) {
    const code = freshCode()
    const id = resumeId || crypto.randomUUID()
    const session: Session = {
      code,
      hostId: id,
      participants: new Map(),
      clients: new Map(),
      chat: [],
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
    }
    session.participants.set(id, person)
    session.clients.set(id, client)
    client.id = id
    client.name = name
    client.sessionCode = code
    sessions.set(code, session)
    send(client.ws, publicSession(session, person))
    return
  }
  const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const session = sessions.get(code)
  if (!session) {
    send(client.ws, { t: 'error', message: 'That invite is no longer live.' })
    return
  }
    if (resumeId && session.participants.has(resumeId)) {
    const existing = session.participants.get(resumeId)!
    const previous = session.clients.get(resumeId)
    if (previous && previous.ws !== client.ws) {
      previous.sessionCode = undefined
      previous.ws.close()
    }
    existing.name = name || existing.name
    session.clients.set(resumeId, client)
    client.id = resumeId
    client.name = existing.name
    client.sessionCode = code
    if (resumeId === session.hostId) existing.role = 'host'
    send(client.ws, publicSession(session, existing))
    emitRoster(session)
    return
  }
  const id = crypto.randomUUID()
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
  }
  session.participants.set(id, person)
  session.clients.set(id, client)
  client.id = id
  client.name = name
  client.sessionCode = code
  send(client.ws, publicSession(session, person))
  emitRoster(session)
}

function drop(session: Session, id: string, event: 'rejected' | 'removed') {
  const target = session.clients.get(id)
  session.participants.delete(id)
  session.clients.delete(id)
  if (target) {
    target.sessionCode = undefined
    send(target.ws, { t: event })
  }
  emitRoster(session)
}

setInterval(() => {
  const now = Date.now()
  for (const [code, session] of sessions) {
    if (session.clients.size === 0 && session.emptyAt && now - session.emptyAt > 15 * 60 * 1000) {
      sessions.delete(code)
    }
  }
}, 30_000).unref?.()

server.listen(PORT, HOST, () => {
  console.log(`CueHarbor on http://${HOST}:${PORT} (static ${SERVE_STATIC ? STATIC_ROOT : 'off'})`)
})
