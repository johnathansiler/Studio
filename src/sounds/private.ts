import { sha256Hex } from './cache'
import type { SoundEntry, SoundKind } from './types'

/**
 * Private song-making library. The user picks an extracted folder or the zip
 * bundles on this device. Audio is stored here and is never given a factory URL.
 */
export const PRIVATE_CATALOG_VERSION = 'private-song-making-2026-11-09'
export const PRIVATE_LICENSE = 'personal-song-use-no-raw-redistribution'

export interface PrivateSourceFile {
  name: string
  relativePath?: string
  bytes?: ArrayBuffer
  read?: () => Promise<ArrayBuffer>
}

export interface PrivateImportResult {
  installed: number
  missing: number
  rejected: number
  keptPrevious: boolean
  cancelled: boolean
  message: string
}

export interface PrivateLibraryStore {
  catalog(): Promise<SoundEntry[]>
  readSha(sha256: string): Promise<ArrayBuffer | null>
  writeSha(sha256: string, bytes: ArrayBuffer): Promise<void>
  deleteSha(sha256: string): Promise<void>
  commit(entries: SoundEntry[]): Promise<void>
}

const KINDS = new Set<SoundKind>(['one-shot', 'loop'])
const DB_NAME = 'cueharbor-private-sounds'
const DB_FILES = 'files'
const DB_CATALOG = 'catalog'
const CATALOG_KEY = 'entries'

let storeOverride: PrivateLibraryStore | null = null

export function setPrivateLibraryStore(store: PrivateLibraryStore | null) {
  storeOverride = store
}

export function privateLibraryStore() {
  return storeOverride ?? idbPrivateStore()
}

export function parsePrivateCatalog(input: unknown): Array<SoundEntry & { localRelPath: string }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const doc = input as Record<string, unknown>
  if (doc.version !== PRIVATE_CATALOG_VERSION) return []
  if (doc.visibility !== 'private-local-only' || doc.factoryUploadAllowed !== false) return []
  if (!Array.isArray(doc.entries)) return []
  const entries: Array<SoundEntry & { localRelPath: string }> = []
  const seen = new Set<string>()
  for (const item of doc.entries) {
    const entry = parsePrivateEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

function parsePrivateEntry(input: unknown): (SoundEntry & { localRelPath: string }) | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (raw.redistributionAllowed !== false || raw.factoryUploadAllowed !== false) return null
  if (raw.visibility !== 'private-local-only') return null
  if (raw.crossFactoryShaMatch !== false) return null
  const license = typeof raw.license === 'string' ? raw.license.trim() : ''
  const licenseClass = typeof raw.licenseClass === 'string' ? raw.licenseClass.trim() : ''
  if (license !== PRIVATE_LICENSE || licenseClass !== 'PERSONAL_SONG_USE_NO_RAW_REDISTRIBUTION') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  const type = raw.type
  const sha = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : ''
  const blob = typeof raw.localBlobId === 'string' ? raw.localBlobId.trim() : ''
  const rel = typeof raw.localRelPath === 'string' ? raw.localRelPath.trim().replace(/\\/g, '/') : ''
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (!id || !name.trim() || typeof type !== 'string' || !KINDS.has(type as SoundKind)) return null
  if (!/^[a-f0-9]{64}$/.test(sha) || blob !== `blob:sha256:${sha}`) return null
  if (!rel.startsWith('assets/') || !rel.endsWith(`/${sha}.wav`) || rel.includes('..')) return null
  if (!path.startsWith('private/') || path.includes('..') || /^https?:/i.test(path)) return null
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim()) : []
  const bpm = typeof raw.bpm === 'number' && Number.isFinite(raw.bpm) && raw.bpm > 0 ? raw.bpm : undefined
  const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : undefined
  return {
    id,
    path,
    name,
    type: type as SoundKind,
    tags,
    bpm,
    key,
    durationSec: typeof raw.durationSec === 'number' && raw.durationSec >= 0 ? raw.durationSec : 0,
    sampleRate: typeof raw.sampleRate === 'number' && raw.sampleRate > 0 ? raw.sampleRate : 48000,
    license,
    licenseClass,
    licenseNote: typeof raw.licenseNote === 'string' ? raw.licenseNote : undefined,
    source: 'On this device',
    collection: typeof raw.collection === 'string' ? raw.collection : undefined,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    pack: typeof raw.packId === 'string' ? raw.packId : undefined,
    sha256: sha,
    bytes: typeof raw.bytes === 'number' ? raw.bytes : undefined,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    publisher: typeof raw.publisher === 'string' ? raw.publisher : undefined,
    localBlobId: blob,
    attributionRequired: false,
    isContentAlias: raw.isContentAlias === true,
    origin: 'private',
    localRelPath: rel.replace(/^\/+/, ''),
  }
}

