export type HarborKind = 'one-shot' | 'loop' | 'instrument'
export type LoopKind = 'drum' | 'melodic'

export const INSTRUMENT_FAMILIES = ['Strings', 'Brass', 'Woodwinds', 'Keys', 'Bass', 'Guitar', 'Mallets', 'World', 'Synth'] as const

export type InstrumentFamily = (typeof INSTRUMENT_FAMILIES)[number]

/** One catalog row. Zone and loop fields are optional so a partial row can still parse. */
export interface HarborEntry {
  id: string
  path: string
  name: string
  type: HarborKind
  tags: string[]
  bpm?: number
  key?: string
  bars?: number
  durationSec: number
  sampleRate: number
  license: string
  source: string
  pack?: string
  instrument?: string
  articulation?: string
  /** MIDI root. Absent on loops. */
  root?: number
  velLo?: number
  velHi?: number
  /** 1-based round-robin index. */
  roundRobin?: number
  loopKind?: LoopKind
  family?: InstrumentFamily
  release: boolean
  sha256?: string
  bytes?: number
  role?: string
  attributionRequired?: boolean
}

export interface CatalogInstrument {
  id: string
  name: string
  license: string
  path: string
  category?: string
  tags: string[]
  description?: string
  source?: string
  velocityLayers?: number
  roundRobins?: number
  releaseSamples?: number
  sampleCount?: number
  bytes?: number
  family: InstrumentFamily
}

export interface HarborCatalog {
  version: string
  instruments: CatalogInstrument[]
  loops: HarborEntry[]
  /** Sample rows, when a document lists them directly. The live catalog uses `instruments`. */
  entries: HarborEntry[]
}
