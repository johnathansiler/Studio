/**
 * Key of one mono buffer.
 *
 * Full recordings use a harmonic pitch-class profile written from the
 * published method (Gómez 2006; Faraldo, Gómez, Jordà, and Herrera 2016):
 * a Hann spectrum, parabolic peak picking, a tuning-frequency histogram,
 * and a cosine-weighted HPCP summed over every frame. Overtones that sit
 * on a lower partial are folded onto that partial. EDMA is the default
 * profile. Nothing here is linked against a GPL library.
 *
 * A loop of about 40 seconds or less stays on the harmonic/percussive
 * estimator. That is what holds plucked guitars, drummed loops, and the
 * formant shifter. The HPCP sum is the full-track path.
 */

import { fft } from './fft'
import type { KeyCandidate, KeyReading } from './clipKey'
import { estimateKey as estimateLoop, estimateProfiles as estimateLoopProfiles } from './keyEstimateLoop'

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

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

/** Frame matches the usual full-track extractor: one Hann window, no overlap. */
const FFT_SIZE = 4096
const HOP = 4096
const MIN_HZ = 40
const MAX_HZ = 3500
const MAX_PEAKS = 60
/** Bins under this fraction of the frame maximum are dropped before the sum. */
const PCP_THRESHOLD = 0.08
/**
 * How many harmonics of each peak are folded into the pitch class of f/h.
 * 1 keeps the peak on its own pitch class. 4 is the published harmonic weight.
 */
const HARMONICS = 1
const HARMONIC_SLOPE = 0.6
/**
 * Cepstral order of a spectral envelope. 0 leaves peak magnitudes alone.
 * A smooth envelope was measured on GiantSteps+ and on the rendered chords.
 * It flattened the thirds that the key profiles need, so the shipped path
 * folds harmonic peaks onto their fundamental instead.
 */
const WHITEN_ORDER = 0

const WINDOW = new Float32Array(FFT_SIZE)
for (let i = 0; i < FFT_SIZE; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE)

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

interface Peak {
  hz: number
  mag: number
}

interface Heard {
  /** Sum of per-frame, unit-max pitch-class profiles. */
  pcp: Float32Array
  /** Same sum, restricted to peaks under 160 Hz, for relative-key ties. */
  bass: Float32Array
  cents: number
  rms: number
  /** Share of spectral energy sitting in the picked peaks. */
  peakShare: number
  flatness: number
}

function addCosine(hpcp: Float32Array, hz: number, weight: number, refHz: number) {
  if (!(weight > 0) || !(hz > 1)) return
  const midi = 69 + 12 * Math.log2(hz / refHz)
  const size = hpcp.length
  const base = Math.floor(midi)
  const frac = midi - base
  // A one-semitone cosine window: energy reaches only the nearer semitone,
  // and it fades to zero at the quarter-tone boundary.
  if (frac <= 0.5) {
    const bin = ((base % size) + size) % size
    hpcp[bin] += weight * Math.cos(Math.PI * frac)
  }
  if (frac >= 0.5) {
    const bin = (((base + 1) % size) + size) % size
    hpcp[bin] += weight * Math.cos(Math.PI * (1 - frac))
  }
}

function addHarmonics(hpcp: Float32Array, hz: number, weight: number, refHz: number) {
  let scale = 1
  for (let harm = 1; harm <= HARMONICS; harm++) {
    const freq = hz / harm
    if (freq >= MIN_HZ && freq <= MAX_HZ) addCosine(hpcp, freq, weight * scale, refHz)
    scale *= HARMONIC_SLOPE
  }
}

/** One cepstral lifter. A low order follows the broad spectral tilt, not each partial. */
function spectralEnvelope(mag: Float32Array, fftSize: number, order: number) {
  const bins = mag.length
  const logMag = new Float32Array(fftSize)
  for (let k = 0; k < bins; k++) logMag[k] = Math.log(Math.max(mag[k], 1e-12))
  for (let k = 1; k < bins; k++) logMag[fftSize - k] = logMag[k]
  const real = logMag
  const imag = new Float32Array(fftSize)
  fft(real, imag, true)
  for (let i = order + 1; i < fftSize - order; i++) {
    real[i] = 0
    imag[i] = 0
  }
  fft(real, imag, false)
  const env = new Float32Array(bins)
  for (let k = 0; k < bins; k++) env[k] = Math.exp(real[k])
  return env
}

