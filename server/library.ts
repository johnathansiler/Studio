/**
 * Owner-only presign for the private R2 library.
 * Audio bytes are not streamed through this process. The phone fetches a signed GET,
 * or uploads a WAV with a signed PUT under the audio prefix.
 * The big catalog/catalog.json.gz object stays immutable. Appended rows live in the
 * small catalog/catalog-additions.json sidecar. Readers merge the two; additions win.
 * catalog-append reads and writes only that sidecar. A key that exists only in the
 * base catalog is not looked up, so the first append of that key reports added: 1
 * and stores a sidecar row. A later append of a key already in the sidecar adds nothing.
 * The library passphrase is never written to a log.
 * Credentials stay in the process environment.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { AwsClient } from 'aws4fetch'
import { layersForNotes, type InstrumentQuery, type LibraryInstrument } from '../src/library/group.ts'
import { LIBRARY_UPLOAD_MAX_KEYS, libraryAudioKey, libraryUploadSize, mergeCatalogEntries } from '../src/library/upload.ts'

export const LIBRARY_EXPIRES_SEC = 15 * 60
export const LIBRARY_CATALOG_KEY = 'catalog/catalog.json.gz'
/** Appended rows only. The base catalog gzip is never rewritten by an append. */
export const LIBRARY_ADDITIONS_KEY = 'catalog/catalog-additions.json'
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

/** A catalog object key. Audio keys are not writable through the catalog copier. */
export function libraryCatalogWriteKey(input: unknown): string | null {
  const key = libraryObjectKey(input)
  if (!key || !key.startsWith('catalog/')) return null
  return key
}

/**
 * Presign one create-only PUT for a WAV under the audio prefix.
 * Content-Type, Content-Length, and If-None-Match are part of the signature,
 * so a different type, a different size, or a replacement of an existing object is rejected.
 * The secret is not placed in the URL.
 */
