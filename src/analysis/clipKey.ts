/**
 * Key and tempo of one audio clip.
 *
 * Key listens to the audio as it sounds: a 36-bin harmonic pitch-class profile
 * (peak STFT, three bins per semitone), a tuning search around A440, then
 * Krumhansl–Kessler, Temperley, and EDMA major/minor profiles. The top two
 * candidates are kept because a relative major and minor share the same notes.
 *
 * Tempo listens to the source, before the stretch: an onset-strength envelope,
 * its autocorrelation, and a comb tempogram.
 *
 * Both run on plain PCM. The worker renders the stretch first so the key is
 * the pitch the clip is playing, including transpose.
 */

import { chooseFft, foldChroma } from './chroma'
import { fft, hann } from './fft'
import type { ClipHearing } from '../model/types'

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
const BINS = 36

/** Krumhansl–Kessler probe-tone profiles. */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/** Temperley, Music and Probability. */
const TEMP_MAJOR = [5, 2, 3.5, 2, 4.5, 4, 2, 4.5, 2, 3.5, 1.5, 4]
const TEMP_MINOR = [5, 2, 3.5, 4.5, 2, 4, 2, 4.5, 3.5, 2, 1.5, 4]

/** Faraldo EDMA profiles, the ones Essentia ships for loop-like music. */
const EDMA_MAJOR = [1, 0.157808021, 0.366133251, 0.127058867, 0.588516922, 0.332227667, 0.107226417, 0.710546603, 0.15476814, 0.373265925, 0.097658604, 0.443561062]
const EDMA_MINOR = [1, 0.150171156, 0.378050852, 0.45244178, 0.139651959, 0.385338478, 0.122140361, 0.696360448, 0.394150762, 0.188959016, 0.200616277, 0.346860558]

const MAJOR_PROFILES = [KK_MAJOR, TEMP_MAJOR, EDMA_MAJOR]
const MINOR_PROFILES = [KK_MINOR, TEMP_MINOR, EDMA_MINOR]

export interface KeyCandidate {
  root: number
  minor: boolean
  name: string
  /** Mean Pearson correlation of the three profiles. */
  corr: number
  score: number
}

export interface KeyReading {
  clear: boolean
  label: string
  root: number | null
  scale: '' | 'ionian' | 'aeolian'
  confidence: number
  alt: KeyCandidate | null
  /** Cents sharp of A440. Positive means the audio is sharp. */
  cents: number
  tonal: number
  best: KeyCandidate | null
}

export interface TempoReading {
  bpm: number
  confidence: number
}

