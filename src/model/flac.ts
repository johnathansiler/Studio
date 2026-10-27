/** Subset FLAC (Xiph, BSD) using verbatim subframes. Zip deflate does the shrinking. */

export function encodeFlac(channels: Float32Array[], sampleRate: number, bits: 16 | 24 = 16): Uint8Array {
  if (!channels.length) throw new Error('No audio channels')
  const length = channels[0].length
  const frames: Uint8Array[] = []
  const block = 4096
  for (let start = 0; start < length; start += block) {
    const count = Math.min(block, length - start)
    frames.push(encodeFrame(channels, start, count, sampleRate, bits, frames.length))
  }
  if (!frames.length) frames.push(encodeFrame(channels, 0, 1, sampleRate, bits, 0))
  let minFrame = frames[0].length
  let maxFrame = frames[0].length
  for (const frame of frames) {
    minFrame = Math.min(minFrame, frame.length)
    maxFrame = Math.max(maxFrame, frame.length)
  }
  const info = streamInfo(sampleRate, channels.length, bits, length, minFrame, maxFrame, block)
  const total = 4 + info.length + frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Uint8Array(total)
  out.set(new TextEncoder().encode('fLaC'), 0)
  out.set(info, 4)
  let offset = 4 + info.length
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

export function decodeFlac(bytes: Uint8Array): { sampleRate: number; channels: Float32Array[] } {
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'fLaC') throw new Error('Not a FLAC file')
  const info = readStreamInfo(bytes.subarray(4, 42))
  const channels = Array.from({ length: info.channels }, () => new Float32Array(info.totalSamples))
  let offset = 4
  const header = bytes[offset]
  const last = (header & 0x80) !== 0
  const type = (header >> 0) & 0x7f
  const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
  void last
  void type
  offset += 4 + length
  let frameIndex = 0
  let written = 0
  while (offset + 8 < bytes.length && written < info.totalSamples) {
    const frame = decodeFrame(bytes, offset, info.bits)
    const count = Math.min(frame.count, info.totalSamples - written)
    for (let c = 0; c < info.channels; c++) {
      channels[c].set(frame.channels[c].subarray(0, count), written)
    }
    written += count
    offset = frame.next
    frameIndex += 1
    if (frameIndex > info.totalSamples) break
  }
  return { sampleRate: info.sampleRate, channels }
}

function streamInfo(sampleRate: number, channels: number, bits: number, total: number, minFrame: number, maxFrame: number, block: number) {
  const buf = new Uint8Array(38)
  buf[0] = 0x80
  buf[3] = 34
  const view = new DataView(buf.buffer)
  view.setUint16(4, block, false)
  view.setUint16(6, block, false)
  write24(buf, 8, minFrame)
  write24(buf, 11, maxFrame)
  const packed = (BigInt(sampleRate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bits - 1) << 36n) | BigInt(total)
  for (let i = 0; i < 8; i++) buf[14 + i] = Number((packed >> BigInt(56 - i * 8)) & 0xffn)
  return buf
}

function readStreamInfo(block: Uint8Array) {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
  const packed = view.getBigUint64(14, false)
  const sampleRate = Number((packed >> 44n) & 0xfffffn)
  const channels = Number((packed >> 41n) & 0x7n) + 1
  const bits = Number((packed >> 36n) & 0x1fn) + 1
  const totalSamples = Number(packed & 0xfffffffffn)
  return { sampleRate, channels, bits, totalSamples }
}

function encodeFrame(channels: Float32Array[], start: number, count: number, sampleRate: number, bits: 16 | 24, index: number) {
  const writer = new BitWriter()
  writer.write(0x3ffe, 14)
  writer.write(0, 1)
  writer.write(0, 1)
  writer.write(count === 4096 ? 12 : 7, 4)
  writer.write(rateCode(sampleRate), 4)
  writer.write(channels.length - 1, 4)
  writer.write(bits === 24 ? 6 : 4, 3)
  writer.write(0, 1)
  for (const byte of utf8(index)) writer.write(byte, 8)
  if (count !== 4096) writer.write(count - 1, 16)
  const header = writer.bytes()
  const headerCrc = crc8(header)
  const body = new BitWriter()
  for (let c = 0; c < channels.length; c++) {
    body.write(0, 1)
    body.write(1, 6)
    body.write(0, 1)
    const full = bits === 16 ? 0x8000 : 0x800000
    const positive = full - 1
    for (let i = 0; i < count; i++) {
      const sample = Math.max(-1, Math.min(1, channels[c][start + i] || 0))
      const code = Math.trunc(sample < 0 ? sample * full : sample * positive)
      body.write(code & (bits === 16 ? 0xffff : 0xffffff), bits)
    }
  }
  body.align()
  const samples = body.bytes()
  const frame = new Uint8Array(header.length + 1 + samples.length + 2)
  frame.set(header, 0)
  frame[header.length] = headerCrc
  frame.set(samples, header.length + 1)
  const footer = crc16(frame.subarray(0, frame.length - 2))
  frame[frame.length - 2] = (footer >> 8) & 0xff
  frame[frame.length - 1] = footer & 0xff
  return frame
}