function fileKey(file: PrivateSourceFile) {
  return (file.relativePath || file.name).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}

export function matchPrivateFiles(entries: Array<SoundEntry & { localRelPath?: string }>, files: PrivateSourceFile[]) {
  const byPath = new Map<string, PrivateSourceFile>()
  for (const file of files) {
    const rel = fileKey(file)
    byPath.set(rel, file)
    const assets = rel.match(/(?:^|\/)(assets\/[a-f0-9]{2}\/[a-f0-9]{64}\.wav)$/i)
    if (assets) byPath.set(assets[1].toLowerCase(), file)
  }
  const found: { entry: SoundEntry; file: PrivateSourceFile }[] = []
  let missing = 0
  for (const entry of entries) {
    const rel = (entry.localRelPath || '').toLowerCase()
    const file = byPath.get(rel)
    if (!file) {
      missing += 1
      continue
    }
    const { localRelPath, ...sound } = entry
    void localRelPath
    found.push({ entry: sound, file })
  }
  return { found, missing }
}

async function fileBytes(file: PrivateSourceFile) {
  if (file.bytes) return file.bytes
  if (file.read) return file.read()
  return new ArrayBuffer(0)
}

export async function readPrivateCatalog(): Promise<SoundEntry[]> {
  try {
    return await privateLibraryStore().catalog()
  } catch {
    return []
  }
}

export async function readPrivateFile(id: string): Promise<ArrayBuffer | null> {
  const entries = await readPrivateCatalog()
  const entry = entries.find((item) => item.id === id)
  if (!entry?.sha256) return null
  return privateLibraryStore().readSha(entry.sha256)
}

export async function importPrivateLibrary(files: PrivateSourceFile[], options?: { signal?: AbortSignal }): Promise<PrivateImportResult> {
  const store = privateLibraryStore()
  const previous = await store.catalog()
  const previousSha = new Set(previous.map((entry) => entry.sha256).filter((sha): sha is string => Boolean(sha)))
  let unpacked: PrivateSourceFile[]
  try {
    unpacked = await preparePrivateSources(files)
  } catch {
    return { installed: previous.length, missing: 0, rejected: 0, keptPrevious: true, cancelled: false, message: 'That zip could not be read. The library already on this device was kept.' }
  }
  if (options?.signal?.aborted) {
    return { installed: previous.length, missing: 0, rejected: 0, keptPrevious: true, cancelled: true, message: 'Import cancelled. The library already on this device was kept.' }
  }
  const catalogFile = unpacked.find((file) => /(^|\/)private_catalog\.json$/i.test(fileKey(file)) || /(^|\/)catalog\.json$/i.test(fileKey(file)))
  if (!catalogFile) {
    return { installed: previous.length, missing: 0, rejected: 0, keptPrevious: true, cancelled: false, message: 'Choose the extracted folder or zip that contains PRIVATE_CATALOG.json. Nothing was changed.' }
  }
  let parsed: Array<SoundEntry & { localRelPath: string }>
  let rawCount = 0
  try {
    const document = JSON.parse(new TextDecoder().decode(await fileBytes(catalogFile))) as { entries?: unknown }
    rawCount = Array.isArray(document.entries) ? document.entries.length : 0
    parsed = parsePrivateCatalog(document)
  } catch {
    return { installed: previous.length, missing: 0, rejected: 0, keptPrevious: true, cancelled: false, message: 'That catalog could not be read. The library already on this device was kept.' }
  }
  const offered = unpacked.filter((file) => file !== catalogFile)
  const rejected = Math.max(0, rawCount - parsed.length)
  if (!parsed.length) {
    return { installed: previous.length, missing: 0, rejected, keptPrevious: true, cancelled: false, message: 'That catalog has no private rows this app can install. Nothing was changed.' }
  }
  const { found, missing } = matchPrivateFiles(parsed, offered)
  if (!found.length) {
    return { installed: previous.length, missing, rejected, keptPrevious: true, cancelled: false, message: 'None of the catalog audio was in the folder you chose. Nothing was changed.' }
  }
  const written: string[] = []
  try {
    const installed = new Map(previous.map((entry) => [entry.id, entry]))
    for (const item of found) {
      if (options?.signal?.aborted) throw new DOMException('The import was cancelled.', 'AbortError')
      const bytes = await fileBytes(item.file)
      const hash = await sha256Hex(bytes)
      if (hash !== item.entry.sha256) throw new Error('A file did not match the catalog hash.')
      if (!previousSha.has(hash)) {
        await store.writeSha(hash, bytes)
        written.push(hash)
      }
      installed.set(item.entry.id, item.entry)
    }
    if (options?.signal?.aborted) throw new DOMException('The import was cancelled.', 'AbortError')
    await store.commit([...installed.values()])
  } catch (error) {
    for (const hash of written) {
      if (!previousSha.has(hash)) await store.deleteSha(hash).catch(() => undefined)
    }
    const cancelled = error instanceof DOMException && error.name === 'AbortError'
    const quota = error instanceof DOMException && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    const message = cancelled
      ? 'Import cancelled. The library already on this device was kept.'
      : quota
        ? 'This browser does not have room for those files. The library already on this device was kept.'
        : error instanceof Error ? `${error.message} The library already on this device was kept.` : 'The import did not finish. The library already on this device was kept.'
    return { installed: previous.length, missing, rejected, keptPrevious: true, cancelled, message }
  }
  const total = (await store.catalog()).length
  const skipped = missing ? ` ${missing} catalog ${missing === 1 ? 'file was' : 'files were'} not in this folder.` : ''
  return {
    installed: total,
    missing,
    rejected,
    keptPrevious: false,
    cancelled: false,
    message: `Installed ${found.length} private ${found.length === 1 ? 'file' : 'files'} on this device.${skipped} They are not uploaded.`,
  }
}

