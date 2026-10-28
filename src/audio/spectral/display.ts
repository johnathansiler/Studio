import { analyze, hann } from './fft'
import type { SpectralSettings } from './types'

export interface SpectrogramView {
  t0: number
  t1: number
  hz0: number
  hz1: number
}

export interface SpectrogramImage {
  width: number
  height: number
  /** Row-major RGB, magnitude painted dark → green → amber. */
  rgb: Uint8ClampedArray
  times: number
}

const PREVIEW: SpectralSettings = { fftSize: 1024, hop: 256 }

/** Magnitudes for the visible window. Hop grows on long clips so the draw stays light. */
export function previewSettings(length: number): SpectralSettings {
  const fftSize = length < 2048 ? 512 : PREVIEW.fftSize
  const target = 280
  const hop = Math.max(fftSize / 4, Math.ceil(length / target))
  return { fftSize, hop }
}

export function spectrogramColumns(channel: Float32Array, sampleRate: number, view: SpectrogramView) {
  const from = Math.max(0, Math.floor(view.t0 * channel.length))
  const to = Math.min(channel.length, Math.max(from + 8, Math.ceil(view.t1 * channel.length)))
  const slice = channel.subarray(from, to)
  const settings = previewSettings(slice.length)
  const window = hann(settings.fftSize)
  const spec = analyze(slice, settings.fftSize, settings.hop, window)
  const bins = (settings.fftSize >> 1) + 1
  const columns: Float32Array[] = []
  for (let frame = 0; frame < spec.re.length; frame++) {
    const column = new Float32Array(bins)
    for (let bin = 0; bin < bins; bin++) column[bin] = Math.hypot(spec.re[frame][bin], spec.im[frame][bin])
    columns.push(column)
  }
  return { columns, settings, sampleRate, from, span: Math.max(1, to - from) }
}

export function paintSpectrogram(
  channel: Float32Array,
  sampleRate: number,
  view: SpectrogramView,
  width: number,
  height: number,
) {
  const image = new Uint8ClampedArray(width * height * 4)
  const { columns, settings } = spectrogramColumns(channel, sampleRate, view)
  if (!columns.length || width < 2 || height < 2) return image
  for (let x = 0; x < width; x++) {
    const frame = Math.min(columns.length - 1, Math.floor((x / width) * columns.length))
    const column = columns[frame]
    for (let y = 0; y < height; y++) {
      const hz = hzAt(y / height, view.hz0, view.hz1)
      const bin = Math.min(column.length - 1, Math.max(0, Math.round((hz * settings.fftSize) / sampleRate)))
      const mag = column[bin] || 0
      const db = 20 * Math.log10(mag + 1e-8)
      const [r, g, b] = heat(db)
      const at = (y * width + x) * 4
      image[at] = r
      image[at + 1] = g
      image[at + 2] = b
      image[at + 3] = 255
    }
  }
  return image
}

export function hzAt(yFromTop: number, hz0: number, hz1: number) {
  const low = Math.log(Math.max(1, hz0))
  const high = Math.log(Math.max(hz0 + 1, hz1))
  const t = 1 - yFromTop
  return Math.exp(low + t * (high - low))
}

export function yForHz(hz: number, hz0: number, hz1: number) {
  const low = Math.log(Math.max(1, hz0))
  const high = Math.log(Math.max(hz0 + 1, hz1))
  const t = (Math.log(Math.max(1, hz)) - low) / (high - low || 1)
  return 1 - t
}

export function heat(db: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (db + 92) / 78))
  if (t < 0.45) {
    const u = t / 0.45
    return [Math.round(8 + u * 20), Math.round(18 + u * 90), Math.round(16 + u * 28)]
  }
  if (t < 0.8) {
    const u = (t - 0.45) / 0.35
    return [Math.round(28 + u * 196), Math.round(108 + u * 60), Math.round(44 - u * 20)]
  }
  const u = (t - 0.8) / 0.2
  return [Math.round(224 + u * 31), Math.round(168 + u * 70), Math.round(24 + u * 200)]
}

export function zoomView(view: SpectrogramView, anchorT: number, anchorHz: number, factor: number, nyquist: number): SpectrogramView {
  const nextSpan = clamp((view.t1 - view.t0) * factor, 0.02, 1)
  const hzSpan = Math.max(1.15, (view.hz1 / view.hz0) ** factor)
  let t0 = anchorT - (anchorT - view.t0) * (nextSpan / (view.t1 - view.t0 || 1))
  let t1 = t0 + nextSpan
  if (t0 < 0) {
    t1 -= t0
    t0 = 0
  }
  if (t1 > 1) {
    t0 -= t1 - 1
    t1 = 1
  }
  const low = Math.max(20, anchorHz / Math.sqrt(hzSpan))
  const high = Math.min(nyquist, low * hzSpan)
  return {
    t0: clamp(t0, 0, 0.98),
    t1: clamp(t1, 0.02, 1),
    hz0: Math.max(20, Math.min(low, nyquist / 1.2)),
    hz1: Math.max(Math.max(20, Math.min(low, nyquist / 1.2)) * 1.2, high),
  }
}

export function panView(view: SpectrogramView, dt: number, dLog: number, nyquist: number): SpectrogramView {
  const span = view.t1 - view.t0
  let t0 = view.t0 + dt
  let t1 = t0 + span
  if (t0 < 0) {
    t1 -= t0
    t0 = 0
  }
  if (t1 > 1) {
    t0 -= t1 - 1
    t1 = 1
  }
  const log0 = Math.log(view.hz0) + dLog
  const log1 = Math.log(view.hz1) + dLog
  let hz0 = Math.exp(log0)
  let hz1 = Math.exp(log1)
  if (hz0 < 20) {
    hz1 *= 20 / hz0
    hz0 = 20
  }
  if (hz1 > nyquist) {
    hz0 *= nyquist / hz1
    hz1 = nyquist
  }
  return { t0, t1, hz0: Math.max(20, hz0), hz1: Math.min(nyquist, Math.max(hz0 * 1.2, hz1)) }
}

function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value))
}
