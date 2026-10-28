import { NOTE_NAMES, scaleById, type ScaleId } from '../model/scale'
import { normalizeChroma, type SpectralFrame } from './chroma'
import type { AnalysisChord, AnalysisKey } from './types'

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const MODE_SCALES: ScaleId[] = ['ionian', 'mixolydian', 'lydian', 'aeolian', 'dorian', 'harmonicMinor', 'phrygian', 'melodicMinor']

const CHORD_TEMPLATES: { id: string; intervals: number[] }[] = [
  { id: 'maj7', intervals: [0, 4, 7, 11] },
  { id: '7', intervals: [0, 4, 7, 10] },
  { id: 'm7', intervals: [0, 3, 7, 10] },
  { id: 'm7b5', intervals: [0, 3, 6, 10] },
  { id: 'dim7', intervals: [0, 3, 6, 9] },
  { id: 'mMaj7', intervals: [0, 3, 7, 11] },
  { id: 'aug', intervals: [0, 4, 8] },
  { id: 'dim', intervals: [0, 3, 6] },
  { id: 'sus2', intervals: [0, 2, 7] },
  { id: 'sus4', intervals: [0, 5, 7] },
  { id: 'maj', intervals: [0, 4, 7] },
  { id: 'min', intervals: [0, 3, 7] },
]

const SUFFIX: Record<string, string> = {
  maj7: 'maj7',
  '7': '7',
  m7: 'm7',
  m7b5: 'm7b5',
  dim7: 'dim7',
  mMaj7: 'mMaj7',
  aug: 'aug',
  dim: 'dim',
  sus2: 'sus2',
  sus4: 'sus4',
  maj: '',
  min: 'm',
}

const TRIAD_OF: Record<string, string | undefined> = {
  maj7: 'maj',
  '7': 'maj',
  m7: 'min',
  mMaj7: 'min',
  m7b5: 'dim',
  dim7: 'dim',
}

