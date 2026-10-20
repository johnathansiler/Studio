export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  if (!channels.length) throw new Error('No audio channels')
  const length = channels[0].length
  for (const ch of channels) {
    if (ch.length !== length) throw new Error('Channel length mismatch')
  }
  const numChannels = channels.length
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const dataSize = length * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i] || 0))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

export interface WavInfo {
  sampleRate: number
  channels: number
  bits: number
  dataBytes: number
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
  let dataBytes = 0
  while (offset + 8 <= buffer.byteLength) {
    const id = readString(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
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
  return { sampleRate, channels, bits, dataBytes }
}

export function decodeWavPCM(buffer: ArrayBuffer): { sampleRate: number; channels: Float32Array[] } {
  const info = parseWavHeader(buffer)
  if (info.bits !== 16) throw new Error('Only 16-bit PCM is supported')
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
  const frames = info.dataBytes / (info.channels * 2)
  const channels: Float32Array[] = Array.from({ length: info.channels }, () => new Float32Array(frames))
  let p = dataOffset
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < info.channels; c++) {
      const s = view.getInt16(p, true)
      channels[c][i] = s < 0 ? s / 0x8000 : s / 0x7fff
      p += 2
    }
  }
  return { sampleRate: info.sampleRate, channels }
}

export function linearResample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice()
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate))
  const out = new Float32Array(outLen)
  const scale = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const pos = i * scale
    const i0 = Math.floor(pos)
    const i1 = Math.min(input.length - 1, i0 + 1)
    const f = pos - i0
    const a = input[Math.min(input.length - 1, i0)] || 0
    const b = input[i1] || 0
    out[i] = a + (b - a) * f
  }
  return out
}

function writeString(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

function readString(view: DataView, offset: number, length: number) {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i))
  return s
}
