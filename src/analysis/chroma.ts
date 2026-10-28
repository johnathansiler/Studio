import { fft, hann } from './fft'

const BINS = 36

export interface SpectralFrame {
  /** Seconds at the center of the window. */
  time: number
  /** Three bins per semitone, folded later once the tuning is known. */
  fine: Float32Array
  /** Pitch classes estimated from energy below ~200 Hz. */
  bass: Float32Array
  rms: number
  /** Half-wave spectral flux, for tempo and onsets. */
  flux: number
}

export function chooseFft(sampleRate: number) {
  const want = Math.round(sampleRate / 5)
  let n = 2048
  while (n < want && n < 8192) n <<= 1
  return n
}

function prefixMean(mag: Float32Array, radius: number) {
  const n = mag.length
  const prefix = new Float32Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + mag[i]
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius)
    const b = Math.min(n, i + radius + 1)
    out[i] = (prefix[b] - prefix[a]) / Math.max(1, b - a)
  }
  return out
}

function mod(n: number, base: number) {
  return ((n % base) + base) % base
}

/** Add a spectral peak into the 36-bin pitch-class profile. */
function addPeak(fine: Float32Array, hz: number, weight: number, refHz: number) {
  if (!(hz > 20) || !(weight > 0)) return
  const midi = 69 + 12 * Math.log2(hz / refHz)
  const pos = midi * 3
  const base = Math.floor(pos)
  const frac = pos - base
  fine[mod(base, BINS)] += weight * (1 - frac)
  fine[mod(base + 1, BINS)] += weight * frac
}

interface Peak {
  hz: number
  weight: number
}

function peaksOf(mag: Float32Array, sampleRate: number, lowHz: number, highHz: number): Peak[] {
  const n = mag.length
  let maxMag = 0
  for (let i = 1; i < n; i++) if (mag[i] > maxMag) maxMag = mag[i]
  if (maxMag < 1e-8) return []
  const floor = maxMag * 1e-4
  const mean = prefixMean(mag, 16)
  const peaks: Peak[] = []
  const nyquist = (n - 2) * (sampleRate / (n * 2))
  const hi = Math.min(highHz, nyquist)
  for (let k = 2; k < n - 2; k++) {
    const hz = (k * sampleRate) / (n * 2)
    if (hz < lowHz || hz > hi) continue
    if (mag[k] < floor || mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue
    const white = mag[k] / (mean[k] + floor)
    if (white < 1.7) continue
    const left = mag[k - 1]
    const mid = mag[k]
    const right = mag[k + 1]
    const denom = left - 2 * mid + right
    const shift = denom === 0 ? 0 : (0.5 * (left - right)) / denom
    const clamped = Math.max(-0.5, Math.min(0.5, shift))
    peaks.push({ hz: ((k + clamped) * sampleRate) / (n * 2), weight: mid })
  }
  peaks.sort((a, b) => b.weight - a.weight)
  return peaks.slice(0, 24)
}

function fluxBetween(prev: Float32Array | null, mag: Float32Array) {
  if (!prev) return 0
  let sum = 0
  const bins = Math.min(prev.length, mag.length)
  for (let i = 1; i < bins; i++) {
    const delta = Math.log1p(mag[i]) - Math.log1p(prev[i])
    if (delta > 0) sum += delta
  }
  return sum
}

/**
 * Harmonic pitch-class profiles. Each frame keeps a 36-bin chroma so a later
 * pass can slide the tuning by a third of a semitone without another FFT.
 */
export function spectralFrames(samples: Float32Array, sampleRate: number): SpectralFrame[] {
  const fftSize = chooseFft(sampleRate)
  let hop = fftSize >> 2
  const maxFrames = 2800
  if (samples.length / hop > maxFrames) hop = Math.max(1, Math.ceil(samples.length / maxFrames))
  const window = new Float32Array(fftSize)
  const real = new Float32Array(fftSize)
  const imag = new Float32Array(fftSize)
  const frames: SpectralFrame[] = []
  let prev: Float32Array | null = null
  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    let energy = 0
    for (let i = 0; i < fftSize; i++) {
      const sample = samples[start + i] || 0
      energy += sample * sample
      window[i] = sample
    }
    const rms = Math.sqrt(energy / fftSize)
    const fine = new Float32Array(BINS)
    const bass = new Float32Array(12)
    let flux = 0
    if (rms > 1e-5) {
      for (let i = 0; i < fftSize; i++) real[i] = window[i] * hann(i, fftSize)
      imag.fill(0)
      fft(real, imag, false)
      const bins = fftSize >> 1
      const mag = new Float32Array(bins)
      for (let i = 0; i < bins; i++) mag[i] = Math.hypot(real[i], imag[i])
      flux = fluxBetween(prev, mag)
      prev = mag
      for (const peak of peaksOf(mag, sampleRate, 55, 5000)) {
        addPeak(fine, peak.hz, peak.weight, 440)
        // A strong partial also votes, more quietly, for the fundamental an octave or a twelfth down.
        if (peak.hz > 140) addPeak(fine, peak.hz / 2, peak.weight * 0.18, 440)
        if (peak.hz > 210) addPeak(fine, peak.hz / 3, peak.weight * 0.08, 440)
      }
      for (const peak of peaksOf(mag, sampleRate, 40, 220)) {
        const midi = 69 + 12 * Math.log2(peak.hz / 440)
        const pc = mod(Math.round(midi), 12)
        bass[pc] += peak.weight
      }
    } else {
      prev = null
    }
    frames.push({ time: (start + fftSize / 2) / sampleRate, fine, bass, rms, flux })
  }
  return frames
}

/** Fold 36-bin chroma onto 12 pitch classes. `shift` is in third-semitone steps. */
export function foldChroma(fine: Float32Array, shift: number) {
  const out = new Float32Array(12)
  for (let i = 0; i < BINS; i++) {
    const pc = mod(Math.round((i + shift) / 3), 12)
    out[pc] += fine[i] || 0
  }
  return out
}

/** Pick the tuning offset whose folded chroma is the most peaked. */
export function tuningShift(frames: SpectralFrame[]) {
  const avg = new Float32Array(BINS)
  for (const frame of frames) {
    for (let i = 0; i < BINS; i++) avg[i] += frame.fine[i]
  }
  let best = 0
  let bestPeak = -1
  for (const shift of [-1, 0, 1]) {
    const folded = foldChroma(avg, shift)
    let sum = 0
    let max = 0
    for (let i = 0; i < 12; i++) {
      sum += folded[i]
      if (folded[i] > max) max = folded[i]
    }
    const peak = sum > 0 ? max / sum : 0
    if (peak > bestPeak) {
      bestPeak = peak
      best = shift
    }
  }
  return best
}

export function normalizeChroma(chroma: Float32Array) {
  let sum = 0
  for (let i = 0; i < chroma.length; i++) sum += chroma[i]
  if (sum <= 1e-8) return chroma
  for (let i = 0; i < chroma.length; i++) chroma[i] /= sum
  return chroma
}
