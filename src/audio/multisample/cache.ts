import { decodeWavPCM } from '../../model/wav'
import type { DecodedSample, SampleFormat, SamplePack, SampleRef } from './types'
import { assertHuggingFaceUrl } from './source'
import { packStream, STREAM_FRAMES, viewStream, type SampleStream } from './stream'

export interface SampleBank {
  get(sample: SampleRef): DecodedSample | null
  request(sample: SampleRef): void
}

export class MemoryBank implements SampleBank {
  constructor(private readonly samples = new Map<string, DecodedSample>()) {}

  get(sample: SampleRef) {
    return this.samples.get(sample.id) ?? null
  }

  request(_sample: SampleRef) {}

  put(id: string, sample: DecodedSample) {
    this.samples.set(id, sample)
  }
}

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>

/**
 * Decodes a sample the first time a voice asks for it.
 * Packed fonts decode one zone. Remote files are fetched one URL at a time.
 */
export class SampleCache implements SampleBank {
  private readonly decoded = new Map<string, DecodedSample>()
  private readonly views = new Map<string, DecodedSample>()
  private readonly streams = new Map<string, SampleStream>()
  private readonly packs = new Map<string, SamplePack>()
  private readonly inflight = new Map<string, Promise<DecodedSample | null>>()
  private readonly order: string[] = []
  private bytes = 0

  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    readonly maxBytes = 256 * 1024 * 1024,
  ) {}

  get(sample: SampleRef) {
    const hit = this.decoded.get(sample.id)
    if (hit) return hit
    if (this.views.has(sample.id)) return null
    if (sample.packId && this.packs.has(sample.packId)) {
      if ((sample.frameCount || 0) > STREAM_FRAMES) return null
      const made = decodePacked(this.packs.get(sample.packId)!, sample)
      this.remember(sample.id, made)
      return made
    }
    return null
  }

  /**
   * Long samples page from the pack or the caller's buffer.
   * Short samples return null here and play from get().
   */
  stream(sample: SampleRef): SampleStream | null {
    const existing = this.streams.get(sample.id)
    if (existing) return existing
    const view = this.views.get(sample.id)
    if (view) {
      const made = viewStream(view)
      this.streams.set(sample.id, made)
      return made
    }
    if (sample.packId && (sample.frameCount || 0) > STREAM_FRAMES && this.packs.has(sample.packId)) {
      const pack = this.packs.get(sample.packId)!
      const made = packStream(sample, pack.id, (start, count) => decodePackedRange(pack, sample, start, count).channels)
      this.streams.set(sample.id, made)
      return made
    }
    return null
  }

  request(sample: SampleRef) {
    if (this.get(sample) || this.views.has(sample.id)) return
    if (sample.packId && this.packs.has(sample.packId)) return
    if (!sample.url || this.inflight.has(sample.id)) return
    const task = this.load(sample).catch(() => null)
    this.inflight.set(sample.id, task)
    void task.finally(() => {
      if (this.inflight.get(sample.id) === task) this.inflight.delete(sample.id)
    })
  }

  async load(sample: SampleRef): Promise<DecodedSample | null> {
    const ready = this.get(sample) ?? this.views.get(sample.id)
    if (ready) return ready
    if (!sample.url) return null
    assertHuggingFaceUrl(sample.url)
    const headers: Record<string, string> = {}
    const ranged = sample.format !== 'wav' && sample.byteOffset != null && sample.byteLength != null && sample.byteLength > 0
    if (ranged) headers.Range = `bytes=${sample.byteOffset}-${sample.byteOffset! + sample.byteLength! - 1}`
    const response = await this.fetchImpl(sample.url, { headers })
    if (!response.ok) throw new Error(`Sample download failed (${response.status})`)
    let bytes = await response.arrayBuffer()
    if (ranged && response.status === 200 && sample.byteOffset != null && sample.byteLength != null) {
      bytes = bytes.slice(sample.byteOffset, sample.byteOffset + sample.byteLength)
    }
    const decoded = decodeSampleBytes(bytes, sample)
    this.remember(sample.id, decoded)
    return decoded
  }

  holdAudio(id: string, sample: DecodedSample) {
    const frames = sample.channels[0]?.length ?? 0
    if (frames > STREAM_FRAMES) {
      this.views.set(id, sample)
      this.decoded.delete(id)
      this.streams.delete(id)
      return
    }
    this.views.delete(id)
    this.streams.delete(id)
    this.remember(id, sample)
  }

  holdPack(pack: SamplePack) {
    this.packs.set(pack.id, pack)
    for (const [id, stream] of this.streams) {
      if (stream.packId === pack.id) this.streams.delete(id)
    }
  }

  loadedIds() {
    return [...new Set([...this.decoded.keys(), ...this.views.keys()])]
  }

  /** Ids installed as a whole decoded buffer. Long files and packed zones stay off this list. */
  fullResidentIds() {
    return [...this.decoded.keys()]
  }

  /** Float frames decoded for playback right now. Packed chunks count; in-place views do not. */
  playbackFloatFrames() {
    let count = 0
    for (const stream of this.streams.values()) count += stream.resident()
    return count
  }

  async settle() {
    await Promise.all([...this.inflight.values()])
  }

  private remember(id: string, sample: DecodedSample) {
    const frames = sample.channels[0]?.length ?? 0
    if (frames > STREAM_FRAMES) {
      this.views.set(id, sample)
      this.decoded.delete(id)
      this.streams.delete(id)
      return
    }
    if (this.decoded.has(id)) {
      this.decoded.set(id, sample)
      return
    }
    const size = sample.channels.reduce((sum, channel) => sum + channel.byteLength, 0)
    this.decoded.set(id, sample)
    this.order.push(id)
    this.bytes += size
    while (this.bytes > this.maxBytes && this.order.length > 1) {
      const drop = this.order.shift()
      if (!drop || drop === id) continue
      const old = this.decoded.get(drop)
      this.decoded.delete(drop)
      if (old) this.bytes -= old.channels.reduce((sum, channel) => sum + channel.byteLength, 0)
    }
  }
}

