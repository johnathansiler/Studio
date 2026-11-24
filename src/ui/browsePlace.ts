import type { DrumSub, FastSort } from '../library/fastBrowse'
import { EMPTY_LIBRARY_QUERY, type LibraryQuery } from '../library/types'
import type { BrowseRow } from '../library/browse'

export const BROWSE_PLACE_KEY = 'cueharbor-browse-place'

export type BrowsePlaceTab = 'library' | 'patterns' | 'clips'

export interface BrowsePlace {
  tab: BrowsePlaceTab
  libraryText: string
  libraryGroup: string
  libraryQuery: LibraryQuery
  /** Last auditioned or loaded row. Reopen scrolls this id into view. */
  libraryFocus: string
  /** First visible row when the list was last scrolled. */
  libraryAnchor: string
  /** Recent or Favorites quick filter. Empty shows the whole library. */
  libraryQuick: '' | 'recent' | 'favorites'
  patternText: string
  patternFocus: string
  clipText: string
  clipFocus: string
  /** Last drum shelf in the one-shot browser. Empty is every shelf. */
  drumCategory: string
  drumSub: DrumSub | ''
  /** Last loop shelf, genre chip, and sort. */
  loopCategory: string
  loopGenre: string
  loopSort: FastSort
  /** Section ids the person closed. */
  collapsedSections: string[]
  /** Beat Machine pad browser, kept apart from the Arrange library. */
  padText: string
  padCategory: string
  padSub: DrumSub | ''
  padAnchor: string
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

const GROUPS = new Set(['type', 'category', 'instrument', 'genre', 'key', 'bpm', 'mood', 'pack'])

export function emptyBrowsePlace(): BrowsePlace {
  return {
    tab: 'library',
    libraryText: '',
    libraryGroup: 'type',
    libraryQuery: { ...EMPTY_LIBRARY_QUERY },
    libraryFocus: '',
    libraryAnchor: '',
    libraryQuick: '',
    patternText: '',
    patternFocus: '',
    clipText: '',
    clipFocus: '',
    drumCategory: '',
    drumSub: '',
    loopCategory: '',
    loopGenre: '',
    loopSort: 'name',
    collapsedSections: [],
    padText: '',
    padCategory: '',
    padSub: '',
    padAnchor: '',
  }
}

export function browseRowId(row: BrowseRow) {
  return row.kind === 'instrument' ? `instrument:${row.instrument.id}` : `sound:${row.entry.key}`
}

/** Index of a saved row id. -1 when that item is not in the current list. */
export function browseIndexForId(ids: readonly string[], id: string) {
  if (!id) return -1
  return ids.indexOf(id)
}

/** Scroll offset that puts `index` at the top of a fixed-height virtual list. */
export function scrollTopForIndex(index: number, rowHeight: number) {
  if (index <= 0 || rowHeight <= 0) return 0
  return index * rowHeight
}

export function readBrowsePlace(storage: Store | null = defaultStorage()): BrowsePlace {
  const empty = emptyBrowsePlace()
  const raw = storage?.getItem(BROWSE_PLACE_KEY) ?? ''
  if (!raw) return empty
  try {
    const parsed = JSON.parse(raw) as Partial<BrowsePlace>
    const tab = parsed.tab === 'patterns' || parsed.tab === 'clips' || parsed.tab === 'library' ? parsed.tab : 'library'
    const group = typeof parsed.libraryGroup === 'string' && GROUPS.has(parsed.libraryGroup) ? parsed.libraryGroup : 'type'
    return {
      ...empty,
      ...parsed,
      tab,
      libraryGroup: group,
      libraryQuery: { ...EMPTY_LIBRARY_QUERY, ...(parsed.libraryQuery ?? {}) },
      libraryText: typeof parsed.libraryText === 'string' ? parsed.libraryText : '',
      libraryFocus: typeof parsed.libraryFocus === 'string' ? parsed.libraryFocus : '',
      libraryAnchor: typeof parsed.libraryAnchor === 'string' ? parsed.libraryAnchor : '',
      libraryQuick: parsed.libraryQuick === 'recent' || parsed.libraryQuick === 'favorites' ? parsed.libraryQuick : '',
      patternText: typeof parsed.patternText === 'string' ? parsed.patternText : '',
      patternFocus: typeof parsed.patternFocus === 'string' ? parsed.patternFocus : '',
      clipText: typeof parsed.clipText === 'string' ? parsed.clipText : '',
      clipFocus: typeof parsed.clipFocus === 'string' ? parsed.clipFocus : '',
      drumCategory: typeof parsed.drumCategory === 'string' ? parsed.drumCategory : '',
      drumSub: parsed.drumSub === 'closed' || parsed.drumSub === 'open' || parsed.drumSub === 'crash' || parsed.drumSub === 'ride' ? parsed.drumSub : '',
      loopCategory: typeof parsed.loopCategory === 'string' ? parsed.loopCategory : '',
      loopGenre: typeof parsed.loopGenre === 'string' ? parsed.loopGenre : '',
      loopSort: parsed.loopSort === 'bpm' || parsed.loopSort === 'key' || parsed.loopSort === 'name' ? parsed.loopSort : 'name',
      collapsedSections: Array.isArray(parsed.collapsedSections) ? parsed.collapsedSections.filter((item) => typeof item === 'string') : [],
      padText: typeof parsed.padText === 'string' ? parsed.padText : '',
      padCategory: typeof parsed.padCategory === 'string' ? parsed.padCategory : '',
      padSub: parsed.padSub === 'closed' || parsed.padSub === 'open' || parsed.padSub === 'crash' || parsed.padSub === 'ride' ? parsed.padSub : '',
      padAnchor: typeof parsed.padAnchor === 'string' ? parsed.padAnchor : '',
    }
  } catch {
    return empty
  }
}

export function writeBrowsePlace(patch: Partial<BrowsePlace>, storage: Store | null = defaultStorage()) {
  const next = { ...readBrowsePlace(storage), ...patch }
  if (patch.libraryQuery) next.libraryQuery = { ...EMPTY_LIBRARY_QUERY, ...patch.libraryQuery }
  try { storage?.setItem(BROWSE_PLACE_KEY, JSON.stringify(next)) } catch { /* the open panel still holds it */ }
  return next
}

function defaultStorage(): Store | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}
