/**
 * Prototype key front-ends. This is our own code.
 *
 * The HPCP, tuning histogram, spectral whitening, and profile correlation
 * follow the published Gómez / Faraldo / Essentia KeyExtractor methods so the
 * benchmark can be compared with that system. Essentia itself is not imported.
 *
 * Pitch-class bin 0 is A, matching a 440 Hz reference. A positive tuning
 * offset means the audio is sharp of A440.
 */

import { fft, hann } from '../../src/analysis/fft.ts'

const FFT_SIZE = 4096
const HOP = 4096
const MIN_HZ = 25
const MAX_HZ = 3500
const PEAKS = 60
const PEAK_FLOOR = 0.0001
const LIVE_SECONDS = 24
const BINS = 12

export interface ChromaView {
  /** Harmonics on, whitened, reference locked to A440. */
  hpcp440: number[]
  /** Same, reference shifted by the estimated tuning. */
  hpcpTuned: number[]
  /** Tuned, but each peak votes only for its own pitch class. */
  hpcpNoHarm: number[]
  /** Tuned harmonics, peak magnitudes not whitened. */
  hpcpRaw: number[]
  /** Tuned fundamental pitches below 250 Hz. */
  bass: number[]
  /** Four equal time slices of the tuned HPCP. */
  segments: number[][]
  /** Global NNLS note activations, folded. Bin 0 is A. */
  nnls: number[]
  entropy: number
  lowShare: number
  flatness: number
}

export interface Extracted {
  seconds: number
  /** Cents sharp of A440, from the whole buffer. */
  cents: number
  liveCents: number
  frames: number
  liveFrames: number
  live: ChromaView
  full: ChromaView
  /** Four slices, 72 semitone bins from C2. Natural log magnitude. */
  cqtLive: number[][]
  cqtFull: number[][]
}

interface Peak {
  hz: number
  raw: number
  white: number
}

interface Frame {
  peaks: Peak[]
  cqt: Float32Array
  low: number
  total: number
  flat: number
}

function lin2db(value: number) {
  return value < 1e-10 ? -100 : 10 * Math.log10(value)
}

