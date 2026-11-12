import { libraryFetch } from '../audio/multisample/cache'
import { selectLayers } from '../audio/multisample/map'
import { encodeLibraryPath, libraryFileUrl } from '../audio/multisample/source'
import type { SampleRef, SamplerProgram } from '../audio/multisample/types'
import { midiVelocity } from '../audio/multisample/types'
import { sampleLoadBegin, sampleLoadFinish, sampleLoadRatio } from '../audio/sampleLoadBus'
import { decodeWavPCM } from '../model/wav'
import { type SoundCache } from '../sounds/cache'
import { absolutizeProgram } from '../audio/multisample/import'
import { importSfz } from '../audio/multisample/sfz'
import { instrumentCatalogUrl, instrumentLibraryBase, instrumentTreeUrl } from './contract'
import { programFromPaths, programLicense } from './program'
import { parseHarborCatalog } from './parse'
import { datasetFilePath, reconcileProgram } from './reconcile'
import { fillKeyboard } from './zones'
import type { CatalogInstrument, HarborCatalog } from './types'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function instrumentFileUrl(path: string) {
  return libraryFileUrl(instrumentLibraryBase(), path)
}

function bytesOf(text: string) {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

/** The versioned catalog only. A missing file does not invent instruments. */
export async function loadHarborCatalog(fetchImpl: FetchLike = libraryFetch, cache?: SoundCache): Promise<HarborCatalog> {
  const url = instrumentCatalogUrl()
  try {
    const response = await fetchImpl(url, { cache: 'no-store' })
    if (response.ok) {
      const text = await response.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        return readCached(cache, url)
      }
      const catalog = parseHarborCatalog(json)
      if (catalog.entries.length && cache) {
        try { await cache.put(url, bytesOf(text)) } catch { /* the list still shows */ }
      }
      const ready = catalog.instruments.length + catalog.loops.length + catalog.entries.length
      return ready ? catalog : { version: catalog.version, instruments: [], loops: [], entries: [] }
    }
  } catch {
    /* the last cached catalog is the fallback */
  }
  return readCached(cache, url)
}