interface Gather {
  fine: Float32Array
  bass: Float32Array
  segments: Float32Array[]
  tonal: number
  rms: number
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function mod(n: number, base: number) {
  return ((n % base) + base) % base
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>) {
  const n = Math.min(a.length, b.length)
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    sa += a[i] || 0
    sb += b[i] || 0
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = (a[i] || 0) - ma
    const xb = (b[i] || 0) - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  if (da <= 1e-12 || db <= 1e-12) return 0
  return num / Math.sqrt(da * db)
}

function rotate(hist: ArrayLike<number>, root: number) {
  const out = new Array<number>(12)
  for (let i = 0; i < 12; i++) out[i] = hist[(i + root) % 12] || 0
  return out
}

function rotateBins(src: Float32Array, shift: number) {
  const out = new Float32Array(BINS)
  const s = ((shift % BINS) + BINS) % BINS
  const base = Math.floor(s)
  const frac = s - base
  for (let i = 0; i < BINS; i++) {
    const a = src[(i + base) % BINS] || 0
    const b = src[(i + base + 1) % BINS] || 0
    out[i] = a * (1 - frac) + b * frac
  }
  return out
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
  const mean = prefixMean(mag, 12)
  const peaks: Peak[] = []
  const nyquist = (n - 2) * (sampleRate / (n * 2))
  const hi = Math.min(highHz, nyquist)
  for (let k = 2; k < n - 2; k++) {
    const hz = (k * sampleRate) / (n * 2)
    if (hz < lowHz || hz > hi) continue
    if (mag[k] < floor || mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue
    const white = mag[k] / (mean[k] + floor)
    if (white < 1.45) continue
    const left = mag[k - 1]
    const mid = mag[k]
    const right = mag[k + 1]
    const denom = left - 2 * mid + right
    const delta = denom === 0 ? 0 : (0.5 * (left - right)) / denom
    const shift = Math.max(-0.5, Math.min(0.5, delta))
    peaks.push({ hz: ((k + shift) * sampleRate) / (n * 2), weight: Math.log1p(mid) })
  }
  peaks.sort((a, b) => b.weight - a.weight)
  return peaks.slice(0, 28)
}

function addPeak(fine: Float32Array, hz: number, weight: number) {
  if (!(hz > 20) || !(weight > 0)) return
  const midi = 69 + 12 * Math.log2(hz / 440)
  const pos = midi * 3
  const base = Math.floor(pos)
  const frac = pos - base
  fine[mod(base, BINS)] += weight * (1 - frac)
  fine[mod(base + 1, BINS)] += weight * frac
}

function emptyGather(parts: number): Gather {
  return {
    fine: new Float32Array(BINS),
    bass: new Float32Array(BINS),
    segments: Array.from({ length: parts }, () => new Float32Array(BINS)),
    tonal: 0,
    rms: 0,
  }
}

/** HPCP frames, referenced to A440 so a later pass can slide the tuning. */
function gather(samples: Float32Array, sampleRate: number): Gather {
  const limit = Math.min(samples.length, Math.round(sampleRate * 24))
  const data = samples.subarray(0, limit)
  const parts = 4
  const found = emptyGather(parts)
  if (data.length < 64 || !(sampleRate > 0)) return found
  const fftSize = chooseFft(sampleRate)
  let hop = fftSize >> 2
  const maxFrames = 900
  if (data.length / hop > maxFrames) hop = Math.max(1, Math.ceil(data.length / maxFrames))
  const real = new Float32Array(fftSize)
  const imag = new Float32Array(fftSize)
  let peakEnergy = 0
  let specEnergy = 0
  const duration = data.length / sampleRate
  for (let start = 0; start + fftSize <= data.length; start += hop) {
    let energy = 0
    for (let i = 0; i < fftSize; i++) {
      const sample = data[start + i] || 0
      energy += sample * sample
      real[i] = sample * hann(i, fftSize)
    }
    const rms = Math.sqrt(energy / fftSize)
    if (rms < 1e-5) continue
    imag.fill(0)
    fft(real, imag, false)
    const bins = fftSize >> 1
    const mag = new Float32Array(bins)
    for (let i = 0; i < bins; i++) {
      mag[i] = Math.hypot(real[i], imag[i])
      specEnergy += mag[i]
    }
    const time = (start + fftSize / 2) / sampleRate
    const edge = time < duration * 0.18 || time > duration * 0.82 ? 1.35 : 1
    const weight = rms * edge
    const part = Math.min(parts - 1, Math.max(0, Math.floor((time / Math.max(0.001, duration)) * parts)))
    const fine = found.segments[part]
    for (const peak of peaksOf(mag, sampleRate, 50, 5000)) {
      const emphasis = 1 + Math.min(2.2, 140 / peak.hz)
      const w = peak.weight * emphasis
      addPeak(fine, peak.hz, w)
      addPeak(found.fine, peak.hz, w * weight)
      peakEnergy += peak.weight
      if (peak.hz < 220) addPeak(found.bass, peak.hz, w * weight * 1.4)
    }
    found.rms += rms
  }
  found.tonal = specEnergy > 0 ? peakEnergy / specEnergy : 0
  return found
}

function foldAt(fine: Float32Array, cents: number) {
  const bins = cents * 0.03
  return foldChroma(rotateBins(fine, bins), 0)
}

function profileCorr(chroma: ArrayLike<number>, root: number, minor: boolean) {
  const profiles = minor ? MINOR_PROFILES : MAJOR_PROFILES
  const turned = rotate(chroma, root)
  let sum = 0
  for (const profile of profiles) sum += pearson(turned, profile)
  return sum / profiles.length
}

function triadEnergy(chroma: ArrayLike<number>, root: number, minor: boolean) {
  const third = (root + (minor ? 3 : 4)) % 12
  const fifth = (root + 7) % 12
  const avoid = (root + (minor ? 4 : 3)) % 12
  return (chroma[root] || 0) + (chroma[third] || 0) + 0.75 * (chroma[fifth] || 0) - 0.55 * (chroma[avoid] || 0)
}

function bestTriad(chroma: ArrayLike<number>) {
  let bestRoot = 0
  let bestMinor = false
  let best = -Infinity
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const energy = triadEnergy(chroma, root, minor)
      if (energy > best) {
        best = energy
        bestRoot = root
        bestMinor = minor
      }
    }
  }
  return { root: bestRoot, minor: bestMinor, energy: best }
}