export async function presignR2Put(env: LibraryEnv, key: string, size: number, expires = LIBRARY_EXPIRES_SEC): Promise<string> {
  const ready = readLibraryEnv(env)
  const objectKey = libraryAudioKey(key)
  const bytes = libraryUploadSize(size)
  if (!ready || !objectKey || bytes == null) throw new Error(LIBRARY_NOT_READY)
  const url = new URL(r2ObjectUrl(ready.accountId, ready.bucket, objectKey))
  url.searchParams.set('X-Amz-Expires', String(expires))
  const client = new AwsClient({
    accessKeyId: ready.accessKeyId,
    secretAccessKey: ready.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
  const signed = await client.sign(url, {
    method: 'PUT',
    headers: {
      'content-type': LIBRARY_PUT_TYPE,
      'content-length': String(bytes),
      'if-none-match': '*',
    },
    aws: { signQuery: true, allHeaders: true },
  })
  const signedUrl = signed.url
  const names = new URL(signedUrl).searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? []
  if (!names.includes('content-type') || !names.includes('content-length') || !names.includes('if-none-match')) throw new Error(LIBRARY_NOT_READY)
  if (signedUrl.includes(ready.secretAccessKey) || signedUrl.includes(ready.accessKey)) throw new Error(LIBRARY_NOT_READY)
  return signedUrl
}

export interface LibraryObjectBody {
  status: number
  bytes: Uint8Array | null
  etag?: string | null
}

export interface LibraryWriteConditions {
  ifMatch?: string
  ifNoneMatch?: string
}

const CATALOG_CONFLICT = 'catalog-conflict'
const LIBRARY_PUT_TYPE = 'audio/wav'

/** Catalog bytes only. Audio objects are not read here except for a HEAD used to skip an existing upload. */
export interface LibraryObjects {
  get(key: string): Promise<LibraryObjectBody>
  put(key: string, bytes: Uint8Array, contentType: string, conditions?: LibraryWriteConditions): Promise<void>
  copy(from: string, to: string, conditions?: LibraryWriteConditions): Promise<void>
  head?(key: string): Promise<boolean>
  /**
   * Strong ETag from HEAD. Catalog append uses this when GET omitted the header
   * (or only returned a weak tag) so the conditional PUT still has If-Match.
   */
  etag?(key: string): Promise<string | null>
}

function awsClient(ready: LibraryReady) {
  return new AwsClient({
    accessKeyId: ready.accessKeyId,
    secretAccessKey: ready.secretAccessKey,
    service: 's3',
    region: 'auto',
  })
}

/** First ETag header value. `.get` is case-insensitive; iteration covers a wrapper that hides `.get`. */
function rawEtag(headers: Headers): string {
  try {
    const direct = headers.get('etag')
    if (direct) return direct
  } catch {
    // fall through to iteration
  }
  try {
    for (const [name, value] of headers.entries()) {
      if (name.toLowerCase() === 'etag' && value) return value
    }
  } catch {
    // no header list
  }
  return ''
}

function isWeakEtag(value: string) {
  return /^w\//i.test(value.trim().split(',')[0]?.trim() ?? '')
}

/**
 * ETag for If-Match. R2's object tag is a quoted strong tag. A proxy may wrap it
 * as a weak tag or drop the quotes; If-Match uses the strong comparison, so a
 * weak tag never matches and an unquoted tag does not either.
 */
function quoteEtag(value: string | null | undefined): string | null {
  let text = value?.trim().split(',')[0]?.trim() ?? ''
  if (!text || text === '*') return null
  if (/^w\//i.test(text)) text = text.slice(2).trim()
  if (!text || text === '*') return null
  if (text.startsWith('"') && text.endsWith('"') && text.length > 2) return text
  if (/^[\x21\x23-\x7E]+$/.test(text)) return `"${text}"`
  return null
}

function responseEtag(response: Response, allowWeak: boolean): string | null {
  const raw = rawEtag(response.headers)
  if (!raw) return null
  if (!allowWeak && isWeakEtag(raw)) return null
  return quoteEtag(raw)
}

function r2Objects(readEnv: () => LibraryEnv, fetchImpl?: typeof fetch): LibraryObjects {
  async function call(method: string, key: string, init?: { body?: Uint8Array; contentType?: string; copySource?: string; conditions?: LibraryWriteConditions; identity?: boolean }) {
    const ready = readLibraryEnv(readEnv())
    const objectKey = method === 'PUT' ? libraryCatalogWriteKey(key) : libraryObjectKey(key)
    if (!ready || !objectKey) throw new Error(LIBRARY_NOT_READY)
    const headers: Record<string, string> = {}
    if (init?.contentType) headers['content-type'] = init.contentType
    if (init?.copySource) headers['x-amz-copy-source'] = init.copySource
    if (init?.conditions?.ifMatch) headers['if-match'] = init.conditions.ifMatch
    if (init?.conditions?.ifNoneMatch) headers['if-none-match'] = init.conditions.ifNoneMatch
    // Ask for the stored bytes. A compressed GET drops or weakens ETag, and the
    // next conditional PUT then has nothing safe to send as If-Match.
    if (init?.identity) headers['accept-encoding'] = 'identity'
    const url = r2ObjectUrl(ready.accountId, ready.bucket, objectKey)
    const request = { method, headers, body: init?.body as BodyInit | undefined }
    if (!fetchImpl) return awsClient(ready).fetch(url, request)
    return fetchImpl(await awsClient(ready).sign(url, request))
  }
  return {
    async get(key) {
      const response = await call('GET', key, { identity: true })
      // A weak tag is not usable for If-Match. Leave it empty so the caller can HEAD.
      const etag = responseEtag(response, false)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (response.status === 404) return { status: 404, bytes: null, etag: null }
      if (!response.ok) return { status: response.status, bytes: null, etag: null }
      return { status: 200, bytes, etag }
    },
    async put(key, bytes, contentType, conditions) {
      const response = await call('PUT', key, { body: bytes, contentType, conditions })
      if (response.status === 412) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(CATALOG_CONFLICT)
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('Could not write the library catalog.')
      }
      await response.body?.cancel().catch(() => undefined)
    },
    async copy(from, to, conditions) {
      const ready = readLibraryEnv(readEnv())
      const sourceKey = libraryCatalogWriteKey(from)
      if (!ready || !sourceKey) throw new Error(LIBRARY_NOT_READY)
      const source = `/${ready.bucket}/${sourceKey.split('/').map((part) => encodeURIComponent(part)).join('/')}`
      const response = await call('PUT', to, { copySource: source, conditions })
      if (response.status === 412) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(CATALOG_CONFLICT)
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('Could not write the library catalog.')
      }
      await response.body?.cancel().catch(() => undefined)
    },
    async head(key) {
      const response = await call('HEAD', key)
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 404) return false
      if (response.ok) return true
      throw new Error('Could not sign that sound.')
    },
    async etag(key) {
      const response = await call('HEAD', key, { identity: true })
      const etag = responseEtag(response, true)
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 404 || !response.ok) return null
      return etag
    },
  }
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
  /** Raw query string, including the leading `?` when present. */
  search?: string
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

