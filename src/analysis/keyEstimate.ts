/**
 * Key of one mono buffer.
 *
 * The whole buffer is analysed. A loop under about 32 seconds is read
 * circularly so the seam counts. Harmonic and percussive energy are split
 * (a short median HPSS), the harmonic spectrum is whitened, and peaks land
 * on a 36-bin log-frequency chroma. Tuning is a search around A440.
 * EDMA, Temperley, and Krumhansl profiles can be used alone or blended.
 * Bass and downbeats break relative-major ties. Drums and noise stay unclear.
 */

import { chooseFft, foldChroma } from './chroma'
import { fft, hann } from './fft'
import type { KeyCandidate, KeyReading } from './clipKey'

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
const BINS = 36

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const TEMP_MAJOR = [5, 2, 3.5, 2, 4.5, 4, 2, 4.5, 2, 3.5, 1.5, 4]
const TEMP_MINOR = [5, 2, 3.5, 4.5, 2, 4, 2, 4.5, 3.5, 2, 1.5, 4]
const EDMA_MAJOR = [1, 0.157808021, 0.366133251, 0.127058867, 0.588516922, 0.332227667, 0.107226417, 0.710546603, 0.15476814, 0.373265925, 0.097658604, 0.443561062]
const EDMA_MINOR = [1, 0.150171156, 0.378050852, 0.45244178, 0.139651959, 0.385338478, 0.122140361, 0.696360448, 0.394150762, 0.188959016, 0.200616277, 0.346860558]

export type KeyProfile = 'edma' | 'temperley' | 'krumhansl' | 'blend'

export interface KeyDetectOptions {
  profile?: KeyProfile
  /** Circular read. Defaults to on for buffers of about 32 seconds or less. */
  loop?: boolean
}