function correlate(a: number[] | Float32Array, b: number[]) {
  const n = Math.min(a.length, b.length)
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    sa += a[i]
    sb += b[i]
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma
    const xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

function rotate(hist: Float32Array | number[], root: number) {
  const out = new Array<number>(12)
  for (let i = 0; i < 12; i++) out[i] = hist[(i + root) % 12] || 0
  return out
}

function modeProfile(scale: ScaleId) {
  if (scale === 'ionian') return MAJOR
  if (scale === 'aeolian') return MINOR
  const profile = new Array<number>(12).fill(0.4)
  const intervals = scaleById(scale).intervals
  intervals.forEach((interval, index) => {
    profile[interval] = index === 0 ? 6.2 : 3.1
  })
  if (intervals.some((interval) => interval === 7)) profile[7] = 5
  const third = intervals.find((interval) => interval === 3 || interval === 4)
  if (third != null) profile[third] = 4.5
  return profile
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export interface KeyFit {
  root: number
  scale: ScaleId
  score: number
}

/** Krumhansl correlation over the modes CueHarbor already ships. */
export function fitKey(hist: Float32Array | number[]): KeyFit {
  let best: KeyFit = { root: 0, scale: 'ionian', score: -Infinity }
  let total = 0
  for (let i = 0; i < 12; i++) total += hist[i] || 0
  if (total <= 1e-6) return { root: 0, scale: 'ionian', score: 0 }
  for (let root = 0; root < 12; root++) {
    const turned = rotate(hist, root)
    for (const scale of MODE_SCALES) {
      const score = correlate(turned, modeProfile(scale))
      if (score > best.score) best = { root, scale, score }
    }
  }
  const major = bestMajorMinor(hist, false)
  const minor = bestMajorMinor(hist, true)
  if (Math.abs(major.score - minor.score) < 0.06) {
    const pick = thirdDelta(hist, major.root, false) >= thirdDelta(hist, minor.root, true) ? major : minor
    if (pick.score > best.score - 0.04) best = pick
  } else if (best.scale !== 'ionian' && best.scale !== 'aeolian') {
    const plain = major.score >= minor.score ? major : minor
    if (plain.score > best.score - 0.045) best = plain
  }
  return best
}

function bestMajorMinor(hist: Float32Array | number[], minor: boolean): KeyFit {
  const profile = minor ? MINOR : MAJOR
  const scale: ScaleId = minor ? 'aeolian' : 'ionian'
  let best: KeyFit = { root: 0, scale, score: -Infinity }
  for (let root = 0; root < 12; root++) {
    const score = correlate(rotate(hist, root), profile)
    if (score > best.score) best = { root, scale, score }
  }
  return best
}

function thirdDelta(hist: Float32Array | number[], root: number, minor: boolean) {
  const want = (root + (minor ? 3 : 4)) % 12
  const other = (root + (minor ? 4 : 3)) % 12
  return (hist[want] || 0) - (hist[other] || 0) + 0.4 * (hist[root] || 0)
}

export function keyFromHistogram(hist: Float32Array | number[]): AnalysisKey & { scale: ScaleId } {
  let total = 0
  for (let i = 0; i < 12; i++) total += hist[i] || 0
  if (total <= 1e-6) return { root: 0, name: 'C', mode: 'major', label: 'C major', confidence: 0, scale: 'ionian' }
  const fit = fitKey(hist)
  const name = NOTE_NAMES[fit.root]
  const named = scaleById(fit.scale)
  let mode = named.name.toLowerCase()
  let label = `${name} ${mode}`
  if (fit.scale === 'ionian') {
    mode = 'major'
    label = `${name} major`
  } else if (fit.scale === 'aeolian') {
    mode = 'minor'
    label = `${name} minor`
  }
  return { root: fit.root, name, mode, label, confidence: clamp01((fit.score + 1) / 2), scale: fit.scale }
}

function cosine(chroma: Float32Array, template: Float32Array) {
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < 12; i++) {
    num += chroma[i] * template[i]
    da += chroma[i] * chroma[i]
    db += template[i] * template[i]
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

function inScale(pc: number, root: number, scale: ScaleId) {
  const rel = (pc - root + 12) % 12
  return scaleById(scale).intervals.some((interval) => interval === rel)
}

export interface ChordFit {
  root: number
  id: string
  symbol: string
  score: number
}

/** Template match a 12-bin chroma vector. Bass and key nudge near ties. */
export function chordFromChroma(chroma: Float32Array, bass: Float32Array | null, key: { root: number; scale: ScaleId } | null): ChordFit | null {
  let energy = 0
  for (let i = 0; i < 12; i++) energy += chroma[i]
  if (energy < 1e-4) return null
  const norm = new Float32Array(12)
  for (let i = 0; i < 12; i++) norm[i] = chroma[i] / energy
  let bassPc = -1
  let bassEnergy = 0
  if (bass) {
    for (let i = 0; i < 12; i++) {
      if (bass[i] > bassEnergy) {
        bassEnergy = bass[i]
        bassPc = i
      }
    }
  }
  let best: ChordFit | null = null
  const scored: ChordFit[] = []
  for (let root = 0; root < 12; root++) {
    for (const template of CHORD_TEMPLATES) {
      const weights = new Float32Array(12)
      for (const interval of template.intervals) weights[(root + interval) % 12] = 1
      let score = cosine(norm, weights)
      if (bassPc === root && bassEnergy > 0) score += 0.045
      if (key && template.intervals.every((interval) => inScale((root + interval) % 12, key.root, key.scale))) score += 0.02
      const fit = { root, id: template.id, symbol: `${NOTE_NAMES[root]}${SUFFIX[template.id] ?? ''}`, score }
      scored.push(fit)
      if (!best || score > best.score) best = fit
    }
  }
  if (!best) return null
  const chosen = best
  const triadId = TRIAD_OF[chosen.id]
  if (triadId) {
    const triad = scored.find((fit) => fit.root === chosen.root && fit.id === triadId)
    const seventh = CHORD_TEMPLATES.find((template) => template.id === chosen.id)?.intervals.at(-1) ?? 0
    const seventhPc = (chosen.root + seventh) % 12
    const rootEnergy = norm[chosen.root] || 0
    const seventhWeak = rootEnergy <= 0 || norm[seventhPc] < rootEnergy * 0.45
    if (triad && seventhWeak && triad.score >= chosen.score - 0.035) return triad
  }
  return chosen
}

export function histogramFromFrames(frames: SpectralFrame[], shift: number, fold: (fine: Float32Array, shift: number) => Float32Array) {
  const hist = new Float32Array(12)
  for (const frame of frames) {
    const chroma = fold(frame.fine, shift)
    const weight = Math.max(frame.rms, 1e-4)
    for (let i = 0; i < 12; i++) hist[i] += chroma[i] * weight
  }
  return hist
}

export interface BarChroma {
  chroma: Float32Array
  bass: Float32Array
  energy: number
  flux: number
}

export function accumulateBar(bar: BarChroma, chroma: Float32Array, bass: Float32Array | null, energy: number, flux = 0) {
  for (let i = 0; i < 12; i++) bar.chroma[i] += chroma[i] || 0
  if (bass) for (let i = 0; i < 12; i++) bar.bass[i] += bass[i] || 0
  bar.energy += energy
  bar.flux += flux
}

export function blankBars(count: number): BarChroma[] {
  return Array.from({ length: count }, () => ({
    chroma: new Float32Array(12),
    bass: new Float32Array(12),
    energy: 0,
    flux: 0,
  }))
}

export function chordsForBars(bars: BarChroma[], beatsPerBar: number, key: { root: number; scale: ScaleId }): AnalysisChord[] {
  const chords: AnalysisChord[] = []
  bars.forEach((bar, index) => {
    const fit = chordFromChroma(bar.chroma, bar.bass, key)
    if (!fit || bar.energy <= 1e-5) return
    normalizeChroma(bar.chroma)
    chords.push({
      bar: index,
      startBeat: index * beatsPerBar,
      beats: beatsPerBar,
      symbol: fit.symbol,
      root: fit.root,
      confidence: clamp01(fit.score),
    })
  })
  return chords
}

/** Tempo from the spectral-flux autocorrelation, biased gently toward a walking tempo. */
export function estimateTempo(frames: SpectralFrame[]): number {
  if (frames.length < 8) return 120
  const hop = Math.max(1e-4, frames[1].time - frames[0].time)
  const env = new Float32Array(frames.length)
  let mean = 0
  for (let i = 0; i < frames.length; i++) {
    env[i] = frames[i].flux
    mean += frames[i].flux
  }
  mean /= frames.length
  for (let i = 0; i < env.length; i++) env[i] = Math.max(0, env[i] - mean)
  const minBpm = 70
  const maxBpm = 180
  const minLag = Math.max(2, Math.round(60 / maxBpm / hop))
  const maxLag = Math.min(env.length - 2, Math.round(60 / minBpm / hop))
  if (maxLag <= minLag) return 120
  let bestLag = minLag
  let best = -1
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    let count = 0
    for (let i = 0; i + lag < env.length; i++) {
      sum += env[i] * env[i + lag]
      count++
    }
    const lag2 = lag * 2
    if (lag2 < env.length) {
      for (let i = 0; i + lag2 < env.length; i++) sum += 0.55 * env[i] * env[i + lag2]
    }
    if ((lag & 1) === 0) {
      const half = lag >> 1
      for (let i = 0; i + half < env.length; i++) sum += 0.2 * env[i] * env[i + half]
    }
    const bpm = 60 / (lag * hop)
    const prior = Math.exp(-0.5 * (Math.log(bpm / 120) / 0.45) ** 2)
    const score = (count > 0 ? sum / count : 0) * (0.72 + 0.28 * prior)
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  const bpm = 60 / (bestLag * hop)
  return Math.round(Math.max(60, Math.min(200, bpm)) * 10) / 10
}
