import type { SpectralPoint, SpectralRegion } from './types'

export function regionTime(region: SpectralRegion): [number, number] {
  let lo = 1
  let hi = 0
  for (const point of region.points) {
    lo = Math.min(lo, point.t)
    hi = Math.max(hi, point.t)
  }
  if (!region.points.length) return [0, 1]
  return [clamp(lo, 0, 1), clamp(hi, 0, 1)]
}

export function regionHz(region: SpectralRegion): [number, number] {
  let lo = Number.POSITIVE_INFINITY
  let hi = 0
  for (const point of region.points) {
    lo = Math.min(lo, point.hz)
    hi = Math.max(hi, point.hz)
  }
  if (!Number.isFinite(lo)) return [0, 0]
  return [lo, hi]
}

export function pointInPolygon(x: number, y: number, points: SpectralPoint[]) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    const hit = a.hz > y !== b.hz > y && x < ((b.t - a.t) * (y - a.hz)) / (b.hz - a.hz || 1e-12) + a.t
    if (hit) inside = !inside
  }
  return inside
}

/** Lasso tests run in log-frequency so a shape drawn on the spectrogram stays the shape. */
function lassoHit(t: number, hz: number, points: SpectralPoint[]) {
  const mapped = points.map((point) => ({ t: point.t, hz: Math.log(Math.max(1, point.hz)) }))
  return pointInPolygon(t, Math.log(Math.max(1, hz)), mapped)
}

export function regionContains(region: SpectralRegion, t: number, hz: number) {
  if (t < 0 || t > 1 || hz <= 0) return false
  if (region.tool === 'box') {
    const [t0, t1] = regionTime(region)
    const [f0, f1] = regionHz(region)
    return t >= t0 && t <= t1 && hz >= f0 && hz <= f1
  }
  if (region.tool === 'lasso') return lassoHit(t, hz, region.points)
  const fundamental = region.points[0]?.hz ?? 0
  if (fundamental <= 0) return false
  const [t0, t1] = regionTime(region)
  if (t < t0 || t > t1) return false
  const partials = Math.max(1, region.partials ?? 8)
  const width = region.width ?? 0.03
  for (let partial = 1; partial <= partials; partial++) {
    const center = fundamental * partial
    if (Math.abs(hz - center) <= center * width) return true
  }
  return false
}

export function broadband(region: SpectralRegion, sampleRate: number) {
  const [lo, hi] = regionHz(region)
  return hi - lo > sampleRate * 0.25
}

/** One weight per positive bin, including DC and Nyquist. 1 means fully selected. */
export function frameWeights(
  region: SpectralRegion,
  frames: number,
  fftSize: number,
  hop: number,
  sampleRate: number,
  length: number,
  pad: number,
): Float32Array[] {
  const bins = (fftSize >> 1) + 1
  const weights: Float32Array[] = []
  for (let frame = 0; frame < frames; frame++) {
    const row = new Float32Array(bins)
    const center = frame * hop + fftSize / 2 - pad
    const t = length > 0 ? center / length : 0
    for (let bin = 0; bin < bins; bin++) {
      const hz = (bin * sampleRate) / fftSize
      row[bin] = regionContains(region, t, hz) ? 1 : 0
    }
    weights.push(row)
  }
  if (region.tool === 'harmonic') return weights
  return feather(weights)
}

function feather(rows: Float32Array[]) {
  if (!rows.length) return rows
  const bins = rows[0].length
  const next = rows.map((row) => Float32Array.from(row))
  for (let frame = 0; frame < rows.length; frame++) {
    for (let bin = 0; bin < bins; bin++) {
      let sum = 0
      let weight = 0
      for (let df = -1; df <= 1; df++) {
        for (let db = -1; db <= 1; db++) {
          const rf = rows[frame + df]
          if (!rf) continue
          const value = rf[bin + db]
          if (value == null) continue
          const tap = df === 0 && db === 0 ? 0.5 : 0.0625
          sum += value * tap
          weight += tap
        }
      }
      next[frame][bin] = weight > 0 ? sum / weight : 0
    }
  }
  return next
}

function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value))
}
