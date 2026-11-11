import { LIBRARY_CATALOG_KEY, gunzipText, idbCatalogCache, indexParsedCatalog, parseLibraryCatalog, sameCatalog, type CachedCatalog, type CatalogCache } from './catalog'
import { readLibraryAccessKey, signLibraryKeys } from './access'
import type { LibraryDocument } from './types'
import type { LibraryIndex } from './search'

export interface AudioCache {
  get(key: string): Promise<ArrayBuffer | null>
  put(key: string, bytes: ArrayBuffer): Promise<void>
}

const AUDIO_DB = 'cueharbor-my-library'
const AUDIO_STORE = 'audio'
const AUDIO_CACHE = 'cueharbor-my-library-audio'

function copyBytes(bytes: ArrayBuffer) {
  return bytes.slice(0)
}

function storedBytes(value: unknown): ArrayBuffer | null {
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    return copy.buffer
  }
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return (value as ArrayBuffer).slice(0)
  return null
}

export function memoryAudioCache(map = new Map<string, ArrayBuffer>()): AudioCache {
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

function openAudioDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(AUDIO_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog')
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function cacheKey(key: string) {
  return `https://cueharbor.local/library/${encodeURIComponent(key)}`
}

export function browserAudioCache(): AudioCache {
  return {
    async get(key) {
      const fromDb = await readIdb(key)
      if (fromDb) return fromDb
      if (typeof caches === 'undefined') return null
      try {
        const cache = await caches.open(AUDIO_CACHE)
        const hit = await cache.match(cacheKey(key))
        return hit ? hit.arrayBuffer() : null
      } catch {
        return null
      }
    },
    async put(key, bytes) {
      const copy = copyBytes(bytes)
      await writeIdb(key, copy).catch(() => undefined)
      if (typeof caches === 'undefined') return
      try {
        const cache = await caches.open(AUDIO_CACHE)
        await cache.put(cacheKey(key), new Response(copy.slice(0)))
      } catch { /* IndexedDB still has the file */ }
    },
  }
}

async function readIdb(key: string) {
  if (typeof indexedDB === 'undefined') return null
  try {
    const db = await openAudioDb()
    return await new Promise<ArrayBuffer | null>((resolve, reject) => {
      const request = db.transaction(AUDIO_STORE, 'readonly').objectStore(AUDIO_STORE).get(key)
      request.onsuccess = () => {
        resolve(storedBytes(request.result))
      }
      request.onerror = () => reject(request.error)
    })
  } catch {
    return null
  }
}

async function writeIdb(key: string, bytes: ArrayBuffer) {
  if (typeof indexedDB === 'undefined') return
  const db = await openAudioDb()
  const copy = new Uint8Array(copyBytes(bytes))
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(AUDIO_STORE, 'readwrite').objectStore(AUDIO_STORE).put(copy, key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

let audioCache: AudioCache | null = null
let catalogCache: CatalogCache | null = null

export function libraryAudioCache() {
  return audioCache ?? (audioCache = typeof indexedDB === 'undefined' ? memoryAudioCache() : browserAudioCache())
}

export function libraryCatalogCache() {
  return catalogCache ?? (catalogCache = typeof indexedDB === 'undefined' ? { async read() { return null }, async write() { /* no disk */ } } : idbCatalogCache())
}

export function setLibraryCaches(next: { audio?: AudioCache | null; catalog?: CatalogCache | null }) {
  if (next.audio !== undefined) audioCache = next.audio
  if (next.catalog !== undefined) catalogCache = next.catalog
}

/** Bytes for one object. A cached copy is used offline. A miss gets a new signature, never a stored URL. */
export async function fetchLibraryBytes(key: string, fetchImpl: typeof fetch = fetch, cache = libraryAudioCache()): Promise<ArrayBuffer> {
  const cached = await cache.get(key).catch(() => null)
  if (cached) return cached
  const accessKey = readLibraryAccessKey()
  if (!accessKey) throw new Error('Unlock My Library on this device first.')
  const signed = await signLibraryKeys([key], accessKey, fetchImpl)
  const url = signed.urls.find((item) => item.key === key)?.url
  if (!url) throw new Error('Could not sign that sound.')
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error('Could not download that sound.')
  const bytes = await response.arrayBuffer()
  try { await cache.put(key, bytes) } catch { /* playback still has the bytes */ }
  return bytes
}

export interface LoadedCatalog {
  document: LibraryDocument
  index: LibraryIndex
  fromCache: boolean
}

/**
 * Show the cached catalog, then refresh it when the signed copy has a new version.
 * The gzip is stored. Presigned URLs are not.
 */
export async function loadLibraryCatalog(fetchImpl: typeof fetch = fetch, cache = libraryCatalogCache(), onCached?: (loaded: LoadedCatalog) => void): Promise<LoadedCatalog> {
  const cached = await cache.read().catch(() => null)
  let cachedParsed: Awaited<ReturnType<typeof parseGzip>> | null = null
  let cachedIndex: LibraryIndex | null = null
  if (cached?.gzip) {
    try {
      cachedParsed = await parseGzip(cached.gzip)
      cachedIndex = indexParsed(cachedParsed)
      onCached?.({ document: cachedParsed.document, index: cachedIndex, fromCache: true })
    } catch {
      cachedParsed = null
      cachedIndex = null
    }
  }
  const accessKey = readLibraryAccessKey()
  if (!accessKey) {
    if (!cachedParsed || !cachedIndex) throw new Error('Unlock My Library on this device first.')
    return { document: cachedParsed.document, index: cachedIndex, fromCache: true }
  }
  try {
    const signed = await signLibraryKeys([LIBRARY_CATALOG_KEY], accessKey, fetchImpl)
    const url = signed.urls.find((item) => item.key === LIBRARY_CATALOG_KEY)?.url
    if (!url) throw new Error('Could not sign the library catalog.')
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error('Could not download the library catalog.')
    const gzip = await response.arrayBuffer()
    const hash = await sha256Hex(gzip)
    const cachedMeta = cachedParsed
      ? { version: cachedParsed.document.version, generatedAt: cachedParsed.document.generatedAt, count: cachedParsed.document.count }
      : null
    const storedMeta = cached ? { version: cached.version, generatedAt: cached.generatedAt, count: cached.count } : null
    if (cachedParsed && cachedIndex && cached?.sha256 === hash && cachedMeta && storedMeta && sameCatalog(storedMeta, cachedMeta)) {
      return { document: cachedParsed.document, index: cachedIndex, fromCache: true }
    }
    const parsed = await parseGzip(gzip)
    const meta = { version: parsed.document.version, generatedAt: parsed.document.generatedAt, count: parsed.document.count }
    const stored: CachedCatalog = { ...meta, sha256: hash, gzip: gzip.slice(0) }
    try { await cache.write(stored) } catch { /* the list still shows */ }
    return { document: parsed.document, index: indexParsed(parsed), fromCache: false }
  } catch (error) {
    if (cachedParsed && cachedIndex) return { document: cachedParsed.document, index: cachedIndex, fromCache: true }
    throw error
  }
}

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function parseGzip(bytes: ArrayBuffer) {
  const text = await gunzipText(bytes)
  const parsed = parseLibraryCatalog(JSON.parse(text) as unknown)
  if (!parsed) throw new Error('The library catalog could not be read.')
  return parsed
}

function indexParsed(parsed: NonNullable<Awaited<ReturnType<typeof parseGzip>>>) {
  return indexParsedCatalog(parsed)
}
