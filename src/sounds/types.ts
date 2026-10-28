export type SoundKind = 'one-shot' | 'loop' | 'instrument'

/** One row of the public sound-library index. */
export interface SoundEntry {
  id: string
  path: string
  name: string
  type: SoundKind
  tags: string[]
  bpm?: number
  key?: string
  durationSec: number
  sampleRate: number
  license: string
  source: string
}

export interface CatalogResult {
  entries: SoundEntry[]
  /** `missing` means the index was not there or could not be read. */
  status: 'ok' | 'missing'
}

export interface SoundQuery {
  text: string
  type: 'all' | SoundKind
  /** `project` keeps tempos near the song, including half-time and double-time. */
  bpm: 'any' | 'project'
  /** Empty shows every key. */
  key: string
  favoritesOnly: boolean
  projectBpm: number
  favorites: string[]
}
