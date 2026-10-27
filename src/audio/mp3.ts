import { Mp3Encoder } from '@breezystack/lamejs'
import { NOTE_NAMES, scaleById } from '../model/scale'
import type { Project } from '../model/types'
import { linearResample } from '../model/wav'

export interface Mp3Tags {
  title: string
  artist: string
  bpm: number
  key: string
  artwork?: Uint8Array | null
  comment?: string
  isrc?: string
}

export interface Mp3Options {
  mode: 'cbr' | 'vbr'
  bitrate: number
  quality: number
  tags?: Mp3Tags
}

const BITRATES = [128, 160, 192, 224, 256, 320]

export function encodeMp3(channels: Float32Array[], sampleRate: number, options: Mp3Options): Uint8Array {
  const rate = sampleRate === 44100 ? 44100 : 48000
  const audio = channels.map((channel) => (sampleRate === rate ? channel : linearResample(channel, sampleRate, rate)))
  const left = audio[0] ?? new Float32Array(0)
  const right = audio[1] ?? left
  const length = Math.min(left.length, right.length)
  const bitrate = nearestBitrate(options.bitrate)
  const audioBytes = options.mode === 'vbr'
    ? encodeVbr(left, right, length, rate, bitrate, options.quality)
    : encodeCbr(left, right, length, rate, bitrate)
  const tags = options.tags
  if (!tags) return audioBytes
  return concat([id3(tags), audioBytes])
}

export function mp3Duration(bytes: Uint8Array): { seconds: number; sampleRate: number; frames: number } {
  let offset = 0
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    offset = 10 + syncsafe(bytes, 6)
  }
  let frames = 0
  let sampleRate = 44100
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1
      continue
    }
    const header = frameHeader(bytes, offset)
    if (!header) {
      offset += 1
      continue
    }
    frames += 1
    sampleRate = header.sampleRate
    offset += header.size
  }
  return { seconds: frames ? (frames * 1152) / sampleRate : 0, sampleRate, frames }
}

export function keyLabel(project: Project) {
  const scale = scaleById(project.scale?.scale)
  const root = NOTE_NAMES[((project.scale?.root ?? 0) % 12 + 12) % 12]
  return `${root} ${scale.name}`
}

function encodeCbr(left: Float32Array, right: Float32Array, length: number, rate: number, bitrate: number) {
  const encoder = new Mp3Encoder(2, rate, bitrate)
  const parts: Uint8Array[] = []
  const block = 1152
  for (let offset = 0; offset < length; offset += block) {
    const n = Math.min(block, length - offset)
    const l = new Int16Array(n)
    const r = new Int16Array(n)
    for (let i = 0; i < n; i++) {
      l[i] = floatToInt16(left[offset + i] ?? 0)
      r[i] = floatToInt16(right[offset + i] ?? 0)
    }
    parts.push(asBytes(encoder.encodeBuffer(l, r)))
  }
  parts.push(asBytes(encoder.flush()))
  return concat(parts)
}

/**
 * The published lamejs bundle's VBR init calls helpers that are not in the build.
 * Frame choice uses two CBR passes. The reservoir is off, so each frame stands alone.
 */
function encodeVbr(left: Float32Array, right: Float32Array, length: number, rate: number, bitrate: number, quality: number) {
  const [low, high] = vbrPair(quality, bitrate)
  if (low === high) return encodeCbr(left, right, length, rate, low)
  const quiet = framesOf(encodeCbr(left, right, length, rate, low))
  const loud = framesOf(encodeCbr(left, right, length, rate, high))
  const count = Math.min(quiet.length, loud.length)
  const q = Math.max(0, Math.min(9, Math.round(quality)))
  const threshold = 0.04 + q * 0.02
  const chosen: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    chosen.push(frameEnergy(left, right, i * 1152) >= threshold ? loud[i] : quiet[i])
  }
  return concat(chosen)
}

function vbrPair(quality: number, bitrate: number): [number, number] {
  const q = Math.max(0, Math.min(9, Math.round(quality)))
  const center = BITRATES.indexOf(nearestBitrate(bitrate))
  const down = q >= 5 ? 2 : 1
  const up = q <= 4 ? 2 : 1
  return [BITRATES[Math.max(0, center - down)], BITRATES[Math.min(BITRATES.length - 1, center + up)]]
}

