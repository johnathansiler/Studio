/**
 * Harmonic pitch-class profile key reader.
 *
 * Peaks are whitened, then each peak votes for its own pitch class and for
 * the lower pitches that would have it as a harmonic. A one-semitone cosine
 * window spreads that vote. The result is correlated with the Essentia EDMA
 * profiles. Reference is A440, so pitch-class bin 0 is A.
 *
 * This is our own code. The steps follow the published Gómez HPCP and the
 * Essentia KeyExtractor settings that were measured for this app: 4 harmonics,
 * cosine window, 25–3500 Hz, no extra tuning search.
 */

import { fft, hann } from './fft'
import type { KeyCandidate, KeyReading } from './clipKey'

export type KeyProfile = 'edma' | 'temperley' | 'krumhansl' | 'blend'

const FFT_SIZE = 4096
const HOP = 4096
const MIN_HZ = 25
const MAX_HZ = 3500
const PEAKS = 60
const PEAK_FLOOR = 0.0001
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
const GATE = 0.55

const EDMA_MAJOR = [1, 0.29, 0.5, 0.4, 0.6, 0.56, 0.32, 0.8, 0.31, 0.45, 0.42, 0.39]
const EDMA_MINOR = [1, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32]
const TEMP_MAJOR = [5, 2, 3.5, 2, 4.5, 4, 2, 4.5, 2, 3.5, 1.5, 4]
const TEMP_MINOR = [5, 2, 3.5, 4.5, 2, 4, 2, 4.5, 3.5, 2, 1.5, 4]
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const PROFILES: Record<Exclude<KeyProfile, 'blend'>, { major: number[]; minor: number[] }> = {
  edma: { major: EDMA_MAJOR, minor: EDMA_MINOR },
  temperley: { major: TEMP_MAJOR, minor: TEMP_MINOR },
  krumhansl: { major: KK_MAJOR, minor: KK_MINOR },
}