async function preparePrivateSources(files: PrivateSourceFile[]) {
  const out: PrivateSourceFile[] = []
  for (const file of files) {
    if (!fileKey(file).endsWith('.zip')) {
      out.push(file)
      continue
    }
    out.push(...await filesFromZip(await fileBytes(file)))
  }
  return out
}

export async function filesFromZip(bytes: ArrayBuffer): Promise<PrivateSourceFile[]> {
  const { unzip } = await import('../model/zip')
  const entries = await unzip(new Uint8Array(bytes))
  return entries.map((entry) => ({
    name: entry.name.split('/').pop() || entry.name,
    relativePath: entry.name,
    bytes: entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength) as ArrayBuffer,
  }))
}

export function memoryPrivateStore(): PrivateLibraryStore {
  const files = new Map<string, ArrayBuffer>()
  let entries: SoundEntry[] = []
  return {
    async catalog() {
      return entries.map((entry) => ({ ...entry }))
    },
    async readSha(sha) {
      const hit = files.get(sha)
      return hit ? hit.slice(0) : null
    },
    async writeSha(sha, bytes) {
      files.set(sha, bytes.slice(0))
    },
    async deleteSha(sha) {
      files.delete(sha)
    },
    async commit(next) {
      entries = next.map((entry) => ({ ...entry }))
    },
  }
}

function idbPrivateStore(): PrivateLibraryStore {
  let dbPromise: Promise<IDBDatabase> | null = null
  const open = () => {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('This browser cannot store a private library.'))
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(DB_FILES)) db.createObjectStore(DB_FILES)
          if (!db.objectStoreNames.contains(DB_CATALOG)) db.createObjectStore(DB_CATALOG)
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
  return {
    async catalog() {
      const db = await open()
      return (await idbGet<SoundEntry[]>(db, DB_CATALOG, CATALOG_KEY)) ?? []
    },
    async readSha(sha) {
      const db = await open()
      const value = await idbGet<ArrayBuffer | Uint8Array>(db, DB_FILES, sha)
      if (value instanceof Uint8Array) {
        const copy = new Uint8Array(value.byteLength)
        copy.set(value)
        return copy.buffer
      }
      return value ? value.slice(0) : null
    },
    async writeSha(sha, bytes) {
      const db = await open()
      await idbPut(db, DB_FILES, sha, new Uint8Array(bytes.slice(0)))
    },
    async deleteSha(sha) {
      const db = await open()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DB_FILES, 'readwrite')
        tx.objectStore(DB_FILES).delete(sha)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    async commit(entries) {
      const db = await open()
      await idbPut(db, DB_CATALOG, CATALOG_KEY, entries)
    },
  }
}

function idbGet<T>(db: IDBDatabase, store: string, key: string) {
  return new Promise<T | null>((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

function idbPut(db: IDBDatabase, store: string, key: string, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

