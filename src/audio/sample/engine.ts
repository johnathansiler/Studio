import { detectTransients } from '../stretch/engine'
import { clamp, sanitize } from '../plugins/dsp'
import type { LooperLayer, LooperState, SamplerState, SampleZone } from '../../model/types'

export type { LooperLayer, LooperState, SamplerState, SampleZone }

export interface LoopTake {
  samples: Float32Array
  gain: number
  mute: boolean
  reverse: boolean
  speed: number
}

export interface LoopBox {
  length: number
  takes: LoopTake[]
  undone: LoopTake[]
  feedback: number
}

export function emptySampler(): SamplerState {
  return {
    bufferId: '',
    start: 0,
    end: 1,
    loopStart: 0,
    loopEnd: 1,
    fadeIn: 0,
    fadeOut: 0,
    crossfade: 0.02,
    loopMode: 0,
    root: 60,
    slices: [],
  }
}

export function emptyLooper(): LooperState {
  return {
    layers: [],
    undone: [],
    sync: true,
    bars: 1,
    feedback: 0.85,
    transport: 0,
    startBeat: 0,
    lengthSamples: 0,
  }
}

export function zoneFor(zones: SampleZone[], pitch: number) {
  const hits = zones.filter((zone) => pitch >= zone.lo && pitch <= zone.hi)
  if (!hits.length) return null
  return hits.slice().sort((a, b) => Math.abs(a.root - pitch) - Math.abs(b.root - pitch) || a.lo - b.lo)[0]
}

export function sampleVoiceLimit(quality: 'full' | 'eco') {
  return quality === 'eco' ? 4 : 16
}

export function sampleUsesStretch(stretch: number, quality: 'full' | 'eco') {
  return stretch >= 0.5 && quality !== 'eco'
}

export function barSamples(tempo: number, sampleRate: number, numerator = 4) {
  const beats = Math.max(1, numerator)
  return Math.round((beats * sampleRate * 60) / Math.max(1, tempo))
}

/** Synced loop length. An integer number of bars at the project tempo. */
export function syncedLoopSamples(bars: number, tempo: number, sampleRate: number, numerator = 4) {
  return Math.max(1, Math.round(bars)) * barSamples(tempo, sampleRate, numerator)
}

/** Free loop: the first pass is one bar, and this is the tempo it implies. */
export function tempoFromLoop(samples: number, sampleRate: number, beats = 4) {
  if (!(samples > 0)) return 120
  return (Math.max(1, beats) * 60 * sampleRate) / samples
}

/** Next bar boundary. A beat already on the bar stays there. */
export function nextBar(beat: number, beatsPerBar = 4) {
  const bar = Math.max(1, beatsPerBar)
  const steps = Math.ceil(beat / bar - 1e-6)
  return steps * bar
}

export function normalizeChannel(channel: Float32Array) {
  let peak = 0
  for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i] || 0))
  const out = new Float32Array(channel.length)
  const gain = peak > 1e-8 ? 0.99 / peak : 1
  for (let i = 0; i < channel.length; i++) out[i] = sanitize((channel[i] || 0) * gain)
  return out
}

export function reverseChannel(channel: Float32Array) {
  const out = new Float32Array(channel.length)
  for (let i = 0; i < channel.length; i++) out[i] = sanitize(channel[channel.length - 1 - i] || 0)
  return out
}

export function fadeChannel(channel: Float32Array, fadeIn: number, fadeOut: number) {
  const out = new Float32Array(channel.length)
  const inn = Math.max(0, Math.min(channel.length, Math.round(fadeIn)))
  const outN = Math.max(0, Math.min(channel.length, Math.round(fadeOut)))
  for (let i = 0; i < channel.length; i++) {
    let gain = 1
    if (inn > 0 && i < inn) gain *= i / inn
    if (outN > 0 && i > channel.length - 1 - outN) gain *= (channel.length - 1 - i) / outN
    out[i] = sanitize((channel[i] || 0) * gain)
  }
  return out
}

export function trimSilence(channel: Float32Array, threshold = 0.001) {
  let start = 0
  let end = channel.length
  while (start < end && Math.abs(channel[start] || 0) < threshold) start += 1
  while (end > start && Math.abs(channel[end - 1] || 0) < threshold) end -= 1
  if (end - start < 2) return channel.slice()
  return channel.slice(start, end)
}