async function readCached(cache: SoundCache | undefined, url: string): Promise<HarborCatalog> {
  if (!cache) return { version: '', instruments: [], loops: [], entries: [] }
  try {
    const bytes = await cache.get(url)
    if (!bytes) return { version: '', instruments: [], loops: [], entries: [] }
    return parseHarborCatalog(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
  } catch {
    return { version: '', instruments: [], loops: [], entries: [] }
  }
}

export function rememberHarborCatalog(catalog: HarborCatalog) {
  return catalog
}

export function samplesForNote(program: SamplerProgram, note: number, velocity = 0.9): SampleRef[] {
  const midi = midiVelocity(velocity)
  const seen = new Set<string>()
  const samples: SampleRef[] = []
  for (const trigger of ['attack', 'release'] as const) {
    const mapped = selectLayers(program, {
      note,
      velocity: midi,
      keyswitch: program.defaultSwitch,
      roundRobin: {},
      trigger,
    })
    for (const layer of mapped.layers) {
      if (seen.has(layer.sample.id)) continue
      seen.add(layer.sample.id)
      samples.push(layer.sample)
    }
  }
  return samples
}

async function readBody(response: Response, onProgress?: (ratio: number) => void, totalHint = 0) {
  const total = Number(response.headers.get('content-length')) || totalHint
  if (!response.body) {
    const bytes = await response.arrayBuffer()
    onProgress?.(1)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    if (!step.value) continue
    chunks.push(step.value)
    received += step.value.byteLength
    if (total > 0) onProgress?.(Math.min(1, received / total))
  }
  const out = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  onProgress?.(1)
  return out.buffer
}

/** Download just the zones a note will play. Other roots stay on Hugging Face. */
export async function loadZoneSamples(
  samples: SampleRef[],
  fetchImpl: FetchLike = libraryFetch,
  cache?: SoundCache,
) {
  const loaded: { id: string; sampleRate: number; channels: Float32Array[] }[] = []
  for (const sample of samples) {
    if (!sample.url) continue
    sampleLoadBegin(sample.id)
    try {
      const cached = cache ? await cache.get(sample.url) : null
      const bytes = cached ?? await readBody(
        await fetchImpl(sample.url).then((response) => {
          if (!response.ok) throw new Error(`Could not download that zone (${response.status})`)
          return response
        }),
        (ratio) => sampleLoadRatio(sample.id, ratio),
        sample.byteLength,
      )
      const wav = decodeWavPCM(bytes)
      if (cache && !cached) {
        try { await cache.put(sample.url, bytes) } catch { /* playback still has the buffer */ }
      }
      sampleLoadRatio(sample.id, 1)
      loaded.push({ id: sample.id, sampleRate: wav.sampleRate, channels: wav.channels })
    } finally {
      sampleLoadFinish(sample.id)
    }
  }
  return loaded
}

/**
 * `#include` paths in this library are written from the root preset, even inside a nested map.
 * Try the file that contains the directive first, then the root preset, and fetch only a path
 * the dataset listing contains. An empty listing keeps the old request so a failed index
 * does not erase the instrument.
 */
async function readIncludes(
  presetUrl: string,
  rootUrl: string,
  text: string,
  fetchImpl: FetchLike,
  files: Map<string, string>,
  existing: Set<string> | null,
  depth: number,
) {
  if (depth > 4) return
  const includes = [...text.matchAll(/#include\s+"([^"]+)"/gi)].map((match) => match[1])
  for (const include of includes) {
    const key = include.replace(/\\/g, '/')
    if (files.has(include) || files.has(key)) continue
    const url = includeUrl(include, presetUrl, rootUrl, existing)
    if (!url) continue
    try {
      const response = await fetchImpl(url)
      if (!response.ok) continue
      const body = await response.text()
      files.set(include, body)
      if (key !== include) files.set(key, body)
      await readIncludes(url, rootUrl, body, fetchImpl, files, existing, depth + 1)
    } catch {
      /* a missing include leaves those zones out */
    }
  }
}

function includeUrl(include: string, presetUrl: string, rootUrl: string, existing: Set<string> | null) {
  const fromHere = resolvedDatasetPath(presetUrl, include)
  const fromRoot = resolvedDatasetPath(rootUrl, include)
  const listed = [fromHere, fromRoot].find((path) => path && existing?.has(path))
  if (listed) return libraryFileUrl(instrumentLibraryBase(), listed)
  if (existing && existing.size > 0) return ''
  try {
    return new URL(include.replace(/\\/g, '/'), presetUrl).toString()
  } catch {
    return ''
  }
}

function resolvedDatasetPath(baseFileUrl: string, relative: string) {
  try {
    const root = baseFileUrl.replace(/[^/]*$/, '')
    const clean = relative.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!clean || /^(https?:)?\/\//i.test(clean)) return ''
    return datasetFilePath(new URL(encodeLibraryPath(clean), root).toString())
  } catch {
    return ''
  }
}

/** `instruments/<id>` so a preset under Programs/ still sees the sibling sample folders. */
export function instrumentSampleRoot(path: string) {
  const clean = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const parts = clean.split('/').filter(Boolean)
  if (parts[0] === 'instruments' && parts[1]) return `${parts[0]}/${parts[1]}`
  return clean.replace(/\/[^/]+\.(sfz|dspreset)$/i, '')
}

/** Files under one instrument folder. The listing is metadata, not the samples. */
export async function listInstrumentFiles(path: string, fetchImpl: FetchLike = libraryFetch, audioOnly = true) {
  const folder = path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/[^/]+\.(sfz|dspreset)$/i, '')
  const files: string[] = []
  let url: string | null = `${instrumentTreeUrl(folder)}?recursive=1&limit=1000`
  const seen = new Set<string>()
  while (url && !seen.has(url)) {
    seen.add(url)
    const response = await fetchImpl(url)
    if (!response.ok) break
    const page = await response.json() as { type?: string; path?: string }[]
    if (!Array.isArray(page)) break
    for (const item of page) {
      if (item.type !== 'file' || !item.path) continue
      if (audioOnly && !/\.(wav|flac|aif|aiff)$/i.test(item.path)) continue
      files.push(item.path)
    }
    const link = response.headers.get('Link') ?? ''
    const next = link.split(',').find((part) => part.includes('rel="next"'))
    url = next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')) : null
    if (files.length > 8000) break
  }
  return files
}

/** Build the multi-sample program for one catalog instrument. Samples stay on Hugging Face until a note plays. */
export async function prepareCatalogInstrument(instrument: CatalogInstrument, fetchImpl: FetchLike = libraryFetch) {
  if (/\.(sfz|dspreset)$/i.test(instrument.path)) {
    const listed = await listInstrumentFiles(instrumentSampleRoot(instrument.path), fetchImpl, false)
    const existing = new Set(listed)
    const url = instrumentFileUrl(instrument.path)
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`${instrument.name} is not on Hugging Face yet (${response.status})`)
    const text = await response.text()
    const files = new Map<string, string>()
    await readIncludes(url, url, text, fetchImpl, files, existing, 0)
    const imported = importSfz(text, instrument.name, files)
    const absolute = absolutizeProgram(imported, url)
    const reconciled = existing.size ? reconcileProgram(absolute, listed) : absolute
    return fillKeyboard({
      ...reconciled,
      id: `harbor:${instrument.id}`,
      name: instrument.name,
      license: programLicense(instrument.license),
      author: instrument.source ?? '',
    })
  }
  const paths = await listInstrumentFiles(instrument.path, fetchImpl)
  const built = programFromPaths(instrument, paths)
  if (!built) return null
  const reconciled = paths.length ? reconcileProgram(built.program, paths) : built.program
  return fillKeyboard(reconciled)
}