function salientCount(chroma: ArrayLike<number>) {
  let max = 0
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const value = chroma[i] || 0
    sum += value
    if (value > max) max = value
  }
  if (max <= 0 || sum <= 0) return 0
  let count = 0
  for (let i = 0; i < 12; i++) if ((chroma[i] || 0) > max * 0.22) count++
  return count
}

interface Ranked {
  root: number
  minor: boolean
  corr: number
  score: number
}

function rankKeys(chroma: Float32Array, bass: Float32Array, segments: Float32Array[]): Ranked[] {
  const bassSum = bass.reduce((sum, value) => sum + value, 0)
  const chromaSum = chroma.reduce((sum, value) => sum + value, 0) || 1
  const chords = segments.map((segment) => bestTriad(segment))
  const ranked: Ranked[] = []
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const corr = profileCorr(chroma, root, minor)
      const bassTonic = bassSum > 0 ? (bass[root] || 0) / bassSum : 0
      const triad = triadEnergy(chroma, root, minor) / chromaSum
      let progression = 0
      const degrees = minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11]
      chords.forEach((chord, index) => {
        const rel = (chord.root - root + 12) % 12
        const tonic = rel === 0 && chord.minor === minor
        if (degrees.includes(rel)) progression += tonic ? 1.35 : 0.7
        if (rel === 7 && !chord.minor) progression += 0.55
        if (index === 0 && tonic) progression += 0.85
        if (index === chords.length - 1 && tonic) progression += 0.45
      })
      progression /= Math.max(1, chords.length)
      const score = corr + bassTonic * 0.22 + triad * 0.35 + progression * 0.16
      ranked.push({ root, minor, corr, score })
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked
}

function candidateOf(row: Ranked): KeyCandidate {
  return {
    root: row.root,
    minor: row.minor,
    name: `${NAMES[row.root]} ${row.minor ? 'minor' : 'major'}`,
    corr: row.corr,
    score: row.score,
  }
}

