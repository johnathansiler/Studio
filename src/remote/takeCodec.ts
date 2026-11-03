/**
 * High-quality take audio for a Cloudflare relay.
 * Direct peers still move a lossless wav. A relay pair moves this compressed
 * payload on the same data channel, so the bytes stay off Render and show up
 * in the peer-connection stats the usage meter already reports.
 * Opus at 128–160 kbps when the browser can encode it, otherwise MP3 at 160.
 */

import { encodeMp3 } from '../audio/mp3'
import { linearResample } from '../model/wav'

export const TAKE_BITRATE_MIN = 128_000
export const TAKE_BITRATE_MAX = 160_000
export const TAKE_BITRATE = 160_000

export type TakeCodecId = 'opus' | 'mp3'

export interface EncodedTakeBytes {
  codec: TakeCodecId
  bitrate: number
  bytes: Uint8Array
}

export interface DecodedTake {
  channels: Float32Array[]
  sampleRate: number
}

export interface TakeAudioCodec {
  encode(channels: Float32Array[], sampleRate: number): Promise<EncodedTakeBytes | null>
  decode(bytes: Uint8Array): Promise<DecodedTake | null>
}

export interface EncoderSupport {
  webcodecsOpus?: boolean
  mediaRecorderOpus?: boolean
  mp3?: boolean
}

export interface EncoderChoice {
  id: TakeCodecId
  bitrate: number
  via: 'webcodecs' | 'media-recorder' | 'mp3'
}

/** Keep the relay copy inside the free-tier-friendly band. */
export function clampTakeBitrate(rate: number): number {
  if (!Number.isFinite(rate)) return TAKE_BITRATE
  return Math.min(TAKE_BITRATE_MAX, Math.max(TAKE_BITRATE_MIN, Math.round(rate)))
}

/** Opus first. MP3 is the encoder every browser in this app can run. */
export function chooseTakeEncoder(support: EncoderSupport): EncoderChoice | null {
  if (support.webcodecsOpus) return { id: 'opus', bitrate: TAKE_BITRATE, via: 'webcodecs' }
  if (support.mediaRecorderOpus) return { id: 'opus', bitrate: TAKE_BITRATE, via: 'media-recorder' }
  if (support.mp3 !== false) return { id: 'mp3', bitrate: TAKE_BITRATE, via: 'mp3' }
  return null
}

export function probeTakeEncoder(): EncoderSupport {
  const g = globalThis as {
    AudioEncoder?: unknown
    MediaRecorder?: { isTypeSupported?: (type: string) => boolean }
  }
  let mediaRecorderOpus = false
  try {
    mediaRecorderOpus = Boolean(g.MediaRecorder?.isTypeSupported?.('audio/webm;codecs=opus'))
  } catch {
    mediaRecorderOpus = false
  }
  return {
    webcodecsOpus: typeof g.AudioEncoder === 'function',
    mediaRecorderOpus,
    mp3: true,
  }
}

export function browserTakeCodec(): TakeAudioCodec {
  return {
    async encode(channels, sampleRate) {
      return encodeCompressedTake(channels, sampleRate)
    },
    decode(bytes) {
      return decodeCompressedTake(bytes)
    },
  }
}

/**
 * Deterministic stand-in used by tests. The wire codec is still Opus at 160 kbps.
 * Samples are scaled so a later wav upgrade is visibly different.
 */
export function testTakeCodec(scale = 0.5): TakeAudioCodec {
  return {
    async encode(channels, sampleRate) {
      if (!channels.length || !channels[0].length) return null
      const scaled = channels.map((channel) => {
        const out = new Float32Array(channel.length)
        for (let i = 0; i < channel.length; i++) out[i] = (channel[i] || 0) * scale
        return out
      })
      return {
        codec: 'opus',
        bitrate: TAKE_BITRATE,
        bytes: writeContainer({
          kind: KIND_TEST,
          channels: scaled.length,
          bitrate: TAKE_BITRATE,
          sampleRate,
          description: new Uint8Array(),
          frames: [{ type: 1, timestamp: 0, duration: scaled[0].length / sampleRate, bytes: interleave(scaled) }],
        }),
      }
    },
    async decode(bytes) {
      const container = readTakeContainer(bytes)
      if (!container || container.kind !== KIND_TEST || !container.frames.length) return null
      const channels = deinterleave(container.frames[0].bytes, container.channels)
      if (!channels.length || !channels[0].length) return null
      return { channels, sampleRate: container.sampleRate }
    },
  }
}