function db2lin(value: number) {
  return 10 ** (value / 10)
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/** Partials 1..n map onto pitch-class offsets, with octave partials stacked on the fundamental. */
function harmonicTable(harmonics: number) {
  const rows: { semitone: number; weight: number }[] = []
  const precision = 0.00001
  for (let i = 0; i <= harmonics; i++) {
    let semitone = 12 * Math.log2(i + 1)
    const octweight = Math.max(1, (semitone / 12) * 0.5)
    while (semitone >= 12 - precision) semitone -= 12
    const found = rows.find((row) => Math.abs(row.semitone - semitone) < precision)
    if (found) found.weight += 1 / octweight
    else rows.push({ semitone, weight: 1 / octweight })
  }
  return rows
}

const HARM4 = harmonicTable(4)
const HARM0 = harmonicTable(0)

function whiten(mag: Float32Array, sampleRate: number, peaks: { hz: number; raw: number }[]): number[] {
  const maxFreq = MAX_HZ * 1.2
  const spectralRange = sampleRate / 2
  const nPeaks = peaks.length
  const db = new Array<number>(nPeaks)
  for (let i = 0; i < nPeaks; i++) db[i] = 2 * lin2db(peaks[i].raw)
  let maxAmp = -1e9
  for (let i = 0; i < nPeaks; i++) {
    if (peaks[i].hz <= maxFreq) maxAmp = Math.max(maxAmp, db[i])
  }
  const xs: number[] = []
  const ys: number[] = []
  const specSize = mag.length
  for (let freq = 0; freq <= maxFreq && freq <= spectralRange; freq += 100) {
    const bf = freq - Math.max(50, freq * 0.34)
    const ef = freq + Math.max(50, freq * 0.58)
    let b = Math.round((bf / spectralRange) * (specSize - 1))
    let e = Math.round((ef / spectralRange) * (specSize - 1))
    b = Math.max(0, Math.min(specSize - 1, b))
    e = Math.max(b + 1, Math.min(specSize, e))
    const c = b / 2 + e / 2
    const half = e - c
    let n = 0
    let wavg = 0
    for (let i = b; i < e; i++) {
      let weight = 1 - Math.abs(i - c) / half
      weight *= weight
      weight *= weight
      const energy = mag[i] * mag[i]
      weight *= energy
      wavg += energy * weight
      n += weight
    }
    if (n !== 0) wavg /= n
    xs.push(freq)
    ys.push(wavg)
  }
  if (ys.length >= 2) ys[ys.length - 1] = ys[ys.length - 2]
  for (let i = 0; i < ys.length; i++) ys[i] = 2 * lin2db(Math.sqrt(ys[i]))
  const at = (freq: number) => {
    if (!xs.length) return -100
    if (freq <= xs[0]) return ys[0]
    if (freq >= xs[xs.length - 1]) return ys[ys.length - 1]
    let hi = 1
    while (hi < xs.length && xs[hi] < freq) hi++
    const lo = hi - 1
    const span = xs[hi] - xs[lo] || 1
    const t = (freq - xs[lo]) / span
    return ys[lo] * (1 - t) + ys[hi] * t
  }
  const out = new Array<number>(nPeaks)
  for (let i = 0; i < nPeaks; i++) {
    const freq = peaks[i].hz
    const amp = db[i]
    if (freq > maxFreq - 100) {
      out[i] = db2lin((amp - 20 * freq / 4000) / 2)
      continue
    }
    const env = at(freq)
    let white = amp
    if (amp < maxAmp - 40) white = (maxAmp - 40 - amp) / 2
    if (amp > env) white = 0
    else if (amp > env - 30) white = amp - env
    else white = -200
    white -= 20 * freq / 4000
    out[i] = db2lin(white / 2)
  }
  return out
}

function peaksOf(mag: Float32Array, sampleRate: number): Peak[] {
  const fftSize = mag.length * 2
  const binHz = sampleRate / fftSize
  const k0 = Math.max(2, Math.ceil(MIN_HZ / binHz))
  const k1 = Math.min(mag.length - 2, Math.floor(MAX_HZ / binHz))
  const found: { hz: number; raw: number }[] = []
  for (let k = k0; k <= k1; k++) {
    const mid = mag[k]
    if (mid < PEAK_FLOOR || mid < mag[k - 1] || mid < mag[k + 1]) continue
    const left = mag[k - 1]
    const right = mag[k + 1]
    const denom = left - 2 * mid + right
    const delta = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom))
    found.push({ hz: (k + delta) * binHz, raw: mid })
  }
  found.sort((a, b) => b.raw - a.raw)
  const kept = found.slice(0, PEAKS)
  const white = whiten(mag, sampleRate, kept)
  const peaks: Peak[] = []
  for (let i = 0; i < kept.length; i++) peaks.push({ hz: kept[i].hz, raw: kept[i].raw, white: white[i] || 0 })
  return peaks
}

function addPeak(hpcp: Float32Array, hz: number, mag: number, refHz: number, table: { semitone: number; weight: number }[], minHz: number) {
  if (!(hz > 0) || !(mag > 0)) return
  const size = hpcp.length
  const resolution = size / 12
  const windowSize = 1
  for (const harm of table) {
    const freq = hz * 2 ** (-harm.semitone / 12)
    if (freq < minHz || freq > MAX_HZ) continue
    const pcpBin = Math.log2(freq / refHz) * size
    const left = Math.ceil(pcpBin - (resolution * windowSize) / 2)
    const right = Math.floor(pcpBin + (resolution * windowSize) / 2)
    const gain = mag * mag * harm.weight * harm.weight
    for (let i = left; i <= right; i++) {
      const distance = Math.abs(pcpBin - i) / resolution
      const weight = Math.cos(Math.PI * (distance / windowSize))
      if (weight <= 0) continue
      let wrapped = i % size
      if (wrapped < 0) wrapped += size
      hpcp[wrapped] += weight * gain
    }
  }
}

function meanFrames(frames: Float32Array[], from: number, to: number) {
  const out = new Float32Array(BINS)
  const n = Math.max(1, to - from)
  for (let f = from; f < to; f++) {
    const row = frames[f]
    for (let i = 0; i < BINS; i++) out[i] += row[i]
  }
  for (let i = 0; i < BINS; i++) out[i] /= n
  return out
}

function segmentsOf(frames: Float32Array[], from: number, to: number) {
  const span = Math.max(1, to - from)
  const out: number[][] = []
  for (let part = 0; part < 4; part++) {
    const a = from + Math.floor((span * part) / 4)
    const b = from + Math.floor((span * (part + 1)) / 4)
    out.push(Array.from(meanFrames(frames, a, Math.max(a + 1, b))))
  }
  return out
}

