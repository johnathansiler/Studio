/**
 * Multi-resolution min/max cache for waveform drawing.
 * Built once on the UI thread from a copied buffer. Playback never calls this.
 */

export interface PeakLevel {
  /** Samples represented by one bin. */
  leaf: number
  min: Float32Array
  max: Float32Array
}

export interface PeakPyramid {
  length: number
  levels: PeakLevel[]
}

export interface PeakBin {
  min: number
  max: number
}

export function buildPeakPyramid(channel: ArrayLike<number>, leaf = 64): PeakPyramid {
  const length = channel.length | 0
  if (length <= 0) return { length: 0, levels: [] }
  const step = Math.max(1, leaf | 0)
  const bins = Math.max(1, Math.ceil(length / step))
  const min = new Float32Array(bins)
  const max = new Float32Array(bins)
  for (let bin = 0; bin < bins; bin++) {
    const from = bin * step
    const to = Math.min(length, from + step)
    let lo = 0
    let hi = 0
    for (let i = from; i < to; i++) {
      const value = channel[i] || 0
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
    min[bin] = lo
    max[bin] = hi
  }
  const levels: PeakLevel[] = [{ leaf: step, min, max }]
  let prevMin = min
  let prevMax = max
  let size = step
  const group = 4
  while (prevMin.length > 8) {
    const nextBins = Math.ceil(prevMin.length / group)
    if (nextBins >= prevMin.length) break
    const nextMin = new Float32Array(nextBins)
    const nextMax = new Float32Array(nextBins)
    for (let bin = 0; bin < nextBins; bin++) {
      const from = bin * group
      const to = Math.min(prevMin.length, from + group)
      let lo = 0
      let hi = 0
      for (let i = from; i < to; i++) {
        if (prevMin[i] < lo) lo = prevMin[i]
        if (prevMax[i] > hi) hi = prevMax[i]
      }
      nextMin[bin] = lo
      nextMax[bin] = hi
    }
    size *= group
    levels.push({ leaf: size, min: nextMin, max: nextMax })
    prevMin = nextMin
    prevMax = nextMax
  }
  return { length, levels }
}

/** One min/max per column for a sample span. Uses the finest pyramid level that still covers a column. */
export function peaksForSpan(pyramid: PeakPyramid, start: number, end: number, columns: number): PeakBin[] {
  const cols = Math.max(1, columns | 0)
  const out: PeakBin[] = []
  if (!pyramid.levels.length || pyramid.length <= 0) {
    for (let i = 0; i < cols; i++) out.push({ min: 0, max: 0 })
    return out
  }
  const from = Math.max(0, Math.min(pyramid.length - 1, start))
  const to = Math.max(from + 1, Math.min(pyramid.length, end))
  const span = to - from
  const perColumn = span / cols
  let level = pyramid.levels[0]
  for (const candidate of pyramid.levels) {
    if (candidate.leaf <= perColumn * 2) level = candidate
    else break
  }
  for (let column = 0; column < cols; column++) {
    const sample0 = from + (column * span) / cols
    const sample1 = from + ((column + 1) * span) / cols
    const bin0 = Math.max(0, Math.floor(sample0 / level.leaf))
    const bin1 = Math.min(level.min.length, Math.max(bin0 + 1, Math.ceil(sample1 / level.leaf)))
    let lo = 0
    let hi = 0
    for (let bin = bin0; bin < bin1; bin++) {
      if (level.min[bin] < lo) lo = level.min[bin]
      if (level.max[bin] > hi) hi = level.max[bin]
    }
    out.push({ min: lo, max: hi })
  }
  return out
}
