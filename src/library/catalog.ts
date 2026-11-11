import type { LibraryDocument, LibraryEntry } from './types'
import { buildLibraryIndex, libraryTitle, type LibraryIndex } from './search'

export const LIBRARY_CATALOG_KEY = 'catalog/catalog.json.gz'

export interface CachedCatalog {
  version: number
  generatedAt: string
  count: number
  /** SHA-256 of the gzip bytes. A matching hash means the version is unchanged. */
  sha256?: string
  gzip: ArrayBuffer
}

export interface CatalogCache {
  read(): Promise<CachedCatalog | null>
  write(doc: CachedCatalog): Promise<void>
}

export function sameCatalog(cached: { version: number; generatedAt: string; count: number } | null, next: { version: number; generatedAt: string; count: number }) {
  if (!cached) return false
  return cached.version === next.version && cached.generatedAt === next.generatedAt && cached.count === next.count
}

export async function gunzipText(bytes: ArrayBuffer) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

export function parseLibraryCatalog(input: unknown): { document: LibraryDocument; words: string[][] } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  if (!Array.isArray(raw.entries)) return null
  const pool = new Map<string, string>()
  const share = (value: string) => {
    const hit = pool.get(value)
    if (hit !== undefined) return hit
    pool.set(value, value)
    return value
  }
  const entries: LibraryEntry[] = []
  const words: string[][] = []
  for (const item of raw.entries) {
    const parsed = parseEntry(item, share)
    if (!parsed) continue
    entries.push(parsed.entry)
    words.push(parsed.words)
  }
  return {
    document: {
      version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 0,
      generatedAt: typeof raw.generated_at === 'string' ? raw.generated_at : '',
      count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? raw.count : entries.length,
      pending: typeof raw.pending === 'string' ? raw.pending : '',
      entries,
    },
    words,
  }
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function texts(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}

function tempo(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function parseEntry(input: unknown, share: (value: string) => string): { entry: LibraryEntry; words: string[] } | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const key = text(raw.key)
  if (!key || key.includes('..') || key.startsWith('/') || key.includes('://')) return null
  const search = text(raw.search).toLowerCase()
  const words = search.split(/\s+/).filter(Boolean)
  const genre = texts(raw.genre).map(share)
  const mood = texts(raw.mood).map(share)
  const tags = texts(raw.tags).map(share)
  return {
    entry: {
      key,
      size: typeof raw.size === 'number' && raw.size > 0 ? raw.size : 0,
      format: share(text(raw.format).toLowerCase()),
      pack: share(text(raw.pack)),
      type: share(text(raw.type).toLowerCase()),
      category: share(text(raw.category).toLowerCase()),
      instrument: share(text(raw.instrument).toLowerCase()),
      genre,
      bpm: tempo(raw.bpm),
      bpmAlt: tempo(raw.bpm_alt),
      musicalKey: share(text(raw.musical_key)),
      root: share(text(raw.root)),
      note: share(text(raw.note)),
      mood,
      tags,
      license: text(raw.license),
      name: libraryTitle(key),
    },
    words,
  }
}

export function indexParsedCatalog(parsed: { document: LibraryDocument; words: string[][] }): LibraryIndex {
  return buildLibraryIndex(parsed.document.entries, parsed.words)
}

const DB_NAME = 'cueharbor-my-library'
const DB_STORE = 'catalog'
const DB_KEY = 'current'

function storedCatalogBytes(value: unknown): ArrayBuffer | null {
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    return copy.buffer
  }
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return (value as ArrayBuffer).slice(0)
  return null
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function idbCatalogCache(): CatalogCache {
  return {
    async read() {
      if (typeof indexedDB === 'undefined') return null
      try {
        const db = await openDb()
        return await new Promise((resolve, reject) => {
          const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(DB_KEY)
          request.onsuccess = () => {
            const row = request.result as { version?: number; generatedAt?: string; count?: number; sha256?: string; gzip?: unknown } | undefined
            const gzip = row ? storedCatalogBytes(row.gzip) : null
            if (!row || !gzip || typeof row.version !== 'number' || typeof row.generatedAt !== 'string' || typeof row.count !== 'number') {
              resolve(null)
              return
            }
            resolve({ version: row.version, generatedAt: row.generatedAt, count: row.count, sha256: typeof row.sha256 === 'string' ? row.sha256 : undefined, gzip })
          }
          request.onerror = () => reject(request.error)
        })
      } catch {
        return null
      }
    },
    async write(doc) {
      if (typeof indexedDB === 'undefined') return
      const db = await openDb()
      const copy = doc.gzip.slice(0)
      await new Promise<void>((resolve, reject) => {
        const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put({
          version: doc.version,
          generatedAt: doc.generatedAt,
          count: doc.count,
          gzip: copy,
        }, DB_KEY)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    },
  }
}

export function memoryCatalogCache(slot: { current: CachedCatalog | null } = { current: null }): CatalogCache {
  return {
    async read() {
      const hit = slot.current
      return hit ? { ...hit, gzip: hit.gzip.slice(0) } : null
    },
    async write(doc) {
      slot.current = { ...doc, gzip: doc.gzip.slice(0) }
    },
  }
}