function entropy01(chroma: ArrayLike<number>) {
  let sum = 0
  for (let i = 0; i < chroma.length; i++) sum += Math.max(0, chroma[i] || 0)
  if (sum <= 1e-12) return 1
  let h = 0
  for (let i = 0; i < chroma.length; i++) {
    const p = Math.max(0, chroma[i] || 0) / sum
    if (p > 1e-12) h -= p * Math.log(p)
  }
  return h / Math.log(chroma.length)
}

function tuningCents(histogram: Float32Array) {
  let best = 0
  let peak = -1
  for (let i = 0; i < histogram.length; i++) {
    if (histogram[i] > peak) {
      peak = histogram[i]
      best = i
    }
  }
  if (peak <= 0) return 0
  let cents = best - 50
  if (cents < -35) cents += 100
  return cents
}

function refHz(cents: number) {
  return 440 * 2 ** (cents / 1200)
}

interface NnlsDict {
  cols: { index: number; value: number }[][]
  pitch: number[]
}

function nnlsDictionary(sampleRate: number, cents: number): NnlsDict {
  const fftSize = FFT_SIZE
  const binHz = sampleRate / fftSize
  const nBins = fftSize / 2
  const cols: { index: number; value: number }[][] = []
  const pitch: number[] = []
  const tune = 2 ** (cents / 1200)
  for (let midi = 36; midi <= 84; midi++) {
    const f0 = tune * 440 * 2 ** ((midi - 69) / 12)
    const weights = [1, 0.5, 0.25, 0.12, 0.06]
    const bins = new Map<number, number>()
    for (let h = 0; h < weights.length; h++) {
      const freq = f0 * (h + 1)
      if (freq >= sampleRate / 2 || freq > 5000) break
      const k = freq / binHz
      const base = Math.floor(k)
      const frac = k - base
      if (base >= 1 && base < nBins) bins.set(base, (bins.get(base) || 0) + weights[h] * (1 - frac))
      if (base + 1 >= 1 && base + 1 < nBins) bins.set(base + 1, (bins.get(base + 1) || 0) + weights[h] * frac)
    }
    let norm = 0
    for (const value of bins.values()) norm += value * value
    norm = Math.sqrt(norm) || 1
    const col: { index: number; value: number }[] = []
    for (const [index, value] of bins) col.push({ index, value: value / norm })
    cols.push(col)
    pitch.push(((midi % 12) + 12) % 12)
  }
  return { cols, pitch }
}

function nnlsFold(mean: Float32Array, dict: NnlsDict) {
  const n = dict.cols.length
  const x = new Float64Array(n)
  x.fill(1 / n)
  const dx = new Float64Array(mean.length)
  for (let iter = 0; iter < 24; iter++) {
    dx.fill(0)
    for (let j = 0; j < n; j++) {
      const weight = x[j]
      if (weight === 0) continue
      for (const entry of dict.cols[j]) dx[entry.index] += entry.value * weight
    }
    const num = new Float64Array(n)
    const den = new Float64Array(n)
    for (let j = 0; j < n; j++) {
      for (const entry of dict.cols[j]) {
        num[j] += entry.value * (mean[entry.index] / (dx[entry.index] + 1e-8))
        den[j] += entry.value
      }
    }
    for (let j = 0; j < n; j++) x[j] = Math.max(0, x[j] * num[j] / (den[j] + 1e-8))
  }
  const chroma = new Float32Array(12)
  for (let j = 0; j < n; j++) chroma[dict.pitch[j]] += x[j]
  // Dictionary pitch 0 is C. Rotate so bin 0 is A, matching HPCP.
  const rotated = new Array<number>(12)
  for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + 9) % 12]
  return rotated
}

function frameSpectrum(samples: Float32Array, start: number, real: Float32Array, imag: Float32Array) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const sample = start + i < samples.length ? samples[start + i] || 0 : 0
    real[i] = sample * hann(i, FFT_SIZE)
    imag[i] = 0
  }
  fft(real, imag, false)
  const mag = new Float32Array(FFT_SIZE >> 1)
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(real[i], imag[i])
  return mag
}

function cqtOf(mag: Float32Array, sampleRate: number) {
  const out = new Float32Array(72)
  const fftSize = mag.length * 2
  const binHz = sampleRate / fftSize
  for (let semi = 0; semi < 72; semi++) {
    const midi = 36 + semi
    const lo = 440 * 2 ** ((midi - 0.5 - 69) / 12)
    const hi = 440 * 2 ** ((midi + 0.5 - 69) / 12)
    const a = Math.max(1, Math.floor(lo / binHz))
    const b = Math.min(mag.length - 1, Math.ceil(hi / binHz))
    let sum = 0
    for (let k = a; k <= b; k++) sum += mag[k]
    out[semi] = Math.log1p(sum / Math.max(1, b - a + 1))
  }
  return out
}

