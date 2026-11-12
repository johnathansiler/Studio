import { familyFor } from './family'
import { licenseAllowed } from './license'
import type { CatalogInstrument, HarborCatalog, HarborEntry, HarborKind, LoopKind } from './types'

const KINDS = new Set<HarborKind>(['one-shot', 'loop', 'instrument'])
const LEGACY_ALIAS = /(?:^|\/)darkblack-bass(?:\/|$)/i

function record(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

function text(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function number(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key]
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function tagsOf(raw: Record<string, unknown>) {
  const value = raw.tags
  if (!Array.isArray(value)) return []
  return value.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim())
}

function safePath(path: string) {
  const clean = path.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '')
  if (!clean || /^https?:/i.test(clean) || clean.includes('://')) return ''
  // `computer..wav` is a file name. `..` is only unsafe as its own folder.
  if (clean.split('/').some((part) => part === '.' || part === '..')) return ''
  return clean
}

function loopKindOf(raw: Record<string, unknown>, tags: string[], name: string, path: string): LoopKind {
  const role = text(raw, ['role', 'loopKind', 'loopType']).toLowerCase()
  if (role === 'drum-loop' || role === 'drum' || role === 'drums') return 'drum'
  if (role === 'melodic-loop' || role === 'melodic' || role === 'melody') return 'melodic'
  const hay = `${name} ${path} ${tags.join(' ')} ${text(raw, ['category'])}`.toLowerCase()
  if (/\b(drum-loop|drums)\b/.test(hay) || tags.some((tag) => tag === 'drum-loop' || tag === 'drums')) return 'drum'
  return 'melodic'
}

/** `instruments/darkblack-bass` is the old folder. `black-and-blue-basses` is the instrument to load. */
export function legacyAlias(path: string, id = '') {
  return LEGACY_ALIAS.test(path) || LEGACY_ALIAS.test(id)
}

export function parseCatalogInstrument(input: unknown): CatalogInstrument | null {
  const raw = record(input)
  if (!raw) return null
  const id = text(raw, ['id'])
  const path = safePath(text(raw, ['path']))
  const name = text(raw, ['name'])
  const license = text(raw, ['license'])
  if (!id || !path || !name || !licenseAllowed(license, raw.attributionRequired === true)) return null
  if (legacyAlias(path, id)) return null
  const tags = tagsOf(raw)
  const category = text(raw, ['category']) || undefined
  return {
    id,
    name,
    license,
    path,
    category,
    tags,
    description: text(raw, ['description']) || undefined,
    source: text(raw, ['source']) || undefined,
    velocityLayers: number(raw, ['velocityLayers']),
    roundRobins: number(raw, ['roundRobins']),
    releaseSamples: number(raw, ['releaseSamples']),
    sampleCount: number(raw, ['sampleCount']),
    bytes: number(raw, ['bytes']),
    family: familyFor({ category, name, tags, instrument: name }),
  }
}

function releaseOf(raw: Record<string, unknown>, articulation: string) {
  if (raw.release === true || raw.trigger === 'release') return true
  const role = text(raw, ['role', 'trigger']).toLowerCase()
  if (role === 'release' || role.includes('release')) return true
  return /\brelease\b/i.test(articulation)
}

/** One sample or loop row. A broken row is skipped. */
export function parseHarborEntry(input: unknown): HarborEntry | null {
  const raw = record(input)
  if (!raw) return null
  const id = text(raw, ['id'])
  const path = safePath(text(raw, ['path']))
  const name = text(raw, ['name'])
  const typeText = text(raw, ['type']) || 'loop'
  if (!id || !path || !name || !KINDS.has(typeText as HarborKind)) return null
  if (legacyAlias(path, id)) return null
  const type = typeText as HarborKind
  const license = text(raw, ['license'])
  const attribution = raw.attributionRequired === true
  if (!licenseAllowed(license, attribution)) return null
  const tags = tagsOf(raw)
  const instrument = text(raw, ['instrument', 'instrumentName'])
  const articulation = text(raw, ['articulation', 'artic'])
  const rootValue = number(raw, ['root', 'rootNote', 'rootMidi', 'midi', 'midiRoot'])
  const root = rootValue != null ? Math.max(0, Math.min(127, Math.round(rootValue))) : undefined
  if (type === 'one-shot' && !(instrument && root != null)) return null
  const bpm = number(raw, ['bpm', 'loopBpm'])
  const bars = number(raw, ['bars', 'loopBars'])
  const duration = number(raw, ['durationSec', 'duration'])
  const rate = number(raw, ['sampleRate'])
  const sha = text(raw, ['sha256'])
  const bytes = number(raw, ['bytes'])
  const release = releaseOf(raw, articulation)
  const kind = type === 'loop' ? loopKindOf(raw, tags, name, path) : undefined
  const promoted = type === 'one-shot' ? 'instrument' : type
  const velLo = number(raw, ['velLo', 'velocityLo', 'lovel'])
  const velHi = number(raw, ['velHi', 'velocityHi', 'hivel'])
  const roundRobinValue = number(raw, ['roundRobin', 'rr', 'rrIndex', 'seq'])
  return {
    id,
    path,
    name,
    type: promoted,
    tags,
    bpm: bpm != null && bpm > 0 ? bpm : undefined,
    key: text(raw, ['key', 'loopKey']) || undefined,
    bars: bars != null && bars > 0 ? bars : undefined,
    durationSec: duration != null && duration >= 0 ? duration : 0,
    sampleRate: rate != null && rate > 0 ? rate : 48000,
    license,
    source: text(raw, ['source']),
    pack: text(raw, ['pack', 'packId']) || undefined,
    instrument: instrument || undefined,
    articulation: articulation.replace(/\brelease\b/i, '').trim() || undefined,
    root: promoted === 'instrument' ? root : undefined,
    velLo: velLo != null ? Math.max(1, Math.min(127, Math.round(velLo))) : undefined,
    velHi: velHi != null ? Math.max(1, Math.min(127, Math.round(velHi))) : undefined,
    roundRobin: roundRobinValue != null && roundRobinValue > 0 ? Math.round(roundRobinValue) : undefined,
    loopKind: kind,
    release,
    sha256: /^[a-f0-9]{64}$/i.test(sha) ? sha.toLowerCase() : undefined,
    bytes: bytes != null && bytes > 0 ? bytes : undefined,
    role: text(raw, ['role']) || undefined,
    attributionRequired: attribution,
  }
}

function listOf(raw: Record<string, unknown>, key: string) {
  return Array.isArray(raw[key]) ? raw[key] as unknown[] : []
}

/**
 * The live catalog is `{ version, instruments, loops }`.
 * A document that still carries sample `entries` is read as those rows.
 */
export function parseHarborCatalog(input: unknown): HarborCatalog {
  const raw = record(input)
  if (!raw) return { version: '', instruments: [], loops: [], entries: [] }
  const version = raw.version == null ? '' : String(raw.version)
  const instruments = listOf(raw, 'instruments').map(parseCatalogInstrument).filter((item): item is CatalogInstrument => Boolean(item))
  const loops = listOf(raw, 'loops').map(parseHarborEntry).filter((item): item is HarborEntry => Boolean(item && item.type === 'loop'))
  const entries = listOf(raw, 'entries').map(parseHarborEntry).filter((item): item is HarborEntry => Boolean(item))
  return { version, instruments, loops, entries }
}
