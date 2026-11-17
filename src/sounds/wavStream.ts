import { polyphaseKernel, sampleKernel } from '../audio/quality/resample'
import { decodeWavPCM, parseWavHeader } from '../model/wav'

const PREVIEW_TAPS = 96

export interface WavInfoReady {
  sampleRate: number
  channels: number
  bits: number
  frames: number
  dataOffset: number
  bytesPerSample: number
}

/**
 * Lossless WAV decoder that can emit frames before the file has finished arriving.
 * Completed frames match `decodeWavPCM`. 16-bit, 24-bit, and float 32 are kept.
 */
export class WavDecoder {
  private storage = new Uint8Array(65536)
  private length = 0
  private info: WavInfoReady | null = null
  readonly fileChannels: Float32Array[] = []
  decodedFrames = 0

  push(chunk: Uint8Array): number {
    if (!chunk.byteLength) return 0
    this.ensure(this.length + chunk.byteLength)
    this.storage.set(chunk, this.length)
    this.length += chunk.byteLength
    if (!this.info) {
      const parsed = this.readInfo()
      if (!parsed) return 0
      this.info = parsed
      for (let channel = 0; channel < parsed.channels; channel++) this.fileChannels.push(new Float32Array(parsed.frames))
    }
    return this.pullFrames()
  }

  ready() {
    return this.info
  }

  private ensure(need: number) {
    if (this.storage.byteLength >= need) return
    let size = this.storage.byteLength
    while (size < need) size *= 2
    const next = new Uint8Array(size)
    next.set(this.storage.subarray(0, this.length))
    this.storage = next
  }

  private readInfo(): WavInfoReady | null {
    if (this.length < 12) return null
    const head = this.storage
    if (head[0] !== 0x52 || head[1] !== 0x49 || head[2] !== 0x46 || head[3] !== 0x46) return null
    if (head[8] !== 0x57 || head[9] !== 0x41 || head[10] !== 0x56 || head[11] !== 0x45) return null
    const view = new DataView(head.buffer, head.byteOffset, this.length)
    let offset = 12
    let sampleRate = 0
    let channels = 0
    let bits = 0
    let format = 1
    let dataBytes = 0
    let dataOffset = 0
    while (offset + 8 <= this.length) {
      const id = String.fromCharCode(head[offset], head[offset + 1], head[offset + 2], head[offset + 3])
      const size = view.getUint32(offset + 4, true)
      if (id === 'fmt ') {
        if (offset + 8 + 16 > this.length) return null
        format = view.getUint16(offset + 8, true)
        channels = view.getUint16(offset + 10, true)
        sampleRate = view.getUint32(offset + 12, true)
        bits = view.getUint16(offset + 22, true)
        if (format === 0xfffe && size >= 40 && offset + 8 + 40 <= this.length) format = view.getUint16(offset + 32, true)
      } else if (id === 'data') {
        dataBytes = size
        dataOffset = offset + 8
        break
      }
      const step = 8 + size + (size % 2)
      if (offset + step > this.length && id !== 'data') return null
      offset += step
    }
    if (!sampleRate || !channels || !dataOffset) return null
    const bytesPerSample = format === 3 ? 4 : bits === 24 ? 3 : bits === 16 ? 2 : 0
    if (!bytesPerSample) return null
    const frames = Math.floor((dataBytes || 0) / (channels * bytesPerSample))
    if (!frames) return null
    return { sampleRate, channels, bits, frames, dataOffset, bytesPerSample }
  }

  private pullFrames() {
    const info = this.info
    if (!info) return 0
    const frameBytes = info.channels * info.bytesPerSample
    const available = Math.floor(Math.max(0, this.length - info.dataOffset) / frameBytes)
    const target = Math.min(info.frames, available)
    const start = this.decodedFrames
    if (target <= start) return 0
    const view = new DataView(this.storage.buffer, this.storage.byteOffset, this.length)
    let p = info.dataOffset + start * frameBytes
    const out = this.fileChannels
    for (let frame = start; frame < target; frame++) {
      for (let channel = 0; channel < info.channels; channel++) {
        if (info.bytesPerSample === 4) {
          out[channel][frame] = view.getFloat32(p, true)
          p += 4
        } else if (info.bytesPerSample === 3) {
          const code = readInt24(view, p)
          out[channel][frame] = code < 0 ? code / 0x800000 : code / 0x7fffff
          p += 3
        } else {
          const sample = view.getInt16(p, true)
          out[channel][frame] = sample < 0 ? sample / 0x8000 : sample / 0x7fff
          p += 2
        }
      }
    }
    this.decodedFrames = target
    return target - start
  }
}