const PROFILE_SET: Record<KeyProfile, { major: number[][]; minor: number[][] }> = {
  edma: { major: [EDMA_MAJOR], minor: [EDMA_MINOR] },
  temperley: { major: [TEMP_MAJOR], minor: [TEMP_MINOR] },
  krumhansl: { major: [KK_MAJOR], minor: [KK_MINOR] },
  blend: { major: [EDMA_MAJOR, TEMP_MAJOR, KK_MAJOR], minor: [EDMA_MINOR, TEMP_MINOR, KK_MINOR] },
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
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

function median(values: Float32Array, count: number) {
  const copy = values.subarray(0, count)
  const list = Array.from(copy)
  list.sort((a, b) => a - b)
  return list[Math.floor((count - 1) / 2)] || 0
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

function addBin(fine: Float32Array, hz: number, weight: number) {
  if (!(hz > 20) || !(weight > 0)) return
  const midi = 69 + 12 * Math.log2(hz / 440)
  const pos = midi * 3
  const base = Math.floor(pos)
  const frac = pos - base
  const n = fine.length
  fine[((base % n) + n) % n] += weight * (1 - frac)
  fine[(((base + 1) % n) + n) % n] += weight * frac
}

interface Peak {
  hz: number
  weight: number
  harmonic?: boolean
}

function peaksOf(mag: Float32Array, sampleRate: number, fftSize: number): Peak[] {
  const n = mag.length
  let maxMag = 0
  for (let i = 1; i < n; i++) if (mag[i] > maxMag) maxMag = mag[i]
  if (maxMag < 1e-8) return []
  const floor = maxMag * 1e-4
  const mean = new Float32Array(n)
  const prefix = new Float32Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + mag[i]
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 8)
    const b = Math.min(n, i + 9)
    mean[i] = (prefix[b] - prefix[a]) / Math.max(1, b - a)
  }
  const peaks: Peak[] = []
  const binHz = sampleRate / fftSize
  for (let k = 2; k < n - 2; k++) {
    const hz = k * binHz
    if (hz < 28 || hz > 5000) continue
    if (mag[k] < floor || mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue
    const white = mag[k] / (mean[k] + floor)
    if (white < 1.35) continue
    const left = mag[k - 1]
    const mid = mag[k]
    const right = mag[k + 1]
    const denom = left - 2 * mid + right
    const delta = denom === 0 ? 0 : (0.5 * (left - right)) / denom
    const shift = Math.max(-0.5, Math.min(0.5, delta))
    peaks.push({ hz: (k + shift) * binHz, weight: Math.log1p(mid) * white })
  }
  peaks.sort((a, b) => a.hz - b.hz)
  for (let i = 0; i < peaks.length; i++) {
    for (let j = 0; j < i; j++) {
      const ratio = peaks[i].hz / peaks[j].hz
      const nearest = Math.round(ratio)
      if (nearest >= 2 && nearest <= 8 && Math.abs(Math.log2(ratio / nearest)) < 0.06) {
        // The 3rd harmonic is a twelfth (the fifth). The 7th sits near a minor seventh and fakes a minor triad on the fifth.
        const keep = nearest === 7 ? 0.04 : nearest === 3 ? 0.08 : nearest === 5 ? 0.4 : 0.5
        peaks[i].weight *= keep
        peaks[i].harmonic = true
        break
      }
    }
  }
  peaks.sort((a, b) => b.weight - a.weight)
  return peaks.slice(0, 24)
}

interface Gather {
  fine: Float32Array
  bass: Float32Array
  downbeat: Float32Array
  segments: Float32Array[]
  rms: number
  harm: number
  perc: number
  flatness: number
}

function analyse(samples: Float32Array, sampleRate: number, loop: boolean): Gather {
  const parts = 4
  const found: Gather = {
    fine: new Float32Array(BINS),
    bass: new Float32Array(BINS),
    downbeat: new Float32Array(BINS),
    segments: Array.from({ length: parts }, () => new Float32Array(BINS)),
    rms: 0,
    harm: 0,
    perc: 0,
    flatness: 0,
  }
  if (samples.length < 64 || !(sampleRate > 0)) return found
  const fftSize = chooseFft(sampleRate)
  let hop = fftSize >> 2
  const span = Math.max(hop, loop ? samples.length : Math.max(hop, samples.length - fftSize + hop))
  const maxFrames = 2000
  if (span / hop > maxFrames) hop = Math.max(1, Math.ceil(span / maxFrames))
  const frames = Math.max(1, Math.floor(span / hop))
  const binHz = sampleRate / fftSize
  const used = Math.min(fftSize >> 1, Math.max(16, Math.ceil(5200 / binHz)))
  const spec = new Float32Array(frames * used)
  const rms = new Float32Array(frames)
  const real = new Float32Array(fftSize)
  const imag = new Float32Array(fftSize)
  const read = (index: number) => {
    if (loop) {
      const n = samples.length
      return samples[((index % n) + n) % n] || 0
    }
    return index >= 0 && index < samples.length ? samples[index] || 0 : 0
  }
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * hop
    let energy = 0
    for (let i = 0; i < fftSize; i++) {
      const sample = read(start + i)
      energy += sample * sample
      real[i] = sample * hann(i, fftSize)
    }
    rms[frame] = Math.sqrt(energy / fftSize)
    found.rms += rms[frame]
    if (rms[frame] < 1e-5) continue
    imag.fill(0)
    fft(real, imag, false)
    const row = frame * used
    for (let k = 0; k < used; k++) spec[row + k] = Math.hypot(real[k], imag[k])
  }
  const harm = new Float32Array(spec.length)
  const timeWin = 7
  const timeTmp = new Float32Array(timeWin)
  for (let k = 0; k < used; k++) {
    for (let frame = 0; frame < frames; frame++) {
      let count = 0
      for (let delta = -3; delta <= 3; delta++) {
        const at = frame + delta
        const src = at < 0 || at >= frames ? frame : at
        timeTmp[count++] = spec[src * used + k]
      }
      harm[frame * used + k] = median(timeTmp, count)
    }
  }
  const freqWin = 17
  const freqTmp = new Float32Array(freqWin)
  const masked = new Float32Array(used)
  let flatWeight = 0
  let beatLag = 0
  let bestBeat = 0
  const minLag = Math.max(2, Math.round((60 / 180) * sampleRate / hop))
  const maxLag = Math.min(frames - 2, Math.round((60 / 70) * sampleRate / hop))
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < frames; i++) sum += rms[i] * rms[i + lag]
    if (sum > bestBeat) {
      bestBeat = sum
      beatLag = lag
    }
  }
  const bar = beatLag > 0 ? beatLag * 4 : 0
  for (let frame = 0; frame < frames; frame++) {
    const row = frame * used
    for (let k = 0; k < used; k++) {
      let count = 0
      for (let delta = -8; delta <= 8; delta++) {
        const src = Math.max(0, Math.min(used - 1, k + delta))
        freqTmp[count++] = spec[row + src]
      }
      const perc = median(freqTmp, count)
      const h = harm[row + k]
      const mask = (h * h) / (h * h + perc * perc + 1e-12)
      masked[k] = spec[row + k] * mask
      found.harm += h * mask
      found.perc += perc * (1 - mask)
    }
    if (rms[frame] > 1e-4) {
      let logSum = 0
      let linSum = 0
      let count = 0
      for (let k = 2; k < used; k++) {
        const value = spec[row + k]
        if (!(value > 1e-8)) continue
        logSum += Math.log(value)
        linSum += value
        count++
      }
      if (count > 8 && linSum > 0) {
        const flat = Math.exp(logSum / count) / (linSum / count)
        found.flatness += flat * rms[frame]
        flatWeight += rms[frame]
      }
    }
    const peaks = peaksOf(masked, sampleRate, fftSize)
    const time = (frame * hop + fftSize / 2) / sampleRate
    const duration = samples.length / sampleRate
    const part = Math.min(parts - 1, Math.max(0, Math.floor((time / Math.max(0.001, duration)) * parts)))
    let down = 1
    if (bar > 4) {
      const pos = (frame % bar) / bar
      if (pos < 0.16) down = 2.4
      else if (pos > 0.84) down = 1.35
    } else if (time < duration * 0.16 || time > duration * 0.84) down = 1.45
    const segment = found.segments[part]
    for (const peak of peaks) {
      const emphasis = 1 + Math.min(1.1, 80 / peak.hz)
      const weight = peak.weight * emphasis * (0.65 + 0.35 * rms[frame])
      addBin(segment, peak.hz, weight)
      addBin(found.fine, peak.hz, weight * down)
      if (peak.hz < 160 && !peak.harmonic) {
        addBin(found.bass, peak.hz, weight * 1.8)
        if (down > 1.2) addBin(found.downbeat, peak.hz, weight * down)
      }
    }
  }
  if (flatWeight > 0) found.flatness /= flatWeight
  return found
}

