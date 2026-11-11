import type { LibraryEntry, LibraryFacets, LibraryQuery } from './types'

export interface LibraryIndex {
  entries: LibraryEntry[]
  facets: LibraryFacets
  /** Whole-word postings, sorted. */
  exact: Map<string, Uint32Array>
  /** First three letters to words that start with them. */
  prefixes: Map<string, string[]>
}

export interface LibraryHits {
  total: number
  /** Null means the hits are entries 0..total-1 in order. */
  ids: Uint32Array | null
}

const EMPTY = new Uint32Array()

export function libraryTitle(key: string) {
  const base = key.split('/').pop() || key
  const stem = base.replace(/\.[a-z0-9]+$/i, '')
  return stem.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || base
}

export function queryTokens(text: string) {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9#]+|[^a-z0-9#]+$/g, ''))
    .filter(Boolean)
}

/**
 * Whole words in `search`.
 * A query word shorter than 3 letters must match a token exactly, so "c" matches the note C and not C#.
 * A word of 3 or more letters also matches tokens that start with it.
 */
export function tokenMatches(queryWord: string, words: readonly string[]) {
  const query = queryWord.toLowerCase()
  if (!query) return true
  if (query.length < 3) return words.includes(query)
  return words.some((word) => word.startsWith(query))
}

export function entryMatchesText(search: string, text: string) {
  const tokens = queryTokens(text)
  if (!tokens.length) return true
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.every((token) => tokenMatches(token, words))
}

export function buildLibraryIndex(entries: LibraryEntry[], words: string[][]): LibraryIndex {
  const lists = new Map<string, number[]>()
  const prefixWords = new Map<string, Set<string>>()
  entries.forEach((_entry, index) => {
    const seen = new Set<string>()
    for (const raw of words[index] ?? []) {
      const word = raw.toLowerCase()
      if (!word || seen.has(word)) continue
      seen.add(word)
      let list = lists.get(word)
      if (!list) lists.set(word, list = [])
      list.push(index)
      if (word.length >= 3) {
        const head = word.slice(0, 3)
        let bucket = prefixWords.get(head)
        if (!bucket) prefixWords.set(head, bucket = new Set())
        bucket.add(word)
      }
    }
  })
  const exact = new Map<string, Uint32Array>()
  for (const [word, list] of lists) exact.set(word, Uint32Array.from(list))
  const prefixes = new Map<string, string[]>()
  for (const [head, bucket] of prefixWords) prefixes.set(head, [...bucket])
  return { entries, facets: facetsOf(entries), exact, prefixes }
}

function facetsOf(entries: LibraryEntry[]): LibraryFacets {
  const types = new Set<string>()
  const categories = new Set<string>()
  const instruments = new Set<string>()
  const genres = new Set<string>()
  const keys = new Set<string>()
  const moods = new Set<string>()
  const packs = new Set<string>()
  for (const entry of entries) {
    if (entry.type) types.add(entry.type)
    if (entry.category) categories.add(entry.category)
    if (entry.instrument) instruments.add(entry.instrument)
    if (entry.musicalKey) keys.add(entry.musicalKey)
    if (entry.pack) packs.add(entry.pack)
    for (const genre of entry.genre) if (genre) genres.add(genre)
    for (const mood of entry.mood) if (mood) moods.add(mood)
  }
  const sort = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b))
  return {
    types: sort(types),
    categories: sort(categories),
    instruments: sort(instruments),
    genres: sort(genres),
    keys: sort(keys),
    moods: sort(moods),
    packs: sort(packs),
  }
}

function postings(index: LibraryIndex, token: string): Uint32Array {
  if (token.length < 3) return index.exact.get(token) ?? EMPTY
  const words = index.prefixes.get(token.slice(0, 3)) ?? []
  const lists: Uint32Array[] = []
  for (const word of words) {
    if (!word.startsWith(token)) continue
    const list = index.exact.get(word)
    if (list?.length) lists.push(list)
  }
  return unionMarked(lists, index.entries.length)
}

/** Merge posting lists in one pass. Pairwise unions get slow when a short prefix hits thousands of words. */
function unionMarked(lists: Uint32Array[], size: number) {
  if (!lists.length) return EMPTY
  if (lists.length === 1) return lists[0]
  const seen = new Uint8Array(size)
  let count = 0
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]
      if (seen[id] === 0) {
        seen[id] = 1
        count += 1
      }
    }
  }
  const out = new Uint32Array(count)
  let n = 0
  for (let i = 0; i < size; i++) if (seen[i]) out[n++] = i
  return out
}

/** Rows that belong on screen. The height is the visible pane, never the full catalog. */
export function libraryRowWindow(total: number, scrollTop: number, viewHeight: number, row = 64) {
  const height = Math.max(row, Math.min(viewHeight > 0 ? viewHeight : row, 4096))
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / row) - 4)
  const visible = Math.ceil(height / row) + 10
  const end = Math.min(total, start + visible)
  return { start, end: Math.max(start, end) }
}

function intersect(a: Uint32Array, b: Uint32Array) {
  const out: number[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const av = a[i]
    const bv = b[j]
    if (av === bv) {
      out.push(av)
      i += 1
      j += 1
    } else if (av < bv) i += 1
    else j += 1
  }
  return Uint32Array.from(out)
}

export function entryMatchesFilters(entry: LibraryEntry, query: LibraryQuery) {
  if (query.type && entry.type !== query.type) return false
  if (query.category && entry.category !== query.category) return false
  if (query.instrument && entry.instrument !== query.instrument) return false
  if (query.genre && !entry.genre.includes(query.genre)) return false
  if (query.musicalKey && entry.musicalKey !== query.musicalKey) return false
  if (query.mood && !entry.mood.includes(query.mood)) return false
  if (query.pack && entry.pack !== query.pack) return false
  if (query.bpmMin == null && query.bpmMax == null) return true
  const tempos = [entry.bpm, entry.bpmAlt].filter((bpm): bpm is number => bpm != null && bpm > 0)
  return tempos.some((bpm) => (query.bpmMin == null || bpm >= query.bpmMin) && (query.bpmMax == null || bpm <= query.bpmMax))
}

export function searchLibrary(index: LibraryIndex, query: LibraryQuery): LibraryHits {
  const tokens = queryTokens(query.text || '')
  let ids: Uint32Array | null = null
  if (tokens.length) {
    ids = postings(index, tokens[0])
    for (let n = 1; n < tokens.length; n++) {
      ids = intersect(ids, postings(index, tokens[n]))
      if (!ids.length) break
    }
  }
  const filtered = query.type || query.category || query.instrument || query.genre || query.musicalKey || query.mood || query.pack || query.bpmMin != null || query.bpmMax != null
  if (!filtered) {
    if (!ids) return { total: index.entries.length, ids: null }
    return { total: ids.length, ids }
  }
  const source = ids ?? null
  const count = source ? source.length : index.entries.length
  const kept: number[] = []
  for (let n = 0; n < count; n++) {
    const id = source ? source[n] : n
    if (entryMatchesFilters(index.entries[id], query)) kept.push(id)
  }
  return { total: kept.length, ids: Uint32Array.from(kept) }
}

export function hitAt(index: LibraryIndex, hits: LibraryHits, position: number) {
  if (position < 0 || position >= hits.total) return null
  const id = hits.ids ? hits.ids[position] : position
  return index.entries[id] ?? null
}