function decodeFrame(bytes: Uint8Array, offset: number, bits: number) {
  const reader = new BitReader(bytes, offset * 8)
  const sync = reader.read(14)
  if (sync !== 0x3ffe) throw new Error('Bad FLAC frame')
  reader.read(1)
  reader.read(1)
  const blockCode = reader.read(4)
  reader.read(4)
  const channelCode = reader.read(4)
  const sizeCode = reader.read(3)
  reader.read(1)
  readUtf8(reader)
  let count = blockSize(blockCode)
  if (blockCode === 6) count = reader.read(8) + 1
  if (blockCode === 7) count = reader.read(16) + 1
  const sampleBits = sizeCode === 6 ? 24 : sizeCode === 4 ? 16 : bits
  const channels = channelCode <= 7 ? channelCode + 1 : 2
  const headerBits = reader.bit
  reader.bit = Math.ceil(headerBits / 8) * 8 + 8
  const audio: Float32Array[] = []
  for (let c = 0; c < channels; c++) {
    reader.read(1)
    const kind = reader.read(6)
    reader.read(1)
    if (kind !== 1) throw new Error('Only verbatim FLAC subframes are supported')
    const full = sampleBits === 16 ? 0x8000 : 0x800000
    const positive = full - 1
    const channel = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      let code = reader.read(sampleBits)
      if (code & (1 << (sampleBits - 1))) code -= 1 << sampleBits
      channel[i] = code < 0 ? code / full : code / positive
    }
    audio.push(channel)
  }
  reader.bit = Math.ceil(reader.bit / 8) * 8
  const next = (reader.bit >> 3) + 2
  return { channels: audio, count, next }
}

function blockSize(code: number) {
  if (code === 1) return 192
  if (code >= 2 && code <= 5) return 576 * 2 ** (code - 2)
  if (code >= 8 && code <= 15) return 256 * 2 ** (code - 8)
  return 0
}

function rateCode(sampleRate: number) {
  const codes: Record<number, number> = { 44100: 9, 48000: 10, 96000: 11, 88200: 1, 32000: 8, 22050: 6 }
  return codes[sampleRate] ?? 0
}

function utf8(value: number) {
  if (value < 0x80) return [value]
  const bytes: number[] = []
  let n = value
  while (n > 0) {
    bytes.unshift(n & 0x3f)
    n >>= 6
  }
  bytes[0] |= 0xff << (8 - bytes.length)
  for (let i = 1; i < bytes.length; i++) bytes[i] |= 0x80
  return bytes
}

function readUtf8(reader: BitReader) {
  const first = reader.read(8)
  if (first < 0x80) return first
  let extra = 0
  let probe = first
  while (probe & 0x80) {
    extra += 1
    probe = (probe << 1) & 0xff
  }
  let value = first & ((1 << (8 - extra)) - 1)
  for (let i = 1; i < extra; i++) value = (value << 6) | (reader.read(8) & 0x3f)
  return value
}

class BitWriter {
  private data: number[] = []
  private acc = 0
  private n = 0
  write(value: number, bits: number) {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >>> i) & 1)
      this.n += 1
      if (this.n === 8) {
        this.data.push(this.acc & 0xff)
        this.acc = 0
        this.n = 0
      }
    }
  }
  align() {
    if (this.n) this.write(0, 8 - this.n)
  }
  bytes() {
    return Uint8Array.from(this.data)
  }
}

class BitReader {
  bit: number
  constructor(private bytes: Uint8Array, bit: number) {
    this.bit = bit
  }
  read(bits: number) {
    let value = 0
    for (let i = 0; i < bits; i++) {
      const byte = this.bytes[this.bit >> 3] ?? 0
      const bit = (byte >> (7 - (this.bit & 7))) & 1
      this.bit += 1
      value = (value << 1) | bit
    }
    return value
  }
}

function crc8(data: Uint8Array) {
  let crc = 0
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}

function crc16(data: Uint8Array) {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

function write24(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >> 16) & 0xff
  bytes[offset + 1] = (value >> 8) & 0xff
  bytes[offset + 2] = value & 0xff
}
