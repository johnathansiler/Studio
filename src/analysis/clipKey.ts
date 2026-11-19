/**
 * Key and tempo of one audio clip.
 *
 * Key reads the whole buffer (a short loop wraps around the seam). Peaks from
 * a Hann spectrum are tuned and summed into a harmonic pitch-class profile.
 * EDMA is the default profile. The top key and the runner-up are always
 * returned. "No clear key" is for drums and noise.
 *
 * Tempo listens to the source, before the stretch: an onset-strength envelope,
 * its autocorrelation, and a comb tempogram.
 *
 * Both run on plain PCM. The worker renders the stretch first so the key is
 * the pitch the clip is playing, including transpose.
 */

import type { ClipHearing } from '../model/types'
import { estimateKey, type KeyDetectOptions, type KeyProfile } from './keyEstimate'

export type { KeyDetectOptions, KeyProfile }

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

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}


/** Key of one mono buffer, already at the pitch the listener hears. */
export function detectKey(samples: Float32Array, sampleRate: number, options?: KeyDetectOptions): KeyReading {
  return estimateKey(samples, sampleRate, options)
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
  const winnerScore = key.best && key.best.score > 0 ? key.best.score : 0
  const altConfidence = alt && winnerScore > 0
    ? Math.min(key.confidence, clamp01(key.confidence * (alt.score / winnerScore)))
    : 0
  return {
    key: key.clear ? key.label : '',
    root: key.clear ? key.root : null,
    scale: key.clear ? key.scale : '',
    confidence: key.clear ? key.confidence : 0,
    alt: alt?.name ?? '',
    altRoot: alt ? alt.root : null,
    altScale: alt ? (alt.minor ? 'aeolian' : 'ionian') : '',
    altConfidence,
    clearKey: key.clear,
    bpm: tempo.bpm > 0 ? tempo.bpm : 0,
    bpmConfidence: tempo.bpm > 0 ? tempo.confidence : 0,
    cents: Math.round(key.cents),
  }
}