export async function encodeCompressedTake(
  channels: Float32Array[],
  sampleRate: number,
  support: EncoderSupport = probeTakeEncoder(),
): Promise<EncodedTakeBytes | null> {
  const choice = chooseTakeEncoder(support)
  if (!choice) return null
  const bitrate = clampTakeBitrate(choice.bitrate)
  if (choice.via === 'webcodecs') {
    const opus = await encodeOpusWebCodecs(channels, sampleRate, bitrate).catch(() => null)
    if (opus) return { codec: 'opus', bitrate, bytes: opus }
  }
  if (choice.id === 'opus' && (choice.via === 'media-recorder' || support.mediaRecorderOpus || choice.via === 'webcodecs')) {
    const webm = await encodeOpusMediaRecorder(channels, sampleRate, bitrate).catch(() => null)
    if (webm) return { codec: 'opus', bitrate, bytes: webm }
  }
  if (support.mp3 === false && choice.id !== 'mp3') return null
  const mp3 = encodeMp3Take(channels, sampleRate, bitrate)
  return mp3 ? { codec: 'mp3', bitrate, bytes: mp3 } : null
}

export async function decodeCompressedTake(bytes: Uint8Array): Promise<DecodedTake | null> {
  const container = readTakeContainer(bytes)
  if (!container || !container.frames.length) return null
  if (container.kind === KIND_OPUS) return decodeOpusWebCodecs(container)
  if (container.kind === KIND_MP3 || container.kind === KIND_WEBM) {
    const payload = container.frames.length === 1 ? container.frames[0].bytes : concat(container.frames.map((frame) => frame.bytes))
    return decodeWithAudioContext(payload, container.sampleRate)
  }
  return null
}

/** MP3 at 160 kbps. Bitrate is kbps for the lame wrapper, and the container records bits per second. */
export function encodeMp3Take(channels: Float32Array[], sampleRate: number, bitrate = TAKE_BITRATE): Uint8Array | null {
  if (!channels.length || !channels[0].length) return null
  const kbps = Math.round(clampTakeBitrate(bitrate) / 1000)
  const mp3 = encodeMp3(channels, sampleRate, { mode: 'cbr', bitrate: kbps, quality: 2 })
  if (!mp3.byteLength) return null
  const rate = sampleRate === 44100 ? 44100 : 48000
  return writeContainer({
    kind: KIND_MP3,
    channels: Math.min(2, channels.length),
    bitrate: clampTakeBitrate(bitrate),
    sampleRate: rate,
    description: new Uint8Array(),
    frames: [{ type: 1, timestamp: 0, duration: channels[0].length / sampleRate, bytes: mp3 }],
  })
}

export interface TakeContainer {
  kind: number
  channels: number
  bitrate: number
  sampleRate: number
  description: Uint8Array
  frames: { type: number; timestamp: number; duration: number; bytes: Uint8Array }[]
}

const KIND_OPUS = 1
const KIND_MP3 = 2
const KIND_WEBM = 3
const KIND_TEST = 9
const MAGIC = [0x43, 0x48, 0x43, 0x31]

export function readTakeContainer(bytes: Uint8Array): TakeContainer | null {
  if (bytes.byteLength < 20 || bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2] || bytes[3] !== MAGIC[3]) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = bytes[4]
  const channels = bytes[5]
  const bitrate = view.getUint32(6, true)
  const sampleRate = view.getUint32(10, true)
  const descLen = view.getUint16(14, true)
  if (!channels || channels > 8 || descLen > 4096 || 16 + descLen + 4 > bytes.byteLength) return null
  if (bitrate < TAKE_BITRATE_MIN || bitrate > TAKE_BITRATE_MAX) return null
  if (sampleRate < 8000 || sampleRate > 192000) return null
  const description = bytes.slice(16, 16 + descLen)
  let offset = 16 + descLen
  const frameCount = view.getUint32(offset, true)
  offset += 4
  if (frameCount < 1 || frameCount > 500_000) return null
  const frames: TakeContainer['frames'] = []
  for (let index = 0; index < frameCount; index++) {
    if (offset + 21 > bytes.byteLength) return null
    const type = bytes[offset]
    const timestamp = view.getFloat64(offset + 1, true)
    const duration = view.getFloat64(offset + 9, true)
    const size = view.getUint32(offset + 17, true)
    offset += 21
    if (size < 1 || offset + size > bytes.byteLength) return null
    frames.push({ type, timestamp, duration, bytes: bytes.slice(offset, offset + size) })
    offset += size
  }
  return { kind, channels, bitrate, sampleRate, description, frames }
}