/** Key of one mono buffer, already at the pitch the listener hears. */
export function detectKey(samples: Float32Array, sampleRate: number): KeyReading {
  const blank: KeyReading = {
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
  if (samples.length < 256 || !(sampleRate > 0)) return blank
  const heard = gather(samples, sampleRate)
  blank.tonal = heard.tonal
  if (heard.rms < 1e-4) return blank
  // Tuning is how tightly each semitone's energy sits on its center bin.
  // Key correlation is not used here, or a one-semitone slide can win the search.
  let bestCents = 0
  let bestTune = -Infinity
  for (let cents = -45; cents <= 45; cents += 3) {
    const rotated = rotateBins(heard.fine, cents * 0.03)
    let center = 0
    let total = 0
    for (let i = 0; i < BINS; i++) {
      const value = rotated[i] || 0
      total += value
      if (i % 3 === 0) center += value
    }
    const peak = total > 0 ? center / total : 0
    if (peak > bestTune) {
      bestTune = peak
      bestCents = cents
    }
  }
  const chroma = foldAt(heard.fine, bestCents)
  const bass = foldAt(heard.bass, bestCents)
  const segments = heard.segments.map((segment) => foldAt(segment, bestCents))
  const ranked = rankKeys(chroma, bass, segments)
  const winner = ranked[0]
  const runner = ranked[1]
  if (!winner) return blank
  const salient = salientCount(chroma)
  const margin = winner.corr - (runner?.corr ?? 0)
  const confidence = clamp01(winner.corr * (0.72 + 0.28 * clamp01(margin / 0.12)))
  const clear = salient >= 3 && heard.tonal >= 0.012 && winner.corr >= 0.45 && confidence >= 0.32
  const best = candidateOf(winner)
  const alt = runner && runner.corr > 0.2 ? candidateOf(runner) : null
  if (!clear) {
    return { ...blank, cents: bestCents, confidence, best, alt, tonal: heard.tonal }
  }
  return {
    clear: true,
    label: best.name,
    root: best.root,
    scale: best.minor ? 'aeolian' : 'ionian',
    confidence,
    alt,
    cents: bestCents,
    tonal: heard.tonal,
    best,
  }
}

function smooth(env: Float32Array) {
  const out = new Float32Array(env.length)
  for (let i = 0; i < env.length; i++) {
    const a = env[Math.max(0, i - 1)] || 0
    const b = env[i] || 0
    const c = env[Math.min(env.length - 1, i + 1)] || 0
    out[i] = (a + 2 * b + c) / 4
  }
  return out
}

function autocorrAt(env: Float32Array, lag: number) {
  if (lag < 2 || lag >= env.length - 2) return 0
  let sum = 0
  let count = 0
  for (let i = 0; i + lag < env.length; i++) {
    sum += env[i] * env[i + lag]
    count++
  }
  return count > 0 ? sum / count : 0
}

/** Impulse trains cancel at half tempo and add up at the beat, so this rejects octave errors. */
function fourierTempo(env: Float32Array, hopSec: number, bpm: number) {
  const omega = (2 * Math.PI * bpm * hopSec) / 60
  let re = 0
  let im = 0
  for (let i = 0; i < env.length; i++) {
    const mag = env[i]
    if (mag === 0) continue
    re += mag * Math.cos(omega * i)
    im += mag * Math.sin(omega * i)
  }
  return Math.hypot(re, im) / env.length
}

function strongOnsets(env: Float32Array) {
  let max = 0
  for (let i = 0; i < env.length; i++) if (env[i] > max) max = env[i]
  const gate = max * 0.4
  const hits: number[] = []
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] < gate || env[i] < env[i - 1] || env[i] < env[i + 1]) continue
    const previous = hits[hits.length - 1]
    if (previous != null && i - previous < 3) {
      if (env[i] > env[previous]) hits[hits.length - 1] = i
      continue
    }
    hits.push(i)
  }
  return hits
}

/** Most common gap between strong onsets, as a tempo. */
function pulseBpm(hits: number[], hopSec: number) {
  if (hits.length < 4) return 0
  const gaps: number[] = []
  for (let i = 1; i < hits.length; i++) {
    const frames = hits[i] - hits[i - 1]
    const seconds = frames * hopSec
    if (seconds >= 0.08 && seconds <= 1.1) gaps.push(seconds)
  }
  if (gaps.length < 3) return 0
  gaps.sort((a, b) => a - b)
  const mid = gaps[Math.floor(gaps.length / 2)]
  return 60 / mid
}

function localAutocorr(env: Float32Array, lag: number) {
  let best = 0
  for (let delta = -2; delta <= 2; delta++) best = Math.max(best, autocorrAt(env, lag + delta))
  return best
}

