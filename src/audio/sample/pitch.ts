import { continuousCeiling, transparentLimit } from '../liveStage'

/** Chromatic sampler pitch. One sample, every key, relative to a root note. */

export { continuousCeiling, transparentLimit }

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** playbackRate = 2^((note - root) / 12). Root plays the sample unchanged. */
export function playbackRateFor(note: number, root: number) {
  const semis = note - root
  if (!Number.isFinite(semis)) return 1
  return 2 ** (semis / 12)
}

export function noteName(midi: number) {
  const note = Math.round(Number.isFinite(midi) ? midi : 60)
  const pc = ((note % 12) + 12) % 12
  return `${NAMES[pc]}${Math.floor(note / 12) - 1}`
}

/**
 * One envelope step. `samples` is the time constant in samples.
 * A zero or missing length still moves over at least one sample, so the gain
 * never jumps from the current value to the target in the same sample.
 */
export function gainStep(current: number, target: number, samples: number) {
  const from = Number.isFinite(current) ? current : 0
  const to = Number.isFinite(target) ? target : 0
  const steps = Math.max(1, Math.round(Number.isFinite(samples) ? Math.abs(samples) : 1))
  const next = from + (to - from) * (1 - Math.exp(-1 / steps))
  if (!Number.isFinite(next) || Math.abs(next) < 1e-15) return 0
  return next
}

/**
 * Soft ceiling past 0.98, continuous with the linear region.
 * A hard switch to tanh used to drop a sample from 0.98 to about 0.75.
 */
export function softClip(sample: number) {
  return transparentLimit(sample, 0.98, 1)
}

function hermite(at: (index: number) => number, pos: number) {
  const i = Math.floor(pos)
  const f = pos - i
  const y0 = at(i - 1)
  const y1 = at(i)
  const y2 = at(i + 1)
  const y3 = at(i + 2)
  const c0 = y1
  const c1 = 0.5 * (y2 - y0)
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
  return ((c3 * f + c2) * f + c1) * f + c0
}

function windowedSinc(offset: number, radius: number) {
  if (Math.abs(offset) >= radius) return 0
  const hann = 0.5 + 0.5 * Math.cos((Math.PI * offset) / radius)
  if (Math.abs(offset) < 1e-6) return hann
  const pix = Math.PI * offset
  return (Math.sin(pix) / pix) * hann
}

/**
 * Read a sample at a fractional source position.
 * Pitching up uses a windowed sinc so the image above the new Nyquist is rejected.
 * Pitching down uses 4-point Hermite, which is exact on whole samples.
 * Loop points wrap inside the kernel so a read never grabs audio past the loop.
 */
export function readPlayed(
  buffer: Float32Array,
  at: number,
  rate: number,
  loopFrom: number | null,
  loopTo: number | null,
) {
  if (buffer.length < 2 || !Number.isFinite(at)) return 0
  const wrap = loopFrom != null && loopTo != null && loopTo - loopFrom >= 2
  const sampleAt = (index: number) => {
    if (!wrap) {
      if (index < 0 || index >= buffer.length) return 0
      return buffer[index] || 0
    }
    const from = loopFrom as number
    const span = (loopTo as number) - from
    let rel = index - from
    rel = ((rel % span) + span) % span
    const i = Math.max(0, Math.min(buffer.length - 1, from + Math.floor(rel)))
    return buffer[i] || 0
  }
  if (rate > 1.02) {
    const scale = Math.max(1, rate)
    const radius = 8
    const reach = Math.min(48, Math.ceil(radius * scale))
    const origin = Math.floor(at)
    let acc = 0
    let norm = 0
    for (let k = -reach; k <= reach; k++) {
      const weight = windowedSinc((origin + k - at) / scale, radius)
      if (weight === 0) continue
      acc += sampleAt(origin + k) * weight
      norm += weight
    }
    return norm !== 0 ? acc / norm : 0
  }
  return hermite(sampleAt, at)
}