function readInt24(view: DataView, offset: number) {
  const unsigned = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
  return unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned
}

/** How many output samples are identical to a full-file sinc once `decodedFrames` have arrived. */
export function stableOutputCount(decodedFrames: number, totalFrames: number, outLen: number, half = PREVIEW_TAPS) {
  if (outLen <= 1 || totalFrames <= 1) return decodedFrames >= totalFrames ? outLen : 0
  if (decodedFrames >= totalFrames) return outLen
  const scale = totalFrames / outLen
  let lo = 0
  let hi = outLen
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const center = (mid - 1 + 0.5) * scale - 0.5
    if (Math.floor(center) + half < decodedFrames) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function outputLength(frames: number, fromRate: number, toRate: number) {
  if (!(frames > 0) || !(fromRate > 0) || !(toRate > 0) || fromRate === toRate) return frames
  return Math.max(1, Math.round(frames * (toRate / fromRate)))
}

/**
 * Windowed-sinc slices.
 * Each new index uses the same kernel position as `resampleSinc` on the finished file.
 */
export class RateStreamer {
  private readonly outLen: number
  private readonly scale: number
  private readonly kernel: ReturnType<typeof polyphaseKernel> | null
  private emitted = 0
  private readonly outputs: Float32Array[]

  constructor(private readonly source: Float32Array[], totalFrames: number, fromRate: number, toRate: number, private readonly half = PREVIEW_TAPS) {
    this.outLen = outputLength(totalFrames, fromRate, toRate)
    this.scale = totalFrames > 1 && this.outLen > 1 ? totalFrames / this.outLen : 1
    const same = !(fromRate > 0) || !(toRate > 0) || fromRate === toRate || totalFrames <= 1 || this.outLen <= 1
    this.kernel = same ? null : polyphaseKernel(Math.min(0.45, 0.45 / Math.max(1, this.scale)), this.half)
    this.outputs = source.map(() => new Float32Array(this.outLen))
  }

  /** Newly stable samples, copied so the caller can transfer them. */
  take(decodedFrames: number, totalFrames: number): Float32Array[] | null {
    const stable = this.kernel
      ? stableOutputCount(decodedFrames, totalFrames, this.outLen, this.half)
      : Math.min(this.outLen, decodedFrames)
    if (stable <= this.emitted) return null
    const from = this.emitted
    const count = stable - from
    const slices = this.outputs.map(() => new Float32Array(count))
    for (let channel = 0; channel < this.source.length; channel++) {
      const dest = slices[channel]
      const full = this.outputs[channel]
      if (!this.kernel) {
        dest.set(this.source[channel].subarray(from, stable))
        full.set(dest, from)
        continue
      }
      for (let index = from; index < stable; index++) {
        const sample = sampleKernel(this.kernel, this.source[channel], (index + 0.5) * this.scale - 0.5, 0, totalFrames)
        full[index] = sample
        dest[index - from] = sample
      }
    }
    this.emitted = stable
    return slices
  }

  rateMatched() {
    return this.outputs.map((channel) => channel.slice())
  }
}

export function peakOutline(channel: ArrayLike<number>, bins = 64) {
  const count = Math.max(1, bins | 0)
  const peaks: { min: number; max: number }[] = []
  const length = channel.length | 0
  if (!length) return peaks
  for (let bin = 0; bin < count; bin++) {
    const start = Math.floor((bin * length) / count)
    const end = Math.max(start + 1, Math.floor(((bin + 1) * length) / count))
    let lo = 0
    let hi = 0
    for (let index = start; index < end; index++) {
      const sample = channel[index] || 0
      if (sample < lo) lo = sample
      if (sample > hi) hi = sample
    }
    peaks.push({ min: lo, max: hi })
  }
  return peaks
}

/** Whole-file decode used when a worker is unavailable. Same samples as the stream. */
export function decodeWholeWav(bytes: ArrayBuffer) {
  const header = parseWavHeader(bytes)
  const decoded = decodeWavPCM(bytes)
  return { sampleRate: decoded.sampleRate, channels: decoded.channels, bits: header.bits }
}
