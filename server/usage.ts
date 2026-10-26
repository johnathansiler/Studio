import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { capGigabytes, creditSession, estimateBytesPerSecond, monthKey, usageSnapshot, type UsageSnapshot } from '../src/model/usage.ts'

const REDIS_KEY = 'cueharbor:cf-egress'
const GAP_MS = 120_000

interface Bucket {
  publishers: number
  subscribers: number
  /** Bytes from earlier stats epochs (a reload zeroes the browser counters). */
  reported: number
  epochSeen: number
  estimated: number
  credited: number
  lastAccrual: number
}

interface LedgerFile {
  month: string
  bytes: number
  sessions: Record<string, Bucket>
}

export interface UsageLedger {
  view(now?: number): Promise<UsageSnapshot>
  blocked(now?: number): Promise<boolean>
  openSession(id: string, publishers: number, subscribers: number, now?: number): Promise<void>
  setShape(id: string, publishers: number, subscribers: number, now?: number): Promise<void>
  closeSession(id: string, now?: number): Promise<void>
  report(id: string, cumulative: number, now?: number): Promise<UsageSnapshot>
  applyFloor(bytes: number, now?: number): Promise<UsageSnapshot>
  stop(): void
}

export function createUsageLedger(options: {
  env?: NodeJS.ProcessEnv
  filePath?: string
  now?: () => number
} = {}): UsageLedger {
  const env = options.env || process.env
  const filePath = options.filePath || env.CF_USAGE_PATH || path.join(tmpdir(), 'cueharbor-cf-usage.json')
  const redisUrl = env.CF_USAGE_REDIS_URL || env.REDIS_URL || ''
  const clock = options.now || Date.now
  let record: LedgerFile = { month: monthKey(new Date(clock())), bytes: 0, sessions: {} }
  let loaded = false
  /** Sessions this process has opened or heard from. A restart must not keep estimating rooms that are already gone. */
  const live = new Set<string>()
  let writing: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    void accrue(clock()).catch(() => undefined)
  }, 10_000)
  timer.unref?.()

  function blank(now: number): LedgerFile {
    return { month: monthKey(new Date(now)), bytes: 0, sessions: {} }
  }

  function roll(now: number) {
    const month = monthKey(new Date(now))
    if (record.month !== month) record = blank(now)
  }

  async function load() {
    if (loaded) return
    loaded = true
    const fromFile = await readStore(filePath)
    const fromRedis = redisUrl ? await readRedis(redisUrl) : null
    const now = clock()
    const month = monthKey(new Date(now))
    const candidates = [fromFile, fromRedis].filter((item): item is LedgerFile => Boolean(item && item.month === month))
    if (!candidates.length) {
      record = blank(now)
      return
    }
    candidates.sort((a, b) => b.bytes - a.bytes)
    record = candidates[0]
  }

  async function persist() {
    const snapshot = JSON.parse(JSON.stringify(record)) as LedgerFile
    writing = writing.then(async () => {
      await writeStore(filePath, snapshot)
      if (redisUrl) await writeRedis(redisUrl, snapshot)
    }).catch(() => undefined)
    await writing
  }

  function touch(now: number) {
    roll(now)
    let added = 0
    for (const [id, bucket] of Object.entries(record.sessions)) {
      if (!live.has(id)) continue
      added += accrueBucket(bucket, now)
    }
    if (added) record.bytes += added
    return added
  }

  async function accrue(now: number) {
    await load()
    const added = touch(now)
    if (added) await persist()
  }

  async function mutate(now: number) {
    await load()
    touch(now)
    await persist()
    return usageSnapshot(record.bytes, capGigabytes(env.CF_REALTIME_MONTHLY_CAP_GB), record.month)
  }

  return {
    async view(now = clock()) {
      await load()
      touch(now)
      return usageSnapshot(record.bytes, capGigabytes(env.CF_REALTIME_MONTHLY_CAP_GB), record.month)
    },
    async blocked(now = clock()) {
      const snap = await this.view(now)
      return snap.blocked
    },
    async openSession(id: string, publishers: number, subscribers: number, now = clock()) {
      await load()
      roll(now)
      live.add(id)
      if (!record.sessions[id]) {
        record.sessions[id] = {
          publishers: Math.max(0, publishers),
          subscribers: Math.max(0, subscribers),
          reported: 0,
          epochSeen: 0,
          estimated: 0,
          credited: 0,
          lastAccrual: now,
        }
      } else {
        record.sessions[id].publishers = Math.max(0, publishers)
        record.sessions[id].subscribers = Math.max(0, subscribers)
      }
      await persist()
    },
    async setShape(id: string, publishers: number, subscribers: number, now = clock()) {
      await load()
      live.add(id)
      const bucket = record.sessions[id]
      if (!bucket) return
      touch(now)
      bucket.publishers = Math.max(0, publishers)
      bucket.subscribers = Math.max(0, subscribers)
      await persist()
    },
    async closeSession(id: string, now = clock()) {
      await load()
      live.delete(id)
      if (!record.sessions[id]) return
      touch(now)
      delete record.sessions[id]
      await persist()
    },
    async report(id: string, cumulative: number, now = clock()) {
      await load()
      roll(now)
      const seen = Number.isFinite(cumulative) ? Math.max(0, cumulative) : 0
      live.add(id)
      let bucket = record.sessions[id]
      if (!bucket) {
        bucket = {
          publishers: 1,
          subscribers: 1,
          reported: 0,
          epochSeen: 0,
          estimated: 0,
          credited: 0,
          lastAccrual: now,
        }
        record.sessions[id] = bucket
      }
      noteReport(bucket, seen)
      return mutate(now)
    },
    async applyFloor(bytes: number, now = clock()) {
      await load()
      roll(now)
      const floor = Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0
      const cap = usageSnapshot(0, capGigabytes(env.CF_REALTIME_MONTHLY_CAP_GB), record.month)
      const clamped = Math.min(floor, capBytesOf(cap.capGigabytes))
      if (clamped > record.bytes) record.bytes = clamped
      await persist()
      return usageSnapshot(record.bytes, cap.capGigabytes, record.month)
    },
    stop() {
      clearInterval(timer)
    },
  }
}

