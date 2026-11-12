import type { LibraryInstrumentSummary } from './group'
import type { LibraryEntry } from './types'
import type { SoundEntry } from '../sounds/types'

export const RECENT_CAP = 50
export const RECENT_STORAGE_KEY = 'cueharbor-recent-sounds'

export type RecentKind = 'library' | 'instrument' | 'catalog' | 'harbor'

export interface RecentSound {
  id: string
  at: number
  name: string
  detail: string
  kind: RecentKind
  library?: LibraryEntry
  instrument?: LibraryInstrumentSummary
  sound?: SoundEntry
  harborId?: string
  harborName?: string
  harborFamily?: string
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const listeners = new Set<() => void>()
let memory: RecentSound[] | null = null

export function pushRecent(list: RecentSound[], item: RecentSound, cap = RECENT_CAP): RecentSound[] {
  const next = [item, ...list.filter((row) => row.id !== item.id)]
  return next.slice(0, Math.max(1, cap))
}

export function readRecent(storage: Store | null = defaultStorage()): RecentSound[] {
  if (memory) return memory
  memory = parseRecent(storage?.getItem(RECENT_STORAGE_KEY) ?? '')
  return memory
}

export function recentSounds(): RecentSound[] {
  return readRecent()
}

export function subscribeRecent(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function rememberRecent(item: Omit<RecentSound, 'at'> & { at?: number }, storage: Store | null = defaultStorage(), now = Date.now()) {
  const next = pushRecent(readRecent(storage), { ...item, at: item.at ?? now })
  memory = next
  try { storage?.setItem(RECENT_STORAGE_KEY, JSON.stringify(next)) } catch { /* the session still has the list */ }
  for (const listener of listeners) listener()
  return next
}

export function replaceRecent(next: RecentSound[], storage: Store | null = defaultStorage()) {
  memory = next.slice(0, RECENT_CAP)
  try { storage?.setItem(RECENT_STORAGE_KEY, JSON.stringify(memory)) } catch { /* the session still has the list */ }
  for (const listener of listeners) listener()
}

export function clearRecent(storage: Store | null = defaultStorage()) {
  memory = []
  try { storage?.removeItem(RECENT_STORAGE_KEY) } catch { /* already gone */ }
  for (const listener of listeners) listener()
}

export function rememberLibrarySound(entry: LibraryEntry) {
  rememberRecent({
    id: `library:${entry.key}`,
    name: entry.name,
    detail: entry.type || 'Sound',
    kind: 'library',
    library: entry,
  })
}

export function rememberLibraryInstrument(instrument: LibraryInstrumentSummary) {
  rememberRecent({
    id: `instrument:${instrument.id}`,
    name: instrument.name,
    detail: instrument.category || 'Instrument',
    kind: 'instrument',
    instrument,
  })
}

export function rememberCatalogSound(entry: SoundEntry) {
  rememberRecent({
    id: `catalog:${entry.id}`,
    name: entry.name,
    detail: entry.type,
    kind: 'catalog',
    sound: entry,
  })
}

export function rememberHarborInstrument(item: { id: string; name: string; family?: string }) {
  rememberRecent({
    id: `harbor:${item.id}`,
    name: item.name,
    detail: item.family || 'Instrument',
    kind: 'harbor',
    harborId: item.id,
    harborName: item.name,
    harborFamily: item.family,
  })
}

function parseRecent(raw: string): RecentSound[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecent).slice(0, RECENT_CAP)
  } catch {
    return []
  }
}

function isRecent(value: unknown): value is RecentSound {
  if (!value || typeof value !== 'object') return false
  const row = value as RecentSound
  return typeof row.id === 'string' && typeof row.name === 'string' && typeof row.at === 'number'
}

function defaultStorage(): Store | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}