function writeContainer(input: {
  kind: number
  channels: number
  bitrate: number
  sampleRate: number
  description: Uint8Array
  frames: { type: number; timestamp: number; duration: number; bytes: Uint8Array }[]
}): Uint8Array {
  const desc = input.description.byteLength > 4096 ? input.description.slice(0, 4096) : input.description
  let size = 20 + desc.byteLength
  for (const frame of input.frames) size += 21 + frame.bytes.byteLength
  const out = new Uint8Array(size)
  out.set(MAGIC, 0)
  const view = new DataView(out.buffer)
  out[4] = input.kind
  out[5] = input.channels
  view.setUint32(6, input.bitrate, true)
  view.setUint32(10, input.sampleRate, true)
  view.setUint16(14, desc.byteLength, true)
  out.set(desc, 16)
  let offset = 16 + desc.byteLength
  view.setUint32(offset, input.frames.length, true)
  offset += 4
  for (const frame of input.frames) {
    out[offset] = frame.type ? 1 : 0
    view.setFloat64(offset + 1, frame.timestamp, true)
    view.setFloat64(offset + 9, frame.duration, true)
    view.setUint32(offset + 17, frame.bytes.byteLength, true)
    offset += 21
    out.set(frame.bytes, offset)
    offset += frame.bytes.byteLength
  }
  return out
}

async function encodeOpusWebCodecs(channels: Float32Array[], sampleRate: number, bitrate: number): Promise<Uint8Array | null> {
  const prepared = atRate(channels, sampleRate, 48000)
  if (!prepared) return null
  const g = globalThis as unknown as WebCodecHost
  if (typeof g.AudioEncoder !== 'function' || typeof g.AudioData !== 'function') return null
  const supported = await g.AudioEncoder.isConfigSupported?.({
    codec: 'opus',
    sampleRate: 48000,
    numberOfChannels: prepared.channels.length,
    bitrate,
  }).catch(() => ({ supported: false }))
  if (supported && supported.supported === false) return null
  const frames: TakeContainer['frames'] = []
  let description = new Uint8Array()
  let failed: unknown = null
  const encoder = new g.AudioEncoder({
    output: (chunk, meta) => {
      const bytes = new Uint8Array(chunk.byteLength)
      chunk.copyTo(bytes)
      const desc = sourceBytes(meta?.decoderConfig?.description)
      if (desc.byteLength && !description.byteLength) description = desc.slice()
      frames.push({
        type: chunk.type === 'key' ? 1 : 0,
        timestamp: chunk.timestamp / 1_000_000,
        duration: (chunk.duration || 0) / 1_000_000,
        bytes,
      })
    },
    error: (error) => {
      failed = error
    },
  })
  try {
    encoder.configure({
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: prepared.channels.length,
      bitrate,
    })
    const frame = 960
    const length = prepared.channels[0].length
    for (let offset = 0; offset < length; offset += frame) {
      const planar = new Float32Array(frame * prepared.channels.length)
      let write = 0
      for (const channel of prepared.channels) {
        const slice = channel.subarray(offset, Math.min(length, offset + frame))
        planar.set(slice, write)
        write += frame
      }
      const data = new g.AudioData({
        format: 'f32-planar',
        sampleRate: 48000,
        numberOfFrames: frame,
        numberOfChannels: prepared.channels.length,
        timestamp: Math.round((offset / 48000) * 1_000_000),
        data: planar,
      })
      encoder.encode(data)
      data.close()
    }
    await encoder.flush()
  } catch {
    return null
  } finally {
    try { encoder.close() } catch { /* already closed */ }
  }
  if (failed || !frames.length) return null
  return writeContainer({
    kind: KIND_OPUS,
    channels: prepared.channels.length,
    bitrate,
    sampleRate: 48000,
    description,
    frames,
  })
}

