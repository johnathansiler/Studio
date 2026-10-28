import { decodeWavPCM } from '../../model/wav'
import type { DecodedSample, SampleFormat, SamplePack, SampleRef } from './types'
import { assertHuggingFaceUrl } from './source'

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
    if (sample.packId && this.packs.has(sample.packId)) {
      const made = decodePacked(this.packs.get(sample.packId)!, sample)
      this.remember(sample.id, made)
      return made
    }
    return null
  }

  request(sample: SampleRef) {
    if (this.get(sample)) return
    if (!sample.url || this.inflight.has(sample.id)) return
    const task = this.load(sample).catch(() => null)
    this.inflight.set(sample.id, task)
    void task.finally(() => {
      if (this.inflight.get(sample.id) === task) this.inflight.delete(sample.id)
    })
  }

  async load(sample: SampleRef): Promise<DecodedSample | null> {
    const ready = this.get(sample)
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
    this.remember(id, sample)
  }

  holdPack(pack: SamplePack) {
    this.packs.set(pack.id, pack)
  }

  loadedIds() {
    return [...this.decoded.keys()]
  }

  async settle() {
    await Promise.all([...this.inflight.values()])
  }

  private remember(id: string, sample: DecodedSample) {
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