function foldAt(fine: Float32Array, cents: number) {
  return foldChroma(rotateBins(fine, cents * 0.03), 0)
}

function profileCorr(chroma: ArrayLike<number>, root: number, minor: boolean, profile: KeyProfile) {
  const set = minor ? PROFILE_SET[profile].minor : PROFILE_SET[profile].major
  const turned = new Array<number>(12)
  for (let i = 0; i < 12; i++) turned[i] = chroma[(i + root) % 12] || 0
  let sum = 0
  for (const row of set) sum += pearson(turned, row)
  return sum / set.length
}

function triadEnergy(chroma: ArrayLike<number>, root: number, minor: boolean) {
  const third = (root + (minor ? 3 : 4)) % 12
  const fifth = (root + 7) % 12
  const avoid = (root + (minor ? 4 : 3)) % 12
  return (chroma[root] || 0) + (chroma[third] || 0) + 0.55 * (chroma[fifth] || 0) - 0.65 * (chroma[avoid] || 0)
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
  return { root: bestRoot, minor: bestMinor }
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

function entropy01(chroma: ArrayLike<number>) {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Math.max(0, chroma[i] || 0)
  if (sum <= 1e-8) return 1
  let h = 0
  for (let i = 0; i < 12; i++) {
    const p = Math.max(0, chroma[i] || 0) / sum
    if (p > 1e-8) h -= p * Math.log(p)
  }
  return h / Math.log(12)
}

function isRelative(aRoot: number, aMinor: boolean, bRoot: number, bMinor: boolean) {
  if (aMinor === bMinor) return false
  const up = (bRoot - aRoot + 12) % 12
  return aMinor ? up === 3 : up === 9
}

interface Ranked {
  root: number
  minor: boolean
  corr: number
  score: number
}

function rank(chroma: Float32Array, bass: Float32Array, downbeat: Float32Array, segments: Float32Array[], profile: KeyProfile): Ranked[] {
  const bassSum = bass.reduce((sum, value) => sum + value, 0)
  const downSum = downbeat.reduce((sum, value) => sum + value, 0)
  const chromaSum = chroma.reduce((sum, value) => sum + value, 0) || 1
  const chords = segments.map((segment) => bestTriad(segment))
  const ranked: Ranked[] = []
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const corr = profileCorr(chroma, root, minor, profile)
      const bassTonic = bassSum > 0 ? (bass[root] || 0) / bassSum : 0
      const downTonic = downSum > 0 ? (downbeat[root] || 0) / downSum : bassTonic
      const triad = triadEnergy(chroma, root, minor) / chromaSum
      let progression = 0
      const degrees = minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11]
      chords.forEach((chord, index) => {
        const rel = (chord.root - root + 12) % 12
        const tonic = rel === 0 && chord.minor === minor
        if (degrees.includes(rel)) progression += tonic ? 1.45 : 0.55
        if (rel === 7 && !chord.minor) progression += 0.35
        if (index === 0 && tonic) progression += 1.05
        if (index === chords.length - 1 && tonic) progression += 0.85
      })
      progression /= Math.max(1, chords.length)
      const score = corr + bassTonic * 0.48 + downTonic * 0.42 + triad * 0.22 + progression * 0.2
      ranked.push({ root, minor, corr, score })
    }
  }
  ranked.sort((a, b) => b.score - a.score || b.corr - a.corr)
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

