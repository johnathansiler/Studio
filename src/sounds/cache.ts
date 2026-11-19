import { LIBRARY_OBJECT_PREFIX } from '../library/objectUrl'
import { libraryFetch } from './direct'
import { assertSoundUrl } from './source'

export interface StoredFile {
  key: string
  size: number
  at: number
  sha256?: string
}

export interface ByteStore {
  get(key: string): Promise<ArrayBuffer | null>
  put(key: string, bytes: ArrayBuffer): Promise<void>
  delete?(key: string): Promise<void>
  /** Remember a hash that was already checked, so the next read can skip it. */
  note?(key: string, sha256: string): Promise<void>
  /** Sizes already on disk. Audio bytes stay put until a later read. */
  stat?(): Promise<StoredFile[]>
}

/** Phone cache bound. One file can exceed it; the rest are dropped. The whole library is not kept. */
export const SOUND_CACHE_BUDGET_BYTES = 64 * 1024 * 1024

/** How many library files download at once. Extra requests wait, and a cancel leaves the queue. */
export const SOUND_DOWNLOAD_LIMIT = 3

/** Background preview fetches. They never take the last slot from a tap. */
const PREFETCH_LIMIT = 1

function pinnedCatalogKey(key: string) {
  return key.includes('/catalogs/soundscout-') || key.endsWith('#rows')
}

export interface FetchSoundOptions {
  attempts?: number
  delayMs?: number
  sha256?: string
  totalBytes?: number
  onProgress?: (ratio: number) => void
  /** Called with each network chunk so playback can start before the file ends. */
  onChunk?: (chunk: Uint8Array) => void
  /** Prefetch waits behind a tap. A tap never waits behind prefetch. */
  priority?: 'user' | 'prefetch'
  signal?: AbortSignal
  /**
   * A passphrase-signed My Library object.
   * The URL must be the stable library-object key. The signed host is fetched by the caller.
   */
  trusted?: boolean
}

const DB_NAME = 'cueharbor-sound-library'
const DB_STORE = 'files'
const CACHE_NAME = 'cueharbor-sound-library'

function copyBytes(bytes: ArrayBuffer) {
  return bytes.slice(0)
}

export function memoryByteStore(map = new Map<string, ArrayBuffer>()): ByteStore {
  return {
    async get(key) {
      const hit = map.get(key)
      return hit ? copyBytes(hit) : null
    },
    async put(key, bytes) {
      map.set(key, copyBytes(bytes))
    },
    async delete(key) {
      map.delete(key)
    },
    async stat() {
      return [...map.entries()].map(([key, bytes], index) => ({ key, size: bytes.byteLength, at: index }))
    },
  }
}

/** Cache API. Missing in some private modes; callers keep the IndexedDB copy. */
export function cacheApiStore(cachesImpl: CacheStorage = globalThis.caches, name = CACHE_NAME): ByteStore {
  return {
    async get(key) {
      const cache = await cachesImpl.open(name)
      const hit = await cache.match(key)
      if (!hit) return null
      return hit.arrayBuffer()
    },
    async put(key, bytes) {
      const cache = await cachesImpl.open(name)
      await cache.put(key, new Response(copyBytes(bytes)))
    },
    async delete(key) {
      const cache = await cachesImpl.open(name)
      await cache.delete(key)
    },
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

const DB_VERSION = 2
const DB_META = 'meta'

function openSoundDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
        if (!db.objectStoreNames.contains(DB_META)) db.createObjectStore(DB_META)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        dbPromise = null
        reject(request.error)
      }
    })
  }
  return dbPromise
}

