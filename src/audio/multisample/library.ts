import { absolutizeProgram, importInstrument, type ImportedInstrument } from './import'
import { libraryFileUrl, resolveSampleUrl } from './source'
import type { SampleLicense, SamplerProgram } from './types'

export interface LibraryEntry {
  id: string
  name: string
  license: SampleLicense
  /** Path inside the dataset, for example `upright-piano/instrument.dspreset`. */
  path: string
  bytes: number
  description: string
}

/**
 * Metadata only. The dataset is not created here; each instrument is fetched
 * on its own when someone picks it. Samples stay on Hugging Face and load per note.
 */
export const STARTER_CATALOG: LibraryEntry[] = [
  {
    id: 'upright-piano',
    name: 'Upright Piano',
    license: 'CC0-1.0',
    path: 'upright-piano/instrument.dspreset',
    bytes: 0,
    description: 'CC0 Knight upright piano (VCSL): 45 sampled notes, 2 velocity layers, release samples',
  },
  {
    id: 'string-section',
    name: 'String Section',
    license: 'CC0-1.0',
    path: 'string-section/instrument.sfz',
    bytes: 0,
    description: 'CC0 VSCO-2 string ensemble: contrabass, celli, violas and violins (sustain vibrato) split across the keyboard',
  },
  {
    id: 'nylon-guitar',
    name: 'Nylon Guitar',
    license: 'CC0-1.0',
    path: 'nylon-guitar/instrument.dspreset',
    bytes: 0,
    description: 'CC0 Spanish classical (nylon) guitar from FreePats, chromatic',
  },
  {
    id: 'felt-piano',
    name: 'Felt Piano',
    license: 'public-domain',
    path: 'felt-piano/instrument.sfz',
    bytes: 0,
    description: 'Public-domain Fuchs & Möhr upright with felt (Tom Guder): every key, 3 velocity layers',
  },
]

const LICENSES = new Set<SampleLicense>(['CC0-1.0', 'Unlicense', 'public-domain'])

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>

/** `catalog.json` at the dataset root. A missing file keeps the built-in list. */
export async function fetchCatalog(base: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<LibraryEntry[]> {
  const url = libraryFileUrl(base, 'catalog.json')
  try {
    const response = await fetchImpl(url)
    if (!response.ok) return STARTER_CATALOG.map((entry) => ({ ...entry }))
    const body = (await response.json()) as { instruments?: unknown }
    const parsed = parseCatalog(body?.instruments)
    return parsed.length ? parsed : STARTER_CATALOG.map((entry) => ({ ...entry }))
  } catch {
    return STARTER_CATALOG.map((entry) => ({ ...entry }))
  }
}

/**
 * Download one instrument preset. Sample files are not fetched here;
 * the engine requests each zone the first time it is played.
 */
export async function fetchInstrument(base: string, entry: LibraryEntry, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<ImportedInstrument> {
  if (!LICENSES.has(entry.license)) throw new Error('Starter instruments must be CC0, public domain, or Unlicense')
  const url = libraryFileUrl(base, entry.path)
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`${entry.name} is not on Hugging Face yet (${response.status})`)
  const bytes = await response.arrayBuffer()
  const imported = importInstrument(entry.path, bytes)
  return {
    program: named(absolutizeProgram(imported.program, url), entry),
    programs: imported.programs.map((program) => named(absolutizeProgram(program, url), entry)),
    pack: imported.pack,
  }
}

export function presetUrl(base: string, entry: LibraryEntry) {
  return libraryFileUrl(base, entry.path)
}

export function sampleUrl(preset: string, samplePath: string) {
  return resolveSampleUrl(preset, samplePath)
}

function named(program: SamplerProgram, entry: LibraryEntry): SamplerProgram {
  return { ...program, name: program.name || entry.name, license: entry.license }
}

function parseCatalog(value: unknown): LibraryEntry[] {
  if (!Array.isArray(value)) return []
  const entries: LibraryEntry[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const row = item as Partial<LibraryEntry>
    if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.path !== 'string') continue
    if (!LICENSES.has(row.license as SampleLicense)) continue
    if (row.path.includes('..') || row.path.startsWith('/')) continue
    entries.push({
      id: row.id,
      name: row.name,
      license: row.license as SampleLicense,
      path: row.path,
      bytes: typeof row.bytes === 'number' ? row.bytes : 0,
      description: typeof row.description === 'string' ? row.description : '',
    })
  }
  return entries
}