async function decodeOpusWebCodecs(container: TakeContainer): Promise<DecodedTake | null> {
  const g = globalThis as unknown as WebCodecHost
  if (typeof g.AudioDecoder !== 'function' || typeof g.EncodedAudioChunk !== 'function') return null
  const planes: Float32Array[][] = []
  let failed: unknown = null
  const decoder = new g.AudioDecoder({
    output: (audio) => {
      planes.push(copyPlanes(audio))
      audio.close()
    },
    error: (error) => {
      failed = error
    },
  })
  try {
    decoder.configure({
      codec: 'opus',
      sampleRate: container.sampleRate,
      numberOfChannels: container.channels,
      description: container.description.byteLength ? container.description.slice() : undefined,
    })
    for (const frame of container.frames) {
      decoder.decode(new g.EncodedAudioChunk({
        type: frame.type ? 'key' : 'delta',
        timestamp: Math.round(frame.timestamp * 1_000_000),
        duration: Math.round(frame.duration * 1_000_000),
        data: frame.bytes.slice(),
      }))
    }
    await decoder.flush()
  } catch {
    return null
  } finally {
    try { decoder.close() } catch { /* already closed */ }
  }
  if (failed || !planes.length) return null
  return { channels: joinPlanes(planes, container.channels), sampleRate: container.sampleRate }
}

