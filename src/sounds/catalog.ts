import type { CatalogResult, SoundEntry, SoundKind, SoundQuery } from './types'
import { soundIndexUrl } from './source'
import type { SoundCache } from './cache'

const KINDS = new Set<SoundKind>(['one-shot', 'loop', 'instrument'])

/** CC0, public domain, and Unlicense only. */
export function licenseAllowed(license: string) {
  const text = license.trim().toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ')
  if (!text) return false
  if (text === 'cc0' || text.startsWith('cc0 ') || text.startsWith('cc0-') || text.startsWith('cc-0') || text.startsWith('cc zero') || text.startsWith('creative commons zero')) return true
  if (text === 'public domain' || text.startsWith('public domain')) return true
  if (text === 'unlicense' || text.startsWith('unlicense')) return true
  return false
}

export function parseSoundEntry(input: unknown): SoundEntry | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const type = raw.type
  if (!id || !path || !name || typeof type !== 'string' || !KINDS.has(type as SoundKind)) return null
  const license = typeof raw.license === 'string' ? raw.license.trim() : ''
  if (!licenseAllowed(license)) return null
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim()) : []
  const bpm = typeof raw.bpm === 'number' && Number.isFinite(raw.bpm) && raw.bpm > 0 ? raw.bpm : undefined
  const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : undefined
  const durationSec = typeof raw.durationSec === 'number' && Number.isFinite(raw.durationSec) && raw.durationSec >= 0 ? raw.durationSec : 0
  const sampleRate = typeof raw.sampleRate === 'number' && Number.isFinite(raw.sampleRate) && raw.sampleRate > 0 ? raw.sampleRate : 48000
  const source = typeof raw.source === 'string' ? raw.source.trim() : ''
  return { id, path, name, type: type as SoundKind, tags, bpm, key, durationSec, sampleRate, license, source }
}

export function parseCatalog(input: unknown): SoundEntry[] {
  if (!Array.isArray(input)) return []
  const entries: SoundEntry[] = []
  for (const item of input) {
    const entry = parseSoundEntry(item)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Half-time and double-time count as the same tempo. */
export function bpmMatchesProject(bpm: number, projectBpm: number) {
  if (!(bpm > 0) || !(projectBpm > 0)) return false
  let candidate = bpm
  while (candidate > projectBpm * 1.5) candidate /= 2
  while (candidate < projectBpm / 1.5) candidate *= 2
  return Math.abs(candidate - projectBpm) / projectBpm <= 0.06
}

export function filterSounds(entries: SoundEntry[], query: SoundQuery): SoundEntry[] {
  const tokens = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const key = query.key.trim().toLowerCase()
  return entries
    .filter((entry) => {
      if (query.type !== 'all' && entry.type !== query.type) return false
      if (query.favoritesOnly && !query.favorites.includes(entry.id)) return false
      if (key && (entry.key || '').toLowerCase() !== key) return false
      if (query.bpm === 'project' && (entry.bpm == null || !bpmMatchesProject(entry.bpm, query.projectBpm))) return false
      if (!tokens.length) return true
      const hay = `${entry.name} ${entry.tags.join(' ')} ${entry.key ?? ''} ${entry.type} ${entry.source}`.toLowerCase()
      return tokens.every((token) => hay.includes(token))
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export function soundKeys(entries: SoundEntry[]) {
  return [...new Set(entries.map((entry) => entry.key).filter((key): key is string => Boolean(key)))].sort((a, b) => a.localeCompare(b))
}

export function catalogMessage(result: CatalogResult, filteredCount: number, queryActive: boolean) {
  if (result.status === 'missing') return 'The sound library is not online yet.'
  if (!result.entries.length) return 'No free sounds are listed yet.'
  if (!filteredCount && queryActive) return 'Nothing matches those filters.'
  return ''
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function bytesOf(text: string) {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

/**
 * Network first. A missing or unreadable index falls back to the last cached copy,
 * then to an empty catalog so the panel can still open.
 */
export async function loadSoundCatalog(fetchImpl: FetchLike = (input, init) => fetch(input, init), cache?: SoundCache): Promise<CatalogResult> {
  const url = soundIndexUrl()
  const store = cache
  try {
    const response = await fetchImpl(url, { cache: 'no-store' })
    if (response.ok) {
      const text = await response.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        return cachedCatalog(store, url)
      }
      if (!Array.isArray(json)) return { entries: [], status: 'missing' }
      if (store) {
        try { await store.put(url, bytesOf(text)) } catch { /* the list still shows */ }
      }
      return { entries: parseCatalog(json), status: 'ok' }
    }
  } catch {
    /* try the copy kept from the last successful load */
  }
  return cachedCatalog(store, url)
}

async function cachedCatalog(cache: SoundCache | undefined, url: string): Promise<CatalogResult> {
  if (!cache) return { entries: [], status: 'missing' }
  try {
    const bytes = await cache.get(url)
    if (!bytes) return { entries: [], status: 'missing' }
    const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!Array.isArray(json)) return { entries: [], status: 'missing' }
    return { entries: parseCatalog(json), status: 'ok' }
  } catch {
    return { entries: [], status: 'missing' }
  }
}