function blankReading(): KeyReading {
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

function chosenProfile(options: KeyDetectOptions): KeyProfile {
  if (options.profile) return options.profile
  const env = typeof process !== 'undefined' ? process.env.CUE_KEY_PROFILE : ''
  if (env === 'edma' || env === 'temperley' || env === 'krumhansl' || env === 'blend') return env
  return 'blend'
}

function scoreGather(heard: Gather, profile: KeyProfile): KeyReading {
  const blank = blankReading()
  const harmShare = heard.harm / (heard.harm + heard.perc + 1e-9)
  blank.tonal = harmShare
  if (heard.rms < 1e-4) return blank
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
  const downbeat = foldAt(heard.downbeat, bestCents)
  const segments = heard.segments.map((segment) => foldAt(segment, bestCents))
  const ranked = rank(chroma, bass, downbeat, segments, profile)
  const winner = ranked[0]
  const runner = ranked[1]
  if (!winner) return blank
  const salient = salientCount(chroma)
  const flat = entropy01(chroma)
  const margin = winner.score - (runner?.score ?? 0)
  const corrGap = winner.corr - (runner?.corr ?? 0)
  const relative = Boolean(runner && isRelative(winner.root, winner.minor, runner.root, runner.minor))
  let confidence = clamp01(0.08 + 0.62 * clamp01((winner.corr - 0.2) / 0.55) + 0.22 * clamp01(margin / 0.12) + 0.12 * clamp01(corrGap / 0.08))
  if (relative && margin < 0.08) confidence *= 0.72
  if (harmShare > 0.55 && winner.corr > 0.55) confidence = clamp01(confidence + 0.06)
  const best = candidateOf(winner)
  const alt = runner && runner.corr > 0.15 ? candidateOf(runner) : null
  const percussive = harmShare < 0.27 && winner.corr < 0.8
  // A nearly flat chroma still correlates with whichever profile it leans toward. That is noise, not a key.
  // Tonal loops, including a full mix with drums, sit near 0.75–0.90. White and brown noise sit above 0.98.
  const noisy = flat > 0.96
  const weak = winner.corr < 0.33 || salient < 3 || confidence < 0.2
  const clear = !percussive && !noisy && !weak
  if (!clear) {
    return { ...blank, cents: bestCents, confidence, best, alt, tonal: harmShare }
  }
  return {
    clear: true,
    label: best.name,
    root: best.root,
    scale: best.minor ? 'aeolian' : 'ionian',
    confidence,
    alt,
    cents: bestCents,
    tonal: harmShare,
    best,
  }
}

export function estimateKey(samples: Float32Array, sampleRate: number, options: KeyDetectOptions = {}): KeyReading {
  if (samples.length < 256 || !(sampleRate > 0)) return blankReading()
  const loop = options.loop ?? samples.length / sampleRate <= 32
  return scoreGather(analyse(samples, sampleRate, loop), chosenProfile(options))
}

/** One analysis, every profile. Used to choose the default without repeating the FFT. */
export function estimateProfiles(samples: Float32Array, sampleRate: number, loop?: boolean): Record<KeyProfile, KeyReading> {
  const useLoop = loop ?? samples.length / sampleRate <= 32
  const heard = samples.length < 256 || !(sampleRate > 0) ? null : analyse(samples, sampleRate, useLoop)
  const profiles: KeyProfile[] = ['edma', 'temperley', 'krumhansl', 'blend']
  const out = {} as Record<KeyProfile, KeyReading>
  for (const profile of profiles) out[profile] = heard ? scoreGather(heard, profile) : blankReading()
  return out
}