export function snapZero(channel: Float32Array, index: number, radius = 256) {
  const at = clamp(Math.round(index), 0, Math.max(0, channel.length - 1))
  let best = at
  let bestDist = radius + 1
  const from = Math.max(1, at - radius)
  const to = Math.min(channel.length - 1, at + radius)
  for (let i = from; i <= to; i++) {
    const prev = channel[i - 1] || 0
    const value = channel[i] || 0
    if (prev === 0 || prev * value < 0 || Math.abs(value) < 1e-5) {
      const dist = Math.abs(i - at)
      if (dist < bestDist) {
        best = i
        bestDist = dist
      }
    }
  }
  return best
}

export function sliceEven(length: number, count: number) {
  const n = Math.max(1, Math.min(16, Math.round(count)))
  const span = Math.max(1, length)
  const slices: { start: number; end: number }[] = []
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * span) / n)
    const end = i === n - 1 ? span : Math.floor(((i + 1) * span) / n)
    slices.push({ start, end: Math.max(start + 1, end) })
  }
  return slices
}

export function sliceBeats(length: number, sampleRate: number, bpm: number, division = 1) {
  const step = Math.max(1, Math.round(((sampleRate * 60) / Math.max(1, bpm)) * Math.max(0.25, division)))
  const slices: { start: number; end: number }[] = []
  for (let start = 0; start < length && slices.length < 64; start += step) {
    slices.push({ start, end: Math.min(length, start + step) })
  }
  return slices.length ? slices : [{ start: 0, end: Math.max(1, length) }]
}

export function sliceTransients(channel: Float32Array, sampleRate: number, sensitivity: number) {
  const threshold = 0.05 + (1 - clamp(sensitivity, 0, 1)) * 0.6
  const hits = detectTransients(channel, sampleRate, threshold).filter((hit) => hit > 0 && hit < channel.length)
  const marks = [0, ...hits, channel.length]
  const unique = marks.filter((mark, index) => index === 0 || mark > marks[index - 1])
  const slices: { start: number; end: number }[] = []
  for (let i = 0; i < unique.length - 1 && slices.length < 16; i++) {
    slices.push({ start: unique[i], end: unique[i + 1] })
  }
  return slices.length ? slices : [{ start: 0, end: Math.max(1, channel.length) }]
}

export function slicesToNotes(count: number, stepBeats = 0.25) {
  const notes: { pitch: number; startBeat: number; durationBeats: number; velocity: number }[] = []
  const n = Math.max(0, Math.min(16, count))
  for (let i = 0; i < n; i++) {
    notes.push({
      pitch: 36 + i,
      startBeat: i * stepBeats,
      durationBeats: stepBeats,
      velocity: 0.9,
    })
  }
  return notes
}

export function detectRoot(channel: Float32Array, sampleRate: number) {
  const hz = estimateHz(channel, sampleRate)
  if (!hz) return 60
  const midi = Math.round(69 + 12 * Math.log2(hz / 440))
  return clamp(midi, 0, 127)
}

export function peaks(channel: Float32Array, buckets: number) {
  const n = Math.max(1, buckets)
  const out: { min: number; max: number }[] = []
  if (!channel.length) return out
  const span = channel.length / n
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * span)
    const b = Math.max(a + 1, Math.floor((i + 1) * span))
    let min = 0
    let max = 0
    for (let j = a; j < b && j < channel.length; j++) {
      const value = channel[j] || 0
      if (value < min) min = value
      if (value > max) max = value
    }
    out.push({ min, max })
  }
  return out
}

/** Min/max per column, scaled so the loudest sample fills the waveform. */
export function scaledPeaks(channel: Float32Array, buckets: number) {
  const bars = peaks(channel, buckets)
  let peak = 0
  for (const bar of bars) peak = Math.max(peak, Math.abs(bar.min), bar.max)
  if (peak < 1e-8) return bars
  return bars.map((bar) => ({ min: bar.min / peak, max: bar.max / peak }))
}

/**
 * Play a region. Near the wrap, the tail fades into the sample that plays
 * next so a hard edit does not click. One-shot stops at the end.
 */
export function renderLooped(channel: Float32Array, start: number, end: number, frames: number, fade: number, mode: number) {
  const out = new Float32Array(Math.max(0, frames))
  if (channel.length < 2 || frames <= 0) return out
  const a = clamp(Math.floor(start), 0, channel.length - 2)
  const b = clamp(Math.floor(end), a + 2, channel.length)
  const span = b - a
  const xf = mode === 2 ? 0 : Math.max(0, Math.min(span - 2, Math.floor(fade)))
  let pos = 0
  let dir = 1
  for (let i = 0; i < out.length; i++) {
    let sample = readAt(channel, a + pos)
    if (xf > 1 && dir > 0 && pos >= span - xf) {
      const t = (pos - (span - xf)) / xf
      const head = readAt(channel, a)
      sample = sample * (1 - t) + head * t
    }
    out[i] = sanitize(sample)
    if (mode === 2) {
      if (pos < span - 1) pos += 1
      else out[i] = 0
      continue
    }
    if (mode === 1) {
      pos += dir
      if (pos >= span - 1) {
        pos = span - 2
        dir = -1
      } else if (pos <= 0) {
        pos = 1
        dir = 1
      }
    } else {
      pos += 1
      if (pos >= span) pos = 0
    }
  }
  return out
}