function envelopeAt(env: Float32Array, bin: number) {
  const k0 = Math.max(0, Math.min(env.length - 2, Math.floor(bin)))
  const frac = Math.max(0, Math.min(1, bin - k0))
  return env[k0] * (1 - frac) + env[k0 + 1] * frac
}

function pickPeaks(mag: Float32Array, sampleRate: number, fftSize: number): Peak[] {
  const peaks: Peak[] = []
  const binHz = sampleRate / fftSize
  const env = WHITEN_ORDER > 0 ? spectralEnvelope(mag, fftSize, WHITEN_ORDER) : null
  for (let k = 2; k < mag.length - 2; k++) {
    const center = mag[k]
    if (!(center > mag[k - 1] && center >= mag[k + 1] && center > 1e-8)) continue
    const left = mag[k - 1]
    const right = mag[k + 1]
    const denom = left - 2 * center + right
    const delta = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom))
    const hz = (k + delta) * binHz
    if (hz < 30 || hz > 5000) continue
    let weight = center - 0.25 * (left - right) * delta
    if (env) weight /= envelopeAt(env, k + delta) + 1e-12
    if (weight > 0) peaks.push({ hz, mag: weight })
  }
  // A peak that sits on a harmonic of a lower peak is mostly that note's
  // overtone. Move it onto the lower partial. Octaves are already the same
  // pitch class. The 3rd is a fifth, the 5th a major third, the 7th a flat
  // seventh; leaving those in place makes a plucked minor chord look major.
  peaks.sort((a, b) => a.hz - b.hz)
  for (let i = 0; i < peaks.length; i++) {
    for (let j = 0; j < i; j++) {
      const ratio = peaks[i].hz / peaks[j].hz
      const nearest = Math.round(ratio)
      if (nearest < 2 || nearest > 8) continue
      if (Math.abs(Math.log2(ratio / nearest)) > 0.04) continue
      const sameClass = nearest === 2 || nearest === 4 || nearest === 8
      const moved = sameClass ? 0 : nearest === 5 ? 0.9 : nearest === 7 ? 0.92 : 0.82
      peaks[j].mag += peaks[i].mag * moved
      peaks[i].mag *= 1 - moved
      break
    }
  }
  if (peaks.length > MAX_PEAKS) {
    peaks.sort((a, b) => b.mag - a.mag)
    peaks.length = MAX_PEAKS
  }
  return peaks
}

function tuningCents(frames: Peak[][]) {
  const hist = new Float32Array(100)
  for (const frame of frames) {
    for (const peak of frame) {
      if (peak.hz < MIN_HZ || peak.hz > MAX_HZ) continue
      const midi = 69 + 12 * Math.log2(peak.hz / 440)
      const cents = (midi - Math.round(midi)) * 100
      const bin = Math.round(cents + 50)
      const index = ((bin % 100) + 100) % 100
      hist[index] += peak.mag
    }
  }
  const smooth = new Float32Array(100)
  for (let i = 0; i < 100; i++) {
    let sum = 0
    for (let d = -3; d <= 3; d++) sum += hist[(i + d + 100) % 100]
    smooth[i] = sum
  }
  let best = 0
  let total = 0
  for (let i = 0; i < 100; i++) {
    total += smooth[i]
    if (smooth[i] > smooth[best]) best = i
  }
  const mean = total / 100
  // A flat histogram is not a tuning. Leave the reference at A440.
  if (!(smooth[best] > mean * 1.35)) return 0
  return best - 50
}

