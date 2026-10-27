import { resampleSinc } from '../audio/quality/resample'

export type WavBits = 16 | 24 | 32
export type DitherMode = 'none' | 'tpdf' | 'shaped'

export interface WavEncodeOptions {
  bits?: WavBits
  dither?: DitherMode
  random?: () => number
}

export function encodeWav(channels: Float32Array[], sampleRate: number, options?: WavEncodeOptions): ArrayBuffer {
  if (!channels.length) throw new Error('No audio channels')
  const length = channels[0].length
  for (const ch of channels) {
    if (ch.length !== length) throw new Error('Channel length mismatch')
  }
  const bits: WavBits = options?.bits ?? 16
  const dither = options?.dither ?? 'none'
  const random = options?.random ?? Math.random
  const numChannels = channels.length
  const bytesPerSample = bits === 16 ? 2 : bits === 24 ? 3 : 4
  const format = bits === 32 ? 3 : 1
  const blockAlign = numChannels * bytesPerSample
  const dataSize = length * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  const errors = channels.map(() => ({ e: 0 }))
  let offset = 44
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = channels[c][i] ?? 0
      if (bits === 32) {
        view.setFloat32(offset, Number.isFinite(sample) ? sample : 0, true)
        offset += 4
      } else if (bits === 24) {
        writeInt24(view, offset, quantize(sample, 24, dither, random, errors[c]))
        offset += 3
      } else {
        view.setInt16(offset, quantize(sample, 16, dither, random, errors[c]), true)
        offset += 2
      }
    }
  }
  return buffer
}

function quantize(sample: number, bits: 16 | 24, dither: DitherMode, random: () => number, error: { e: number }) {
  const full = bits === 16 ? 0x8000 : 0x800000
  const positive = full - 1
  let s = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
  if (dither !== 'none') {
    const quantum = 1 / positive
    const noise = (random() - random()) * quantum
    s += dither === 'shaped' ? noise - error.e : noise
    s = Math.max(-1, Math.min(1, s))
  }
  const scaled = s < 0 ? s * full : s * positive
  const code = Math.trunc(scaled)
  const clamped = Math.max(-full, Math.min(positive, code))
  if (dither === 'shaped') {
    const decoded = clamped < 0 ? clamped / full : clamped / positive
    error.e = decoded - (Number.isFinite(sample) ? sample : 0)
  }
  return clamped
}

function writeInt24(view: DataView, offset: number, value: number) {
  view.setUint8(offset, value & 0xff)
  view.setUint8(offset + 1, (value >> 8) & 0xff)
  view.setUint8(offset + 2, (value >> 16) & 0xff)
}

export interface WavInfo {
  sampleRate: number
  channels: number
  bits: number
  dataBytes: number
  format: number
}

export function parseWavHeader(buffer: ArrayBuffer): WavInfo {
  const view = new DataView(buffer)
  const riff = readString(view, 0, 4)
  const wave = readString(view, 8, 4)
  if (riff !== 'RIFF' || wave !== 'WAVE') throw new Error('Not a WAV file')
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let format = 1
  let dataBytes = 0
  while (offset + 8 <= buffer.byteLength) {
    const id = readString(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      format = view.getUint16(offset + 8, true)
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      bits = view.getUint16(offset + 22, true)
    } else if (id === 'data') {
      dataBytes = size
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (!sampleRate || !channels || !dataBytes) throw new Error('Incomplete WAV header')
  return { sampleRate, channels, bits, dataBytes, format }
}

export function decodeWavPCM(buffer: ArrayBuffer): { sampleRate: number; channels: Float32Array[] } {
  const info = parseWavHeader(buffer)
  const bytesPerSample = info.format === 3 ? 4 : info.bits === 24 ? 3 : info.bits === 16 ? 2 : 0
  if (!bytesPerSample) throw new Error('Only 16-bit, 24-bit, and 32-bit float WAV are supported')
  const view = new DataView(buffer)
  let offset = 12
  let dataOffset = 0
  while (offset + 8 <= buffer.byteLength) {
    const id = readString(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    if (id === 'data') {
      dataOffset = offset + 8
      break
    }
    offset += 8 + size + (size % 2)
  }
  const frames = Math.floor(info.dataBytes / (info.channels * bytesPerSample))
  const channels: Float32Array[] = Array.from({ length: info.channels }, () => new Float32Array(frames))
  let p = dataOffset
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < info.channels; c++) {
      if (info.format === 3) {
        channels[c][i] = view.getFloat32(p, true)
        p += 4
      } else if (info.bits === 24) {
        const code = readInt24(view, p)
        channels[c][i] = code < 0 ? code / 0x800000 : code / 0x7fffff
        p += 3
      } else {
        const s = view.getInt16(p, true)
        channels[c][i] = s < 0 ? s / 0x8000 : s / 0x7fff
        p += 2
      }
    }
  }
  return { sampleRate: info.sampleRate, channels }
}

function readInt24(view: DataView, offset: number) {
  const unsigned = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
  return unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned
}

export function linearResample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice()
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate))
  return resampleSinc(input, outLen, 64)
}

function writeString(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

function readString(view: DataView, offset: number, length: number) {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i))
  return s
}