function headerValue(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value
  const text = raw?.trim() ?? ''
  if (!text || text.length > 64 || text.includes(',') || /\s/.test(text)) return ''
  return text
}

/**
 * Address for the rate limit.
 * Cloudflare sets CF-Connecting-IP and overwrites a client-supplied value.
 * X-Forwarded-For is appended to, so its first address is forgeable and is ignored.
 */
export function libraryClientIp(headers: { [key: string]: string | string[] | undefined }, remoteAddress?: string | null) {
  return headerValue(headers['cf-connecting-ip']) || headerValue(headers['true-client-ip']) || remoteAddress?.trim() || 'local'
}

export interface InstrumentCatalog {
  search(query: InstrumentQuery): Promise<{ total: number; offset: number; limit: number; instruments: unknown[] }>
  get(id: string): Promise<LibraryInstrument | null>
}

const LIBRARY_POST = new Set(['/api/library/sign', '/api/library/upload-sign', '/api/library/catalog-append'])

export function createLibraryApi(deps: {
  env: () => LibraryEnv
  sign?: (key: string, env: LibraryEnv) => Promise<string>
  signPut?: (key: string, size: number, env: LibraryEnv) => Promise<string>
  now?: () => number
  instruments?: InstrumentCatalog
  objects?: LibraryObjects
  /** Used by the R2 client when `objects` is not injected. Tests pass this so they never call R2. */
  fetch?: typeof fetch
}): LibraryApi {
  const failures = new Map<string, number[]>()
  const successes = new Map<string, number[]>()
  const sign = deps.sign ?? ((key: string, env: LibraryEnv) => presignR2Get(env, key))
  const signPut = deps.signPut ?? ((key: string, size: number, env: LibraryEnv) => presignR2Put(env, key, size))
  const objects = deps.objects ?? r2Objects(deps.env, deps.fetch)
  let catalogTail: Promise<unknown> = Promise.resolve()
  let writeSeq = 0

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = catalogTail.then(task, task)
    catalogTail = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    async handle(call) {
      const env = deps.env()
      const ready = readLibraryEnv(env)
      const path = call.pathname
      const instrumentPath = instrumentRoute(path)
      if (!instrumentPath && path !== '/api/library' && !LIBRARY_POST.has(path)) {
        return { status: 404, body: { error: 'Not found.' } }
      }
      if (!ready) return { status: call.method === 'GET' && path === '/api/library' ? 200 : 503, body: { ready: false, message: LIBRARY_NOT_READY } }
      if (call.method === 'GET' && path === '/api/library') return { status: 200, body: { ready: true } }
      if (!instrumentPath && (call.method !== 'POST' || !LIBRARY_POST.has(path))) return { status: 405, body: { error: 'Use POST.' } }

      const now = call.now
      const ip = call.ip || 'local'
      const locked = prune(failures.get(ip) ?? [], now, FAIL_WINDOW_MS)
      if (locked.length) failures.set(ip, locked)
      else failures.delete(ip)
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
      if (instrumentPath) {
        recent.push(now)
        successes.set(ip, recent)
        return serveInstruments(deps.instruments, instrumentPath, call, (key) => sign(key, env))
      }
      if (path === '/api/library/upload-sign') {
        const items = uploadItems(call.body)
        if (!items) return { status: 400, body: { error: 'Those library paths cannot be signed.' } }
        recent.push(now)
        successes.set(ip, recent)
        return signUploads(items, env, signPut, objects)
      }
      if (path === '/api/library/catalog-append') {
        const listed = entriesFromBody(call.body)
        const probe = listed ? mergeCatalogEntries({ version: 0, generated_at: '', count: 0, pending: '', entries: [] }, listed, now) : { ok: false as const }
        if (!probe.ok) return { status: 400, body: { error: 'Those catalog entries cannot be added.' } }
        recent.push(now)
        successes.set(ip, recent)
        return exclusive(() => appendCatalog(listed!, objects, now, () => {
          writeSeq += 1
          return writeSeq
        }))
      }
      const keys = keysFromBody(call.body)
      if (!keys) return { status: 400, body: { error: 'Those library paths cannot be signed.' } }
      recent.push(now)
      successes.set(ip, recent)
      const urls: { key: string; url: string }[] = []
      for (const key of keys) {
        urls.push({ key, url: await sign(key, env) })
      }
      return { status: 200, body: { ready: true, expiresIn: LIBRARY_EXPIRES_SEC, urls } }
    },
  }
}

