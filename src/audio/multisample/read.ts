/**
 * 8-tap windowed-sinc reader with three bandwidths.
 * Pitching up picks a lower cutoff so the resample stays band-limited.
 */

const TAPS = 8
const HALF = TAPS / 2
const PHASES = 128
const CUTOFFS = [0.95, 0.48, 0.24]

let table: Float32Array[] | null = null

function kernels() {
  if (table) return table
  const rows: Float32Array[] = []
  for (const cutoff of CUTOFFS) {
    for (let phase = 0; phase < PHASES; phase++) {
      const frac = phase / PHASES
      const row = new Float32Array(TAPS)
      let sum = 0
      for (let tap = 0; tap < TAPS; tap++) {
        const x = tap - (HALF - 1) - frac
        const weight = windowed(x, cutoff, HALF)
        row[tap] = weight
        sum += weight
      }
      if (sum !== 0) for (let tap = 0; tap < TAPS; tap++) row[tap] /= sum
      rows.push(row)
    }
  }
  table = rows
  return rows
}

function sinc(x: number) {
  if (Math.abs(x) < 1e-8) return 1
  const p = Math.PI * x
  return Math.sin(p) / p
}

function windowed(x: number, cutoff: number, radius: number) {
  const stretched = x * cutoff
  if (Math.abs(stretched) >= radius) return 0
  return sinc(stretched) * sinc(stretched / radius) * cutoff
}

export function bandForRate(rate: number) {
  if (!(rate > 1.05)) return 0
  if (rate <= 2.2) return 1
  return 2
}

export interface ReadSpan {
  loop: boolean
  loopStart: number
  loopEnd: number
  fade: number
}

/** Fractional read. `pos` is in source frames. */
export function readFrame(channel: Float32Array, pos: number, rate: number, span: ReadSpan) {
  if (channel.length < 2 || !Number.isFinite(pos)) return 0
  const band = bandForRate(rate)
  const phase = pos - Math.floor(pos)
  const row = kernels()[band * PHASES + Math.min(PHASES - 1, Math.max(0, Math.floor(phase * PHASES)))]
  const origin = Math.floor(pos) - (HALF - 1)
  let sample = 0
  for (let tap = 0; tap < TAPS; tap++) sample += row[tap] * at(channel, origin + tap, span)
  if (span.loop && span.fade > 1 && span.loopEnd > span.loopStart) {
    const fadeStart = span.loopEnd - span.fade
    if (pos >= fadeStart && pos < span.loopEnd) {
      const t = (pos - fadeStart) / span.fade
      const ahead = span.loopStart + (pos - fadeStart)
      const into = readPlain(channel, ahead, rate)
      sample = sample * (1 - t) + into * t
    }
  }
  return sample
}

function readPlain(channel: Float32Array, pos: number, rate: number) {
  const band = bandForRate(rate)
  const phase = pos - Math.floor(pos)
  const row = kernels()[band * PHASES + Math.min(PHASES - 1, Math.max(0, Math.floor(phase * PHASES)))]
  const origin = Math.floor(pos) - (HALF - 1)
  let sample = 0
  const idle: ReadSpan = { loop: false, loopStart: 0, loopEnd: 0, fade: 0 }
  for (let tap = 0; tap < TAPS; tap++) sample += row[tap] * at(channel, origin + tap, idle)
  return sample
}

function at(channel: Float32Array, index: number, span: ReadSpan) {
  let frame = index
  if (span.loop && span.loopEnd > span.loopStart + 1) {
    const start = span.loopStart + Math.max(0, span.fade)
    const end = span.loopEnd
    const width = end - start
    if (width > 1 && frame >= start) {
      while (frame >= end) frame -= width
      while (frame < start) frame += width
    }
  }
  if (frame < 0 || frame >= channel.length) return 0
  return channel[frame] || 0
}

/** Advance a looping playhead. Returns the next position and whether the voice has ended. */
export function advancePlayhead(pos: number, rate: number, end: number, span: ReadSpan) {
  let next = pos + (rate > 0 ? rate : 0)
  if (span.loop && span.loopEnd > span.loopStart + 1) {
    const start = span.loopStart + Math.max(0, span.fade)
    const width = span.loopEnd - start
    if (width > 1 && next >= span.loopEnd) {
      while (next >= span.loopEnd) next -= width
    }
    return { pos: next, done: false }
  }
  const limit = end > 0 ? end : Number.POSITIVE_INFINITY
  if (next >= limit) return { pos: limit, done: true }
  return { pos: next, done: false }
}
