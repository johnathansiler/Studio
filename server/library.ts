/**
 * Owner-only presign for the private R2 library.
 * The server never reads or streams audio. The browser fetches the signed GET itself.
 * Credentials stay in the process environment.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { AwsClient } from 'aws4fetch'

export const LIBRARY_EXPIRES_SEC = 15 * 60
export const LIBRARY_CATALOG_KEY = 'catalog/catalog.json.gz'
export const LIBRARY_NOT_READY = 'My Library is not set up on this server.'

const FAIL_WINDOW_MS = 10 * 60 * 1000
const FAIL_MAX = 8
const OK_WINDOW_MS = 60 * 1000
const OK_MAX = 40
const MAX_KEYS = 24

export interface LibraryEnv {
  R2_ACCOUNT_ID?: string
  R2_BUCKET?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  LIBRARY_ACCESS_KEY?: string
}

export interface LibraryReady {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  accessKey: string
}

export function readLibraryEnv(env: LibraryEnv): LibraryReady | null {
  const accountId = env.R2_ACCOUNT_ID?.trim() ?? ''
  const bucket = env.R2_BUCKET?.trim() ?? ''
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim() ?? ''
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim() ?? ''
  const accessKey = env.LIBRARY_ACCESS_KEY?.trim() ?? ''
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !accessKey) return null
  return { accountId, bucket, accessKeyId, secretAccessKey, accessKey }
}

/** Compare passphrases without leaking the length or the expected value through an early return. */
export function accessKeyMatches(provided: string, expected: string) {
  const left = createHash('sha256').update(provided, 'utf8').digest()
  const right = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(left, right)
}

/** Object key inside the private bucket. Rejects URLs and path escape. */
export function libraryObjectKey(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const key = input.trim()
  if (!key || key.length > 512) return null
  if (key.startsWith('/') || key.includes('\\') || key.includes('://') || key.includes('\0')) return null
  if (/[\u0000-\u001f\u007f]/.test(key)) return null
  if (key.split('/').some((part) => part === '..' || part === '')) return null
  return key
}

export function r2ObjectUrl(accountId: string, bucket: string, key: string) {
  const encoded = key.split('/').map((part) => encodeURIComponent(part)).join('/')
  return `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encoded}`
}

/** Presign one GET. The secret is not placed in the URL. */
export async function presignR2Get(env: LibraryEnv, key: string, expires = LIBRARY_EXPIRES_SEC): Promise<string> {
  const ready = readLibraryEnv(env)
  const objectKey = libraryObjectKey(key)
  if (!ready || !objectKey) throw new Error(LIBRARY_NOT_READY)
  const url = new URL(r2ObjectUrl(ready.accountId, ready.bucket, objectKey))
  url.searchParams.set('X-Amz-Expires', String(expires))
  const client = new AwsClient({
    accessKeyId: ready.accessKeyId,
    secretAccessKey: ready.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
  const signed = await client.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } })
  return signed.url
}

export interface LibraryCall {
  method: string
  pathname: string
  ip: string
  accessKey: string
  body: unknown
  now: number
}

export interface LibraryResult {
  status: number
  body: Record<string, unknown>
}

export interface LibraryApi {
  handle(call: LibraryCall): Promise<LibraryResult>
}

function prune(times: number[], now: number, windowMs: number) {
  return times.filter((time) => now - time < windowMs)
}

export function createLibraryApi(deps: {
  env: () => LibraryEnv
  sign?: (key: string, env: LibraryEnv) => Promise<string>
  now?: () => number
}): LibraryApi {
  const failures = new Map<string, number[]>()
  const successes = new Map<string, number[]>()
  const sign = deps.sign ?? ((key: string, env: LibraryEnv) => presignR2Get(env, key))

  return {
    async handle(call) {
      const env = deps.env()
      const ready = readLibraryEnv(env)
      const path = call.pathname
      if (path !== '/api/library' && path !== '/api/library/sign') {
        return { status: 404, body: { error: 'Not found.' } }
      }
      if (!ready) return { status: call.method === 'GET' && path === '/api/library' ? 200 : 503, body: { ready: false, message: LIBRARY_NOT_READY } }
      if (call.method === 'GET' && path === '/api/library') return { status: 200, body: { ready: true } }
      if (call.method !== 'POST' || path !== '/api/library/sign') return { status: 405, body: { error: 'Use POST.' } }

      const now = call.now
      const ip = call.ip || 'local'
      const locked = prune(failures.get(ip) ?? [], now, FAIL_WINDOW_MS)
      failures.set(ip, locked)
      const provided = call.accessKey ?? ''
      const matches = accessKeyMatches(provided, ready.accessKey)
      if (locked.length >= FAIL_MAX) {
        return { status: 429, body: { error: 'Too many unlock attempts. Wait and try again.' } }
      }
      if (!matches) {
        locked.push(now)
        failures.set(ip, locked)
        return { status: 401, body: { error: 'That passphrase does not unlock the library.' } }
      }
      const recent = prune(successes.get(ip) ?? [], now, OK_WINDOW_MS)
      if (recent.length >= OK_MAX) {
        successes.set(ip, recent)
        return { status: 429, body: { error: 'Too many library requests. Wait a minute and try again.' } }
      }
      const keys = keysFromBody(call.body)
      if (!keys) return { status: 400, body: { error: 'Those library paths cannot be signed.' } }
      const urls: { key: string; url: string }[] = []
      for (const key of keys) {
        urls.push({ key, url: await sign(key, env) })
      }
      recent.push(now)
      successes.set(ip, recent)
      return { status: 200, body: { ready: true, expiresIn: LIBRARY_EXPIRES_SEC, urls } }
    },
  }
}

function keysFromBody(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null
  const raw = body as { key?: unknown; keys?: unknown }
  const listed = Array.isArray(raw.keys) ? raw.keys : raw.key != null ? [raw.key] : null
  if (!listed || !listed.length || listed.length > MAX_KEYS) return null
  const keys: string[] = []
  for (const item of listed) {
    const key = libraryObjectKey(item)
    if (!key) return null
    keys.push(key)
  }
  return keys
}
