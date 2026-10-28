/** Display curves. These are pictures of the settings, not the audio path. */

export function eqGainAt(freq: number, values: Record<string, number>) {
  const low = shelf(freq, values.lowF ?? values.f0 ?? 180, values.lowG ?? values.g0 ?? values.lfG ?? 0, true)
  const mid = bell(freq, values.midF ?? values.f1 ?? values.freq ?? 1500, values.midG ?? values.g1 ?? values.gain ?? 0, values.midQ ?? values.q1 ?? values.q ?? 1)
  const high = shelf(freq, values.highF ?? values.f2 ?? 8000, values.highG ?? values.g2 ?? 0, false)
  return low + mid + high
}

export function eqPoints(values: Record<string, number>, count = 48) {
  const points: number[] = []
  for (let i = 0; i < count; i++) {
    const freq = 30 * Math.pow(20000 / 30, i / (count - 1))
    points.push(eqGainAt(freq, values))
  }
  return points
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
  const t = 1 / (1 + Math.exp((low ? 1 : -1) * x * 3))
  return gain * (low ? t : 1 - t)
}