interface Peak {
  hz: number
  raw: number
  white: number
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

function whiten(mag: Float32Array, sampleRate: number, peaks: { hz: number; raw: number }[]) {
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
    const half = Math.max(1, e - c)
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
  for (let i = 0; i < ys.length; i++) ys[i] = 2 * lin2db(Math.sqrt(Math.max(0, ys[i])))
  const at = (freq: number) => {
    if (!xs.length) return -100
    if (freq <= xs[0]) return ys[0]
    if (freq >= xs[xs.length - 1]) return ys[ys.length - 1]
    let hi = 1
    while (hi < xs.length && xs[hi] < freq) hi++
    const lo = Math.max(0, hi - 1)
    const span = xs[hi] - xs[lo] || 1
    const t = (freq - xs[lo]) / span
    return ys[lo] * (1 - t) + ys[hi] * t
  }
  const out = new Array<number>(nPeaks)
  for (let i = 0; i < nPeaks; i++) {
    const freq = peaks[i].hz
    const amp = db[i]
    let white = amp
    if (freq <= maxFreq - 100) {
      const env = at(freq)
      if (amp < maxAmp - 40) white = (maxAmp - 40 - amp) / 2
      if (amp > env) white = 0
      else if (amp > env - 30) white = amp - env
      else white = -200
      white -= (20 * freq) / 4000
    }
    out[i] = db2lin(white / 2)
  }
  return out
}

function peaksOf(mag: Float32Array, sampleRate: number): Peak[] {
  const binHz = sampleRate / FFT_SIZE
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

function addPeak(hpcp: Float32Array, hz: number, mag: number) {
  if (!(hz > 0) || !(mag > 0)) return
  const size = hpcp.length
  const resolution = size / 12
  for (const harm of HARM4) {
    const freq = hz * 2 ** (-harm.semitone / 12)
    if (freq < MIN_HZ || freq > MAX_HZ) continue
    const pcpBin = Math.log2(freq / 440) * size
    const left = Math.ceil(pcpBin - resolution / 2)
    const right = Math.floor(pcpBin + resolution / 2)
    const gain = mag * mag * harm.weight * harm.weight
    for (let i = left; i <= right; i++) {
      const distance = Math.abs(pcpBin - i) / resolution
      const weight = Math.cos(Math.PI * distance)
      if (weight <= 0) continue
      let wrapped = i % size
      if (wrapped < 0) wrapped += size
      hpcp[wrapped] += weight * gain
    }
  }
}

function gatePcp(pcp: Float32Array) {
  let max = 0
  for (let i = 0; i < pcp.length; i++) if (pcp[i] > max) max = pcp[i]
  const out = new Float32Array(pcp.length)
  if (max <= 1e-12) return out
  for (let i = 0; i < pcp.length; i++) {
    const scaled = pcp[i] / max
    out[i] = scaled < 0.2 ? 0 : scaled
  }
  return out
}

function pearsonShift(pcp: Float32Array, profile: number[], shift: number) {
  const n = 12
  let mean1 = 0
  let mean2 = 0
  for (let i = 0; i < n; i++) {
    mean1 += pcp[i]
    mean2 += profile[i]
  }
  mean1 /= n
  mean2 /= n
  let std1 = 0
  let std2 = 0
  let dot = 0
  for (let i = 0; i < n; i++) {
    const index = (i - shift + n) % n
    const a = pcp[i] - mean1
    const b = profile[index] - mean2
    dot += a * b
    std1 += a * a
    std2 += b * b
  }
  std1 = Math.sqrt(std1)
  std2 = Math.sqrt(std2)
  if (std1 < 1e-8 || std2 < 1e-8) return 0
  return dot / (std1 * std2)
}

interface Ranked {
  root: number
  minor: boolean
  corr: number
}

function rank(pcp: Float32Array, profile: KeyProfile): Ranked[] {
  const gated = gatePcp(pcp)
  const rows: Ranked[] = []
  const sets = profile === 'blend'
    ? [PROFILES.edma, PROFILES.temperley, PROFILES.krumhansl]
    : [PROFILES[profile]]
  for (let shift = 0; shift < 12; shift++) {
    const root = (9 + shift) % 12
    let major = 0
    let minor = 0
    for (const set of sets) {
      major += pearsonShift(gated, set.major, shift)
      minor += pearsonShift(gated, set.minor, shift)
    }
    const scale = sets.length
    rows.push({ root, minor: false, corr: major / scale })
    rows.push({ root, minor: true, corr: minor / scale })
  }
  rows.sort((a, b) => b.corr - a.corr)
  return rows
}

function candidate(row: Ranked, score: number): KeyCandidate {
  return {
    root: row.root,
    minor: row.minor,
    name: `${NAMES[row.root]} ${row.minor ? 'minor' : 'major'}`,
    corr: row.corr,
    score,
  }
}

export function blankKey(): KeyReading {
  return {
    clear: false,
    label: 'No clear key',
    root: null,
    scale: '',
    confidence: 0,
    alt: null,
    cents: 0,
    tonal: 0,
    best: null,
  }
}

interface Heard {
  pcp: Float32Array
  duty: number
  flatness: number
  peakShare: number
}

function analyse(samples: Float32Array, sampleRate: number): Heard {
  const usable = Math.min(samples.length, Math.floor(sampleRate * 120))
  const real = new Float32Array(FFT_SIZE)
  const imag = new Float32Array(FFT_SIZE)
  const pcp = new Float32Array(12)
  let frames = 0
  let peakRms = 0
  const rmses: number[] = []
  let flatSum = 0
  let flatN = 0
  let specEnergy = 0
  let peakEnergy = 0
  for (let start = 0; start + FFT_SIZE <= usable; start += HOP) {
    let energy = 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = samples[start + i] || 0
      energy += sample * sample
      real[i] = sample * hann(i, FFT_SIZE)
      imag[i] = 0
    }
    const rms = Math.sqrt(energy / FFT_SIZE)
    rmses.push(rms)
    if (rms > peakRms) peakRms = rms
    fft(real, imag, false)
    const mag = new Float32Array(FFT_SIZE >> 1)
    let logSum = 0
    let linSum = 0
    let count = 0
    for (let k = 0; k < mag.length; k++) {
      const value = Math.hypot(real[k], imag[k])
      mag[k] = value
      specEnergy += value
      if (value > 1e-8) {
        logSum += Math.log(value)
        linSum += value
        count++
      }
    }
    if (count > 8 && linSum > 0) {
      flatSum += Math.exp(logSum / count) / (linSum / count)
      flatN++
    }
    const peaks = peaksOf(mag, sampleRate)
    for (const peak of peaks) {
      peakEnergy += peak.raw
      addPeak(pcp, peak.hz, peak.white)
    }
    frames++
  }
  let loud = 0
  const gate = peakRms * 0.18
  for (const rms of rmses) if (rms >= gate) loud++
  return {
    pcp,
    duty: frames > 0 ? loud / frames : 0,
    flatness: flatN > 0 ? flatSum / flatN : 1,
    peakShare: specEnergy > 0 ? peakEnergy / specEnergy : 0,
  }
}

function confidenceOf(best: number, runner: number) {
  const margin = best - runner
  return clamp01(0.55 * clamp01((best - 0.15) / 0.55) + 0.45 * clamp01(margin / 0.12))
}

/** A drum hit, a one-shot burst, or noise. These are not given a key name. */
function refusesName(heard: Heard, bestCorr: number) {
  if (heard.duty < 0.22 && bestCorr < 0.92) return true
  if (heard.flatness > 0.42) return true
  if (heard.peakShare < 0.015 && bestCorr < 0.55) return true
  if (bestCorr < 0.28) return true
  return false
}

export function readHpcpKey(samples: Float32Array, sampleRate: number, profile: KeyProfile = 'edma'): KeyReading {
  const blank = blankKey()
  if (samples.length < 256 || !(sampleRate > 0)) return blank
  const heard = analyse(samples, sampleRate)
  const ranked = rank(heard.pcp, profile)
  const best = ranked[0]
  const runner = ranked[1]
  if (!best) return blank
  const confidence = confidenceOf(best.corr, runner?.corr ?? 0)
  const tonal = clamp01(1 - heard.flatness)
  if (refusesName(heard, best.corr)) {
    return { ...blank, confidence, cents: 0, tonal }
  }
  const winner = candidate(best, best.corr)
  const alt = runner && runner.corr > 0.15 ? candidate(runner, runner.corr) : null
  if (confidence < GATE) {
    return {
      clear: false,
      label: 'Unsure',
      root: null,
      scale: '',
      confidence,
      alt,
      cents: 0,
      tonal,
      best: winner,
      unsure: true,
    }
  }
  return {
    clear: true,
    label: winner.name,
    root: winner.root,
    scale: winner.minor ? 'aeolian' : 'ionian',
    confidence,
    alt,
    cents: 0,
    tonal,
    best: winner,
  }
}