export function recordTake(box: LoopBox, input: Float32Array, syncLength: number): LoopBox {
  const length = syncLength > 0 ? syncLength : Math.max(1, input.length)
  const samples = new Float32Array(length)
  const n = Math.min(length, input.length)
  for (let i = 0; i < n; i++) samples[i] = sanitize(input[i] || 0)
  const take: LoopTake = { samples, gain: 1, mute: false, reverse: false, speed: 1 }
  return { length, takes: [...box.takes, take], undone: [], feedback: box.feedback }
}

export function overdubTake(box: LoopBox, input: Float32Array): LoopBox {
  const length = box.length > 0 ? box.length : Math.max(1, input.length)
  return recordTake({ ...box, length, takes: box.takes }, fit(input, length), length)
}

export function undoTake(box: LoopBox): LoopBox {
  if (!box.takes.length) return box
  const last = box.takes[box.takes.length - 1]
  return { ...box, takes: box.takes.slice(0, -1), undone: [...box.undone, last] }
}

export function redoTake(box: LoopBox): LoopBox {
  if (!box.undone.length) return box
  const last = box.undone[box.undone.length - 1]
  return { ...box, takes: [...box.takes, last], undone: box.undone.slice(0, -1) }
}

export function layerGain(take: LoopTake, layersAfter: number, feedback: number) {
  const fb = clamp(feedback, 0, 1)
  return take.gain * fb ** Math.max(0, layersAfter)
}

export function mixTakes(box: LoopBox) {
  const out = new Float32Array(Math.max(0, box.length))
  for (let index = 0; index < box.takes.length; index++) {
    const take = box.takes[index]
    if (take.mute || !take.samples.length) continue
    const gain = layerGain(take, box.takes.length - 1 - index, box.feedback)
    const speed = take.speed > 0 ? take.speed : 1
    for (let i = 0; i < out.length; i++) {
      const raw = Math.floor(i * speed)
      const at = take.reverse ? take.samples.length - 1 - (raw % take.samples.length) : raw % take.samples.length
      const wrapped = at < 0 ? at + take.samples.length : at
      out[i] = sanitize(out[i] + (take.samples[wrapped] || 0) * gain)
    }
  }
  return out
}

export function makeZone(id: string, bufferId: string, start: number, end: number, length: number, index: number): SampleZone {
  const lo = 36 + index
  return {
    id,
    bufferId,
    root: lo,
    lo,
    hi: lo,
    loopStart: length > 0 ? start / length : 0,
    loopEnd: length > 0 ? end / length : 1,
    tune: 0,
    gain: 1,
    pan: 0,
    reverse: false,
    choke: 0,
  }
}

function fit(input: Float32Array, length: number) {
  const out = new Float32Array(length)
  const n = Math.min(length, input.length)
  for (let i = 0; i < n; i++) out[i] = input[i] || 0
  return out
}

function readAt(channel: Float32Array, at: number) {
  const index = clamp(Math.floor(at), 0, channel.length - 1)
  const next = Math.min(channel.length - 1, index + 1)
  const frac = at - index
  return (channel[index] || 0) * (1 - frac) + (channel[next] || 0) * frac
}

function estimateHz(channel: Float32Array, sampleRate: number) {
  const start = Math.min(channel.length - 2, Math.round(sampleRate * 0.02))
  if (start < 0) return 0
  let prev = channel[start] || 0
  let last = -1
  const periods: number[] = []
  for (let i = start + 1; i < channel.length; i++) {
    const value = channel[i] || 0
    if (prev <= 0 && value > 0) {
      const at = i - 1 + prev / (prev - value || 1)
      if (last >= 0) periods.push(at - last)
      last = at
    }
    prev = value
  }
  if (periods.length < 3) return 0
  const window = periods.slice(1, 10)
  const mean = window.reduce((sum, period) => sum + period, 0) / window.length
  return mean > 0 ? sampleRate / mean : 0
}