/** IndexedDB copy so a refresh still has the file after the memory cache is gone. */
export function idbByteStore(): ByteStore {
  return {
    async get(key) {
      const db = await openSoundDb()
      return new Promise((resolve, reject) => {
        const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key)
        request.onsuccess = () => {
          const value = request.result as unknown
          if (value instanceof Uint8Array) {
            const copy = new Uint8Array(value.byteLength)
            copy.set(value)
            resolve(copy.buffer)
          } else if (value instanceof ArrayBuffer) resolve(copyBytes(value))
          else resolve(null)
        }
        request.onerror = () => reject(request.error)
      })
    },
    async put(key, bytes) {
      const db = await openSoundDb()
      const copy = new Uint8Array(copyBytes(bytes))
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([DB_STORE, DB_META], 'readwrite')
        tx.objectStore(DB_STORE).put(copy, key)
        tx.objectStore(DB_META).put({ size: copy.byteLength, at: Date.now() }, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    async delete(key) {
      const db = await openSoundDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([DB_STORE, DB_META], 'readwrite')
        tx.objectStore(DB_STORE).delete(key)
        tx.objectStore(DB_META).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    async note(key, sha256) {
      const db = await openSoundDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DB_META, 'readwrite')
        const store = tx.objectStore(DB_META)
        const read = store.get(key)
        read.onsuccess = () => {
          const row = (read.result as { size?: number; at?: number } | undefined) ?? { size: 0, at: Date.now() }
          store.put({ size: row.size ?? 0, at: row.at ?? Date.now(), sha256 }, key)
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    async stat() {
      const db = await openSoundDb()
      const saved = await readStore(db, DB_META, (value) => {
        const row = value as { size?: number, at?: number, sha256?: string }
        return { size: row?.size ?? 0, at: row?.at ?? 0, sha256: typeof row?.sha256 === 'string' ? row.sha256 : undefined }
      })
      if (saved.length) return saved
      const scanned = await readStore(db, DB_STORE, (value) => {
        const size = value instanceof Uint8Array || value instanceof ArrayBuffer ? value.byteLength : 0
        return { size, at: 0 }
      })
      if (!scanned.length) return []
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DB_META, 'readwrite')
        const meta = tx.objectStore(DB_META)
        for (const row of scanned) meta.put({ size: row.size, at: row.at }, row.key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      return scanned
    },
  }
}

function readStore(db: IDBDatabase, name: string, measure: (value: unknown) => { size: number, at: number, sha256?: string }) {
  return new Promise<StoredFile[]>((resolve, reject) => {
    if (!db.objectStoreNames.contains(name)) {
      resolve([])
      return
    }
    const rows: StoredFile[] = []
    const request = db.transaction(name, 'readonly').objectStore(name).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(rows)
        return
      }
      const measured = measure(cursor.value)
      rows.push({ key: String(cursor.key), size: measured.size, at: measured.at, sha256: measured.sha256 })
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
}

export function browserSoundStores(): ByteStore[] {
  const stores: ByteStore[] = [memoryByteStore()]
  if (typeof caches !== 'undefined' && typeof caches.open === 'function') stores.push(cacheApiStore())
  if (typeof indexedDB !== 'undefined') stores.push(idbByteStore())
  return stores
}

/**
 * Reads the first store that has the file and writes through to every store.
 * Memory is first. Cache API and IndexedDB survive a refresh.
 */
export class SoundCache {
  private readonly order: string[] = []
  private readonly sizes = new Map<string, number>()
  private readonly hashes = new Map<string, string>()
  private readonly ready: Promise<void>

  constructor(private readonly layers: ByteStore[], private readonly budget = SOUND_CACHE_BUDGET_BYTES) {
    this.ready = this.hydrate()
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    await this.ready
    for (let index = 0; index < this.layers.length; index++) {
      try {
        const hit = await this.layers[index].get(key)
        if (!hit) continue
        this.remember(key, hit.byteLength)
        for (let earlier = 0; earlier < index; earlier++) {
          try { await this.layers[earlier].put(key, hit) } catch { /* a faster layer can miss */ }
        }
        return hit
      } catch {
        /* try the next copy */
      }
    }
    return null
  }

  async put(key: string, bytes: ArrayBuffer) {
    await this.ready
    for (const layer of this.layers) {
      try {
        await layer.put(key, bytes)
      } catch {
        /* one store being full does not drop the others */
      }
    }
    this.remember(key, bytes.byteLength)
    await this.evict(key)
  }

  knownHash(key: string) {
    return this.hashes.get(key) ?? ''
  }

  /** The bytes were checked against the catalog. Later reads of this key skip the hash. */
  async noteHash(key: string, sha256: string) {
    const hash = sha256.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(hash)) return
    this.hashes.set(key, hash)
    for (const layer of this.layers) {
      try { await layer.note?.(key, hash) } catch { /* a memory layer has no extra record */ }
    }
  }

  async delete(key: string) {
    await this.ready
    this.sizes.delete(key)
    this.hashes.delete(key)
    this.order.splice(0, this.order.length, ...this.order.filter((item) => item !== key))
    for (const layer of this.layers) {
      try {
        await layer.delete?.(key)
      } catch {
        /* a missing copy is already gone */
      }
    }
  }

  private remember(key: string, size: number) {
    const rest = this.order.filter((item) => item !== key)
    this.order.splice(0, this.order.length, ...rest, key)
    this.sizes.set(key, size)
  }

  /** Drop the oldest files until the newest one fits, or it is the only file left. */
  private async evict(keep: string) {
    const total = () => [...this.sizes.values()].reduce((sum, size) => sum + size, 0)
    while (total() > this.budget) {
      const victim = this.order.find((key) => key !== keep && !pinnedCatalogKey(key))
      if (!victim) break
      if (!keep && this.order.length === 1) break
      await this.forget(victim)
    }
  }

  private async forget(key: string) {
    this.sizes.delete(key)
    this.hashes.delete(key)
    this.order.splice(0, this.order.length, ...this.order.filter((item) => item !== key))
    for (const layer of this.layers) {
      try {
        await layer.delete?.(key)
      } catch {
        /* a missing copy is already gone */
      }
    }
  }

  private async hydrate() {
    const found: StoredFile[] = []
    for (const layer of this.layers) {
      if (!layer.stat) continue
      try {
        found.push(...await layer.stat())
      } catch {
        /* one store can be unavailable */
      }
    }
    found.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
    for (const row of found) {
      if (this.sizes.has(row.key)) continue
      this.sizes.set(row.key, row.size)
      this.order.push(row.key)
      if (row.sha256) this.hashes.set(row.key, row.sha256)
    }
    await this.evict('')
  }
}

let shared: SoundCache | null = null

export function soundCache() {
  if (!shared) shared = new SoundCache(browserSoundStores())
  return shared
}

/** Tests swap the stores. Passing null rebuilds the browser stores. */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readBody(response: Response, onProgress?: (ratio: number) => void, totalHint = 0, onChunk?: (chunk: Uint8Array) => void) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength) onChunk?.(new Uint8Array(bytes))
    onProgress?.(1)
    return bytes
  }
  const header = Number(response.headers.get('content-length'))
  const total = header > 0 ? header : totalHint
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    if (!step.value) continue
    chunks.push(step.value)
    onChunk?.(step.value)
    received += step.value.byteLength
    if (total > 0) onProgress?.(Math.min(1, received / total))
  }
  const out = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  onProgress?.(1)
  return out.buffer
}

