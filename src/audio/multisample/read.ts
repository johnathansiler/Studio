/**
 * 8-tap windowed-sinc reader with three bandwidths.
 * Pitching up picks a lower cutoff so the resample stays band-limited.
 */

const TAPS = 8
const HALF = TAPS / 2
const PHASES = 128
const CUTOFFS = [0.95, 0.72, 0.5, 0.36, 0.24, 0.16]

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
  if (!(rate > 1.02)) return 0
  const need = 0.92 / rate
  for (let band = 0; band < CUTOFFS.length; band++) {
    if (CUTOFFS[band] <= need) return band
  }
  return CUTOFFS.length - 1
}

export interface ReadSpan {
  loop: boolean
  loopStart: number
  loopEnd: number
  fade: number
}

/**
 * Sample-rate ratios near 2 (a 96 kHz file in a 44.1 or 48 kHz context) need a
 * longer kernel. The 8-tap table leaves energy above the output Nyquist, and
 * that alias is the crackle on bright one-shots. Musical pitch stays on the
 * short table: a few semitones is under this ratio.
 */
const STEEP_RATE = 1.45
const STEEP_HALF = 48

function steepSinc(x: number) {
  if (Math.abs(x) < 1e-8) return 1
  const p = Math.PI * x
  return Math.sin(p) / p
}

/** One output sample from a source that is playing faster than the engine. */
export function readBandlimitedAt(sampleAt: (index: number) => number, length: number, pos: number, rate: number) {
  if (length < 2 || !Number.isFinite(pos)) return 0
  const scale = Math.max(1, rate)
  const fc = Math.min(0.45, 0.45 / scale)
  const origin = Math.floor(pos)
  let acc = 0
  let norm = 0
  for (let k = -STEEP_HALF; k <= STEEP_HALF; k++) {
    const idx = origin + k
    const x = idx - pos
    const ratio = k / STEEP_HALF
    const inside = 1 - ratio * ratio
    const win = inside > 0 ? 0.5 + 0.5 * Math.cos(Math.PI * ratio) : 0
    const kernel = 2 * fc * steepSinc(2 * fc * x) * win
    acc += (sampleAt(idx) || 0) * kernel
    norm += kernel
  }
  return norm !== 0 ? acc / norm : 0
}

export function readBandlimited(channel: Float32Array, pos: number, rate: number) {
  return readBandlimitedAt((index) => channel[index] || 0, channel.length, pos, rate)
}

/** Fractional read. `pos` is in source frames. */
export function readFrame(channel: Float32Array, pos: number, rate: number, span: ReadSpan) {
  return readFrameAt((index) => channel[index] || 0, channel.length, pos, rate, span)
}

/** Same reader as readFrame, for a sample that is not one contiguous buffer. */
export function readFrameAt(sampleAt: (index: number) => number, length: number, pos: number, rate: number, span: ReadSpan) {
  if (length < 2 || !Number.isFinite(pos)) return 0
  let sample = rate >= STEEP_RATE
    ? readBandlimitedAt((index) => take(sampleAt, length, index, span), length, pos, rate)
    : readShort(sampleAt, length, pos, rate, span)
  if (span.loop && span.fade > 1 && span.loopEnd > span.loopStart) {
    const fadeStart = span.loopEnd - span.fade
    if (pos >= fadeStart && pos < span.loopEnd) {
      const t = (pos - fadeStart) / span.fade
      const ahead = span.loopStart + (pos - fadeStart)
      const into = readPlainAt(sampleAt, length, ahead, rate)
      sample = sample * (1 - t) + into * t
    }
  }
  return sample
}

function readShort(sampleAt: (index: number) => number, length: number, pos: number, rate: number, span: ReadSpan) {
  const band = bandForRate(rate)
  const phase = pos - Math.floor(pos)
  const row = kernels()[band * PHASES + Math.min(PHASES - 1, Math.max(0, Math.floor(phase * PHASES)))]
  const origin = Math.floor(pos) - (HALF - 1)
  let sample = 0
  for (let tap = 0; tap < TAPS; tap++) sample += row[tap] * take(sampleAt, length, origin + tap, span)
  return sample
}

function readPlainAt(sampleAt: (index: number) => number, length: number, pos: number, rate: number) {
  if (rate >= STEEP_RATE) return readBandlimitedAt(sampleAt, length, pos, rate)
  const idle: ReadSpan = { loop: false, loopStart: 0, loopEnd: 0, fade: 0 }
  return readShort(sampleAt, length, pos, rate, idle)
}

function take(sampleAt: (index: number) => number, length: number, index: number, span: ReadSpan) {
  const frame = resolveFrame(index, span)
  if (frame < 0 || frame >= length) return 0
  return sampleAt(frame) || 0
}

function resolveFrame(index: number, span: ReadSpan) {
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
  return frame
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