function accumulate(frames: Frame[], from: number, to: number, sampleRate: number, cents: number, kind: '440' | 'tuned' | 'noharm' | 'raw' | 'bass') {
  const rows: Float32Array[] = []
  const ref = kind === '440' ? 440 : refHz(cents)
  const table = kind === 'noharm' || kind === 'bass' ? HARM0 : HARM4
  const field = kind === 'raw' ? 'raw' : 'white'
  const minHz = kind === 'bass' ? 40 : MIN_HZ
  const maxHz = kind === 'bass' ? 250 : MAX_HZ
  for (let f = from; f < to; f++) {
    const row = new Float32Array(BINS)
    for (const peak of frames[f].peaks) {
      if (peak.hz < minHz || peak.hz > maxHz) continue
      addPeak(row, peak.hz, peak[field], ref, table, minHz)
    }
    rows.push(row)
  }
  if (!rows.length) rows.push(new Float32Array(BINS))
  return rows
}

function viewFrom(frames: Frame[], from: number, to: number, sampleRate: number, cents: number, meanMag: Float32Array): ChromaView {
  const end = Math.max(from + 1, to)
  const tuned = accumulate(frames, from, end, sampleRate, cents, 'tuned')
  const fixed = accumulate(frames, from, end, sampleRate, 0, '440')
  const noHarm = accumulate(frames, from, end, sampleRate, cents, 'noharm')
  const raw = accumulate(frames, from, end, sampleRate, cents, 'raw')
  const bass = accumulate(frames, from, end, sampleRate, cents, 'bass')
  const hpcpTuned = Array.from(meanFrames(tuned, 0, tuned.length))
  let low = 0
  let total = 0
  let flat = 0
  let flatN = 0
  for (let f = from; f < end && f < frames.length; f++) {
    low += frames[f].low
    total += frames[f].total
    if (frames[f].flat > 0) {
      flat += frames[f].flat
      flatN++
    }
  }
  return {
    hpcp440: Array.from(meanFrames(fixed, 0, fixed.length)),
    hpcpTuned,
    hpcpNoHarm: Array.from(meanFrames(noHarm, 0, noHarm.length)),
    hpcpRaw: Array.from(meanFrames(raw, 0, raw.length)),
    bass: Array.from(meanFrames(bass, 0, bass.length)),
    segments: segmentsOf(tuned, 0, tuned.length),
    nnls: nnlsFold(meanMag, nnlsDictionary(sampleRate, cents)),
    entropy: entropy01(hpcpTuned),
    lowShare: total > 0 ? low / total : 0,
    flatness: flatN > 0 ? flat / flatN : 1,
  }
}

function meanSpectrum(samples: Float32Array, sampleRate: number, from: number, to: number, mags: Float32Array[]) {
  const out = new Float32Array(FFT_SIZE >> 1)
  const n = Math.max(1, Math.min(mags.length, to) - from)
  for (let f = from; f < to && f < mags.length; f++) {
    const row = mags[f]
    for (let i = 0; i < out.length; i++) out[i] += row[i]
  }
  for (let i = 0; i < out.length; i++) out[i] /= n
  void samples
  void sampleRate
  return out
}

function sliceCqt(frames: Frame[], from: number, to: number) {
  const span = Math.max(1, to - from)
  const out: number[][] = []
  for (let part = 0; part < 4; part++) {
    const a = from + Math.floor((span * part) / 4)
    const b = Math.max(a + 1, from + Math.floor((span * (part + 1)) / 4))
    const acc = new Float64Array(72)
    let n = 0
    for (let f = a; f < b && f < to; f++) {
      const row = frames[f].cqt
      for (let i = 0; i < 72; i++) acc[i] += row[i]
      n++
    }
    const slice = new Array<number>(72)
    const denom = Math.max(1, n)
    for (let i = 0; i < 72; i++) slice[i] = acc[i] / denom
    out.push(slice)
  }
  return out
}

