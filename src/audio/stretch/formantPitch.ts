/**
 * Offline pitch shift.
 *
 * In-house phase vocoder (no Rubber Band). Each frame's instantaneous
 * frequency is measured from the phase advance. Spectral peaks own a short
 * main lobe, that lobe moves by a whole number of bins, and the fractional
 * frequency lives entirely in the phase accumulator (Laroche–Dolson identity
 * lock). Splitting one partial across two bins with the same phase is what
 * made a sine beat against itself and read several cents sharp or flat.
 *
 * Stereo uses one phase trajectory, taken from the louder channel, plus each
 * channel's original phase offset, so the image does not wander. A loop whose
 * ends already join is processed circularly, so the seam stays seamless.
 * Transients reset the phase, and an isolated hit is rewritten with a short
 * window so the attack is not smeared. Formants are a cepstral envelope that
 * can stay put or move with the pitch. The output length matches the input.
 * The source buffer is never rewritten.
 */

import { bakeLoopSeam, seamWouldClick } from '../loopSeam'
import { fft } from './phase'

export interface FormantPitchOptions {
  semitones?: number
  cents?: number
  /** Keep the spectral envelope. Off moves the formants with the pitch. */
  formant?: boolean
}

const MIN_SIZE = 512
const MAX_SIZE = 8192

interface ShiftPlan {
  size: number
  hop: number
  /** Square-root Hann. Analysis and synthesis both use it, so the product is Hann and overlap-adds flat. */
  window: Float64Array
  product: Float64Array
}

function princarg(phase: number) {
  return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI))
}

function nextPow2(value: number) {
  let size = MIN_SIZE
  while (size < value) size <<= 1
  return Math.min(MAX_SIZE, size)
}

function sqrtHann(size: number) {
  const window = new Float64Array(size)
  const product = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
    product[i] = hann
    window[i] = Math.sqrt(hann)
  }
  return { window, product }
}

function sanitize(sample: number) {
  if (!Number.isFinite(sample) || Math.abs(sample) < 1e-15) return 0
  return sample
}

function crestFactor(input: Float32Array) {
  let peak = 0
  let sum = 0
  for (let i = 0; i < input.length; i++) {
    const sample = input[i] || 0
    const mag = Math.abs(sample)
    if (mag > peak) peak = mag
    sum += sample * sample
  }
  const mean = Math.sqrt(sum / Math.max(1, input.length))
  return mean > 1e-8 ? peak / mean : 1
}

/** Hits per second, from a short energy envelope. Used to pick the window. */
function onsetDensity(input: Float32Array, sampleRate: number) {
  const hop = Math.max(1, Math.round(sampleRate * 0.01))
  const frames = Math.floor(input.length / hop)
  if (frames < 4) return 0
  let prev = 0
  let hits = 0
  let last = -10
  let peak = 0
  const flux = new Float64Array(frames)
  for (let i = 0; i < frames; i++) {
    let energy = 0
    const at = i * hop
    for (let j = 0; j < hop; j++) {
      const sample = input[at + j] || 0
      energy += sample * sample
    }
    const mag = Math.sqrt(energy / hop)
    flux[i] = Math.max(0, mag - prev)
    if (mag > peak) peak = mag
    prev = mag
  }
  const gate = Math.max(1e-4, peak * 0.18)
  for (let i = 1; i < frames; i++) {
    if (flux[i] < gate || i - last < 4) continue
    if (flux[i] < flux[i - 1]) continue
    hits++
    last = i
  }
  const seconds = input.length / sampleRate
  return seconds > 0 ? hits / seconds : 0
}

function chooseSize(channels: Float32Array[], sampleRate: number) {
  let density = 0
  let crest = 0
  for (const channel of channels) {
    density = Math.max(density, onsetDensity(channel, sampleRate))
    crest = Math.max(crest, crestFactor(channel))
  }
  // A single pluck is not "many hits", but its crest still needs a short window
  // or the long FFT prints the attack early.
  const prefer = density > 8 || crest > 6 ? 2048 : density > 3 || crest > 3.2 ? 4096 : 8192
  const lead = channels[0]?.length ?? 0
  let size = nextPow2(Math.max(MIN_SIZE, Math.round(prefer * (sampleRate / 48000))))
  while (size > lead && size > MIN_SIZE) size >>= 1
  return Math.max(MIN_SIZE, size)
}

