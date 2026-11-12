/**
 * Group the private catalog into instruments when it is read, then keep the map in memory.
 * Audio is never downloaded here. Callers presign only the notes they are about to play.
 */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import {
  groupLibraryInstruments,
  searchInstruments,
  type InstrumentQuery,
  type LibraryInstrument,
} from '../src/library/group.ts'
import { LIBRARY_CATALOG_KEY, presignR2Get, type LibraryEnv } from './library.ts'

const CACHE_MS = 15 * 60 * 1000

export interface InstrumentSource {
  search(query: InstrumentQuery): Promise<ReturnType<typeof searchInstruments>>
  get(id: string): Promise<LibraryInstrument | null>
}

async function entriesFromR2(env: LibraryEnv) {
  const url = await presignR2Get(env, LIBRARY_CATALOG_KEY)
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not read the library catalog.')
  const gzip = Buffer.from(await response.arrayBuffer())
  const hash = createHash('sha256').update(gzip).digest('hex')
  const parsed = JSON.parse(gunzipSync(gzip).toString('utf8')) as { entries?: unknown }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) throw new Error('Could not read the library catalog.')
  // Keep only the fields grouping needs. The search-word lists are for the browser.
  const entries = []
  for (const item of parsed.entries) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const key = typeof row.key === 'string' ? row.key : ''
    if (!key) continue
    entries.push({
      key,
      size: typeof row.size === 'number' ? row.size : 0,
      pack: typeof row.pack === 'string' ? row.pack : '',
      type: typeof row.type === 'string' ? row.type : '',
      category: typeof row.category === 'string' ? row.category : '',
      note: typeof row.note === 'string' ? row.note : '',
      root: typeof row.root === 'string' ? row.root : '',
    })
  }
  return { hash, entries }
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
