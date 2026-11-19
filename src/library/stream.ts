import type { PreviewSlice, StreamedFile } from '../sounds/playStream'
import { streamCatalogSound } from '../sounds/playStream'
import { SoundCache, fetchSoundBytes, type ByteStore } from '../sounds/cache'
import { LibraryAuthError, readLibraryAccessKey, signLibraryKeys } from './access'
import { libraryAudioCache } from './audio'
import { libraryObjectKeyFromUrl, libraryObjectUrl } from './objectUrl'
import type { LibraryEntry } from './types'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

const signedUrls = new Map<string, { url: string; until: number }>()
const memoryBytes = new Map<string, ArrayBuffer>()

function librarySoundByteStore(): ByteStore {
  return {
    async get(url) {
      const mem = memoryBytes.get(url)
      if (mem) return mem.slice(0)
      const key = libraryObjectKeyFromUrl(url)
      if (!key) return null
      return libraryAudioCache().get(key).catch(() => null)
    },
    async put(url, bytes) {
      memoryBytes.set(url, bytes.slice(0))
      const key = libraryObjectKeyFromUrl(url)
      if (!key) return
      await libraryAudioCache().put(key, bytes).catch(() => undefined)
    },
    async delete(url) {
      memoryBytes.delete(url)
    },
  }
}

let soundCache: SoundCache | null = null

function cache() {
  return soundCache ?? (soundCache = new SoundCache([librarySoundByteStore()]))
}

/** Tests start without a remembered signature or a warm file. */
export function resetLibrarySoundMemory() {
  signedUrls.clear()
  memoryBytes.clear()
  soundCache = null
}

async function signedGetUrl(key: string, fetchImpl: FetchImpl) {
  const hit = signedUrls.get(key)
  if (hit && hit.until > Date.now()) return hit.url
  const accessKey = readLibraryAccessKey()
  if (!accessKey) throw new Error('Unlock My Library on this device first.')
  let signed: Awaited<ReturnType<typeof signLibraryKeys>>
  try {
    signed = await signLibraryKeys([key], accessKey, (input, init) => fetchImpl(String(input), init))
  } catch (error) {
    if (error instanceof LibraryAuthError) signedUrls.delete(key)
    throw error
  }
  const url = signed.urls.find((item) => item.key === key)?.url
  if (!url) throw new Error('Could not sign that sound.')
  const ttl = Math.min(Math.max(30, signed.expiresIn || 900), 600)
  signedUrls.set(key, { url, until: Date.now() + ttl * 1000 - 5000 })
  return url
}

async function libraryObjectFetch(input: string, init: RequestInit | undefined, fetchImpl: FetchImpl) {
  const key = libraryObjectKeyFromUrl(input)
  if (!key) return fetchImpl(input, init)
  const url = await signedGetUrl(key, fetchImpl)
  return fetchImpl(url, init)
}

/**
 * Download a passphrase-gated library file and decode it while the bytes arrive.
 * A cached copy skips the signature. The signed URL is not stored.
 */
export async function streamLibraryAsset(options: {
  entry: LibraryEntry
  toRate: number
  signal?: AbortSignal
  fetchImpl?: FetchImpl
  priority?: 'user' | 'prefetch'
  play?: boolean
  onSlice: (slice: PreviewSlice) => void
}): Promise<StreamedFile> {
  const fetchImpl = options.fetchImpl ?? fetch
  const cached = await libraryAudioCache().get(options.entry.key).catch(() => null)
  if (!cached && !readLibraryAccessKey()) throw new Error('Unlock My Library on this device first.')
  return streamCatalogSound({
    url: libraryObjectUrl(options.entry.key),
    toRate: options.toRate,
    totalBytes: options.entry.size > 0 ? options.entry.size : cached?.byteLength,
    signal: options.signal,
    fetchImpl: (input, init) => libraryObjectFetch(input, init, fetchImpl),
    cache: cache(),
    onSlice: options.onSlice,
    play: options.play,
    trusted: true,
    priority: options.priority,
    attempts: 1,
  })
}

/** Warm the first rows. A tap still has a free download slot. */
export async function prefetchLibrarySounds(entries: LibraryEntry[], fetchImpl?: FetchImpl, signal?: AbortSignal) {
  if (!entries.length || !readLibraryAccessKey()) return
  const missing: LibraryEntry[] = []
  for (const entry of entries) {
    const hit = await libraryAudioCache().get(entry.key).catch(() => null)
    if (!hit && !memoryBytes.has(libraryObjectUrl(entry.key))) missing.push(entry)
  }
  if (!missing.length) return
  const impl: FetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  try {
    const signed = await signLibraryKeys(missing.map((entry) => entry.key), readLibraryAccessKey(), (input, init) => impl(String(input), init))
    const ttl = Math.min(Math.max(30, signed.expiresIn || 900), 600)
    const until = Date.now() + ttl * 1000 - 5000
    for (const item of signed.urls) signedUrls.set(item.key, { url: item.url, until })
  } catch {
    return
  }
  await Promise.all(missing.map((entry) => fetchSoundBytes(libraryObjectUrl(entry.key), (input, init) => libraryObjectFetch(input, init, impl), cache(), {
    trusted: true,
    priority: 'prefetch',
    totalBytes: entry.size,
    attempts: 1,
    signal,
  }).catch(() => undefined)))
}

type PreviewEngine = {
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number, loop?: boolean) => void
  feedPreview?: (token: number, channels: Float32Array[], sampleRate: number, gain?: number) => boolean | void
  setPreviewGain?: (token: number, gain: number) => void
  continuePreviewLoop?: (token: number, channels: Float32Array[], sampleRate: number, gain?: number) => boolean | void
}

/**
 * Play a library row as soon as the buffered audio will outlast the rest of the download.
 * Loops keep looping once the whole file has been scheduled.
 */
export async function previewLibrarySound(options: {
  entry: LibraryEntry
  toRate: number
  token: number
  signal?: AbortSignal
  fetchImpl?: FetchImpl
  engine: PreviewEngine
  onStart?: () => void
}) {
  const loop = options.entry.type === 'loop'
  const engine = options.engine
  let started = false
  let level = 0.8
  const file = await streamLibraryAsset({
    entry: options.entry,
    toRate: options.toRate,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    play: Boolean(engine.feedPreview),
    onSlice: (slice) => {
      if (!engine.feedPreview || options.signal?.aborted) return
      const accepted = engine.feedPreview(options.token, slice.channels, slice.sampleRate, slice.gain)
      if (accepted === false) return
      level = slice.gain
      engine.setPreviewGain?.(options.token, slice.gain)
      if (started) return
      started = true
      options.onStart?.()
    },
  })
  if (options.signal?.aborted) return
  const matched = file.matched?.[0]?.length && file.matchedRate ? file.matched : null
  const channels = matched ?? file.channels
  const sampleRate = matched && file.matchedRate ? file.matchedRate : file.sampleRate
  if (!channels[0]?.length) throw new Error('That sound had no audio.')
  if (loop) {
    const looped = started && engine.continuePreviewLoop?.(options.token, channels, sampleRate, level)
    if (looped) return
    engine.stopPreview()
    engine.previewPcm(channels, sampleRate, true)
    if (!started) options.onStart?.()
    return
  }
  if (started) return
  engine.stopPreview()
  engine.previewPcm(channels, sampleRate, false)
  options.onStart?.()
}