function analyse(samples: Float32Array, sampleRate: number, loop: boolean): Heard {
  const found: Heard = {
    pcp: new Float32Array(12),
    bass: new Float32Array(12),
    cents: 0,
    rms: 0,
    peakShare: 0,
    flatness: 1,
  }
  if (samples.length < 64 || !(sampleRate > 0)) return found
  const real = new Float32Array(FFT_SIZE)
  const imag = new Float32Array(FFT_SIZE)
  const read = (index: number) => {
    if (loop) {
      const n = samples.length
      return samples[((index % n) + n) % n] || 0
    }
    return index >= 0 && index < samples.length ? samples[index] || 0 : 0
  }
  const frameCount = loop
    ? Math.max(1, Math.ceil(samples.length / HOP))
    : Math.max(1, Math.floor((Math.max(samples.length, FFT_SIZE) - FFT_SIZE) / HOP) + 1)
  const frames: Peak[][] = []
  let flatWeight = 0
  let peakWeight = 0
  let peakEnergy = 0
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * HOP
    let energy = 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = read(start + i)
      energy += sample * sample
      real[i] = sample * WINDOW[i]
    }
    const rms = Math.sqrt(energy / FFT_SIZE)
    found.rms += rms
    if (rms < 1e-5) continue
    imag.fill(0)
    fft(real, imag, false)
    const bins = FFT_SIZE >> 1
    const mag = new Float32Array(bins)
    let specSum = 0
    let logSum = 0
    let linSum = 0
    let counted = 0
    for (let k = 0; k < bins; k++) {
      const value = Math.hypot(real[k], imag[k])
      mag[k] = value
      specSum += value
      if (k > 3 && value > 1e-10) {
        logSum += Math.log(value)
        linSum += value
        counted++
      }
    }
    if (counted > 8 && linSum > 0) {
      const flat = Math.exp(logSum / counted) / (linSum / counted)
      found.flatness += flat * rms
      flatWeight += rms
    }
    const peaks = pickPeaks(mag, sampleRate, FFT_SIZE)
    let framePeak = 0
    for (const peak of peaks) framePeak += peak.mag
    if (specSum > 0) {
      peakEnergy += (framePeak / specSum) * rms
      peakWeight += rms
    }
    frames.push(peaks)
  }
  if (flatWeight > 0) found.flatness /= flatWeight
  if (peakWeight > 0) found.peakShare = peakEnergy / peakWeight
  const cents = tuningCents(frames)
  found.cents = cents
  const refHz = 440 * 2 ** (cents / 1200)
  for (const peaks of frames) {
    const hpcp = new Float32Array(12)
    const bass = new Float32Array(12)
    let lowestHz = Infinity
    let lowestMag = 0
    for (const peak of peaks) {
      if (peak.hz < MIN_HZ || peak.hz > MAX_HZ) continue
      addHarmonics(hpcp, peak.hz, peak.mag, refHz)
      if (peak.hz < 180 && peak.hz < lowestHz) {
        lowestHz = peak.hz
        lowestMag = peak.mag
      }
    }
    if (lowestHz < 180) addCosine(bass, lowestHz, Math.max(lowestMag, 1), refHz)
    let max = 0
    for (let i = 0; i < 12; i++) if (hpcp[i] > max) max = hpcp[i]
    if (!(max > 0)) continue
    for (let i = 0; i < 12; i++) {
      const value = hpcp[i] / max
      if (value >= PCP_THRESHOLD) found.pcp[i] += value
    }
    let bassMax = 0
    for (let i = 0; i < 12; i++) if (bass[i] > bassMax) bassMax = bass[i]
    if (bassMax > 0) {
      for (let i = 0; i < 12; i++) found.bass[i] += bass[i] / bassMax
    }
  }
  return found
}

