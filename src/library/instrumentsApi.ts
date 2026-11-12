import { LibraryAuthError, readLibraryAccessKey, signedUrlKeepsSecret } from './access'
import { planSignKeys, type InstrumentLayer, type InstrumentPage, type InstrumentQuery, type LibraryInstrument } from './group'
import { libraryAudioCache } from './audio'
import { setLibrarySampleLoader } from './samples'

export interface InstrumentNoteUrl {
  key: string
  url: string
}

async function libraryFetch(path: string, accessKey: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-library-key': accessKey, ...(init?.headers ?? {}) },
  })
  const body = await response.json().catch(() => null) as { error?: string } | null
  if (response.status === 401) {
    throw new LibraryAuthError(body?.error || 'That passphrase does not unlock the library.')
  }
  if (!response.ok) throw new Error(body?.error || 'Could not read the library instruments.')
  return body
}

export async function fetchLibraryInstruments(query: Partial<InstrumentQuery> = {}): Promise<InstrumentPage> {
  const accessKey = readLibraryAccessKey()
  if (!accessKey) throw new Error('Unlock My Library on this device first.')
  const params = new URLSearchParams()
  if (query.text) params.set('q', query.text)
  if (query.category) params.set('category', query.category)
  if (query.pack) params.set('pack', query.pack)
  params.set('offset', String(query.offset ?? 0))
  params.set('limit', String(query.limit ?? 200))
  const body = await libraryFetch(`/api/library/instruments?${params}`, accessKey)
  const page = body as Partial<InstrumentPage> | null
  if (!page || !Array.isArray(page.instruments)) throw new Error('Could not read the library instruments.')
  return {
    total: page.total ?? page.instruments.length,
    offset: page.offset ?? 0,
    limit: page.limit ?? page.instruments.length,
    instruments: page.instruments,
  }
}

/** Every instrument summary. The sample map stays on the server until one instrument is opened. */
export async function fetchAllLibraryInstruments(): Promise<InstrumentPage['instruments']> {
  const first = await fetchLibraryInstruments({ offset: 0, limit: 200 })
  const all = first.instruments.slice()
  let offset = first.instruments.length
  while (offset < first.total) {
    const page = await fetchLibraryInstruments({ offset, limit: 200 })
    if (!page.instruments.length) break
    all.push(...page.instruments)
    offset += page.instruments.length
  }
  return all
}

export async function fetchLibraryInstrument(id: string): Promise<LibraryInstrument> {
  const accessKey = readLibraryAccessKey()
  if (!accessKey) throw new Error('Unlock My Library on this device first.')
  const body = await libraryFetch(`/api/library/instruments/${encodeURIComponent(id)}`, accessKey) as Partial<LibraryInstrument> | null
  if (!body || body.id !== id || !Array.isArray(body.layers)) throw new Error('Could not read that instrument.')
  rememberInstrumentLayers(id, body.layers)
  return body as LibraryInstrument
}

const layerMaps = new Map<string, InstrumentLayer[]>()

/** Keep the map from the instrument that was just loaded, so playback can sign nearby notes. */
export function rememberInstrumentLayers(id: string, layers: InstrumentLayer[]) {
  layerMaps.set(id, layers)
}

export async function signInstrumentKeys(id: string, keys: string[]): Promise<InstrumentNoteUrl[]> {
  const accessKey = readLibraryAccessKey()
  if (!accessKey) throw new Error('Unlock My Library on this device first.')
  const body = await libraryFetch(`/api/library/instruments/${encodeURIComponent(id)}/notes`, accessKey, {
    method: 'POST',
    body: JSON.stringify({ keys }),
  }) as { urls?: InstrumentNoteUrl[] } | null
  return (body?.urls ?? []).filter((item) => item && typeof item.key === 'string' && typeof item.url === 'string' && signedUrlKeepsSecret(item.url, accessKey))
}

const waiting = new Map<string, Array<(bytes: ArrayBuffer) => void>>()
const failing = new Map<string, Array<(error: Error) => void>>()
const prefetching = new Set<string>()
let signTimer: ReturnType<typeof setTimeout> | null = null

function remember(id: string, key: string, resolve: (bytes: ArrayBuffer) => void, reject: (error: Error) => void, prefetch: boolean) {
  const token = `${id}\n${key}`
  const ok = waiting.get(token) ?? []
  ok.push(resolve)
  waiting.set(token, ok)
  const bad = failing.get(token) ?? []
  bad.push(reject)
  failing.set(token, bad)
  if (prefetch) prefetching.add(token)
  if (!signTimer) {
    signTimer = setTimeout(() => {
      signTimer = null
      void flushSignedSamples()
    }, 30)
  }
}

async function flushSignedSamples() {
  const tokens = [...waiting.keys()]
  const groups = new Map<string, { keys: string[]; prefetch: boolean }>()
  for (const token of tokens) {
    const split = token.indexOf('\n')
    const id = token.slice(0, split)
    const key = token.slice(split + 1)
    const group = groups.get(id) ?? { keys: [], prefetch: false }
    group.keys.push(key)
    if (prefetching.has(token)) group.prefetch = true
    groups.set(id, group)
  }
  for (const [id, group] of groups) {
    for (let index = 0; index < group.keys.length; index += 24) {
      const slice = group.keys.slice(index, index + 24)
      const planned = planSignKeys(layerMaps.get(id), slice, group.prefetch && index === 0)
      try {
        const signed = await signInstrumentKeys(id, planned)
        const cache = libraryAudioCache()
        await Promise.all(planned.map(async (key) => {
          const token = `${id}\n${key}`
          const ok = waiting.get(token) ?? []
          const bad = failing.get(token) ?? []
          waiting.delete(token)
          failing.delete(token)
          prefetching.delete(token)
          const url = signed.find((item) => item.key === key)?.url
          if (!url) {
            bad.forEach((reject) => reject(new Error('Could not sign that note.')))
            return
          }
          try {
            const response = await fetch(url)
            if (!response.ok) throw new Error('Could not download that note.')
            const bytes = await response.arrayBuffer()
            try { await cache.put(key, bytes) } catch { /* playback still has the bytes */ }
            ok.forEach((resolve) => resolve(bytes))
          } catch (error) {
            const message = error instanceof Error ? error : new Error('Could not download that note.')
            bad.forEach((reject) => reject(message))
          }
        }))
      } catch (error) {
        const message = error instanceof Error ? error : new Error('Could not sign that note.')
        for (const key of planned) {
          const token = `${id}\n${key}`
          const bad = failing.get(token) ?? []
          waiting.delete(token)
          failing.delete(token)
          prefetching.delete(token)
          bad.forEach((reject) => reject(message))
        }
      }
    }
  }
}

async function loadSignedSample(id: string, key: string, prefetch = false) {
  const cached = await libraryAudioCache().get(key).catch(() => null)
  if (cached) return cached
  return new Promise<ArrayBuffer>((resolve, reject) => remember(id, key, resolve, reject, prefetch))
}

setLibrarySampleLoader((id, key, prefetch) => loadSignedSample(id, key, prefetch))
