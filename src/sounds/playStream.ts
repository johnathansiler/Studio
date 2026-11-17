import { canStartGaplessPreview } from '../audio/previewSchedule'
import type { SoundCache } from './cache'
import { fetchSoundBytes, type FetchSoundOptions } from './cache'
import { RateStreamer, WavDecoder, peakOutline, type WavInfoReady } from './wavStream'

export interface StreamedFile {
  sampleRate: number
  channels: Float32Array[]
  /** Same sinc as playback, at `matchedRate`, without the preview fade. */
  matched?: Float32Array[]
  matchedRate?: number
  peaks: { min: number; max: number }[]
}

export interface PreviewSlice {
  channels: Float32Array[]
  sampleRate: number
  /** Normalize gain times the preview level. Edges are already faded. */
  gain: number
}

const NOTE_PEAK = 10 ** (-12 / 20)
const MAX_BOOST = 10 ** (18 / 20)
const PREVIEW_LEVEL = 0.8

const files = new Map<string, StreamedFile>()
const fileOrder: string[] = []
const inflight = new Map<string, Promise<StreamedFile>>()

export function rememberedFile(key: string) {
  if (!key) return null
  const hit = files.get(key)
  if (!hit) return null
  const rest = fileOrder.filter((item) => item !== key)
  fileOrder.splice(0, fileOrder.length, ...rest, key)
  return hit
}

export function rememberFile(key: string, file: StreamedFile) {
  if (!key || !file.channels[0]?.length) return
  files.set(key, file)
  const rest = fileOrder.filter((item) => item !== key)
  fileOrder.splice(0, fileOrder.length, ...rest, key)
  while (fileOrder.length > 4) {
    const drop = fileOrder.shift()
    if (drop) files.delete(drop)
  }
}

function previewGain(peak: number) {
  if (!(peak > 1e-8)) return PREVIEW_LEVEL
  return PREVIEW_LEVEL * Math.min(MAX_BOOST, NOTE_PEAK / peak)
}

function fadeEdges(channels: Float32Array[], fade: number, start: boolean, end: boolean) {
  if (fade < 2 || (!start && !end)) return channels
  return channels.map((channel) => {
    if (channel.length < 2) return channel
    if (start && end && channel.length < fade * 2) return channel
    const out = channel.slice()
    const span = Math.min(fade, channel.length)
    if (start) for (let i = 0; i < span; i++) out[i] *= i / span
    if (end) for (let i = 0; i < span; i++) out[out.length - 1 - i] *= i / span
    return out
  })
}

interface DecoderSession {
  push(chunk: Uint8Array): void
  finish(): void
  cancel(): void
  done: Promise<StreamedFile>
}

let shared: Worker | null | undefined
let nextId = 1

function sharedWorker() {
  if (shared !== undefined) return shared
  try {
    shared = typeof Worker === 'undefined' ? null : new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    shared = null
  }
  return shared
}

function openDecoder(toRate: number, onSlice: (channels: Float32Array[], sampleRate: number, final: boolean) => void): DecoderSession {
  const worker = sharedWorker()
  if (!worker) return mainDecoder(toRate, onSlice)
  const id = nextId++
  let settled = false
  let resolveDone: (file: StreamedFile) => void = () => undefined
  let rejectDone: (error: Error) => void = () => undefined
  const done = new Promise<StreamedFile>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const onMessage = (event: MessageEvent) => {
    const message = event.data as { id?: number; type?: string; channels?: Float32Array[]; matched?: Float32Array[]; matchedRate?: number; sampleRate?: number; final?: boolean; peaks?: { min: number; max: number }[]; message?: string }
    if (message?.id !== id) return
    if (message.type === 'slice' && message.channels && message.sampleRate) onSlice(message.channels, message.sampleRate, message.final === true)
    if (message.type === 'file' && message.channels && message.sampleRate) {
      cleanup()
      resolveDone({
        sampleRate: message.sampleRate,
        channels: message.channels,
        matched: message.matched,
        matchedRate: message.matchedRate,
        peaks: message.peaks ?? [],
      })
    }
    if (message.type === 'error') {
      cleanup()
      rejectDone(new Error(message.message || 'Could not read that sound.'))
    }
  }
  const cleanup = () => {
    if (settled) return
    settled = true
    worker.removeEventListener('message', onMessage)
  }
  worker.addEventListener('message', onMessage)
  worker.postMessage({ id, type: 'start', toRate })
  return {
    push(chunk) {
      const copy = chunk.byteLength ? chunk.slice() : new Uint8Array()
      worker.postMessage({ id, type: 'chunk', bytes: copy.buffer, done: false }, [copy.buffer])
    },
    finish() {
      worker.postMessage({ id, type: 'chunk', bytes: new ArrayBuffer(0), done: true })
    },
    cancel() {
      worker.postMessage({ id, type: 'cancel' })
      cleanup()
      rejectDone(new DOMException('The download was cancelled.', 'AbortError'))
    },
    done,
  }
}

