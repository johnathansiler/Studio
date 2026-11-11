import type { SoundCache } from './cache'
import { fetchSoundBytes, soundCache, type FetchSoundOptions } from './cache'
import { packLabel, SOUNDSCOUT_VERSION, SOUND_VERSION_PREFIX } from './contract'
import { licenseAllowed } from './license'
import { readPrivateCatalog, readPrivateFile } from './private'
import { soundCatalogUrl, soundFileUrl } from './source'
import type { CatalogResult, SoundEntry, SoundKind, SoundQuery } from './types'

export { licenseAllowed } from './license'

const KINDS = new Set<SoundKind>(['one-shot', 'loop', 'instrument'])

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

let listedFetch: FetchLike = (input, init) => fetch(input, init)
let listedCache: SoundCache | undefined

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
  const collection = typeof raw.collection === 'string' && raw.collection.trim() ? raw.collection.trim() : undefined
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : undefined
  const pitch = typeof raw.pitch === 'string' && raw.pitch.trim() ? raw.pitch.trim() : undefined
  const sha256 = typeof raw.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(raw.sha256.trim()) ? raw.sha256.trim().toLowerCase() : undefined
  const bytes = typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) && raw.bytes > 0 ? raw.bytes : undefined
  const pack = typeof raw.pack === 'string' && raw.pack.trim() ? raw.pack.trim() : undefined
  return { id, path, name, type: type as SoundKind, tags, bpm, key, pitch, durationSec, sampleRate, license, source, collection, category, sha256, bytes, pack }
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

const DRUM_WORD = /\b(drum|drums|kit|kick|snare|hi-?hat|hat|clap|tom|cymbal|rimshot|rim)\b/

/** One-shots and loops that are drum samples or kits. Percussion that is not a drum stays out. */
export function isDrumSound(entry: Pick<SoundEntry, 'name' | 'path' | 'tags' | 'category' | 'role'>) {
  const category = (entry.category ?? '').toLowerCase()
  if (category === 'kick' || category === 'drums' || category === 'percussion' || category === 'perc' || category === 'snare' || category === 'hat' || category === 'clap' || category === 'tom' || category === 'cymbal') return true
  if ((entry.role ?? '').toLowerCase() === 'drum_one_shot') return true
  const path = entry.path.toLowerCase()
  if (path.startsWith('drums/') || path.includes('/drums/')) return true
  return DRUM_WORD.test(`${entry.name} ${entry.path} ${entry.tags.join(' ')}`.toLowerCase())
}

