export type SoundKind = 'one-shot' | 'loop' | 'instrument'

/** Drums is a browser filter over existing samples and kits, not a stored kind. */
export type SoundFilter = 'all' | SoundKind | 'drum'

/** One row of the public sound-library index. */
export interface SoundEntry {
  id: string
  path: string
  name: string
  type: SoundKind
  tags: string[]
  bpm?: number
  key?: string
  /** Evidenced note name, such as C1 on a kick. This is not a musical key. */
  pitch?: string
  durationSec: number
  sampleRate: number
  license: string
  source: string
  collection?: string
  category?: string
  sha256?: string
  bytes?: number
  pack?: string
  licenseClass?: string
  licenseNote?: string
  creator?: string
  attributionRequired?: boolean
  isContentAlias?: boolean
}

export interface CatalogResult {
  entries: SoundEntry[]
  /** `missing` means the index was not there or could not be read. */
  status: 'ok' | 'missing'
}

export interface SoundQuery {
  text: string
  type: SoundFilter
  /** `project` keeps tempos near the song, including half-time and double-time. */
  bpm: 'any' | 'project'
  /** Empty shows every key. */
  key: string
  favoritesOnly: boolean
  projectBpm: number
  favorites: string[]
  /** Empty shows every collection. */
  collection?: string
  /** Empty shows every category. */
  category?: string
}
