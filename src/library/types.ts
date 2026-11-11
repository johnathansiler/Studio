/** One private-library row. `search` is kept only while the index is built. */
export interface LibraryEntry {
  key: string
  size: number
  format: string
  pack: string
  type: string
  category: string
  instrument: string
  genre: string[]
  bpm: number | null
  bpmAlt: number | null
  musicalKey: string
  root: string
  note: string
  mood: string[]
  tags: string[]
  license: string
  name: string
}

export interface LibraryDocument {
  version: number
  generatedAt: string
  count: number
  pending: string
  entries: LibraryEntry[]
}

export interface LibraryQuery {
  text: string
  type: string
  category: string
  instrument: string
  genre: string
  musicalKey: string
  mood: string
  pack: string
  bpmMin: number | null
  bpmMax: number | null
}

export interface LibraryFacets {
  types: string[]
  categories: string[]
  instruments: string[]
  genres: string[]
  keys: string[]
  moods: string[]
  packs: string[]
}

export const EMPTY_LIBRARY_QUERY: LibraryQuery = {
  text: '',
  type: '',
  category: '',
  instrument: '',
  genre: '',
  musicalKey: '',
  mood: '',
  pack: '',
  bpmMin: null,
  bpmMax: null,
}
