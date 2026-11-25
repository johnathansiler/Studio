/**
 * Group the private catalog into instruments when it is read, then keep the map in memory.
 * Audio is never downloaded here. Callers presign only the notes they are about to play.
 */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { overlayRowsByKey } from '../src/library/overlay.ts'
import {
  groupLibraryInstruments,
  searchInstruments,
  type InstrumentQuery,
  type LibraryInstrument,
} from '../src/library/group.ts'
import { LIBRARY_ADDITIONS_KEY, LIBRARY_CATALOG_KEY, presignR2Get, type LibraryEnv } from './library.ts'

const CACHE_MS = 15 * 60 * 1000

export interface InstrumentSource {
  search(query: InstrumentQuery): Promise<ReturnType<typeof searchInstruments>>
  get(id: string): Promise<LibraryInstrument | null>
}

export interface SlimCatalogRow {
  key: string
  size: number
  pack: string
  type: string
  category: string
  note: string
  root: string
}

/** Fields grouping needs. Search words stay in the browser copy of the catalog. */
export function slimCatalogRows(parsed: unknown): SlimCatalogRow[] {
  const entries = parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
    ? (parsed as { entries: unknown[] }).entries
    : []
  const rows: SlimCatalogRow[] = []
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const key = typeof row.key === 'string' ? row.key : ''
    if (!key) continue
    rows.push({
      key,
      size: typeof row.size === 'number' ? row.size : 0,
      pack: typeof row.pack === 'string' ? row.pack : '',
      type: typeof row.type === 'string' ? row.type : '',
      category: typeof row.category === 'string' ? row.category : '',
      note: typeof row.note === 'string' ? row.note : '',
      root: typeof row.root === 'string' ? row.root : '',
    })
  }
  return rows
}

/** Base rows, then sidecar rows. The same key keeps one slot and the addition replaces it. */
export function mergeCatalogRows(base: unknown, additions?: unknown): SlimCatalogRow[] {
  const rows = slimCatalogRows(base)
  if (additions == null) return rows
  overlayRowsByKey(rows, slimCatalogRows(additions))
  return rows
}

function rowsFromGzip(gzip: Buffer): SlimCatalogRow[] {
  const parsed = JSON.parse(gunzipSync(gzip).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    throw new Error('Could not read the library catalog.')
  }
  return slimCatalogRows(parsed)
}

async function readPrivateObject(env: LibraryEnv, key: string): Promise<Buffer | null> {
  const url = await presignR2Get(env, key)
  const response = await fetch(url)
  if (response.status === 404) {
    await response.arrayBuffer().catch(() => undefined)
    return null
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined)
    throw new Error('Could not read the library catalog.')
  }
  return Buffer.from(await response.arrayBuffer())
}

async function entriesFromR2(env: LibraryEnv) {
  let gzip: Buffer | null = await readPrivateObject(env, LIBRARY_CATALOG_KEY)
  if (!gzip) throw new Error('Could not read the library catalog.')
  const hash = createHash('sha256')
  hash.update(gzip)
  const entries = rowsFromGzip(gzip)
  gzip = null
  const extra = await readPrivateObject(env, LIBRARY_ADDITIONS_KEY)
  if (extra) {
    hash.update(extra)
    let parsed: unknown
    try {
      parsed = JSON.parse(extra.toString('utf8')) as unknown
    } catch {
      throw new Error('Could not read the library catalog.')
    }
    overlayRowsByKey(entries, slimCatalogRows(parsed))
  }
  return { hash: hash.digest('hex'), entries }
}

export function createInstrumentSource(deps: {
  env: () => LibraryEnv
  load?: () => Promise<{ hash: string; entries: Parameters<typeof groupLibraryInstruments>[0] }>
  now?: () => number
}): InstrumentSource {
  let cache: { hash: string; at: number; instruments: LibraryInstrument[] } | null = null
  let pending: Promise<LibraryInstrument[]> | null = null
  const now = deps.now ?? (() => Date.now())

  async function load(): Promise<LibraryInstrument[]> {
    if (cache && now() - cache.at < CACHE_MS) return cache.instruments
    if (pending) return pending
    pending = (async () => {
      const loaded = deps.load ? await deps.load() : await entriesFromR2(deps.env())
      if (cache && cache.hash === loaded.hash) {
        cache.at = now()
        return cache.instruments
      }
      const instruments = groupLibraryInstruments(loaded.entries)
      cache = { hash: loaded.hash, at: now(), instruments }
      return instruments
    })().finally(() => {
      pending = null
    })
    return pending
  }

  return {
    async search(query) {
      return searchInstruments(await load(), query)
    },
    async get(id) {
      const instruments = await load()
      return instruments.find((item) => item.id === id) ?? null
    },
  }
}