function mainDecoder(toRate: number, onSlice: (channels: Float32Array[], sampleRate: number, final: boolean) => void): DecoderSession {
  const decoder = new WavDecoder()
  let rate: RateStreamer | null = null
  let info: WavInfoReady | null = null
  let held: Float32Array[] | null = null
  let resolveDone: (file: StreamedFile) => void = () => undefined
  let rejectDone: (error: Error) => void = () => undefined
  const done = new Promise<StreamedFile>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const hold = (slice: Float32Array[]) => {
    if (!held) {
      held = slice
      return
    }
    held = held.map((channel, index) => {
      const next = new Float32Array(channel.length + slice[index].length)
      next.set(channel)
      next.set(slice[index], channel.length)
      return next
    })
  }
  const flush = (sampleRate: number, final: boolean) => {
    if (!held?.[0]?.length) return
    const channels = held
    held = null
    onSlice(channels, sampleRate, final)
  }
  const pump = (finished: boolean) => {
    info = decoder.ready()
    if (!info) return
    if (!rate) rate = new RateStreamer(decoder.fileChannels, info.frames, info.sampleRate, toRate || info.sampleRate)
    const slice = rate.take(decoder.decodedFrames, info.frames)
    if (slice?.[0]?.length) hold(slice)
    const audioDone = decoder.decodedFrames >= info.frames
    const count = held?.[0]?.length ?? 0
    if (count >= 4096 || (audioDone && count > 0)) flush(toRate || info.sampleRate, audioDone)
    if (!finished) return
    const channels = decoder.fileChannels.map((channel) => channel.slice(0, decoder.decodedFrames))
    resolveDone({
      sampleRate: info.sampleRate,
      channels,
      matched: rate?.rateMatched(),
      matchedRate: toRate || info.sampleRate,
      peaks: peakOutline(channels[0] ?? new Float32Array(), 64),
    })
  }
  return {
    push(chunk) {
      if (chunk.byteLength) decoder.push(chunk)
      pump(false)
    },
    finish() {
      info = decoder.ready()
      if (!info || decoder.decodedFrames < info.frames) {
        rejectDone(new Error('That sound file could not be read.'))
        return
      }
      pump(true)
    },
    cancel() {
      rejectDone(new DOMException('The download was cancelled.', 'AbortError'))
    },
    done,
  }
}

/**
 * Download, or read the cached file, and play rate-matched audio.
 * Slices start only when the buffered audio outlasts the rest of the download
 * at the measured throughput. Otherwise the finished decode plays as one buffer.
 * A slice is never appended after silence.
 */
export async function streamCatalogSound(options: {
  url: string
  toRate: number
  sha256?: string
  totalBytes?: number
  signal?: AbortSignal
  fetchImpl?: FetchSoundOptions extends never ? never : (input: string, init?: RequestInit) => Promise<Response>
  cache?: SoundCache
  onSlice: (slice: PreviewSlice) => void
  /** False when the caller only needs the decoded file, for example Load during a preview. */
  play?: boolean
}): Promise<StreamedFile> {
  const key = options.sha256 || options.url
  const cached = rememberedFile(key)
  if (cached) {
    if (options.play !== false) replay(cached, options.toRate, options.onSlice)
    return cached
  }
  const pending = inflight.get(key)
  if (pending) {
    if (options.signal?.aborted) throw new DOMException('The download was cancelled.', 'AbortError')
    const file = await pending
    if (options.play !== false && !options.signal?.aborted) replay(file, options.toRate, options.onSlice)
    return file
  }
  const promise = streamCatalogSoundNow(options)
  inflight.set(key, promise)
  promise.then((file) => rememberFile(key, file), () => undefined).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  return promise
}

