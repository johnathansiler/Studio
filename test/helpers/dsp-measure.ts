/**
 * Offline render and measurement helpers shared by control audits.
 * Plugin tests render at min, default, and max and compare these readings
 * with the label (level in dB, centroid, tail length, stereo balance).
 */

import type { BlockContext, Processor } from '../../src/audio/plugins/types'

export const RATE = 48000

export interface RenderOptions {
  sampleRate?: number
  tempo?: number
  block?: number
  offline?: boolean
  quality?: 'full' | 'eco'
  sidechain?: Float32Array | null
}

export function renderProcessor(
  processor: Processor,
  input: Float32Array[],
  params: Record<string, number>,
  options: RenderOptions = {},
): Float32Array[] {
  const sampleRate = options.sampleRate ?? RATE
  const length = input[0]?.length ?? input[1]?.length ?? 0
  const channels = Math.max(2, input.length)
  const output = Array.from({ length: channels }, () => new Float32Array(length))
  const block = Math.max(1, options.block ?? 128)
  const context: BlockContext = {
    sampleRate,
    tempo: options.tempo ?? 120,
    sampleTime: 0,
    sidechain: options.sidechain ?? null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: options.quality ?? 'full',
    offline: options.offline ?? true,
  }
  processor.reset()
  for (let offset = 0; offset < length; offset += block) {
    const count = Math.min(block, length - offset)
    const sliceIn = input.map((channel) => channel.subarray(offset, offset + count))
    while (sliceIn.length < channels) sliceIn.push(sliceIn[0] ?? new Float32Array(count))
    const sliceOut = output.map((channel) => channel.subarray(offset, offset + count))
    processor.process(sliceIn, sliceOut, params, { ...context, sampleTime: offset })
  }
  return output
}

export function seconds(duration: number, sampleRate = RATE) {
  return Math.max(1, Math.floor(sampleRate * duration))
}

export function sine(freq: number, duration: number, amp = 0.25, sampleRate = RATE) {
  const data = new Float32Array(seconds(duration, sampleRate))
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp
  return data
}

export function noise(duration: number, amp = 0.2, seed = 3, sampleRate = RATE) {
  const data = new Float32Array(seconds(duration, sampleRate))
  let state = seed || 1
  for (let i = 0; i < data.length; i++) {
    state = (state * 16807) % 2147483647
    data[i] = ((state / 2147483647) * 2 - 1) * amp
  }
  return data
}

export function impulse(duration: number, amp = 1, sampleRate = RATE) {
  const data = new Float32Array(seconds(duration, sampleRate))
  data[0] = amp
  return data
}

/** Loud for `burst` seconds, then a steady tone. Used for attack and release. */
export function burst(freq: number, duration: number, burstSec: number, loud = 0.9, quiet = 0.08, sampleRate = RATE) {
  const data = sine(freq, duration, quiet, sampleRate)
  const cut = Math.floor(sampleRate * burstSec)
  for (let i = 0; i < cut && i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * loud
  return data
}

export function rms(buffer: Float32Array, start = 0, end = buffer.length) {
  const from = Math.max(0, start)
  const to = Math.min(buffer.length, end)
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / (to - from))
}

export function levelDb(buffer: Float32Array, start = 0, end = buffer.length) {
  const power = rms(buffer, start, end)
  return power > 1e-10 ? 20 * Math.log10(power) : -140
}

export function peakAbs(buffer: Float32Array, start = 0, end = buffer.length) {
  let peak = 0
  const to = Math.min(buffer.length, end)
  for (let i = Math.max(0, start); i < to; i++) peak = Math.max(peak, Math.abs(buffer[i]))
  return peak
}

export function peakIndex(buffer: Float32Array, start = 0) {
  let peak = 0
  let at = start
  for (let i = start; i < buffer.length; i++) {
    const mag = Math.abs(buffer[i])
    if (mag > peak) {
      peak = mag
      at = i
    }
  }
  return at
}

/** Loudest bin from 40 Hz to 2 kHz. Useful when a pitch shift sits under broadband residue. */
export function dominantHz(buffer: Float32Array, sampleRate = RATE, start = 0) {
  const n = Math.min(4096, buffer.length - start)
  if (n < 64) return 0
  let best = 0
  let at = 0
  const bins = 180
  for (let bin = 2; bin <= bins; bin++) {
    const hz = (bin / n) * sampleRate
    if (hz < 40 || hz > 2000) continue
    const omega = (2 * Math.PI * hz) / sampleRate
    let real = 0
    let imag = 0
    for (let i = 0; i < n; i++) {
      const sample = buffer[start + i] || 0
      real += sample * Math.cos(omega * i)
      imag -= sample * Math.sin(omega * i)
    }
    const power = real * real + imag * imag
    if (power > best) {
      best = power
      at = hz
    }
  }
  return at
}

