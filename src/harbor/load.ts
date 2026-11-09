import { selectLayers } from '../audio/multisample/map'
import { libraryFileUrl } from '../audio/multisample/source'
import type { SampleRef, SamplerProgram } from '../audio/multisample/types'
import { midiVelocity } from '../audio/multisample/types'
import { sampleLoadBegin, sampleLoadFinish, sampleLoadRatio } from '../audio/sampleLoadBus'
import { decodeWavPCM } from '../model/wav'
import { sha256Hex, type SoundCache } from '../sounds/cache'
import { absolutizeProgram } from '../audio/multisample/import'
import { importSfz } from '../audio/multisample/sfz'
import { instrumentCatalogUrl, instrumentLibraryBase, instrumentTreeUrl } from './contract'
import { programFromPaths, programLicense } from './program'
import { parseHarborCatalog } from './parse'
import { fillKeyboard } from './zones'
import type { CatalogInstrument, HarborCatalog } from './types'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

let catalogPromise: Promise<HarborCatalog> | null = null

export function instrumentFileUrl(path: string) {
  return libraryFileUrl(instrumentLibraryBase(), path)
}

function bytesOf(text: string) {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

/** The versioned catalog only. A missing file does not invent instruments. */
export async function loadHarborCatalog(fetchImpl: FetchLike = (input, init) => fetch(input, init), cache?: SoundCache): Promise<HarborCatalog> {
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

export function harborCatalog() {
  if (!catalogPromise) {
    catalogPromise = loadHarborCatalog().catch(() => ({ version: '', instruments: [], loops: [], entries: [] }))
  }
  return catalogPromise
}

export function rememberHarborCatalog(catalog: HarborCatalog) {
  catalogPromise = Promise.resolve(catalog)
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
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
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

export async function hashedZone(bytes: ArrayBuffer, expected?: string) {
  if (!expected) return true
  return (await sha256Hex(bytes)) === expected.toLowerCase()
}

async function readIncludes(presetUrl: string, text: string, fetchImpl: FetchLike, files: Map<string, string>, depth: number) {
  if (depth > 4) return
  const includes = [...text.matchAll(/#include\s+"([^"]+)"/gi)].map((match) => match[1])
  for (const include of includes) {
    if (files.has(include)) continue
    const url = new URL(include, presetUrl).toString()
    try {
      const response = await fetchImpl(url)
      if (!response.ok) continue
      const body = await response.text()
      files.set(include, body)
      await readIncludes(url, body, fetchImpl, files, depth + 1)
    } catch {
      /* a missing include leaves those zones out */
    }
  }
}

/** Audio files under one instrument folder. The listing is metadata, not the samples. */
export async function listInstrumentFiles(path: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
  const folder = path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/[^/]+\.(sfz|dspreset)$/i, '')
  const files: string[] = []
  let url: string | null = `${instrumentTreeUrl(folder)}?recursive=1&limit=1000`
  while (url) {
    const response = await fetchImpl(url)
    if (!response.ok) break
    const page = await response.json() as { type?: string; path?: string }[]
    for (const item of page) {
      if (item.type === 'file' && item.path && /\.(wav|flac|aif|aiff)$/i.test(item.path)) files.push(item.path)
    }
    const link = response.headers.get('Link') ?? ''
    const next = link.split(',').find((part) => part.includes('rel="next"'))
    url = next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')) : null
    if (files.length > 8000) break
  }
  return files
}

/** Build the multi-sample program for one catalog instrument. Samples stay on Hugging Face until a note plays. */
export async function prepareCatalogInstrument(instrument: CatalogInstrument, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
  if (/\.(sfz|dspreset)$/i.test(instrument.path)) {
    const url = instrumentFileUrl(instrument.path)
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`${instrument.name} is not on Hugging Face yet (${response.status})`)
    const text = await response.text()
    const files = new Map<string, string>()
    await readIncludes(url, text, fetchImpl, files, 0)
    const imported = importSfz(text, instrument.name, files)
    const absolute = absolutizeProgram(imported, url)
    return fillKeyboard({
      ...absolute,
      id: `harbor:${instrument.id}`,
      name: instrument.name,
      license: programLicense(instrument.license),
      author: instrument.source ?? '',
    })
  }
  const paths = await listInstrumentFiles(instrument.path, fetchImpl)
  return programFromPaths(instrument, paths)?.program ?? null
}
