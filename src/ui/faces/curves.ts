/** Display curves. These are pictures of the settings, not the audio path. */

export function eqGainAt(freq: number, values: Record<string, number>) {
  const low = shelf(freq, values.lowF ?? values.f0 ?? 180, values.lowG ?? values.g0 ?? values.lfG ?? 0, true)
  const mid = bell(freq, values.midF ?? values.f1 ?? values.freq ?? 1500, values.midG ?? values.g1 ?? values.gain ?? 0, values.midQ ?? values.q1 ?? values.q ?? 1)
  const high = shelf(freq, values.highF ?? values.f2 ?? 8000, values.highG ?? values.g2 ?? 0, false)
  return low + mid + high
}

export const EQ_DB_MIN = -18
export const EQ_DB_MAX = 12
export const EQ_HZ_MIN = 20
export const EQ_HZ_MAX = 20000

export function eqPoints(values: Record<string, number>, count = 64) {
  const points: number[] = []
  for (let i = 0; i < count; i++) {
    const freq = EQ_HZ_MIN * Math.pow(EQ_HZ_MAX / EQ_HZ_MIN, i / (count - 1))
    points.push(eqGainAt(freq, values))
  }
  return points
}

export function freqToX(freq: number, width: number) {
  const t = Math.log(Math.max(EQ_HZ_MIN, freq) / EQ_HZ_MIN) / Math.log(EQ_HZ_MAX / EQ_HZ_MIN)
  return Math.max(0, Math.min(width, t * width))
}

export function xToFreq(x: number, width: number) {
  const t = Math.max(0, Math.min(1, x / Math.max(1, width)))
  return EQ_HZ_MIN * Math.pow(EQ_HZ_MAX / EQ_HZ_MIN, t)
}

export function dbToY(db: number, height: number) {
  const t = (EQ_DB_MAX - db) / (EQ_DB_MAX - EQ_DB_MIN)
  return Math.max(0, Math.min(height, t * height))
}

export function yToDb(y: number, height: number) {
  const t = Math.max(0, Math.min(1, y / Math.max(1, height)))
  return EQ_DB_MAX - t * (EQ_DB_MAX - EQ_DB_MIN)
}

/** Full-width response. The first point is x=0 and the last is x=width. */
export function eqPath(values: Record<string, number>, width: number, height: number, count = 64) {
  return eqPoints(values, count).map((db, index) => {
    const x = (index / (count - 1)) * width
    const y = dbToY(db, height)
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
}

export function transferGain(inputDb: number, threshold: number, ratio: number, knee: number) {
  const safeRatio = Math.max(1, ratio)
  const half = Math.max(0, knee) / 2
  if (inputDb < threshold - half) return inputDb
  if (knee > 0 && inputDb < threshold + half) {
    const x = inputDb - threshold + half
    return inputDb + ((1 / safeRatio - 1) * x * x) / (knee * 2 || 1)
  }
  return threshold + (inputDb - threshold) / safeRatio
}

export function transferPoints(threshold: number, ratio: number, knee: number, count = 32) {
  const points: number[] = []
  for (let i = 0; i < count; i++) {
    const input = -60 + (60 * i) / (count - 1)
    points.push(transferGain(input, threshold, ratio, knee))
  }
  return points
}

export function decaySteps(size: number, feedback: number, count = 16) {
  const tau = 0.15 + Math.max(0, size) * 1.4
  const loop = Math.max(0, Math.min(0.95, feedback))
  return Array.from({ length: count }, (_, index) => {
    const t = index / Math.max(1, count - 1)
    return Math.exp(-t / tau) * (1 - loop * 0.35) + loop * Math.exp(-t * (1.4 - loop))
  })
}

export function driveShape(drive: number, count = 32) {
  const k = 1 + Math.max(0, drive) * 8
  return Array.from({ length: count }, (_, index) => {
    const x = -1 + (2 * index) / (count - 1)
    return Math.tanh(x * k) / Math.tanh(k)
  })
}

function bell(freq: number, center: number, gain: number, q: number) {
  if (!gain) return 0
  const width = Math.max(0.15, 1.4 / Math.max(0.2, q))
  const x = Math.log(Math.max(1, freq) / Math.max(1, center))
  return gain * Math.exp(-(x * x) / (width * width))
}

function shelf(freq: number, corner: number, gain: number, low: boolean) {
  if (!gain) return 0
  const x = Math.log(Math.max(1, freq) / Math.max(1, corner))
  const side = low ? -x : x
  const t = 1 / (1 + Math.exp(-side * 3))
  return gain * t
}