export function extract(samples: Float32Array, sampleRate: number): Extracted {
  const usable = Math.min(samples.length, Math.floor(sampleRate * 120))
  const real = new Float32Array(FFT_SIZE)
  const imag = new Float32Array(FFT_SIZE)
  const frames: Frame[] = []
  const spectra: Float32Array[] = []
  const histFull = new Float32Array(100)
  const histLive = new Float32Array(100)
  const globalFull = new Float32Array(100)
  const globalLive = new Float32Array(100)
  let liveFrames = 0
  for (let start = 0; start + FFT_SIZE <= usable; start += HOP) {
    const mag = frameSpectrum(samples, start, real, imag)
    const time = start / sampleRate
    const found = peaksOf(mag, sampleRate)
    histFull.fill(0)
    let frameEnergy = 0
    for (const peak of found) {
      if (!(peak.hz > 0)) continue
      const note = 12 * Math.log2(peak.hz / 440)
      const deviation = 100 * (note - Math.floor(note + 0.5))
      let index = Math.round(50 + deviation)
      if (index === 100) index = 0
      if (index < 0 || index > 99) continue
      histFull[index] += peak.white
      frameEnergy += peak.white * peak.white
    }
    let frameMax = 0
    let frameAt = 0
    for (let i = 0; i < 100; i++) if (histFull[i] > frameMax) {
      frameMax = histFull[i]
      frameAt = i
    }
    const frameCents = frameMax > 0 ? frameAt - 50 : 0
    let globalIndex = Math.round(50 + frameCents)
    if (globalIndex === 100) globalIndex = 0
    if (globalIndex < 0) globalIndex = 0
    globalFull[globalIndex] += frameEnergy
    if (time < LIVE_SECONDS) globalLive[globalIndex] += frameEnergy
    let low = 0
    let total = 0
    let logSum = 0
    let linSum = 0
    let count = 0
    const binHz = sampleRate / FFT_SIZE
    for (let k = 1; k < mag.length; k++) {
      const energy = mag[k] * mag[k]
      total += energy
      if (k * binHz < 200) low += energy
      if (mag[k] > 1e-8) {
        logSum += Math.log(mag[k])
        linSum += mag[k]
        count++
      }
    }
    const flat = count > 8 && linSum > 0 ? Math.exp(logSum / count) / (linSum / count) : 1
    frames.push({ peaks: found, cqt: cqtOf(mag, sampleRate), low, total, flat })
    spectra.push(mag)
    if (time < LIVE_SECONDS) liveFrames++
  }
  if (!frames.length) {
    const empty = emptyView()
    return {
      seconds: samples.length / sampleRate,
      cents: 0,
      liveCents: 0,
      frames: 0,
      liveFrames: 0,
      live: empty,
      full: empty,
      cqtLive: sliceCqt([], 0, 0),
      cqtFull: sliceCqt([], 0, 0),
    }
  }
  const cents = tuningCents(globalFull)
  const liveCents = tuningCents(globalLive)
  const fullMean = meanSpectrum(samples, sampleRate, 0, frames.length, spectra)
  const liveEnd = Math.max(1, Math.min(frames.length, liveFrames || 1))
  const liveMean = meanSpectrum(samples, sampleRate, 0, liveEnd, spectra)
  const full = viewFrom(frames, 0, frames.length, sampleRate, cents, fullMean)
  const live = liveEnd === frames.length ? full : viewFrom(frames, 0, liveEnd, sampleRate, liveCents, liveMean)
  return {
    seconds: usable / sampleRate,
    cents,
    liveCents,
    frames: frames.length,
    liveFrames: liveEnd,
    live,
    full,
    cqtLive: live === full ? sliceCqt(frames, 0, frames.length) : sliceCqt(frames, 0, liveEnd),
    cqtFull: sliceCqt(frames, 0, frames.length),
  }
}

function emptyView(): ChromaView {
  const zero = () => Array.from({ length: 12 }, () => 0)
  return {
    hpcp440: zero(),
    hpcpTuned: zero(),
    hpcpNoHarm: zero(),
    hpcpRaw: zero(),
    bass: zero(),
    segments: [zero(), zero(), zero(), zero()],
    nnls: zero(),
    entropy: 1,
    lowShare: 0,
    flatness: 1,
  }
}

export function roundChroma(values: number[], digits = 5) {
  const scale = 10 ** digits
  return values.map((value) => Math.round(value * scale) / scale)
}

export function confidenceOf(best: number, runner: number, entropy: number, segmentAgree: number) {
  const margin = best - runner
  let confidence = clamp01(0.5 * clamp01((best - 0.15) / 0.55) + 0.3 * clamp01(margin / 0.12) + 0.2 * clamp01(segmentAgree))
  if (entropy > 0.93) confidence *= 0.55
  if (margin < 0.04) confidence *= 0.75
  return clamp01(confidence)
}

export { LIVE_SECONDS, entropy01 }
