import { assertSoundUrl } from './source'

export interface ByteStore {
  get(key: string): Promise<ArrayBuffer | null>
  put(key: string, bytes: ArrayBuffer): Promise<void>
  delete?(key: string): Promise<void>
}

/** Phone cache bound. One file can exceed it; the rest are dropped. The whole library is not kept. */
export const SOUND_CACHE_BUDGET_BYTES = 64 * 1024 * 1024

export interface FetchSoundOptions {
  attempts?: number
  delayMs?: number
  sha256?: string
  totalBytes?: number
  onProgress?: (ratio: number) => void
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

function openSoundDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
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
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).put(new Uint8Array(copyBytes(bytes)), key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    async delete(key) {
      const db = await openSoundDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
  }
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

  constructor(private readonly layers: ByteStore[], private readonly budget = SOUND_CACHE_BUDGET_BYTES) {}

  async get(key: string): Promise<ArrayBuffer | null> {
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

  async delete(key: string) {
    this.sizes.delete(key)
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
    while (total() > this.budget && this.order.some((key) => key !== keep)) {
      const key = this.order.find((item) => item !== keep)
      if (!key) break
      await this.delete(key)
    }
  }
}

let shared: SoundCache | null = null

export function soundCache() {
  if (!shared) shared = new SoundCache(browserSoundStores())
  return shared
}

/** Tests swap the stores. Passing null rebuilds the browser stores. */
export function setSoundCache(cache: SoundCache | null) {
  shared = cache
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readBody(response: Response, onProgress?: (ratio: number) => void, totalHint = 0) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = await response.arrayBuffer()
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

/** Download one library file from Hugging Face, or the browser copy from last time. */
export async function fetchSoundBytes(url: string, fetchImpl: FetchLike = (input, init) => fetch(input, init), cache = soundCache(), options: FetchSoundOptions = {}): Promise<ArrayBuffer> {
  assertSoundUrl(url)
  const expected = options.sha256?.trim().toLowerCase()
  const hit = await cache.get(url)
  if (hit) {
    if (!expected || await sha256Hex(hit) === expected) {
      options.onProgress?.(1)
      return hit
    }
    await cache.delete(url)
  }
  const attempts = Math.max(1, Math.round(options.attempts ?? 3))
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url)
      if (!response.ok) throw new Error(`Could not download that sound (${response.status})`)
      const bytes = await readBody(response, options.onProgress, options.totalBytes ?? 0)
      if (expected && await sha256Hex(bytes) !== expected) throw new Error('Downloaded audio does not match the SoundScout catalog.')
      try { await cache.put(url, bytes) } catch { /* playback can use the bytes just fetched */ }
      return bytes
    } catch (error) {
      last = error
      if (permanentFailure(error) || attempt === attempts - 1) throw error instanceof Error ? error : new Error('Could not download that sound')
      const wait = options.delayMs ?? (attempt === 0 ? 200 : 600)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw last instanceof Error ? last : new Error('Could not download that sound')
}