function uploadItems(body: unknown): { key: string; size: number }[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = body as { keys?: unknown; files?: unknown }
  const listed = Array.isArray(raw.keys) ? raw.keys : Array.isArray(raw.files) ? raw.files : null
  if (!listed || !listed.length || listed.length > LIBRARY_UPLOAD_MAX_KEYS) return null
  const items: { key: string; size: number }[] = []
  for (const item of listed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const row = item as { key?: unknown; size?: unknown }
    const key = libraryAudioKey(row.key)
    const size = libraryUploadSize(row.size)
    if (!key || size == null) return null
    items.push({ key, size })
  }
  return items
}

function entriesFromBody(body: unknown): unknown[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const listed = (body as { entries?: unknown }).entries
  return Array.isArray(listed) ? listed : null
}

async function signUploads(
  items: { key: string; size: number }[],
  env: LibraryEnv,
  signPut: (key: string, size: number, env: LibraryEnv) => Promise<string>,
  objects: LibraryObjects,
): Promise<LibraryResult> {
  if (!objects.head) return { status: 503, body: { error: 'Could not sign that sound.' } }
  const urls: { key: string; url: string; exists: boolean }[] = []
  for (const item of items) {
    let exists = false
    try {
      exists = await objects.head(item.key)
    } catch {
      return { status: 503, body: { error: 'Could not sign that sound.' } }
    }
    if (exists) {
      urls.push({ key: item.key, url: '', exists: true })
      continue
    }
    try {
      urls.push({ key: item.key, url: await signPut(item.key, item.size, env), exists: false })
    } catch {
      return { status: 503, body: { error: 'Could not sign that sound.' } }
    }
  }
  return { status: 200, body: { ready: true, expiresIn: LIBRARY_EXPIRES_SEC, urls } }
}

function catalogConflict(error: unknown) {
  return error instanceof Error && error.message === CATALOG_CONFLICT
}

const EMPTY_ADDITIONS = { version: 0, generated_at: '', count: 0, entries: [] as unknown[] }

function catalogUnavailable(): { ok: false; result: LibraryResult } {
  return { ok: false, result: { status: 503, body: { error: 'Could not update the library catalog.' } } }
}

/** Quoted tag for If-Match. A weak tag is refused here; HEAD may still recover a strong one. */
function strongSidecarEtag(value: string | null | undefined): string | null {
  if (!value || isWeakEtag(value)) return null
  return quoteEtag(value)
}

/**
 * Sidecar bytes paired with the ETag of those bytes.
 * GET against R2 can omit ETag (or return only a weak tag). HEAD still carries
 * the object tag. A second read confirms the tag still names the bytes, so a
 * writer who landed in between gets a 412 retry instead of an overwrite.
 */
