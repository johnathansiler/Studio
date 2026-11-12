import type { LibraryInstrument } from './group'
import { summarizeInstrument } from './group'
import { favoriteSounds, replaceFavorites, type FavoriteSound } from './favorites'
import { recentSounds, replaceRecent, type RecentSound } from './recent'

function libraryKey(id: string, libraryKey?: string) {
  if (libraryKey) return libraryKey
  return id.replace(/^(library|catalog|sound|instrument):/, '')
}

/** Favorites and recents that pointed at a loose note now point at its grouped instrument. */
export function retargetLibraryMemory(instruments: LibraryInstrument[]) {
  const byKey = new Map<string, LibraryInstrument>()
  for (const instrument of instruments) {
    if (instrument.layers.length < 2 && instrument.notes < 2) continue
    for (const layer of instrument.layers) byKey.set(layer.key, instrument)
    byKey.set(instrument.id, instrument)
  }
  if (!byKey.size) return
  const favorites = foldFavorites(favoriteSounds(), byKey)
  if (favorites) replaceFavorites(favorites)
  const recent = foldRecent(recentSounds(), byKey)
  if (recent) replaceRecent(recent)
}

function foldFavorites(items: FavoriteSound[], byKey: Map<string, LibraryInstrument>) {
  let changed = false
  const next: FavoriteSound[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = libraryKey(item.legacyId || item.id, item.library?.key)
    const group = byKey.get(key)
    if (!group) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        next.push(item)
      }
      continue
    }
    const id = `instrument:${group.id}`
    changed = true
    if (seen.has(id)) continue
    seen.add(id)
    next.push({
      ...item,
      id,
      name: group.name,
      detail: group.category || 'Instrument',
      kind: 'instrument',
      instrument: summarizeInstrument(group),
      legacyId: item.legacyId || item.id,
    })
  }
  return changed ? next : null
}

function foldRecent(items: RecentSound[], byKey: Map<string, LibraryInstrument>) {
  let changed = false
  const next: RecentSound[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = libraryKey(item.id, item.library?.key)
    const group = byKey.get(key)
    if (!group) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        next.push(item)
      }
      continue
    }
    const id = `instrument:${group.id}`
    changed = true
    if (seen.has(id)) continue
    seen.add(id)
    next.push({
      ...item,
      id,
      name: group.name,
      detail: group.category || 'Instrument',
      kind: 'instrument',
      instrument: summarizeInstrument(group),
      library: undefined,
    })
  }
  return changed ? next : null
}
