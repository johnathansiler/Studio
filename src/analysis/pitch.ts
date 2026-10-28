import { autocorrelate } from './fft'
import type { AnalysisBuffer, HumNote, TranscribeOptions } from './types'
import { monoMix } from './mix'

const LOW = 36
const HIGH = 84
const STATES = HIGH - LOW + 2

interface Candidate {
  hz: number
  cmnd: number
  prob: number
}

interface FramePitch {
  time: number
  rms: number
  onset: boolean
  candidates: Candidate[]
  unvoiced: number
}

function decimate(samples: Float32Array, sampleRate: number, targetRate: number) {
  if (sampleRate <= targetRate * 1.05) return { samples, sampleRate }
  const fc = targetRate * 0.22
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate)
  const filtered = new Float32Array(samples.length)
  let y1 = 0
  let y2 = 0
  let y3 = 0
  let y4 = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] || 0
    y1 += a * (x - y1)
    y2 += a * (y1 - y2)
    y3 += a * (y2 - y3)
    y4 += a * (y3 - y4)
    filtered[i] = y4
  }
  const outLen = Math.max(1, Math.round((samples.length * targetRate) / sampleRate))
  const out = new Float32Array(outLen)
  const ratio = samples.length / outLen
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const s0 = filtered[Math.min(filtered.length - 1, i0)] || 0
    const s1 = filtered[Math.min(filtered.length - 1, i0 + 1)] || 0
    out[i] = s0 + (s1 - s0) * frac
  }
  return { samples: out, sampleRate: (outLen / samples.length) * sampleRate }
}

function yinFrame(frame: Float32Array, sampleRate: number, minHz: number, maxHz: number): { candidates: Candidate[]; unvoiced: number } {
  let energy = 0
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i]
  if (energy / frame.length < 1e-6) return { candidates: [], unvoiced: 1 }
  const acf = autocorrelate(frame)
  const w = frame.length
  const cum = new Float32Array(w + 1)
  for (let i = 0; i < w; i++) cum[i + 1] = cum[i] + frame[i] * frame[i]
  const tauMin = Math.max(2, Math.floor(sampleRate / Math.max(50, maxHz)))
  const tauMax = Math.min(w - 3, Math.floor(sampleRate / Math.max(40, minHz)))
  if (tauMax <= tauMin + 2) return { candidates: [], unvoiced: 1 }
  const cmnd = new Float32Array(tauMax + 1)
  cmnd[0] = 1
  let running = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    const e1 = cum[w - tau]
    const e2 = cum[w] - cum[tau]
    const diff = Math.max(0, e1 + e2 - 2 * (acf[tau] || 0))
    running += diff
    cmnd[tau] = running > 0 ? (diff * tau) / running : 1
  }
  const mins: Candidate[] = []
  for (let t = Math.max(1, tauMin); t < tauMax; t++) {
    if (cmnd[t] > cmnd[t - 1] || cmnd[t] >= cmnd[t + 1] || cmnd[t] > 0.92) continue
    const left = cmnd[t - 1]
    const mid = cmnd[t]
    const right = cmnd[t + 1]
    const denom = left - 2 * mid + right
    const shift = denom === 0 ? 0 : (0.5 * (left - right)) / denom
    const tau = Math.max(1, t + Math.max(-0.5, Math.min(0.5, shift)))
    mins.push({ hz: sampleRate / tau, cmnd: mid, prob: 0 })
  }
  let ceiling = 1
  for (const min of mins) {
    min.prob = Math.max(0, ceiling - min.cmnd)
    ceiling = Math.min(ceiling, min.cmnd)
  }
  for (const min of mins) {
    const lower = mins.find((other) => other.hz < min.hz * 0.58 && other.hz > min.hz * 0.42 && other.cmnd < min.cmnd + 0.16)
    if (lower && lower.cmnd < 0.42) min.prob *= 0.28
    min.prob += Math.max(0, 1 - min.cmnd) ** 2 * 0.35
  }
  const voiced = mins.reduce((sum, min) => sum + min.prob, 0)
  const unvoiced = Math.max(0.02, ceiling)
  const total = voiced + unvoiced
  if (total > 0) for (const min of mins) min.prob /= total
  return { candidates: mins.filter((min) => min.prob > 0.01), unvoiced: unvoiced / total }
}