/** Source tempo. `bpm` is 0 when the onsets do not settle on a beat. */
export function detectTempo(samples: Float32Array, sampleRate: number): TempoReading {
  const limit = Math.min(samples.length, Math.round(sampleRate * 32))
  const data = samples.subarray(0, limit)
  if (data.length < sampleRate * 0.45 || !(sampleRate > 0)) return { bpm: 0, confidence: 0 }
  const hop = Math.max(64, Math.round(sampleRate * 0.01))
  const frames = Math.floor(data.length / hop)
  if (frames < 16) return { bpm: 0, confidence: 0 }
  const raw = new Float32Array(frames)
  let prev = 0
  let prevFlux = 0
  for (let i = 0; i < frames; i++) {
    let energy = 0
    let flux = 0
    const at = i * hop
    let last = at > 0 ? data[at - 1] || 0 : 0
    for (let j = 0; j < hop; j++) {
      const sample = data[at + j] || 0
      energy += sample * sample
      const delta = sample - last
      if (delta > 0) flux += delta
      last = sample
    }
    const rms = Math.sqrt(energy / hop)
    raw[i] = Math.max(0, rms - prev) + 0.2 * Math.max(0, flux - prevFlux)
    prev = rms
    prevFlux = flux
  }
  const env = smooth(raw)
  let mean = 0
  for (let i = 0; i < env.length; i++) mean += env[i]
  mean /= env.length
  for (let i = 0; i < env.length; i++) env[i] = Math.max(0, env[i] - mean)
  const hopSec = hop / sampleRate
  const minBpm = 60
  const maxBpm = 190
  const onsets = strongOnsets(env)
  const pulse = pulseBpm(onsets, hopSec)
  const fourier: number[] = []
  const agree: number[] = []
  let maxFourier = 0
  let maxAgree = 0
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const period = fourierTempo(env, hopSec, bpm)
    const lag = Math.max(2, Math.round(60 / bpm / hopSec))
    const ac = localAutocorr(env, lag)
    fourier.push(period)
    agree.push(ac)
    if (period > maxFourier) maxFourier = period
    if (ac > maxAgree) maxAgree = ac
  }
  if (!(maxFourier > 0)) return { bpm: 0, confidence: 0 }
  const scores = fourier.map((period, index) => {
    const ac = maxAgree > 0 ? agree[index] / maxAgree : 0
    return period / maxFourier * 0.82 + ac * 0.18
  })
  let best = 0
  let total = 0
  for (const score of scores) {
    total += score
    if (score > best) best = score
  }
  const steps = scores.length
  if (!(best > 0)) return { bpm: 0, confidence: 0 }
  // A harmonic of the beat also peaks. The tempo is the slowest strong peak.
  let chosenIndex = scores.indexOf(best)
  let chosenScore = best
  for (let i = 1; i < scores.length - 1; i++) {
    const score = scores[i]
    if (score < best * 0.72) continue
    if (score >= scores[i - 1] && score >= scores[i + 1]) {
      chosenIndex = i
      chosenScore = score
      break
    }
  }
  const y0 = scores[Math.max(0, chosenIndex - 1)]
  const y1 = scores[chosenIndex]
  const y2 = scores[Math.min(scores.length - 1, chosenIndex + 1)]
  const denom = y0 - 2 * y1 + y2
  const shift = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom))
  let bpm = Math.round((minBpm + (chosenIndex + shift) * 0.5) * 10) / 10
  if (pulse > 0) {
    const octaves = [pulse / 2, pulse, pulse * 2].filter((value) => value >= minBpm && value <= maxBpm)
    let bestPulse = pulse
    let bestPulseScore = -1
    for (const value of octaves) {
      const index = Math.max(0, Math.min(scores.length - 1, Math.round((value - minBpm) / 0.5)))
      if (scores[index] > bestPulseScore) {
        bestPulseScore = scores[index]
        bestPulse = value
      }
    }
    const tempoIndex = Math.max(0, Math.min(scores.length - 1, Math.round((bpm - minBpm) / 0.5)))
    if (bestPulseScore >= scores[tempoIndex] * 0.85) bpm = bestPulse
  }
  bpm = Math.round(bpm * 10) / 10
  const meanScore = steps > 0 ? total / steps : 0
  const confidence = clamp01((chosenScore - meanScore) / Math.max(1e-8, chosenScore))
  if (confidence < 0.18 || bpm < 55 || bpm > 210) return { bpm: 0, confidence }
  return { bpm, confidence }
}

export function hearingOf(key: KeyReading, tempo: TempoReading): ClipHearing {
  const alt = key.clear && key.alt ? key.alt : null
  return {
    key: key.clear ? key.label : '',
    root: key.clear ? key.root : null,
    scale: key.clear ? key.scale : '',
    confidence: key.clear ? key.confidence : 0,
    alt: alt?.name ?? '',
    altRoot: alt ? alt.root : null,
    altScale: alt ? (alt.minor ? 'aeolian' : 'ionian') : '',
    altConfidence: alt ? clamp01(alt.corr) : 0,
    clearKey: key.clear,
    bpm: tempo.bpm > 0 ? tempo.bpm : 0,
    bpmConfidence: tempo.bpm > 0 ? tempo.confidence : 0,
    cents: Math.round(key.cents),
  }
}