async function streamCatalogSoundNow(options: {
  url: string
  toRate: number
  sha256?: string
  totalBytes?: number
  signal?: AbortSignal
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  cache?: SoundCache
  onSlice: (slice: PreviewSlice) => void
}): Promise<StreamedFile> {
  let peak = 0
  let played = 0
  const pending: { channels: Float32Array[]; sampleRate: number; final: boolean }[] = []
  let received = 0
  let firstAt = 0
  const session = openDecoder(options.toRate, (channels, sampleRate, final) => {
    pending.push({ channels, sampleRate, final })
    consider()
  })
  const bufferedSeconds = () => {
    let samples = 0
    let rate = options.toRate || 48000
    for (const slice of pending) {
      samples += slice.channels[0]?.length ?? 0
      if (slice.sampleRate > 0) rate = slice.sampleRate
    }
    return samples / Math.max(1, rate)
  }
  const emitQueued = () => {
    if (!pending.length) return
    const batch = pending.splice(0, pending.length)
    let nextPeak = peak
    for (const slice of batch) {
      for (const channel of slice.channels) {
        for (let i = 0; i < channel.length; i++) {
          const sample = Math.abs(channel[i] || 0)
          if (sample > nextPeak) nextPeak = sample
        }
      }
    }
    peak = nextPeak
    const gain = previewGain(peak)
    const fade = Math.max(8, Math.round((batch[0].sampleRate || options.toRate || 48000) * 0.0015))
    batch.forEach((slice, index) => {
      const first = played === 0 && index === 0
      const last = slice.final
      played += slice.channels[0]?.length ?? 0
      options.onSlice({
        channels: fadeEdges(slice.channels, fade, first, last),
        sampleRate: slice.sampleRate,
        gain,
      })
    })
  }
  const consider = () => {
    if (played > 0) {
      emitQueued()
      return
    }
    const total = options.totalBytes ?? 0
    if (total > 0 && received >= total) return
    const elapsed = firstAt > 0 ? (performance.now() - firstAt) / 1000 : 0
    if (!canStartGaplessPreview({
      receivedBytes: received,
      totalBytes: total,
      elapsedSec: elapsed,
      bufferedSec: bufferedSeconds(),
    })) return
    emitQueued()
  }
  const note = (bytes: number) => {
    if (bytes <= 0) return
    if (!firstAt) firstAt = performance.now()
    received += bytes
  }
  const abort = () => session.cancel()
  options.signal?.addEventListener('abort', abort, { once: true })
  let streamed = false
  try {
    const bytes = await fetchSoundBytes(options.url, options.fetchImpl, options.cache, {
      sha256: options.sha256,
      totalBytes: options.totalBytes,
      signal: options.signal,
      onChunk: (chunk) => {
        streamed = true
        note(chunk.byteLength)
        session.push(chunk)
        consider()
      },
    })
    if (options.signal?.aborted) {
      session.cancel()
      throw new DOMException('The download was cancelled.', 'AbortError')
    }
    if (!streamed) {
      const view = new Uint8Array(bytes)
      note(view.byteLength)
      const first = Math.min(view.byteLength, 96 * 1024)
      if (first) session.push(view.subarray(0, first))
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (options.signal?.aborted) throw new DOMException('The download was cancelled.', 'AbortError')
      if (first < view.byteLength) session.push(view.subarray(first))
      consider()
    }
    session.finish()
    const file = await session.done
    rememberFile(options.sha256 || options.url, file)
    if (!played && file.channels[0]?.length) replay(file, options.toRate, options.onSlice)
    return file
  } catch (error) {
    session.cancel()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

function replay(file: StreamedFile, toRate: number, onSlice: (slice: PreviewSlice) => void) {
  const sampleRate = toRate || file.sampleRate
  const matched = file.matched?.[0]?.length && file.matchedRate === sampleRate ? file.matched : null
  const channels = matched ?? rateMatch(file, sampleRate)
  const lead = channels?.[0]
  if (!channels || !lead?.length) return
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.abs(channel[i] || 0)
      if (sample > peak) peak = sample
    }
  }
  const fadeAt = Math.max(8, Math.round(sampleRate * 0.0015))
  onSlice({ channels: fadeEdges(channels, fadeAt, true, true), sampleRate, gain: previewGain(peak) })
}

function rateMatch(file: StreamedFile, toRate: number) {
  const frames = file.channels[0]?.length ?? 0
  if (!frames) return null
  const rate = new RateStreamer(file.channels, frames, file.sampleRate, toRate || file.sampleRate)
  return rate.take(frames, frames)
}