function observe(frame: FramePitch) {
  const obs = new Float32Array(STATES)
  obs[0] = Math.max(1e-4, frame.unvoiced)
  for (const candidate of frame.candidates) {
    const midi = 69 + 12 * Math.log2(candidate.hz / 440)
    const center = Math.round(midi)
    for (let note = center - 1; note <= center + 1; note++) {
      if (note < LOW || note > HIGH) continue
      const dist = note - midi
      const weight = Math.exp(-0.5 * (dist / 0.4) ** 2)
      obs[note - LOW + 1] += candidate.prob * weight
    }
  }
  let sum = 0
  for (let i = 0; i < STATES; i++) sum += obs[i]
  if (sum <= 0) {
    obs.fill(Math.log(1e-6))
    obs[0] = 0
    return obs
  }
  for (let i = 0; i < STATES; i++) obs[i] = Math.log(Math.max(1e-8, obs[i] / sum))
  return obs
}

function logTrans(prev: number, next: number) {
  if (prev === 0 && next === 0) return Math.log(0.7)
  if (prev === 0) return Math.log(0.3 / (STATES - 1))
  if (next === 0) return Math.log(0.07)
  const dp = Math.abs(next - prev)
  if (dp === 0) return Math.log(0.78)
  if (dp === 1) return Math.log(0.1)
  if (dp === 2) return Math.log(0.035)
  if (dp === 12) return Math.log(0.012)
  return Math.log(0.02 / STATES) - dp * 0.12
}

function midiOfState(state: number) {
  return state === 0 ? 0 : LOW + state - 1
}

function viterbi(frames: FramePitch[]) {
  const obs = frames.map(observe)
  const n = frames.length
  const score: Float32Array[] = [obs[0] ? Float32Array.from(obs[0]) : new Float32Array(STATES)]
  const back: Int16Array[] = []
  for (let t = 1; t < n; t++) {
    const row = new Float32Array(STATES)
    const from = new Int16Array(STATES)
    const prev = score[t - 1]
    for (let next = 0; next < STATES; next++) {
      let best = -1e12
      let arg = 0
      for (let state = 0; state < STATES; state++) {
        const value = prev[state] + logTrans(state, next)
        if (value > best) {
          best = value
          arg = state
        }
      }
      row[next] = best + obs[t][next]
      from[next] = arg
    }
    score.push(row)
    back.push(from)
  }
  const path = new Int16Array(n)
  let state = 0
  const last = score[n - 1]
  for (let i = 1; i < STATES; i++) if (last[i] > last[state]) state = i
  path[n - 1] = state
  for (let t = n - 1; t > 0; t--) {
    state = back[t - 1][state]
    path[t - 1] = state
  }
  return path
}

function confidenceAt(frame: FramePitch, midi: number) {
  if (midi <= 0) return 0
  let best = 0
  for (const candidate of frame.candidates) {
    const candidateMidi = 69 + 12 * Math.log2(candidate.hz / 440)
    if (Math.abs(candidateMidi - midi) < 0.75) best = Math.max(best, 1 - candidate.cmnd)
  }
  return best
}

interface RawNote {
  pitch: number
  hz: number
  confidence: number
  rms: number
  start: number
  end: number
}

function segment(frames: FramePitch[], path: Int16Array, hopSeconds: number): RawNote[] {
  const notes: RawNote[] = []
  let run: number[] = []
  const flush = () => {
    if (run.length < 2) {
      run = []
      return
    }
    let startIndex = run[0]
    for (let i = run[0]; i >= Math.max(0, run[0] - 10); i--) {
      if (frames[i].onset) startIndex = i
    }
    const start = frames[startIndex].time
    const end = frames[run[run.length - 1]].time + hopSeconds
    if (end - start < 0.07) {
      run = []
      return
    }
    const counts = new Map<number, number>()
    let hz = 0
    let conf = 0
    let rms = 0
    let weight = 0
    for (const index of run) {
      const midi = midiOfState(path[index])
      counts.set(midi, (counts.get(midi) ?? 0) + 1)
      const frameConf = confidenceAt(frames[index], midi)
      const frameHz = 440 * 2 ** ((midi - 69) / 12)
      hz += frameHz * Math.max(0.05, frameConf)
      conf += frameConf
      rms += frames[index].rms
      weight += Math.max(0.05, frameConf)
    }
    let pitch = midiOfState(path[run[0]])
    let best = 0
    for (const [midi, count] of counts) {
      if (count > best) {
        best = count
        pitch = midi
      }
    }
    const meanConf = conf / run.length
    if (meanConf >= 0.28) {
      notes.push({ pitch, hz: hz / weight, confidence: meanConf, rms: rms / run.length, start, end })
    }
    run = []
  }
  for (let i = 0; i < path.length; i++) {
    const midi = midiOfState(path[i])
    if (midi <= 0) {
      flush()
      continue
    }
    if (run.length) {
      const prev = midiOfState(path[run[run.length - 1]])
      const elapsed = frames[i].time - frames[run[0]].time
      if (Math.abs(midi - prev) >= 1 || (frames[i].onset && elapsed > 0.09)) flush()
    }
    run.push(i)
  }
  flush()
  return notes
}

