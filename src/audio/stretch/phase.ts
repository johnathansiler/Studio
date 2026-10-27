import { sanitize } from '../plugins/dsp'
import type { StretchMode } from '../../model/types'

/**
 * Offline time-stretch.
 * A phase vocoder with identity phase locking and transient phase resets.
 * Rubber Band is GPL, so it is not linked. This is the committed renderer.
 */

interface Profile {
  fft: number
  transient: number
}

const PROFILES: Record<StretchMode, Profile> = {
  pro: { fft: 4096, transient: 0.2 },
  tonal: { fft: 8192, transient: 0.07 },
  beats: { fft: 1024, transient: 0.42 },
  voice: { fft: 2048, transient: 0.18 },
  speech: { fft: 1024, transient: 0.28 },
  tape: { fft: 2048, transient: 0.18 },
}

function nextPow2(value: number) {
  let size = 64
  while (size < value) size <<= 1
  return size
}

function princarg(phase: number) {
  return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI))
}

export function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1)
    const wlenRe = Math.cos(ang)
    const wlenIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      const half = len >> 1
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j]
        const uIm = im[i + j]
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe
        re[i + j] = uRe + vRe
        im[i + j] = uIm + vIm
        re[i + j + half] = uRe - vRe
        im[i + j + half] = uIm - vIm
        const nextRe = wRe * wlenRe - wIm * wlenIm
        wIm = wRe * wlenIm + wIm * wlenRe
        wRe = nextRe
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

export function phaseStretch(input: Float32Array, outLen: number, sampleRate: number, mode: StretchMode): Float32Array {
  const length = Math.max(1, outLen)
  const output = new Float32Array(length)
  if (input.length < 2) {
    if (input.length === 1) output.fill(input[0] || 0)
    return output
  }
  if (Math.abs(input.length - length) <= 1) {
    output.set(input.subarray(0, Math.min(input.length, length)))
    if (length > input.length) output[length - 1] = input[input.length - 1] || 0
    return output
  }
  const profile = PROFILES[mode] ?? PROFILES.pro
  let size = nextPow2(Math.min(8192, Math.max(128, Math.round(profile.fft * (sampleRate / 48000)))))
  while (size > input.length && size > 128) size >>= 1
  const synthHop = Math.max(16, size >> 2)
  const ratio = length / input.length
  const analysisHop = synthHop / ratio
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  const weight = new Float64Array(length)
  const half = size >> 1
  const prevAna = new Float64Array(half + 1)
  const prevSyn = new Float64Array(half + 1)
  const prevMag = new Float64Array(half + 1)
  let primed = false
  let inCursor = 0
  const frames = Math.ceil(length / synthHop) + 2

  for (let frame = 0; frame < frames; frame++) {
    const inAt = Math.max(0, Math.min(Math.round(inCursor), Math.max(0, input.length - size)))
    const outAt = frame * synthHop
    if (outAt >= length) break
    const re = new Float64Array(size)
    const im = new Float64Array(size)
    for (let i = 0; i < size; i++) re[i] = (input[inAt + i] || 0) * window[i]
    fft(re, im, false)
    const mag = new Float64Array(half + 1)
    const phase = new Float64Array(half + 1)
    let energy = 0
    for (let bin = 0; bin <= half; bin++) {
      mag[bin] = Math.hypot(re[bin], im[bin])
      phase[bin] = Math.atan2(im[bin], re[bin])
      energy += mag[bin]
    }
    const synth = new Float64Array(half + 1)
    let transient = false
    if (!primed) {
      for (let bin = 0; bin <= half; bin++) synth[bin] = phase[bin]
      primed = true
    } else {
      let flux = 0
      for (let bin = 1; bin < half; bin++) {
        const rise = mag[bin] - prevMag[bin]
        if (rise > 0) flux += rise
      }
      transient = energy > 1e-8 && flux / energy > profile.transient
      const peaks: number[] = []
      const floor = (energy / Math.max(1, half)) * 4
      for (let bin = 1; bin < half; bin++) {
        if (mag[bin] >= mag[bin - 1] && mag[bin] > mag[bin + 1] && mag[bin] > floor) peaks.push(bin)
      }
      const dIn = Math.max(1, analysisHop)
      for (let bin = 0; bin <= half; bin++) {
        const omega = (2 * Math.PI * bin) / size
        const delta = princarg(phase[bin] - prevAna[bin] - omega * dIn)
        const freq = omega + delta / dIn
        const propagated = prevSyn[bin] + freq * synthHop
        if (transient) synth[bin] = phase[bin]
        else {
          let peak = -1
          let distance = 4
          for (const candidate of peaks) {
            const gap = Math.abs(candidate - bin)
            if (gap < distance) {
              distance = gap
              peak = candidate
            }
          }
          synth[bin] =
            peak >= 0
              ? prevSyn[peak] + freqOf(phase[peak], prevAna[peak], peak, size, dIn) * synthHop + princarg(phase[bin] - phase[peak])
              : propagated
        }
      }
    }
    for (let bin = 0; bin <= half; bin++) {
      prevAna[bin] = phase[bin]
      prevSyn[bin] = synth[bin]
      prevMag[bin] = mag[bin]
    }
    const outRe = new Float64Array(size)
    const outIm = new Float64Array(size)
    for (let bin = 0; bin <= half; bin++) {
      outRe[bin] = mag[bin] * Math.cos(synth[bin])
      outIm[bin] = mag[bin] * Math.sin(synth[bin])
      if (bin > 0 && bin < half) {
        outRe[size - bin] = outRe[bin]
        outIm[size - bin] = -outIm[bin]
      }
    }
    fft(outRe, outIm, true)
    const edge = frame === 0
    for (let i = 0; i < size; i++) {
      const at = outAt + i
      if (at < 0 || at >= length) continue
      const shaped = edge && i < half ? 1 : window[i]
      output[at] += outRe[i] * shaped
      weight[at] += window[i] * shaped
    }
    inCursor += analysisHop
    if (inAt >= input.length - size && frame > 0) break
  }
  let typical = 0
  const from = Math.floor(length * 0.2)
  const to = Math.max(from + 1, Math.floor(length * 0.8))
  for (let i = from; i < to; i++) if (weight[i] > typical) typical = weight[i]
  for (let i = 0; i < length; i++) {
    const covered = weight[i]
    if (!(covered > 1e-8) || !(typical > 0)) {
      output[i] = 0
      continue
    }
    const gain = covered >= typical * 0.5 ? 1 / covered : covered / (typical * typical * 0.5)
    output[i] = sanitize(output[i] * gain)
  }
  const onset = Math.min(length, input.length, Math.round(sampleRate * 0.006))
  for (let i = 0; i < onset; i++) {
    const gain = i / onset
    output[i] = (input[i] || 0) * (1 - gain) + output[i] * gain
  }
  return output
}

function freqOf(phase: number, prev: number, bin: number, size: number, dIn: number) {
  const omega = (2 * Math.PI * bin) / size
  return omega + princarg(phase - prev - omega * dIn) / dIn
}