/** Power-weighted spectral centroid in Hz. Magnitude uses a short DFT. */
export function spectralCentroid(buffer: Float32Array, sampleRate = RATE, start = 0) {
  const n = Math.min(2048, buffer.length - start)
  if (n < 32) return 0
  let num = 0
  let den = 0
  const bins = 96
  for (let bin = 1; bin <= bins; bin++) {
    const freq = (bin / bins) * (sampleRate / 2)
    const omega = (2 * Math.PI * freq) / sampleRate
    let real = 0
    let imag = 0
    for (let i = 0; i < n; i++) {
      const sample = buffer[start + i] || 0
      real += sample * Math.cos(omega * i)
      imag -= sample * Math.sin(omega * i)
    }
    const power = real * real + imag * imag
    num += freq * power
    den += power
  }
  return den > 0 ? num / den : 0
}

/** Energy in a band of ±`octaves` around `freq`, relative to the whole window. */
export function bandShare(buffer: Float32Array, freq: number, sampleRate = RATE, octaves = 0.5, start = 0) {
  const n = Math.min(2048, buffer.length - start)
  if (n < 32) return 0
  const low = freq / 2 ** octaves
  const high = freq * 2 ** octaves
  let band = 0
  let all = 0
  const bins = 64
  const fMin = 28
  const fMax = sampleRate * 0.45
  for (let bin = 0; bin < bins; bin++) {
    const hz = fMin * (fMax / fMin) ** (bin / (bins - 1))
    const omega = (2 * Math.PI * hz) / sampleRate
    let real = 0
    let imag = 0
    for (let i = 0; i < n; i++) {
      const sample = buffer[start + i] || 0
      real += sample * Math.cos(omega * i)
      imag -= sample * Math.sin(omega * i)
    }
    const power = real * real + imag * imag
    all += power
    if (hz >= low && hz <= high) band += power
  }
  return all > 0 ? band / all : 0
}

/** Share of energy above the second harmonic. Drive and clipping raise this. */
export function harmonicRatio(buffer: Float32Array, fundamental: number, sampleRate = RATE, start = 0) {
  const n = Math.min(2048, buffer.length - start)
  if (n < 32 || fundamental <= 0) return 0
  let harm = 0
  let all = 0
  const bins = 64
  for (let bin = 1; bin <= bins; bin++) {
    const hz = (bin / bins) * Math.min(8000, sampleRate / 2)
    const omega = (2 * Math.PI * hz) / sampleRate
    let real = 0
    let imag = 0
    for (let i = 0; i < n; i++) {
      const sample = buffer[start + i] || 0
      real += sample * Math.cos(omega * i)
      imag -= sample * Math.sin(omega * i)
    }
    const power = real * real + imag * imag
    all += power
    if (hz > fundamental * 1.6) harm += power
  }
  return all > 0 ? harm / all : 0
}

/** -1 is fully left, +1 is fully right, 0 is balanced. */
export function stereoBalance(left: Float32Array, right: Float32Array, start = 0) {
  const l = rms(left, start)
  const r = rms(right, start)
  const sum = l + r
  if (sum < 1e-8) return 0
  return (r - l) / sum
}

/** Seconds until the signal stays under `threshold` of its peak. */
export function tailSeconds(buffer: Float32Array, sampleRate = RATE, threshold = 0.02) {
  const peak = peakAbs(buffer)
  if (peak < 1e-8) return 0
  const gate = peak * threshold
  let last = 0
  for (let i = 0; i < buffer.length; i++) if (Math.abs(buffer[i]) >= gate) last = i
  return last / sampleRate
}

export function correlation(a: Float32Array, b: Float32Array, start = 0, shift = 0) {
  const n = Math.min(a.length, b.length - shift) - start
  if (n < 8) return 0
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    const x = a[start + i] || 0
    const y = b[start + i + shift] || 0
    dot += x * y
    aa += x * x
    bb += y * y
  }
  const den = Math.sqrt(aa * bb)
  return den > 1e-12 ? dot / den : 0
}

export function finite(buffer: Float32Array, limit = 4) {
  for (let i = 0; i < buffer.length; i++) {
    if (!Number.isFinite(buffer[i])) return false
    if (Math.abs(buffer[i]) > limit) return false
  }
  return true
}