export function decodeSampleBytes(bytes: ArrayBuffer, sample: Pick<SampleRef, 'format' | 'sampleRate' | 'channels'>): DecodedSample {
  if (sample.format === 'wav' || looksLikeWav(bytes)) {
    const wav = decodeWavPCM(bytes)
    return { sampleRate: wav.sampleRate, channels: wav.channels }
  }
  return {
    sampleRate: sample.sampleRate || 48000,
    channels: decodePcm(bytes, sample.format, sample.channels || 1),
  }
}

export function decodePackedRange(pack: SamplePack, sample: SampleRef, start: number, count: number): DecodedSample {
  const origin = Math.max(0, start)
  const total = sample.frameCount > 0 ? sample.frameCount : count
  const frames = Math.max(0, Math.min(count, total - origin))
  return decodePacked(pack, {
    ...sample,
    frameOffset: Math.max(0, sample.frameOffset) + Math.max(0, start),
    frameCount: frames,
  })
}

export function decodePacked(pack: SamplePack, sample: SampleRef): DecodedSample {
  const channels = Math.max(1, sample.channels || pack.channels || 1)
  const frames = Math.max(0, sample.frameCount)
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  const view = new DataView(pack.pcm)
  const low = pack.sm24 ? new Uint8Array(pack.sm24) : null
  const start = Math.max(0, sample.frameOffset)
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const frame = start + i
      const word = frame * channels + channel
      if (low && word < low.length) {
        const hi = view.getUint16(word * 2, true)
        let value = (hi << 8) | low[word]
        if (value & 0x800000) value -= 0x1000000
        out[channel][i] = value < 0 ? value / 0x800000 : value / 0x7fffff
      } else if (word * 2 + 1 < pack.pcm.byteLength) {
        const signed = view.getInt16(word * 2, true)
        out[channel][i] = signed < 0 ? signed / 0x8000 : signed / 0x7fff
      }
    }
  }
  return { sampleRate: sample.sampleRate || 48000, channels: out }
}

function decodePcm(bytes: ArrayBuffer, format: SampleFormat, channels: number) {
  const view = new DataView(bytes)
  const width = format === 'float32' ? 4 : format === 'pcm-s24le' ? 3 : 2
  const frames = Math.floor(bytes.byteLength / (width * Math.max(1, channels)))
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  let offset = 0
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < channels; channel++) {
      if (format === 'float32') {
        out[channel][i] = view.getFloat32(offset, true)
        offset += 4
      } else if (format === 'pcm-s24le') {
        const unsigned = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
        const signed = unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned
        out[channel][i] = signed < 0 ? signed / 0x800000 : signed / 0x7fffff
        offset += 3
      } else {
        const signed = view.getInt16(offset, true)
        out[channel][i] = signed < 0 ? signed / 0x8000 : signed / 0x7fff
        offset += 2
      }
    }
  }
  return out
}

function looksLikeWav(bytes: ArrayBuffer) {
  if (bytes.byteLength < 12) return false
  const head = new Uint8Array(bytes, 0, 4)
  return head[0] === 82 && head[1] === 73 && head[2] === 70 && head[3] === 70
}