async function encodeOpusMediaRecorder(channels: Float32Array[], sampleRate: number, bitrate: number): Promise<Uint8Array | null> {
  const prepared = atRate(channels, sampleRate, 48000)
  const g = globalThis as unknown as {
    AudioContext?: typeof AudioContext
    MediaRecorder?: typeof MediaRecorder
  }
  if (!prepared || typeof g.AudioContext !== 'function' || typeof g.MediaRecorder !== 'function') return null
  let mime = ''
  try {
    if (g.MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus'
    else if (g.MediaRecorder.isTypeSupported?.('audio/ogg;codecs=opus')) mime = 'audio/ogg;codecs=opus'
  } catch {
    mime = ''
  }
  if (!mime) return null
  const ctx = new g.AudioContext({ sampleRate: 48000 })
  try {
    const buffer = ctx.createBuffer(prepared.channels.length, prepared.channels[0].length, 48000)
    prepared.channels.forEach((channel, index) => {
      const copy = new Float32Array(channel.length)
      copy.set(channel)
      buffer.copyToChannel(copy, index)
    })
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const dest = ctx.createMediaStreamDestination()
    source.connect(dest)
    const recorder = new g.MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: bitrate })
    const parts: Blob[] = []
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve()
      recorder.onerror = () => reject(new Error('recorder'))
    })
    recorder.ondataavailable = (event) => {
      if (event.data.size) parts.push(event.data)
    }
    recorder.start()
    const ended = new Promise<void>((resolve) => {
      source.onended = () => resolve()
    })
    source.start()
    await ended
    recorder.stop()
    await stopped
    const blob = new Blob(parts, { type: mime })
    const raw = new Uint8Array(await blob.arrayBuffer())
    if (!raw.byteLength) return null
    return writeContainer({
      kind: KIND_WEBM,
      channels: prepared.channels.length,
      bitrate,
      sampleRate: 48000,
      description: new Uint8Array(),
      frames: [{ type: 1, timestamp: 0, duration: prepared.channels[0].length / 48000, bytes: raw }],
    })
  } catch {
    return null
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

async function decodeWithAudioContext(payload: Uint8Array, fallbackRate: number): Promise<DecodedTake | null> {
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
  if (typeof Ctx !== 'function' || !payload.byteLength) return null
  const ctx = new Ctx()
  try {
    const decoded = await ctx.decodeAudioData(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer)
    const channels: Float32Array[] = []
    for (let index = 0; index < decoded.numberOfChannels; index++) channels.push(decoded.getChannelData(index).slice())
    if (!channels.length) return null
    return { channels, sampleRate: decoded.sampleRate || fallbackRate }
  } catch {
    return null
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

function atRate(channels: Float32Array[], fromRate: number, toRate: number): { channels: Float32Array[] } | null {
  const count = Math.min(2, channels.length)
  if (!count || !channels[0].length) return null
  const length = channels[0].length
  const used = channels.slice(0, count).map((channel) => (channel.length === length ? channel : channel.subarray(0, length)))
  const rate = fromRate > 0 ? fromRate : toRate
  return { channels: used.map((channel) => (rate === toRate ? channel : linearResample(channel, rate, toRate))) }
}

function copyPlanes(audio: AudioDataLike): Float32Array[] {
  const out: Float32Array[] = []
  for (let plane = 0; plane < audio.numberOfChannels; plane++) {
    const samples = new Float32Array(audio.numberOfFrames)
    try {
      audio.copyTo(samples, { planeIndex: plane, format: 'f32-planar' })
    } catch {
      audio.copyTo(samples, { planeIndex: plane })
    }
    out.push(samples)
  }
  return out
}

function joinPlanes(groups: Float32Array[][], channels: number): Float32Array[] {
  const lengths = groups.map((group) => group[0]?.length || 0)
  const total = lengths.reduce((sum, size) => sum + size, 0)
  const out = Array.from({ length: channels }, () => new Float32Array(total))
  let offset = 0
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    const size = lengths[index]
    for (let channel = 0; channel < channels; channel++) {
      const source = group[channel]
      if (source) out[channel].set(source.subarray(0, size), offset)
    }
    offset += size
  }
  return out
}

function interleave(channels: Float32Array[]): Uint8Array {
  const length = channels[0]?.length || 0
  const out = new Uint8Array(length * channels.length * 4)
  const view = new DataView(out.buffer)
  let offset = 0
  for (let index = 0; index < length; index++) {
    for (const channel of channels) {
      view.setFloat32(offset, channel[index] || 0, true)
      offset += 4
    }
  }
  return out
}

function deinterleave(bytes: Uint8Array, channels: number): Float32Array[] {
  if (!channels) return []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frames = Math.floor(bytes.byteLength / (4 * channels))
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  let offset = 0
  for (let index = 0; index < frames; index++) {
    for (let channel = 0; channel < channels; channel++) {
      out[channel][index] = view.getFloat32(offset, true)
      offset += 4
    }
  }
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function sourceBytes(source: BufferSource | undefined): Uint8Array {
  if (!source) return new Uint8Array()
  const view = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  return copy
}

interface AudioDataLike {
  numberOfChannels: number
  numberOfFrames: number
  close(): void
  copyTo(destination: Float32Array, options: { planeIndex: number; format?: string }): void
}

interface WebCodecHost {
  AudioEncoder: {
    new (init: {
      output: (chunk: { type: string; timestamp: number; duration: number | null; byteLength: number; copyTo: (dest: Uint8Array) => void }, meta?: { decoderConfig?: { description?: BufferSource } }) => void
      error: (error: DOMException) => void
    }): {
      configure(config: { codec: string; sampleRate: number; numberOfChannels: number; bitrate: number }): void
      encode(data: { close(): void }): void
      flush(): Promise<void>
      close(): void
    }
    isConfigSupported?: (config: { codec: string; sampleRate: number; numberOfChannels: number; bitrate: number }) => Promise<{ supported?: boolean }>
  }
  AudioDecoder: {
    new (init: {
      output: (audio: AudioDataLike) => void
      error: (error: DOMException) => void
    }): {
      configure(config: { codec: string; sampleRate: number; numberOfChannels: number; description?: BufferSource }): void
      decode(chunk: unknown): void
      flush(): Promise<void>
      close(): void
    }
  }
  AudioData: new (init: {
    format: 'f32-planar'
    sampleRate: number
    numberOfFrames: number
    numberOfChannels: number
    timestamp: number
    data: Float32Array
  }) => { close(): void }
  EncodedAudioChunk: new (init: { type: 'key' | 'delta'; timestamp: number; duration?: number; data: Uint8Array }) => unknown
}
