import { assertSoundUrl } from './source'

export interface ByteStore {
  get(key: string): Promise<ArrayBuffer | null>
  put(key: string, bytes: ArrayBuffer): Promise<void>
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
  constructor(private readonly layers: ByteStore[]) {}

  async get(key: string): Promise<ArrayBuffer | null> {
    for (let index = 0; index < this.layers.length; index++) {
      try {
        const hit = await this.layers[index].get(key)
        if (!hit) continue
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

/** Download a library file from Hugging Face, or the browser copy from last time. */
export async function fetchSoundBytes(url: string, fetchImpl: FetchLike = (input, init) => fetch(input, init), cache = soundCache()): Promise<ArrayBuffer> {
  assertSoundUrl(url)
  const hit = await cache.get(url)
  if (hit) return hit
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`Could not download that sound (${response.status})`)
  const bytes = await response.arrayBuffer()
  try { await cache.put(url, bytes) } catch { /* playback can use the bytes just fetched */ }
  return bytes
}