async function loadSidecar(objects: LibraryObjects): Promise<LibraryObjectBody> {
  const first = await objects.get(LIBRARY_ADDITIONS_KEY)
  if (first.status !== 200 || !first.bytes) return first
  const fromGet = strongSidecarEtag(first.etag)
  if (fromGet) return { status: 200, bytes: first.bytes, etag: fromGet }
  if (!objects.etag) return { status: 200, bytes: first.bytes, etag: quoteEtag(first.etag) }
  const headed = quoteEtag(await objects.etag(LIBRARY_ADDITIONS_KEY))
  if (!headed) return { status: 200, bytes: first.bytes, etag: quoteEtag(first.etag) }
  const again = await objects.get(LIBRARY_ADDITIONS_KEY)
  if (again.status !== 200 || !again.bytes) return again
  const againEtag = strongSidecarEtag(again.etag)
  if (againEtag) return { status: 200, bytes: again.bytes, etag: againEtag }
  const confirm = quoteEtag(await objects.etag(LIBRARY_ADDITIONS_KEY))
  if (confirm && confirm === headed) return { status: 200, bytes: again.bytes, etag: confirm }
  throw new Error(CATALOG_CONFLICT)
}

type AdditionsRead =
  | { ok: true; document: unknown; etag: string | null }
  | { ok: false; result: LibraryResult }
  | { ok: 'retry' }

/** Sidecar only. The base catalog object is not read or written here. */
async function readAdditions(objects: LibraryObjects): Promise<AdditionsRead> {
  try {
    const loaded = await loadSidecar(objects)
    if (loaded.status === 404) return { ok: true, document: { ...EMPTY_ADDITIONS, entries: [] }, etag: null }
    if (loaded.status !== 200 || !loaded.bytes || !loaded.etag) return catalogUnavailable()
    const current = JSON.parse(Buffer.from(loaded.bytes).toString('utf8')) as unknown
    const parsed = current && typeof current === 'object' && !Array.isArray(current) ? current as { entries?: unknown } : null
    if (!parsed || !Array.isArray(parsed.entries)) return catalogUnavailable()
    return { ok: true, document: current, etag: loaded.etag }
  } catch (error) {
    if (catalogConflict(error)) return { ok: 'retry' }
    return catalogUnavailable()
  }
}

/**
 * Append into the sidecar. `added` counts rows that were not already in the sidecar.
 * A key that exists only in the base catalog still counts as added on the first append.
 */
async function appendCatalog(
  listed: unknown[],
  objects: LibraryObjects,
  now: number,
  nextSeq: () => number,
): Promise<LibraryResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const loaded = await readAdditions(objects)
    if (loaded.ok === 'retry') continue
    if (!loaded.ok) return loaded.result
    const merged = mergeCatalogEntries(loaded.document, listed, now)
    if (!merged.ok) return { status: 400, body: { error: 'Those catalog entries cannot be added.' } }
    const version = typeof merged.document.version === 'number' && Number.isFinite(merged.document.version) ? merged.document.version : 0
    const generatedAt = typeof merged.document.generated_at === 'string' ? merged.document.generated_at : ''
    const count = Array.isArray(merged.document.entries) ? merged.document.entries.length : 0
    const previous = loaded.document && typeof loaded.document === 'object' && !Array.isArray(loaded.document) && Array.isArray((loaded.document as { entries?: unknown }).entries)
      ? (loaded.document as { entries: unknown[] }).entries.length
      : 0
    if (count < previous) return { status: 503, body: { error: 'Could not update the library catalog.' } }
    if (!merged.changed) return { status: 200, body: { ready: true, version, generatedAt, count, added: 0, skipped: merged.skipped } }
    try {
      const body = Buffer.from(JSON.stringify(merged.document))
      const stamp = `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${nextSeq()}-${randomBytes(4).toString('hex')}`
      const tempKey = `catalog/tmp/additions-${stamp}.json`
      const backupKey = `catalog/backups/additions-${stamp}.json`
      await objects.put(tempKey, body, 'application/json')
      await objects.copy(tempKey, backupKey)
      // CopyObject on R2 does not apply If-Match to the destination (that header is
      // cf-copy-destination-if-match, and it is still beta). PutObject does, and a
      // mismatched ETag comes back as 412 so the retry keeps the other writer's rows.
      await objects.put(LIBRARY_ADDITIONS_KEY, body, 'application/json', loaded.etag ? { ifMatch: loaded.etag } : { ifNoneMatch: '*' })
      return { status: 200, body: { ready: true, version, generatedAt, count, added: merged.added, skipped: merged.skipped } }
    } catch (error) {
      if (catalogConflict(error) && attempt < 3) continue
      return { status: 503, body: { error: 'Could not update the library catalog.' } }
    }
  }
  return { status: 503, body: { error: 'Could not update the library catalog.' } }
}

