import type { LibraryInstrumentSummary } from './group'
import type { LibraryEntry } from './types'
import type { SoundEntry } from '../sounds/types'
import type { RecentKind } from './recent'

export const FAVORITES_STORAGE_KEY = 'cueharbor-favorite-sounds'

export interface FavoriteSound {
  id: string
  at: number
  name: string
  detail: string
  kind: RecentKind
  /** Stable catalog or library id from an older revision. Lookup uses this before the path. */
  legacyId?: string
  library?: LibraryEntry
  instrument?: LibraryInstrumentSummary
  sound?: SoundEntry
  harborId?: string
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const listeners = new Set<() => void>()
let memory: FavoriteSound[] | null = null

export function favoriteSounds(): FavoriteSound[] {
  return readFavorites()
}

export function readFavorites(storage: Store | null = defaultStorage()): FavoriteSound[] {
  if (memory) return memory
  memory = parseFavorites(storage?.getItem(FAVORITES_STORAGE_KEY) ?? '')
  return memory
}

export function subscribeFavorites(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isFavorite(id: string, storage: Store | null = defaultStorage()) {
  return readFavorites(storage).some((item) => item.id === id || item.legacyId === id)
}

/** Star puts the item first. Starring again removes it. */
export function toggleFavorite(item: Omit<FavoriteSound, 'at'> & { at?: number }, storage: Store | null = defaultStorage(), now = Date.now()) {
  const current = readFavorites(storage)
  const exists = current.some((row) => row.id === item.id)
  const next = exists
    ? current.filter((row) => row.id !== item.id)
    : [{ ...item, at: item.at ?? now }, ...current.filter((row) => row.id !== item.id)]
  write(next, storage)
  return !exists
}

/** Old project favorite ids join this device list, newest of that list first, without a second copy. */
export function absorbLegacyFavoriteIds(ids: string[], storage: Store | null = defaultStorage()) {
  const have = new Set(readFavorites(storage).flatMap((item) => [item.id, item.legacyId || '']))
  for (const id of ids) {
    const key = id.startsWith('catalog:') || id.startsWith('library:') || id.startsWith('instrument:') || id.startsWith('harbor:') ? id : `catalog:${id}`
    if (!id || have.has(id) || have.has(key)) continue
    toggleFavorite({ id: key, name: id, detail: 'Sound', kind: 'catalog', legacyId: id }, storage)
    have.add(id)
    have.add(key)
  }
}

export function replaceFavorites(next: FavoriteSound[], storage: Store | null = defaultStorage()) {
  write(next, storage)
}

function write(next: FavoriteSound[], storage: Store | null) {
  memory = next
  try { storage?.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next)) } catch { /* this device keeps the in-memory list */ }
  for (const listener of listeners) listener()
}

function parseFavorites(raw: string): FavoriteSound[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isFavoriteRow)
  } catch {
    return []
  }
}

function isFavoriteRow(value: unknown): value is FavoriteSound {
  if (!value || typeof value !== 'object') return false
  const row = value as FavoriteSound
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
