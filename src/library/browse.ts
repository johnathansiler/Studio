import type { LibraryInstrumentSummary } from './group'
import type { LibraryHits, LibraryIndex } from './search'
import type { LibraryEntry, LibraryQuery } from './types'

export type BrowseRow =
  | { kind: 'instrument'; instrument: LibraryInstrumentSummary }
  | { kind: 'sound'; entry: LibraryEntry }

function coveredByInstrument(entry: LibraryEntry, instruments: LibraryInstrumentSummary[]) {
  if (entry.type === 'multisample note') return true
  if (entry.type) return false
  const stem = (entry.key.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '')
  if (!/^[A-Ga-g](?:#|b|s)?(?:-1|\d+)?$/i.test(stem)) return false
  return instruments.some((item) => item.folder && entry.key.startsWith(`${item.folder}/`))
}

export function instrumentQueryHit(instrument: LibraryInstrumentSummary, query: LibraryQuery) {
  if (query.type && query.type !== 'instrument') return false
  if (query.genre || query.musicalKey || query.mood || query.bpmMin != null || query.bpmMax != null) return false
  if (query.instrument) return false
  if (query.category && instrument.category.toLowerCase() !== query.category.toLowerCase()) return false
  if (query.pack && instrument.pack.toLowerCase() !== query.pack.toLowerCase()) return false
  const tokens = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return true
  const hay = `${instrument.name} ${instrument.pack} ${instrument.category}`.toLowerCase()
  return tokens.every((token) => hay.includes(token))
}

/** Multisample notes stay out of the list. Instruments lead when the browse is about them. */
export function browseLibraryRows(
  index: LibraryIndex,
  hits: LibraryHits,
  instruments: LibraryInstrumentSummary[],
  query: LibraryQuery,
): BrowseRow[] {
  const sounds: LibraryEntry[] = []
  const count = hits.ids ? hits.ids.length : index.entries.length
  for (let n = 0; n < count; n++) {
    const id = hits.ids ? hits.ids[n] : n
    const entry = index.entries[id]
    if (!entry || coveredByInstrument(entry, instruments)) continue
    sounds.push(entry)
  }
  const shown = instruments.filter((item) => instrumentQueryHit(item, query))
  const soundOnly = query.type === 'one-shot' || query.type === 'loop' || query.type === 'sfx'
  const instrumentRows: BrowseRow[] = shown.map((instrument) => ({ kind: 'instrument', instrument }))
  const soundRows: BrowseRow[] = query.type === 'instrument' ? [] : sounds.map((entry) => ({ kind: 'sound', entry }))
  if (soundOnly) return soundRows
  return [...instrumentRows, ...soundRows]
}