function permanentFailure(error: unknown) {
  return error instanceof Error && /not match the SoundScout catalog|\(404\)|\(403\)|\(401\)|\(400\)/.test(error.message)
}

interface Flight {
  controller: AbortController
  promise: Promise<ArrayBuffer>
  waiters: number
  chunks: Uint8Array[]
  listeners: Set<(chunk: Uint8Array) => void>
}

const flights = new Map<string, Flight>()
let activeDownloads = 0
let prefetchActive = 0
const userWaiters: Array<() => void> = []
const prefetchWaiters: Array<() => void> = []

function acquireDownload(signal?: AbortSignal, priority: 'user' | 'prefetch' = 'user') {
  if (signal?.aborted) return Promise.reject(cancelled())
  const prefetch = priority === 'prefetch'
  if (activeDownloads < SOUND_DOWNLOAD_LIMIT && (!prefetch || prefetchActive < PREFETCH_LIMIT)) {
    activeDownloads += 1
    if (prefetch) prefetchActive += 1
    return Promise.resolve()
  }
  const queue = prefetch ? prefetchWaiters : userWaiters
  return new Promise<void>((resolve, reject) => {
    const grant = () => {
      signal?.removeEventListener('abort', onAbort)
      activeDownloads += 1
      if (prefetch) prefetchActive += 1
      resolve()
    }
    const onAbort = () => {
      const index = queue.indexOf(grant)
      if (index >= 0) queue.splice(index, 1)
      reject(cancelled())
    }
    queue.push(grant)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function releaseDownload(priority: 'user' | 'prefetch' = 'user') {
  activeDownloads = Math.max(0, activeDownloads - 1)
  if (priority === 'prefetch') prefetchActive = Math.max(0, prefetchActive - 1)
  if (userWaiters.length) {
    userWaiters.shift()?.()
    return
  }
  if (prefetchActive < PREFETCH_LIMIT && prefetchWaiters.length) prefetchWaiters.shift()?.()
}

/** Tests start from an empty download queue. */
export function resetSoundDownloads() {
  activeDownloads = 0
  prefetchActive = 0
  userWaiters.splice(0, userWaiters.length)
  prefetchWaiters.splice(0, prefetchWaiters.length)
}

function cancelled() {
  return new DOMException('The download was cancelled.', 'AbortError')
}

function waitFor(promise: Promise<ArrayBuffer>, signal?: AbortSignal) {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => undefined)
    return Promise.reject(cancelled())
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const onAbort = () => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function downloadSound(url: string, fetchImpl: FetchLike, cache: SoundCache, options: FetchSoundOptions, signal: AbortSignal, onChunk: (chunk: Uint8Array) => void) {
  const priority = options.priority === 'prefetch' ? 'prefetch' : 'user'
  await acquireDownload(signal, priority)
  try {
    return await downloadSoundBody(url, fetchImpl, cache, options, signal, onChunk)
  } finally {
    releaseDownload(priority)
  }
}

async function downloadSoundBody(url: string, fetchImpl: FetchLike, cache: SoundCache, options: FetchSoundOptions, signal: AbortSignal, onChunk: (chunk: Uint8Array) => void) {
  const expected = options.sha256?.trim().toLowerCase()
  const attempts = Math.max(1, Math.round(options.attempts ?? 3))
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (signal.aborted) throw cancelled()
      const response = await fetchImpl(url, { signal })
      if (!response.ok) throw new Error(`Could not download that sound (${response.status})`)
      const bytes = await readBody(response, options.onProgress, options.totalBytes ?? 0, onChunk)
      if (expected && await sha256Hex(bytes) !== expected) throw new Error('Downloaded audio does not match the SoundScout catalog.')
      try { await cache.put(url, bytes) } catch { /* playback can use the bytes just fetched */ }
      if (expected) void cache.noteHash(url, expected)
      return bytes
    } catch (error) {
      last = error
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error instanceof Error ? error : cancelled()
      if (permanentFailure(error) || attempt === attempts - 1) throw error instanceof Error ? error : new Error('Could not download that sound')
      const wait = options.delayMs ?? (attempt === 0 ? 200 : 600)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw last instanceof Error ? last : new Error('Could not download that sound')
}

/** Download one library file from Hugging Face, or the browser copy from last time. */
export async function fetchSoundBytes(url: string, fetchImpl: FetchLike = libraryFetch, cache = soundCache(), options: FetchSoundOptions = {}): Promise<ArrayBuffer> {
  if (options.trusted) {
    if (!url.startsWith(LIBRARY_OBJECT_PREFIX)) throw new Error('That library sound could not be read.')
  } else {
    assertSoundUrl(url)
  }
  const expected = options.sha256?.trim().toLowerCase()
  const hit = await cache.get(url)
  const known = cache.knownHash(url)
  if (hit && (!expected || known === expected || await sha256Hex(hit) === expected)) {
    if (expected && known !== expected) void cache.noteHash(url, expected)
    options.onProgress?.(1)
    return hit
  }
  const existing = flights.get(url)
  if (existing) {
    existing.waiters += 1
    if (options.onChunk) {
      existing.listeners.add(options.onChunk)
      for (const chunk of existing.chunks) options.onChunk(chunk)
    }
    const release = () => {
      existing.waiters -= 1
      if (options.onChunk) existing.listeners.delete(options.onChunk)
      if (existing.waiters <= 0) existing.controller.abort()
    }
    if (options.signal?.aborted) {
      release()
      throw cancelled()
    }
    options.signal?.addEventListener('abort', release, { once: true })
    try {
      return await waitFor(existing.promise, options.signal)
    } finally {
      options.signal?.removeEventListener('abort', release)
    }
  }
  const controller = new AbortController()
  const flight: Flight = { controller, promise: Promise.resolve(new ArrayBuffer(0)), waiters: 1, chunks: [], listeners: new Set() }
  if (options.onChunk) flight.listeners.add(options.onChunk)
  const release = () => {
    flight.waiters -= 1
    if (options.onChunk) flight.listeners.delete(options.onChunk)
    if (flight.waiters <= 0) controller.abort()
  }
  if (options.signal?.aborted) release()
  else options.signal?.addEventListener('abort', release, { once: true })
  const promise = downloadSound(url, fetchImpl, cache, options, controller.signal, (chunk) => {
    flight.chunks.push(chunk)
    for (const listener of flight.listeners) listener(chunk)
  })
  flight.promise = promise
  flights.set(url, flight)
  try {
    return await waitFor(promise, options.signal)
  } finally {
    options.signal?.removeEventListener('abort', release)
    if (flights.get(url)?.promise === promise) flights.delete(url)
  }
}