export function filterSounds(entries: SoundEntry[], query: SoundQuery): SoundEntry[] {
  const tokens = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const key = query.key.trim().toLowerCase()
  return entries
    .filter((entry) => {
      if (query.type === 'drum') {
        if (entry.type !== 'one-shot' || !isDrumSound(entry)) return false
      } else if (query.type !== 'all' && entry.type !== query.type) return false
      if (query.favoritesOnly && !query.favorites.includes(entry.id)) return false
      if (query.collection && entry.collection !== query.collection && entry.pack !== query.collection) return false
      if (query.category && entry.category !== query.category) return false
      if (query.tag && !entry.tags.some((tag) => tag.toLowerCase() === query.tag?.toLowerCase())) return false
      if (query.role && (entry.role ?? '').toLowerCase() !== query.role.trim().toLowerCase()) return false
      if (key && !soundKeyMatches(key, entry.key)) return false
      if (query.bpm === 'project' && (entry.bpm == null || !bpmMatchesProject(entry.bpm, query.projectBpm))) return false
      if (!tokens.length) return true
      const hay = `${entry.name} ${entry.collection ?? ''} ${entry.category ?? ''} ${entry.role ?? ''} ${entry.publisher ?? ''} ${entry.pack ?? ''} ${entry.pack ? packLabel(entry.pack) : ''} ${entry.tags.join(' ')} ${entry.key ?? ''} ${entry.pitch ?? ''} ${entry.bpm ?? ''} ${entry.origin === 'private' ? 'private' : ''} ${entry.type} ${entry.source}`.toLowerCase()
      return tokens.every((token) => hay.includes(token))
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/**
 * The library index writes "C major" and "A minor".
 * "C", "Cmaj", and "Am" name the same keys.
 */
function soundKeyMatches(query: string, entryKey: string | undefined) {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return true
  const raw = (entryKey ?? '').trim().toLowerCase()
  if (!raw) return false
  if (raw === wanted) return true
  return canonicalSoundKey(wanted) === canonicalSoundKey(raw)
}

function canonicalSoundKey(value: string) {
  const text = value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  const match = text.match(/^([a-g])\s*([#b♯♭]?)\s*(major|minor|maj|min|m)?$/)
  if (!match) return text
  let accidental = match[2] ?? ''
  if (accidental === '♯') accidental = '#'
  if (accidental === '♭') accidental = 'b'
  const note = `${match[1].toUpperCase()}${accidental}`
  const mode = match[3] ?? ''
  const minor = mode === 'm' || mode === 'min' || mode === 'minor'
  return `${note} ${minor ? 'minor' : 'major'}`
}

export function soundKeys(entries: SoundEntry[]) {
  return [...new Set(entries.map((entry) => entry.key).filter((key): key is string => Boolean(key)))].sort((a, b) => a.localeCompare(b))
}

export function soundPacks(entries: SoundEntry[]) {
  return [...new Set(entries.map((entry) => entry.pack).filter((pack): pack is string => Boolean(pack)))].sort((a, b) => a.localeCompare(b))
}

export function soundCollections(entries: SoundEntry[]) {
  return soundPacks(entries)
}

export function soundCategories(entries: SoundEntry[]) {
  return [...new Set(entries.map((entry) => entry.category).filter((category): category is string => Boolean(category)))].sort((a, b) => a.localeCompare(b))
}

/** Every tag on the loaded catalog. New packs can add tags without a code change. */
export function soundTags(entries: SoundEntry[]) {
  return [...new Set(entries.flatMap((entry) => entry.tags))].sort((a, b) => a.localeCompare(b))
}

/** Roles already stored on the rows. Public rows get one derived role when the file has none. */
export function soundRoles(entries: SoundEntry[]) {
  return [...new Set(entries.map((entry) => entry.role).filter((role): role is string => Boolean(role)))].sort((a, b) => a.localeCompare(b))
}

/**
 * What the browser lists for a kind chip.
 * "Instruments" is not a stored kind in this catalog. It is the same free
 * files, loaded as one sample on the keyboard instead of the old starter list.
 */
export function browserSounds(entries: SoundEntry[], query: SoundQuery) {
  const type = query.type === 'instrument' ? 'all' : query.type
  return filterSounds(entries, { ...query, type })
}

function derivedRole(type: SoundKind, category: string | undefined, tags: string[]) {
  if (type === 'loop') return 'loop'
  const cat = (category ?? '').toLowerCase()
  if (cat === 'kick' || cat === 'snare' || cat === 'clap' || cat === 'hat' || cat === 'hi-hat' || cat === 'tom' || cat === 'drums') return 'drum_one_shot'
  if (tags.some((tag) => /^(kick|snare|clap|hat|drums)$/i.test(tag))) return 'drum_one_shot'
  return 'one_shot'
}

export function catalogMessage(result: CatalogResult, filteredCount: number, queryActive: boolean) {
  if (result.status === 'missing') return 'The sound library is not online yet.'
  if (!result.entries.length) return 'No free sounds are listed yet.'
  if (!filteredCount && queryActive) return 'Nothing matches those filters.'
  return ''
}

function bytesOf(text: string) {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

/**
 * One versioned SoundScout row. Names, bpm, and key are copied only when the
 * document has them. Legacy index rows are not accepted here.
 */
export function parseScoutEntry(input: unknown): SoundEntry | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  const type = raw.type
  if (!id || !path || !name.trim() || typeof type !== 'string' || !KINDS.has(type as SoundKind)) return null
  if (!path.startsWith(SOUND_VERSION_PREFIX) || path.includes('..')) return null
  const license = typeof raw.license === 'string' ? raw.license.trim() : ''
  const licenseClass = typeof raw.licenseClass === 'string' ? raw.licenseClass.trim() : ''
  if (/NOT_CC0/.test(licenseClass) && license !== 'Informal-creator-grant') return null
  const attributionRequired = raw.attributionRequired === true
  if (!licenseAllowed(license, attributionRequired)) return null
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim()) : []
  const bpm = typeof raw.bpm === 'number' && Number.isFinite(raw.bpm) && raw.bpm > 0 ? raw.bpm : undefined
  const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : undefined
  const durationSec = typeof raw.durationSec === 'number' && Number.isFinite(raw.durationSec) && raw.durationSec >= 0 ? raw.durationSec : 0
  const sampleRate = typeof raw.sampleRate === 'number' && Number.isFinite(raw.sampleRate) && raw.sampleRate > 0 ? raw.sampleRate : 0
  if (!(sampleRate > 0)) return null
  const source = typeof raw.source === 'string' ? raw.source.trim() : ''
  const collection = typeof raw.collection === 'string' && raw.collection.trim() ? raw.collection.trim() : undefined
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : undefined
  const sha256 = typeof raw.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(raw.sha256.trim()) ? raw.sha256.trim().toLowerCase() : undefined
  const bytes = typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) && raw.bytes > 0 ? raw.bytes : undefined
  const pack = typeof raw.packId === 'string' && raw.packId.trim() ? raw.packId.trim() : typeof raw.pack === 'string' && raw.pack.trim() ? raw.pack.trim() : undefined
  const explicitRole = typeof raw.role === 'string' && raw.role.trim() ? raw.role.trim() : ''
  return {
    id,
    path,
    name,
    type: type as SoundKind,
    tags,
    bpm,
    key,
    durationSec,
    sampleRate,
    license,
    source,
    collection,
    category,
    sha256,
    bytes,
    pack,
    role: explicitRole || derivedRole(type as SoundKind, category, tags),
    licenseClass: licenseClass || undefined,
    licenseNote: typeof raw.licenseNote === 'string' && raw.licenseNote.trim() ? raw.licenseNote.trim() : undefined,
    creator: typeof raw.creator === 'string' && raw.creator.trim() ? raw.creator.trim() : undefined,
    attributionRequired,
    isContentAlias: raw.isContentAlias === true,
  }
}

/** The versioned catalog object. An array is the old stock index and is ignored. */
export function parseSoundScoutCatalog(input: unknown): SoundEntry[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const doc = input as Record<string, unknown>
  if (doc.version !== SOUNDSCOUT_VERSION || !Array.isArray(doc.entries)) return []
  const entries: SoundEntry[] = []
  for (const item of doc.entries) {
    const entry = parseScoutEntry(item)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * Fetch the versioned SoundScout catalog only.
 * A missing file, a legacy index, or a cached copy of that index does not become the list.
 * The cache key is the catalog URL, which includes the dataset commit and catalog filename.
 * A stored copy of an older commit or filename is not reused.
 * Audio files are not requested here.
 */
export async function loadSoundCatalog(fetchImpl: FetchLike = (input, init) => fetch(input, init), cache?: SoundCache): Promise<CatalogResult> {
  listedFetch = fetchImpl
  listedCache = cache
  const url = soundCatalogUrl()
  try {
    const response = await fetchImpl(url, { cache: 'no-store' })
    if (response.ok) {
      const text = await response.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        return readCachedCatalog(cache, url)
      }
      const remote = parseSoundScoutCatalog(json)
      if (remote.length && cache) {
        try { await cache.put(url, bytesOf(text)) } catch { /* the list still shows */ }
      }
      return finishCatalog(remote, remote.length ? 'ok' : 'missing')
    }
  } catch {
    /* try the last versioned catalog, never the legacy index */
  }
  return readCachedCatalog(cache, url)
}

async function readCachedCatalog(cache: SoundCache | undefined, url: string): Promise<CatalogResult> {
  if (!cache) return finishCatalog([], 'missing')
  try {
    const bytes = await cache.get(url)
    if (!bytes) return finishCatalog([], 'missing')
    const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    const remote = parseSoundScoutCatalog(json)
    if (!remote.length) return finishCatalog([], 'missing')
    return finishCatalog(remote, 'ok')
  } catch {
    return finishCatalog([], 'missing')
  }
}

/** Shared catalog plus files installed on this device. Private rows are not fetched. */
async function finishCatalog(remote: SoundEntry[], status: CatalogResult['status']): Promise<CatalogResult> {
  let local: SoundEntry[] = []
  try {
    local = await readPrivateCatalog()
  } catch {
    local = []
  }
  if (!remote.length && !local.length) return { entries: [], status: 'missing' }
  const seen = new Set(remote.map((entry) => entry.id))
  const entries = remote.concat(local.filter((entry) => entry.origin === 'private' && !seen.has(entry.id)))
  return { entries, status: remote.length ? status : 'ok' }
}

/** One file from the active catalog. Checks the inventory hash before caching. */
export async function fetchCatalogSound(entry: SoundEntry, options?: FetchSoundOptions & { fetchImpl?: FetchLike; cache?: SoundCache }) {
  if (entry.origin === 'private') {
    const bytes = await readPrivateFile(entry.id)
    if (!bytes) throw new Error('That private sound is not on this device. The rest of the project still plays.')
    options?.onProgress?.(1)
    return bytes
  }
  const url = soundFileUrl(entry.path)
  return fetchSoundBytes(url, options?.fetchImpl ?? listedFetch, options?.cache ?? listedCache ?? soundCache(), {
    attempts: options?.attempts,
    delayMs: options?.delayMs,
    onProgress: options?.onProgress,
    sha256: options?.sha256 ?? entry.sha256,
    totalBytes: options?.totalBytes ?? entry.bytes,
  })
}