function instrumentRoute(path: string): { id: string; notes: boolean } | null {
  if (path === '/api/library/instruments') return { id: '', notes: false }
  const match = path.match(/^\/api\/library\/instruments\/(lib_[a-z0-9]+)(\/notes)?$/)
  if (!match) return null
  return { id: match[1], notes: Boolean(match[2]) }
}

function queryNumber(params: URLSearchParams, name: string, fallback: number) {
  const value = Number(params.get(name))
  return Number.isFinite(value) ? value : fallback
}

async function serveInstruments(
  catalog: InstrumentCatalog | undefined,
  route: { id: string; notes: boolean },
  call: LibraryCall,
  sign: (key: string) => Promise<string>,
): Promise<LibraryResult> {
  if (!catalog) return { status: 503, body: { ready: false, message: LIBRARY_NOT_READY } }
  try {
    if (!route.id) {
      if (call.method !== 'GET') return { status: 405, body: { error: 'Use GET.' } }
      const params = new URLSearchParams(call.search ?? '')
      const page = await catalog.search({
        text: params.get('q') ?? '',
        category: params.get('category') ?? '',
        pack: params.get('pack') ?? '',
        offset: queryNumber(params, 'offset', 0),
        limit: queryNumber(params, 'limit', 40),
      })
      return { status: 200, body: { ...page } }
    }
    const instrument = await catalog.get(route.id)
    if (!instrument) return { status: 404, body: { error: 'That instrument is not in the library.' } }
    if (!route.notes) {
      if (call.method !== 'GET') return { status: 405, body: { error: 'Use GET.' } }
      return { status: 200, body: { ...instrument } }
    }
    if (call.method !== 'POST') return { status: 405, body: { error: 'Use POST.' } }
    const request = noteRequest(call.body)
    if (!request) return { status: 400, body: { error: 'Those library paths cannot be signed.' } }
    const known = new Set(instrument.layers.map((layer) => layer.key))
    const layers = request.keys
      ? request.keys.every((key) => known.has(key)) ? layersForNotes(instrument, { keys: request.keys }) : null
      : layersForNotes(instrument, { notes: request.notes, velocity: request.velocity })
    if (!layers?.length) return { status: 400, body: { error: 'Those library paths cannot be signed.' } }
    const urls: { key: string; url: string }[] = []
    for (const layer of layers) urls.push({ key: layer.key, url: await sign(layer.key) })
    return { status: 200, body: { ready: true, expiresIn: LIBRARY_EXPIRES_SEC, urls } }
  } catch {
    return { status: 503, body: { error: 'Could not read the library catalog.' } }
  }
}

function noteRequest(body: unknown): { keys?: string[]; notes?: number[]; velocity?: number } | null {
  if (!body || typeof body !== 'object') return null
  const raw = body as { keys?: unknown; notes?: unknown; velocity?: unknown }
  const keys = Array.isArray(raw.keys) ? raw.keys.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 512) : undefined
  const notes = Array.isArray(raw.notes) ? raw.notes.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : undefined
  if ((!keys || !keys.length) && (!notes || !notes.length)) return null
  if (keys && keys.length > MAX_KEYS) return null
  if (notes && notes.length > 8) return null
  const velocity = typeof raw.velocity === 'number' && Number.isFinite(raw.velocity) ? raw.velocity : undefined
  return { keys, notes, velocity }
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