function profileCorr(chroma: ArrayLike<number>, root: number, minor: boolean, profile: KeyProfile) {
  const set = minor ? PROFILE_SET[profile].minor : PROFILE_SET[profile].major
  const turned = new Array<number>(12)
  for (let i = 0; i < 12; i++) turned[i] = chroma[(i + root) % 12] || 0
  let sum = 0
  for (const row of set) sum += pearson(turned, row)
  return sum / set.length
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

function rank(chroma: Float32Array, bass: Float32Array, profile: KeyProfile): Ranked[] {
  let max = 0
  for (let i = 0; i < 12; i++) if (chroma[i] > max) max = chroma[i]
  const gated = new Float32Array(12)
  if (max > 0) {
    for (let i = 0; i < 12; i++) {
      const value = chroma[i] / max
      gated[i] = value >= PCP_THRESHOLD ? value : 0
    }
  }
  const bassSum = bass.reduce((sum, value) => sum + value, 0)
  const ranked: Ranked[] = []
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const corr = profileCorr(gated, root, minor, profile)
      const bassTonic = bassSum > 0 ? (bass[root] || 0) / bassSum : 0
      // Bass only separates a relative major from its minor. It does not
      // move a confident profile match.
      const score = corr + bassTonic * 0.28
      ranked.push({ root, minor, corr, score })
    }
  }
  ranked.sort((a, b) => b.score - a.score || b.corr - a.corr)
  if (ranked.length >= 2 && isRelative(ranked[0].root, ranked[0].minor, ranked[1].root, ranked[1].minor)) {
    const margin = ranked[0].score - ranked[1].score
    if (margin < 0.015 && bassSum > 0) {
      const a = (bass[ranked[0].root] || 0) / bassSum
      const b = (bass[ranked[1].root] || 0) / bassSum
      if (b > a * 1.25) {
        const swap = ranked[0]
        ranked[0] = ranked[1]
        ranked[1] = swap
      }
    }
  }
  // EDMA is the electronic-music profile. On a close parallel (same tonic,
  // other mode), Krumhansl and Temperley have to agree before that mode wins.
  // A formant-shifted major loop is the case this catches.
  if (profile === 'edma' && ranked.length >= 2) {
    const lead = ranked[0]
    const next = ranked[1]
    if (lead.root === next.root && lead.minor !== next.minor && lead.corr - next.corr < 0.12) {
      const kkLead = profileCorr(gated, lead.root, lead.minor, 'krumhansl')
      const kkNext = profileCorr(gated, next.root, next.minor, 'krumhansl')
      const tempLead = profileCorr(gated, lead.root, lead.minor, 'temperley')
      const tempNext = profileCorr(gated, next.root, next.minor, 'temperley')
      if (kkNext > kkLead && tempNext >= tempLead) {
        ranked[0] = next
        ranked[1] = lead
      }
    }
  }
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
  return 'edma'
}

function scoreHeard(heard: Heard, profile: KeyProfile): KeyReading {
  const blank = blankReading()
  blank.tonal = heard.peakShare
  blank.cents = heard.cents
  if (heard.rms < 1e-4) return blank
  const ranked = rank(heard.pcp, heard.bass, profile)
  const winner = ranked[0]
  const runner = ranked[1]
  if (!winner) return blank
  const margin = winner.corr - (runner?.corr ?? 0)
  const relative = Boolean(runner && isRelative(winner.root, winner.minor, runner.root, runner.minor))
  let confidence = clamp01(0.12 + 0.7 * clamp01((winner.corr - 0.25) / 0.65) + 0.18 * clamp01(margin / 0.08))
  if (relative && margin < 0.06) confidence *= 0.75
  const best = candidateOf(winner)
  const alt = runner && runner.corr > 0.05 ? candidateOf(runner) : null
  // A drum loop and a noise bed are spectrally flat, and little of their
  // energy sits in tonal peaks. A real mix still has a strong profile match.
  const percussive = heard.flatness > 0.35 && heard.peakShare < 0.22 && winner.corr < 0.72
  const weak = winner.corr < 0.42
  const clear = !percussive && !weak
  if (!clear) return { ...blank, cents: heard.cents, confidence, best, alt, tonal: heard.peakShare }
  return {
    clear: true,
    label: best.name,
    root: best.root,
    scale: best.minor ? 'aeolian' : 'ionian',
    confidence,
    alt,
    cents: heard.cents,
    tonal: heard.peakShare,
    best,
  }
}

/** Loops stay on the harmonic-separation estimator. Full recordings use the HPCP sum. */
const LOOP_SECONDS = 40

export function estimateKey(samples: Float32Array, sampleRate: number, options: KeyDetectOptions = {}): KeyReading {
  if (samples.length < 256 || !(sampleRate > 0)) return blankReading()
  if (samples.length / sampleRate <= LOOP_SECONDS) return estimateLoop(samples, sampleRate, options)
  const loop = options.loop ?? false
  return scoreHeard(analyse(samples, sampleRate, loop), chosenProfile(options))
}

/** One analysis, every profile. Used to compare profiles without repeating the FFT. */
export function estimateProfiles(samples: Float32Array, sampleRate: number, loop?: boolean): Record<KeyProfile, KeyReading> {
  if (samples.length / sampleRate <= LOOP_SECONDS) return estimateLoopProfiles(samples, sampleRate, loop)
  const useLoop = loop ?? false
  const heard = samples.length < 256 || !(sampleRate > 0) ? null : analyse(samples, sampleRate, useLoop)
  const profiles: KeyProfile[] = ['edma', 'temperley', 'krumhansl', 'blend']
  const out = {} as Record<KeyProfile, KeyReading>
  for (const profile of profiles) out[profile] = heard ? scoreHeard(heard, profile) : blankReading()
  return out
}