function markOnsets(frames: FramePitch[]) {
  for (let i = 2; i < frames.length; i++) {
    const rms = frames[i].rms
    const prev = frames[i - 1].rms
    const before = frames[i - 2].rms
    frames[i].onset = rms > 0.012 && rms > prev * 1.45 && prev <= before * 1.25
  }
}

function tempoFromOnsets(notes: RawNote[]) {
  if (notes.length < 3) return 120
  const gaps: number[] = []
  for (let i = 1; i < notes.length; i++) gaps.push(notes[i].start - notes[i - 1].start)
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  if (!(median > 0.08)) return 120
  let bpm = 60 / median
  while (bpm < 70) bpm *= 2
  while (bpm > 180) bpm /= 2
  return Math.round(bpm * 10) / 10
}

function quantize(startBeat: number, durationBeats: number, grid: number) {
  if (!(grid > 0)) return { startBeat: Math.max(0, startBeat), durationBeats: Math.max(0.05, durationBeats) }
  const start = Math.max(0, Math.round(startBeat / grid) * grid)
  const end = Math.max(start + grid, Math.round((startBeat + durationBeats) / grid) * grid)
  return { startBeat: start, durationBeats: Math.round((end - start) * 1000) / 1000 }
}

/**
 * pYIN pitch track, energy onsets, and grid quantization.
 * The returned notes use quarter-note beats at the chosen tempo.
 */
export function transcribeHum(buffer: AnalysisBuffer, options: TranscribeOptions = {}): HumNote[] {
  const mixed = monoMix(buffer.channels)
  const minHz = options.minHz ?? 75
  const maxHz = options.maxHz ?? 900
  const { samples, sampleRate } = decimate(mixed, buffer.sampleRate, 16000)
  const period = Math.floor(sampleRate / Math.max(40, minHz))
  const span = Math.min(2048, Math.max(period * 3, 768))
  if (samples.length < span) return []
  let hop = Math.max(96, Math.round(sampleRate * 0.01))
  const maxFrames = 6000
  if ((samples.length - span) / hop > maxFrames) hop = Math.ceil((samples.length - span) / maxFrames)
  const frames: FramePitch[] = []
  const block = new Float32Array(span)
  for (let start = 0; start + span <= samples.length; start += hop) {
    let energy = 0
    for (let i = 0; i < span; i++) {
      block[i] = samples[start + i] || 0
      energy += block[i] * block[i]
    }
    const rms = Math.sqrt(energy / span)
    const heard = rms > 0.008 ? yinFrame(block, sampleRate, minHz, maxHz) : { candidates: [], unvoiced: 1 }
    frames.push({ time: start / sampleRate, rms, onset: false, candidates: heard.candidates, unvoiced: heard.unvoiced })
  }
  if (!frames.length) return []
  markOnsets(frames)
  const path = viterbi(frames)
  const hopSeconds = hop / sampleRate
  const raw = segment(frames, path, hopSeconds)
  if (!raw.length) return []
  const tempo = options.tempo ?? buffer.tempo ?? tempoFromOnsets(raw)
  const safeTempo = tempo > 20 ? tempo : 120
  const grid = options.grid === undefined ? 0.25 : options.grid
  const maxRms = raw.reduce((max, note) => Math.max(max, note.rms), 1e-6)
  return raw.map((note) => {
    const startBeat = (note.start * safeTempo) / 60
    const durationBeats = ((note.end - note.start) * safeTempo) / 60
    const snapped = quantize(startBeat, durationBeats, grid)
    const velocity = Math.max(0.15, Math.min(1, 0.28 + 0.72 * (note.rms / maxRms)))
    return {
      pitch: note.pitch,
      startBeat: snapped.startBeat,
      durationBeats: snapped.durationBeats,
      velocity,
      hz: note.hz,
      confidence: note.confidence,
    }
  })
}