function frameEnergy(left: Float32Array, right: Float32Array, offset: number) {
  const end = Math.min(left.length, offset + 1152)
  if (end <= offset) return 0
  let sum = 0
  for (let i = offset; i < end; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    sum += l * l + r * r
  }
  return Math.sqrt(sum / ((end - offset) * 2))
}

function framesOf(bytes: Uint8Array) {
  const frames: Uint8Array[] = []
  let offset = 0
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1
      continue
    }
    const header = frameHeader(bytes, offset)
    if (!header) {
      offset += 1
      continue
    }
    frames.push(bytes.subarray(offset, offset + header.size))
    offset += header.size
  }
  return frames
}

function nearestBitrate(value: number) {
  let best = BITRATES[0]
  for (const rate of BITRATES) if (Math.abs(rate - value) < Math.abs(best - value)) best = rate
  return best
}

function floatToInt16(sample: number) {
  const s = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
}

function asBytes(chunk: Uint8Array | Int8Array) {
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice()
}

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function id3(tags: Mp3Tags) {
  const frames = [
    textFrame('TIT2', tags.title),
    textFrame('TPE1', tags.artist),
    textFrame('TBPM', String(Math.round(tags.bpm))),
    textFrame('TKEY', tags.key),
  ]
  if (tags.artwork?.length) frames.push(pictureFrame(tags.artwork))
  if (tags.comment) frames.push(commentFrame(tags.comment))
  if (tags.isrc?.trim()) frames.push(textFrame('TSRC', tags.isrc.trim()))
  const body = concat(frames)
  const header = new Uint8Array(10)
  header.set(new TextEncoder().encode('ID3'), 0)
  header[3] = 3
  const size = syncsafeBytes(body.length)
  header.set(size, 6)
  return concat([header, body])
}

function textFrame(id: string, value: string) {
  const text = new TextEncoder().encode(value || '')
  const data = new Uint8Array(1 + text.length)
  data[0] = 3
  data.set(text, 1)
  return frame(id, data)
}

function commentFrame(value: string) {
  const text = new TextEncoder().encode(value)
  const data = new Uint8Array(1 + 3 + 1 + text.length)
  data[0] = 3
  data[1] = 101
  data[2] = 110
  data[3] = 103
  data[4] = 0
  data.set(text, 5)
  return frame('COMM', data)
}

function pictureFrame(artwork: Uint8Array) {
  const mime = artwork[0] === 0x89 ? 'image/png' : 'image/jpeg'
  const mimeBytes = new TextEncoder().encode(mime)
  const data = new Uint8Array(1 + mimeBytes.length + 1 + 1 + 1 + artwork.length)
  data[0] = 0
  data.set(mimeBytes, 1)
  const typeAt = 1 + mimeBytes.length
  data[typeAt] = 0
  data[typeAt + 1] = 3
  data[typeAt + 2] = 0
  data.set(artwork, typeAt + 3)
  return frame('APIC', data)
}

function frame(id: string, data: Uint8Array) {
  const out = new Uint8Array(10 + data.length)
  out.set(new TextEncoder().encode(id), 0)
  new DataView(out.buffer).setUint32(4, data.length, false)
  out.set(data, 10)
  return out
}

function syncsafe(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f)
}

function syncsafeBytes(size: number) {
  return Uint8Array.of((size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f)
}

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const MPEG1_RATES = [44100, 48000, 32000]

function frameHeader(bytes: Uint8Array, offset: number) {
  const b1 = bytes[offset + 1]
  const b2 = bytes[offset + 2]
  const version = (b1 >> 3) & 0x3
  const layer = (b1 >> 1) & 0x3
  if (version !== 3 || layer !== 1) return null
  const bitrate = MPEG1_L3[(b2 >> 4) & 0xf]
  const sampleRate = MPEG1_RATES[(b2 >> 2) & 0x3]
  if (!bitrate || !sampleRate) return null
  const padding = (b2 >> 1) & 0x1
  const size = Math.floor((144 * bitrate * 1000) / sampleRate) + padding
  if (size < 4 || offset + size > bytes.length) return null
  return { size, sampleRate }
}
