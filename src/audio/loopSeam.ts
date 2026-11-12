/**
 * Sample-accurate loop joins.
 * A repeating clip stays on one buffer source. The wrap is the audio thread's
 * loop point, so a timer cannot open a gap. A short equal-power blend runs
 * only when the two ends would click, and it does not fade the phrase to silence.
 */

const SEAM_SEC = 0.002

export function bpmFromName(name: string): number | null {
  const match = name.match(/(\d{2,3}(?:\.\d)?)\s*[-_]?\s*bpm(?![a-z])/i)
  if (!match) return null
  const bpm = Number(match[1])
  if (!(bpm >= 40 && bpm <= 300)) return null
  return bpm
}

export function barsFromName(name: string): number | null {
  const match = name.match(/(\d{1,2})\s*[-_]?\s*bars?(?![a-z])/i)
  if (!match) return null
  const bars = Number(match[1])
  if (!(bars >= 1 && bars <= 64)) return null
  return bars
}

/**
 * Snap a loop to a whole number of beats when the file is already that close.
 * `sourceBpm` is the tempo that makes `samples` land on those beats exactly,
 * so the existing stretch places the clip on the bar grid.
 * Returns null when the file is not a bar-length loop.
 */
export function fitLoopBeats(input: {
  samples: number
  sampleRate: number
  bpm: number
  name?: string
  beatsPerBar?: number
}): { beats: number; sourceBpm: number } | null {
  const samples = input.samples
  const sampleRate = input.sampleRate
  const bpm = input.bpm
  if (!(samples > 1) || !(sampleRate > 0) || !(bpm > 0)) return null
  const seconds = samples / sampleRate
  const rawBeats = seconds * (bpm / 60)
  const perBar = Math.max(1, input.beatsPerBar ?? 4)
  const namedBars = input.name ? barsFromName(input.name) : null
  let beats = rawBeats
  if (namedBars) {
    const named = namedBars * perBar
    const drift = Math.abs(named * (60 / bpm) - seconds)
    if (drift > Math.max(0.05, seconds * 0.03)) return null
    beats = named
  } else {
    const nearestBar = Math.max(perBar, Math.round(rawBeats / perBar) * perBar)
    const nearestBeat = Math.max(1, Math.round(rawBeats))
    const barError = Math.abs(nearestBar - rawBeats) * (60 / bpm)
    const beatError = Math.abs(nearestBeat - rawBeats) * (60 / bpm)
    const tolerance = Math.max(0.04, seconds * 0.015)
    if (barError <= tolerance) beats = nearestBar
    else if (beatError <= tolerance) beats = nearestBeat
    else return null
  }
  if (Math.abs(beats - rawBeats) < 1e-3) return null
  const sourceBpm = (beats * sampleRate * 60) / samples
  if (!(sourceBpm > 20 && sourceBpm < 400)) return null
  return { beats, sourceBpm }
}

/** The restart would click if it jumps farther than the waveform is already moving. */
export function seamWouldClick(channel: Float32Array, start = 0, end = channel.length): boolean {
  const from = Math.max(0, Math.min(channel.length - 1, Math.floor(start)))
  const to = Math.max(from + 2, Math.min(channel.length, Math.floor(end)))
  const last = channel[to - 1] || 0
  const first = channel[from] || 0
  const slope = last - (channel[to - 2] || 0)
  return Math.abs(first - last) > Math.max(0.02, Math.abs(slope) * 3 + 0.008)
}

/**
 * Blend the end of a loop into its start.
 * The buffer length stays put, so the bar grid does not move.
 * A seamless join is copied through. A click gets a 2 ms equal-power blend,
 * then a few samples land on the first sample so the native loop point matches.
 */
export function bakeLoopSeam(channel: Float32Array, sampleRate: number, start = 0, end = channel.length): Float32Array {
  const out = new Float32Array(channel.length)
  out.set(channel)
  const from = Math.max(0, Math.min(out.length - 2, Math.floor(start)))
  const to = Math.max(from + 2, Math.min(out.length, Math.floor(end)))
  if (!seamWouldClick(out, from, to)) return out
  const span = to - from
  const fade = Math.max(8, Math.min(Math.round((sampleRate > 0 ? sampleRate : 48000) * SEAM_SEC), Math.floor(span / 4)))
  const source = new Float32Array(out)
  for (let i = 0; i < fade; i++) {
    const t = i / Math.max(1, fade - 1)
    const gOut = Math.cos(t * Math.PI / 2)
    const gIn = Math.sin(t * Math.PI / 2)
    const at = to - fade + i
    out[at] = (source[at] || 0) * gOut + (source[from + (i % span)] || 0) * gIn
  }
  const glue = Math.min(8, fade)
  const anchor = source[from] || 0
  for (let i = 0; i < glue; i++) {
    const t = (i + 1) / glue
    const at = to - glue + i
    out[at] = (out[at] || 0) * (1 - t) + anchor * t
  }
  return out
}

/** What a looping buffer source plays: pass 2 starts on the sample after pass 1, with nothing inserted. */
export function renderLoopedCycles(channel: Float32Array, sampleRate: number, cycles: number): Float32Array {
  const baked = bakeLoopSeam(channel, sampleRate)
  const turns = Math.max(1, Math.round(cycles))
  const out = new Float32Array(baked.length * turns)
  for (let i = 0; i < out.length; i++) out[i] = baked[i % baked.length] || 0
  return out
}

export function loopBoundaryStats(channel: Float32Array, sampleRate: number) {
  const played = renderLoopedCycles(channel, sampleRate, 2)
  const period = channel.length
  const seam = Math.max(8, Math.round(sampleRate * SEAM_SEC))
  const bodyStart = Math.max(seam, Math.floor(period * 0.25))
  const bodyEnd = Math.max(bodyStart + 8, period - seam)
  return {
    seamRms: rms(played, period - seam, period + seam),
    bodyRms: rms(played, bodyStart, bodyEnd),
    wrapJump: Math.abs((played[period] || 0) - (played[period - 1] || 0)),
    interiorJump: maxJump(played, bodyStart, bodyEnd),
    hole: longestSilence(played, period - seam, period + seam, Math.max(1e-4, rms(played, bodyStart, bodyEnd) * 0.05)),
  }
}

function rms(channel: Float32Array, start: number, end: number) {
  const from = Math.max(0, start)
  const to = Math.min(channel.length, end)
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i++) sum += (channel[i] || 0) ** 2
  return Math.sqrt(sum / (to - from))
}

function maxJump(channel: Float32Array, start: number, end: number) {
  let jump = 0
  const from = Math.max(1, start)
  const to = Math.min(channel.length, end)
  for (let i = from; i < to; i++) jump = Math.max(jump, Math.abs((channel[i] || 0) - (channel[i - 1] || 0)))
  return jump
}

function longestSilence(channel: Float32Array, start: number, end: number, floor: number) {
  let run = 0
  let worst = 0
  const from = Math.max(0, start)
  const to = Math.min(channel.length, end)
  for (let i = from; i < to; i++) {
    if (Math.abs(channel[i] || 0) <= floor) {
      run += 1
      if (run > worst) worst = run
    } else run = 0
  }
  return worst
}