function planFor(size: number): ShiftPlan {
  const hop = Math.max(32, size >> 2)
  const { window, product } = sqrtHann(size)
  return { size, hop, window, product }
}

function findPeaks(mag: Float64Array) {
  const half = mag.length - 1
  let max = 0
  for (let k = 1; k < half; k++) if (mag[k] > max) max = mag[k]
  const floor = max * 0.012
  const peaks: number[] = []
  for (let k = 2; k < half - 1; k++) {
    if (mag[k] < floor) continue
    if (mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue
    if (mag[k] < mag[k - 2] && mag[k] < mag[k + 2]) continue
    peaks.push(k)
  }
  if (!peaks.length && max > 0) {
    let best = 1
    for (let k = 2; k < half; k++) if (mag[k] > mag[best]) best = k
    peaks.push(best)
  }
  return peaks
}

function regionOwners(half: number, peaks: number[]) {
  const owner = new Int32Array(half + 1)
  owner.fill(-1)
  if (!peaks.length) return owner
  let index = 0
  for (let bin = 0; bin <= half; bin++) {
    while (index + 1 < peaks.length && Math.abs(peaks[index + 1] - bin) <= Math.abs(peaks[index] - bin)) index++
    owner[bin] = peaks[index]
  }
  return owner
}

/** Slow spectral shape. Harmonic spikes sit above this and are what we shift. */
function cepstralEnvelope(mag: Float64Array, fftSize: number, sampleRate: number, re: Float64Array, im: Float64Array, env: Float64Array) {
  const half = fftSize >> 1
  re.fill(0)
  im.fill(0)
  for (let k = 0; k <= half; k++) {
    const value = Math.log(mag[k] + 1e-10)
    re[k] = value
    if (k > 0 && k < half) re[fftSize - k] = value
  }
  fft(re, im, true)
  const lifter = Math.max(12, Math.min(Math.round(sampleRate / 900), Math.floor(fftSize / 12)))
  for (let n = lifter; n <= fftSize - lifter; n++) {
    re[n] = 0
    im[n] = 0
  }
  fft(re, im, false)
  let max = 0
  for (let k = 0; k <= half; k++) {
    env[k] = Math.exp(re[k])
    if (env[k] > max) max = env[k]
  }
  const floor = Math.max(1e-8, max * 1e-4)
  for (let k = 0; k <= half; k++) if (env[k] < floor) env[k] = floor
  return env
}

function refineHz(bin: number, mag: Float64Array, instHz: number, freqPerBin: number) {
  const para = () => {
    if (bin <= 0 || bin >= mag.length - 1) return bin * freqPerBin
    const left = Math.log(mag[bin - 1] + 1e-12)
    const mid = Math.log(mag[bin] + 1e-12)
    const right = Math.log(mag[bin + 1] + 1e-12)
    const denom = left - 2 * mid + right
    let delta = denom === 0 ? 0 : (0.5 * (left - right)) / denom
    if (!Number.isFinite(delta)) delta = 0
    delta = Math.max(-0.5, Math.min(0.5, delta))
    return (bin + delta) * freqPerBin
  }
  const shaped = para()
  if (!Number.isFinite(instHz) || instHz <= 0) return shaped
  // The phase advance is exact for a steady tone. The parabola wins when a
  // neighbour has pulled that phase outside a bin.
  if (Math.abs(instHz - shaped) <= freqPerBin * 0.75) return instHz
  return shaped
}

function readSample(channel: Float32Array, index: number, circular: boolean) {
  const length = channel.length
  if (length < 1) return 0
  if (circular) {
    let at = index % length
    if (at < 0) at += length
    return channel[at] || 0
  }
  if (index < 0 || index >= length) return 0
  return channel[index] || 0
}

/**
 * A musical loop already joins. Silence on both ends is not that join:
 * wrapping it would print a hit at the far side of the file.
 */
function joinsAsLoop(channel: Float32Array) {
  const length = channel.length
  if (length < 512) return false
  const edge = Math.min(64, Math.floor(length / 8))
  let edgeEnergy = 0
  let body = 0
  for (let i = 0; i < edge; i++) {
    edgeEnergy += (channel[i] || 0) ** 2 + (channel[length - 1 - i] || 0) ** 2
    const mid = Math.floor(length / 2) + i
    if (mid < length) body += (channel[mid] || 0) ** 2
  }
  if (edgeEnergy < 1e-8) return false
  if (edgeEnergy < body * 0.02) return false
  return !seamWouldClick(channel)
}

interface PassOptions {
  circular: boolean
  formant: boolean
  /** Rewrite isolated attacks with a short window. Off for that rewrite itself. */
  attacks: boolean
  /** Match the source loudness. Off when the caller crops a padded loop and matches once. */
  level: boolean
}

function shiftChannels(
  inputs: Float32Array[],
  sampleRate: number,
  factor: number,
  plan: ShiftPlan,
  pass: PassOptions,
) {
  const count = inputs.length
  const length = inputs[0]?.length ?? 0
  const { size, hop, window, product } = plan
  const halfWin = size >> 1
  const half = size >> 1
  const output = inputs.map(() => new Float32Array(length))
  const weight = new Float64Array(length)
  const re = Array.from({ length: count }, () => new Float64Array(size))
  const im = Array.from({ length: count }, () => new Float64Array(size))
  const mag = Array.from({ length: count }, () => new Float64Array(half + 1))
  const phase = Array.from({ length: count }, () => new Float64Array(half + 1))
  const lastPhase = Array.from({ length: count }, () => new Float64Array(half + 1))
  const freq = Array.from({ length: count }, () => new Float64Array(half + 1))
  const synMag = Array.from({ length: count }, () => new Float64Array(half + 1))
  const synPhase = Array.from({ length: count }, () => new Float64Array(half + 1))
  const own = Array.from({ length: count }, () => new Float64Array(half + 1))
  const sumMag = new Float64Array(half + 1)
  const prevSum = new Float64Array(half + 1)
  const env = new Float64Array(half + 1)
  const cepRe = new Float64Array(size)
  const cepIm = new Float64Array(size)
  const peakPhase = new Float64Array(half + 1)
  const osamp = size / hop
  const expected = (2 * Math.PI * hop) / size
  const freqPerBin = sampleRate / size
  const frames = Math.ceil(length / hop) + 1
  let prevPeaks: number[] = []
  let primed = false

  for (let frame = 0; frame < frames; frame++) {
    const origin = frame * hop - halfWin
    if (!pass.circular && origin >= length) break
    if (pass.circular && frame * hop >= length) break
    for (let c = 0; c < count; c++) {
      const real = re[c]
      const imag = im[c]
      real.fill(0)
      imag.fill(0)
      const channel = inputs[c]
      for (let i = 0; i < size; i++) real[i] = readSample(channel, origin + i, pass.circular) * window[i]
      fft(real, imag, false)
      const magn = mag[c]
      const angle = phase[c]
      for (let k = 0; k <= half; k++) {
        magn[k] = Math.hypot(real[k], imag[k])
        angle[k] = Math.atan2(imag[k], real[k])
      }
    }
    sumMag.fill(0)
    for (let c = 0; c < count; c++) {
      const magn = mag[c]
      for (let k = 0; k <= half; k++) sumMag[k] += magn[k]
    }
    for (let c = 0; c < count; c++) {
      const angle = phase[c]
      const prev = lastPhase[c]
      const hz = freq[c]
      for (let k = 0; k <= half; k++) {
        const delta = princarg(angle[k] - prev[k] - k * expected)
        hz[k] = (k + (osamp * delta) / (2 * Math.PI)) * freqPerBin
        prev[k] = angle[k]
      }
    }
    let energy = 0
    let flux = 0
    for (let k = 1; k < half; k++) {
      energy += sumMag[k]
      if (primed) {
        const rise = sumMag[k] - prevSum[k]
        if (rise > 0) flux += rise
      }
    }
    const transient = primed && energy > 1e-8 && flux / energy > 0.42
    prevSum.set(sumMag)
    const peaks = findPeaks(sumMag)
    const owner = regionOwners(half, peaks)
    const shaped = pass.formant ? cepstralEnvelope(sumMag, size, sampleRate, cepRe, cepIm, env) : null
    for (let c = 0; c < count; c++) {
      synMag[c].fill(0)
      own[c].fill(0)
    }
    const nextPeakPhase = new Float64Array(half + 1)
    for (const peak of peaks) {
      let loud = 0
      for (let c = 1; c < count; c++) if (mag[c][peak] > mag[loud][peak]) loud = c
      const inst = primed ? freq[loud][peak] : peak * freqPerBin
      const refined = refineHz(peak, sumMag, inst, freqPerBin)
      const targetHz = Math.max(1, refined * factor)
      const destPeak = Math.max(1, Math.min(half - 1, Math.round(targetHz / freqPerBin)))
      const shift = destPeak - peak
      let tracked = -1
      if (primed && !transient) {
        let distance = 5
        for (const prev of prevPeaks) {
          const gap = Math.abs(prev - peak)
          if (gap < distance) {
            distance = gap
            tracked = prev
          }
        }
      }
      const carried = tracked >= 0
        ? princarg(peakPhase[tracked] + (2 * Math.PI * targetHz * hop) / sampleRate)
        : phase[loud][peak]
      nextPeakPhase[peak] = carried
      const from = Math.max(1, peak - 2)
      const to = Math.min(half - 1, peak + 2)
      for (let k = from; k <= to; k++) {
        if (owner[k] !== peak) continue
        const dest = k + shift
        if (dest <= 0 || dest >= half) continue
        for (let c = 0; c < count; c++) {
          const binEnv = shaped ? shaped[k] : 1
          const residual = shaped ? mag[c][k] / binEnv : mag[c][k]
          if (!(residual > own[c][dest])) continue
          // Shared peak trajectory, plus this channel's offset from the
          // reference peak. That offset is the lobe shape and the stereo phase.
          const rel = princarg(phase[c][k] - phase[loud][peak])
          own[c][dest] = residual
          synMag[c][dest] = shaped ? residual * shaped[dest] : residual
          synPhase[c][dest] = princarg(carried + rel)
        }
      }
    }
    peakPhase.set(nextPeakPhase)
    prevPeaks = peaks
    primed = true

    for (let c = 0; c < count; c++) {
      const real = re[c]
      const imag = im[c]
      real.fill(0)
      imag.fill(0)
      const magn = synMag[c]
      const angle = synPhase[c]
      for (let k = 1; k < half; k++) {
        if (!(magn[k] > 0)) continue
        real[k] = magn[k] * Math.cos(angle[k])
        imag[k] = magn[k] * Math.sin(angle[k])
        real[size - k] = real[k]
        imag[size - k] = -imag[k]
      }
      fft(real, imag, true)
      const channel = output[c]
      for (let i = 0; i < size; i++) {
        let at = origin + i
        if (pass.circular) {
          at %= length
          if (at < 0) at += length
        } else if (at < 0 || at >= length) continue
        channel[at] += real[i] * window[i]
        if (c === 0) weight[at] += product[i]
      }
    }
  }

  for (let i = 0; i < length; i++) {
    const cover = weight[i]
    const gain = cover > 1e-8 ? 1 / cover : 0
    for (let c = 0; c < count; c++) output[c][i] = sanitize(output[c][i] * gain)
  }
  if (pass.attacks) restoreAttacks(inputs, output, sampleRate, factor, pass.formant)
  if (pass.level) matchLevel(inputs, output)
  return output
}

/** Sample index of each strong attack on the reference channel. */
function findOnsets(input: Float32Array, sampleRate: number) {
  const hop = Math.max(1, Math.round(sampleRate * 0.005))
  const frames = Math.floor(input.length / hop)
  if (frames < 4) return []
  const env = new Float64Array(frames)
  let peak = 0
  for (let i = 0; i < frames; i++) {
    let energy = 0
    const at = i * hop
    const count = Math.min(hop, input.length - at)
    for (let j = 0; j < count; j++) {
      const sample = input[at + j] || 0
      energy += sample * sample
    }
    env[i] = Math.sqrt(energy / Math.max(1, count))
    if (env[i] > peak) peak = env[i]
  }
  if (peak < 1e-4) return []
  const hits: number[] = []
  const gate = peak * 0.28
  const gap = Math.round(0.05 / 0.005)
  let last = -gap
  for (let i = 1; i < frames - 1; i++) {
    if (env[i] < gate || env[i] < env[i - 1] || env[i] < env[i + 1]) continue
    if (env[i] - env[i - 1] < peak * 0.12 || i - last < gap) continue
    const start = i * hop
    let best = start
    let bestAbs = 0
    const from = Math.max(0, start - hop)
    const to = Math.min(input.length, start + hop)
    for (let sample = from; sample < to; sample++) {
      const mag = Math.abs(input[sample] || 0)
      if (mag > bestAbs) {
        bestAbs = mag
        best = sample
      }
    }
    hits.push(best)
    last = i
  }
  return hits
}

/**
 * The long window can print a hit a few milliseconds early.
 * A short window over just the attack puts the transient back on its sample.
 * Every channel uses the same onset, so a stereo hit does not split.
 */
function restoreAttacks(inputs: Float32Array[], shifted: Float32Array[], sampleRate: number, factor: number, formant: boolean) {
  const length = inputs[0]?.length ?? 0
  if (length < 2048) return
  const hits = findOnsets(inputs[0], sampleRate)
  const keep = Math.max(64, Math.round(sampleRate * 0.016))
  for (const hit of hits) {
    const start = Math.max(0, hit - 48)
    const end = Math.min(length, start + 2048)
    if (end - start < MIN_SIZE) continue
    const slices = inputs.map((channel) => Float32Array.from(channel.subarray(start, end)))
    const local = shiftChannels(slices, sampleRate, factor, planFor(1024), { circular: false, formant, attacks: false, level: true })
    const fade = Math.min(keep, local[0].length, length - start)
    const lead = Math.min(Math.round(sampleRate * 0.004), fade)
    for (let c = 0; c < shifted.length; c++) {
      const channel = shifted[c]
      const piece = local[Math.min(c, local.length - 1)]
      for (let i = 0; i < fade; i++) {
        const localGain = i < lead ? 1 : 1 - (i - lead) / Math.max(1, fade - lead)
        channel[start + i] = piece[i] * localGain + channel[start + i] * (1 - localGain)
      }
    }
    const gap = Math.round(sampleRate * 0.008)
    const duck = Math.round(sampleRate * 0.02)
    const earlyTo = Math.max(0, hit - gap)
    const earlyFrom = Math.max(0, earlyTo - duck)
    let early = 0
    for (let i = earlyFrom; i < earlyTo; i++) early += (inputs[0][i] || 0) ** 2
    let burst = 0
    const burstTo = Math.min(length, hit + gap)
    for (let i = hit; i < burstTo; i++) burst += (inputs[0][i] || 0) ** 2
    if (burst > 1e-8 && early / burst < 0.02) {
      for (let i = earlyFrom; i < start; i++) {
        const gain = (i - earlyFrom) / Math.max(1, start - earlyFrom)
        const curved = gain * gain
        for (let c = 0; c < shifted.length; c++) shifted[c][i] *= curved
      }
    }
  }
}

/** One gain for every channel, so a stereo balance does not move to chase a peak. */
function matchLevel(inputs: Float32Array[], outputs: Float32Array[]) {
  let inEnergy = 0
  let outEnergy = 0
  let count = 0
  let peak = 0
  for (let c = 0; c < outputs.length; c++) {
    const input = inputs[Math.min(c, inputs.length - 1)]
    const output = outputs[c]
    for (let i = 0; i < output.length; i++) {
      const sample = output[i]
      inEnergy += (input[i] || 0) ** 2
      outEnergy += sample * sample
      count++
      const mag = Math.abs(sample)
      if (mag > peak) peak = mag
    }
  }
  const inRms = Math.sqrt(inEnergy / Math.max(1, count))
  const outRms = Math.sqrt(outEnergy / Math.max(1, count))
  let gain = outRms > 1e-8 && inRms > 1e-8 ? inRms / outRms : 1
  if (!Number.isFinite(gain)) gain = 1
  gain = Math.min(4, Math.max(0.25, gain))
  if (peak * gain > 1) gain = peak > 0 ? 0.99 / peak : gain
  if (Math.abs(gain - 1) < 1e-4) return
  for (let c = 0; c < outputs.length; c++) {
    const output = outputs[c]
    for (let i = 0; i < output.length; i++) output[i] = sanitize(output[i] * gain)
  }
}

function closeLoop(channels: Float32Array[], sampleRate: number) {
  if (!channels.some((channel) => seamWouldClick(channel))) return channels
  return channels.map((channel) => bakeLoopSeam(channel, sampleRate))
}

function wantsCircular(channels: Float32Array[]) {
  const voiced = channels.filter((channel) => {
    let energy = 0
    const step = Math.max(1, Math.floor(channel.length / 32))
    for (let i = 0; i < channel.length; i += step) energy += (channel[i] || 0) ** 2
    return energy > 1e-8
  })
  if (!voiced.length) return false
  return voiced.every(joinsAsLoop)
}

function wrapLoop(channels: Float32Array[], pad: number) {
  return channels.map((channel) => {
    const extended = new Float32Array(channel.length + pad * 2)
    const length = channel.length
    for (let i = 0; i < extended.length; i++) {
      let at = (i - pad) % length
      if (at < 0) at += length
      extended[i] = channel[at] || 0
    }
    return extended
  })
}

function renderShift(inputs: Float32Array[], sampleRate: number, factor: number, formant: boolean, forcedSize?: number) {
  const size = forcedSize ?? chooseSize(inputs, sampleRate)
  const circular = forcedSize ? false : wantsCircular(inputs)
  const plan = planFor(size)
  if (circular) {
    // Pad with the opposite end so the join is an interior frame of a
    // constant-overlap Hann grid, then keep the original length.
    // Two windows of context. One window still sits on the overlap ramp,
    // and that ramp became a click when the loop came back around.
    const pad = size * 2
    const rendered = shiftChannels(wrapLoop(inputs, pad), sampleRate, factor, plan, {
      circular: false,
      formant,
      attacks: false,
      level: false,
    })
    const cropped = rendered.map((channel) => Float32Array.from(channel.subarray(pad, pad + inputs[0].length)))
    matchLevel(inputs, cropped)
    // A semitone ratio is not a whole number of cycles, so a perfect shift of a
    // seamless loop still jumps at the join. The same 2 ms blend playback uses
    // closes that join without moving the pitch.
    const closed = closeLoop(cropped, sampleRate)
    if (closed !== cropped) matchLevel(inputs, closed)
    return closed
  }
  return shiftChannels(inputs, sampleRate, factor, plan, { circular: false, formant, attacks: !forcedSize, level: true })
}

/** Same-length pitch shift of one channel. */
export function formantPitchShift(input: Float32Array, sampleRate: number, factor: number, formant: boolean) {
  const output = new Float32Array(input.length)
  if (input.length < 8 || !(sampleRate > 0) || !Number.isFinite(factor) || factor <= 0) {
    output.set(input.subarray(0, Math.min(input.length, output.length)))
    return output
  }
  if (Math.abs(factor - 1) < 1e-4) {
    output.set(input)
    return output
  }
  if (input.length < MIN_SIZE) {
    output.set(input.subarray(0, Math.min(input.length, output.length)))
    return output
  }
  return renderShift([input], sampleRate, factor, formant)[0] ?? output
}

export function pitchFactorOf(semitones = 0, cents = 0) {
  return 2 ** ((semitones + cents / 100) / 12)
}

/**
 * Stereo-safe. Channels share one phase trajectory so the image stays put.
 * Length matches the source on every channel.
 */
export function formantPitchChannels(channels: Float32Array[], sampleRate: number, options: FormantPitchOptions) {
  const factor = pitchFactorOf(options.semitones ?? 0, options.cents ?? 0)
  const formant = options.formant !== false
  const usable = channels.filter((channel) => channel && channel.length)
  if (!usable.length) return []
  const length = usable[0].length
  const aligned = usable.map((channel) => {
    if (channel.length === length) return channel
    const fitted = new Float32Array(length)
    fitted.set(channel.subarray(0, Math.min(channel.length, length)))
    return fitted
  })
  if (aligned[0].length < 8 || !(sampleRate > 0) || !Number.isFinite(factor) || factor <= 0) {
    return aligned.map((channel) => Float32Array.from(channel))
  }
  if (Math.abs(factor - 1) < 1e-4 || aligned[0].length < MIN_SIZE) {
    return aligned.map((channel) => Float32Array.from(channel))
  }
  return renderShift(aligned, sampleRate, factor, formant)
}