function capBytesOf(gigabytes: number) {
  return Math.round(gigabytes * 1_000_000_000)
}

function noteReport(bucket: Bucket, cumulative: number) {
  if (cumulative + 4096 < bucket.epochSeen) {
    bucket.reported += bucket.epochSeen
    bucket.epochSeen = cumulative
    return
  }
  bucket.epochSeen = Math.max(bucket.epochSeen, cumulative)
}

function accrueBucket(bucket: Bucket, now: number) {
  const dt = now - bucket.lastAccrual
  if (dt > GAP_MS) bucket.lastAccrual = now
  else if (dt > 0) {
    bucket.estimated += (dt / 1000) * estimateBytesPerSecond(bucket.publishers, bucket.subscribers)
    bucket.lastAccrual = now
  }
  const credit = creditSession(bucket.credited, bucket.reported + bucket.epochSeen, bucket.estimated)
  bucket.credited = credit.credited
  return credit.added
}

async function readStore(filePath: string): Promise<LedgerFile | null> {
  try {
    return normalize(JSON.parse(await readFile(filePath, 'utf8')))
  } catch {
    return null
  }
}

async function writeStore(filePath: string, record: LedgerFile) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(record))
  await rename(temp, filePath)
}

function normalize(value: unknown): LedgerFile | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<LedgerFile>
  if (!row.month || typeof row.bytes !== 'number') return null
  return {
    month: String(row.month),
    bytes: Math.max(0, row.bytes),
    sessions: row.sessions && typeof row.sessions === 'object' ? row.sessions : {},
  }
}

function encodeResp(args: string[]) {
  const parts = [`*${args.length}\r\n`]
  for (const arg of args) {
    parts.push(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`)
  }
  return parts.join('')
}

function readRedis(url: string): Promise<LedgerFile | null> {
  return redisCommand(url, ['GET', REDIS_KEY]).then((reply) => {
    if (!reply) return null
    try {
      return normalize(JSON.parse(reply))
    } catch {
      return null
    }
  }).catch(() => null)
}

function writeRedis(url: string, record: LedgerFile) {
  return redisCommand(url, ['SET', REDIS_KEY, JSON.stringify(record)]).then(() => undefined).catch(() => undefined)
}

/** Enough RESP for GET and SET against the internal Render key-value URL. */
function redisCommand(url: string, args: string[]): Promise<string | null> {
  const parsed = new URL(url)
  const payload = encodeResp(args)
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port || 6379) })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('redis timeout'))
    }, 1500)
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const parsedReply = parseResp(buf)
      if (!parsedReply) return
      clearTimeout(timer)
      socket.end()
      if (parsedReply.error) reject(new Error('redis error'))
      else resolve(parsedReply.value)
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => socket.write(payload))
  })
}

function parseResp(buf: Buffer): { value: string | null; error: boolean } | null {
  if (!buf.length) return null
  const prefix = String.fromCharCode(buf[0])
  const text = buf.toString('utf8')
  if (prefix === '+' || prefix === '-' || prefix === ':') {
    const end = text.indexOf('\r\n')
    if (end < 0) return null
    return { value: text.slice(1, end), error: prefix === '-' }
  }
  if (prefix === '$') {
    const line = text.indexOf('\r\n')
    if (line < 0) return null
    const size = Number(text.slice(1, line))
    if (size < 0) return { value: null, error: false }
    const start = line + 2
    if (buf.length < start + size + 2) return null
    return { value: buf.subarray(start, start + size).toString('utf8'), error: false }
  }
  return null
}
