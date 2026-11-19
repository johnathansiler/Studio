/**
 * Offline pitch shift.
 *
 * A phase vocoder in the Laroche–Dolson style: each frame's instantaneous
 * frequency is measured, spectral peaks own a region, and bins inside that
 * region keep the peak's phase rotation plus their original offset (identity
 * phase locking). Transients reset that phase so attacks are not smeared.
 * The window grows on sustained notes and shrinks when the clip is full of
 * hits. Formant preservation lifts the cepstral envelope off, shifts the
 * residual, and puts the original envelope back, so a vocal does not chipmunk.
 * The output length is the input length. The source buffer is never rewritten.
 */

import { fft } from './phase'

export interface FormantPitchOptions {
  semitones?: number
  cents?: number
  /** Keep the spectral envelope. Off moves the formants with the pitch. */
  formant?: boolean
}

const MIN_SIZE = 512
const MAX_SIZE = 8192

function princarg(phase: number) {
  return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI))
}

function nextPow2(value: number) {
  let size = MIN_SIZE
  while (size < value) size <<= 1
  return size
}

function hann(size: number) {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  return window
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

function chooseSize(input: Float32Array, sampleRate: number) {
  const density = onsetDensity(input, sampleRate)
  const crest = crestFactor(input)
  // A single pluck is not "many hits", but its crest still needs a short window
  // or the long FFT prints the attack early.
  const prefer = density > 8 || crest > 6 ? 2048 : density > 3 || crest > 3.2 ? 4096 : 8192
  let size = nextPow2(Math.max(MIN_SIZE, Math.round(prefer * (sampleRate / 48000))))
  if (size > MAX_SIZE) size = MAX_SIZE
  while (size > input.length && size > MIN_SIZE) size >>= 1
  return Math.max(MIN_SIZE, size)
}

function findPeaks(mag: Float64Array) {
  const half = mag.length - 1
  let max = 0
  for (let k = 1; k < half; k++) if (mag[k] > max) max = mag[k]
  const floor = max * 0.015
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
  if (!peaks.length) return owner
  let index = 0
  for (let bin = 0; bin <= half; bin++) {
    while (index + 1 < peaks.length && Math.abs(peaks[index + 1] - bin) <= Math.abs(peaks[index] - bin)) index++
    owner[bin] = peaks[index]
  }
  return owner
}

/** Slow spectral shape. Harmonic spikes sit above this and are what we shift. */
function cepstralEnvelope(mag: Float64Array, fftSize: number, sampleRate: number) {
  const half = fftSize >> 1
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  for (let k = 0; k <= half; k++) {
    const value = Math.log(mag[k] + 1e-10)
    re[k] = value
    if (k > 0 && k < half) re[fftSize - k] = value
  }
  fft(re, im, true)
  // Short enough to sit under the pitch period, long enough to keep a formant.
  const lifter = Math.max(12, Math.min(Math.round(sampleRate / 900), Math.floor(fftSize / 12)))
  for (let n = lifter; n <= fftSize - lifter; n++) {
    re[n] = 0
    im[n] = 0
  }
  fft(re, im, false)
  const env = new Float64Array(half + 1)
  let max = 0
  for (let k = 0; k <= half; k++) {
    env[k] = Math.exp(re[k])
    if (env[k] > max) max = env[k]
  }
  const floor = Math.max(1e-8, max * 1e-4)
  for (let k = 0; k <= half; k++) if (env[k] < floor) env[k] = floor
  return env
}

interface FramePlan {
  size: number
  hop: number
  window: Float64Array
  /** Flat 1 over the first half of frame 0 so the opening attack is not faded out. */
  edgeWindow: Float64Array
}

function planFor(size: number): FramePlan {
  const hop = Math.max(32, size >> 2)
  const window = hann(size)
  const edgeWindow = window.slice()
  const half = size >> 1
  for (let i = 0; i < half; i++) edgeWindow[i] = 1
  return { size, hop, window, edgeWindow }
}

function analyze(input: Float32Array, at: number, plan: FramePlan, edge: boolean) {
  const { size, window, edgeWindow } = plan
  const use = edge ? edgeWindow : window
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let i = 0; i < size; i++) re[i] = (input[at + i] || 0) * use[i]
  fft(re, im, false)
  const half = size >> 1
  const mag = new Float64Array(half + 1)
  const phase = new Float64Array(half + 1)
  let energy = 0
  for (let k = 0; k <= half; k++) {
    mag[k] = Math.hypot(re[k], im[k])
    phase[k] = Math.atan2(im[k], re[k])
    energy += mag[k]
  }
  return { mag, phase, energy }
}

function shiftFrame(
  mag: Float64Array,
  phase: Float64Array,
  sampleRate: number,
  fftSize: number,
  hop: number,
  factor: number,
  formant: boolean,
  lastPhase: Float64Array,
  peakPhase: Float64Array,
  prevPeaks: number[],
  primed: boolean,
  transient: boolean,
) {
  const half = fftSize >> 1
  const osamp = fftSize / hop
  const freqPerBin = sampleRate / fftSize
  const expected = (2 * Math.PI * hop) / fftSize
  const peaks = findPeaks(mag)
  const owner = regionOwners(half, peaks)
  const trueFreq = new Float64Array(half + 1)
  for (let k = 0; k <= half; k++) {
    let delta = phase[k] - lastPhase[k]
    lastPhase[k] = phase[k]
    delta -= k * expected
    delta = princarg(delta)
    const bins = k + (osamp * delta) / (2 * Math.PI)
    trueFreq[k] = bins * freqPerBin
  }
  const env = formant ? cepstralEnvelope(mag, fftSize, sampleRate) : null
  const nextPeakPhase = new Float64Array(half + 1)
  for (const peak of peaks) {
    let carried = phase[peak]
    if (primed && !transient) {
      let best = -1
      let distance = 4
      for (const prev of prevPeaks) {
        const gap = Math.abs(prev - peak)
        if (gap < distance) {
          distance = gap
          best = prev
        }
      }
      if (best >= 0) {
        const shiftedHz = trueFreq[peak] * factor
        carried = princarg(peakPhase[best] + (2 * Math.PI * shiftedHz * hop) / sampleRate)
      }
    }
    nextPeakPhase[peak] = carried
  }

  const flat = new Float64Array(half + 1)
  const synPhase = new Float64Array(half + 1)
  const own = new Float64Array(half + 1)
  for (let k = 0; k <= half; k++) {
    const peak = owner[k] || peaks[0] || 0
    const residual = env ? mag[k] / env[k] : mag[k]
    const dest = k * factor
    const i0 = Math.floor(dest)
    const frac = dest - i0
    const peakPhaseNow = nextPeakPhase[peak] || phase[peak]
    const offset = princarg(phase[k] - phase[peak])
    const binPhase = princarg(peakPhaseNow + offset)
    const place = (bin: number, gain: number) => {
      if (bin < 0 || bin > half || gain <= 0) return
      const add = residual * gain
      flat[bin] += add
      if (add >= own[bin]) {
        own[bin] = add
        synPhase[bin] = binPhase
      }
    }
    place(i0, 1 - frac)
    place(i0 + 1, frac)
  }
  const synMagn = new Float64Array(half + 1)
  for (let k = 0; k <= half; k++) synMagn[k] = env ? flat[k] * env[k] : flat[k]
  return { synMagn, synPhase, peaks, nextPeakPhase }
}

function synthesize(
  input: Float32Array,
  sampleRate: number,
  factor: number,
  formant: boolean,
  plan: FramePlan,
) {
  const { size, hop, window } = plan
  const half = size >> 1
  const output = new Float32Array(input.length)
  const weight = new Float64Array(input.length)
  const lastPhase = new Float64Array(half + 1)
  const peakPhase = new Float64Array(half + 1)
  const prevMag = new Float64Array(half + 1)
  let prevPeaks: number[] = []
  let primed = false
  const frames = Math.ceil(input.length / hop) + 2
  for (let frame = 0; frame < frames; frame++) {
    const inAt = frame * hop
    const outAt = inAt
    if (outAt >= input.length) break
    if (inAt >= input.length) break
    const edge = frame === 0
    const { mag, phase, energy } = analyze(input, inAt, plan, edge)
    let flux = 0
    if (primed) {
      for (let k = 1; k < half; k++) {
        const rise = mag[k] - prevMag[k]
        if (rise > 0) flux += rise
      }
    }
    const transient = primed && energy > 1e-8 && flux / energy > 0.42
    const shifted = shiftFrame(
      mag,
      phase,
      sampleRate,
      size,
      hop,
      factor,
      formant,
      lastPhase,
      peakPhase,
      prevPeaks,
      primed,
      transient,
    )
    peakPhase.set(shifted.nextPeakPhase)
    prevPeaks = shifted.peaks
    prevMag.set(mag)
    primed = true
    const re = new Float64Array(size)
    const im = new Float64Array(size)
    for (let k = 0; k <= half; k++) {
      re[k] = shifted.synMagn[k] * Math.cos(shifted.synPhase[k])
      im[k] = shifted.synMagn[k] * Math.sin(shifted.synPhase[k])
      if (k > 0 && k < half) {
        re[size - k] = re[k]
        im[size - k] = -im[k]
      }
    }
    fft(re, im, true)
    const useWindow = edge ? plan.edgeWindow : window
    const attack = transient ? Math.round(sampleRate * 0.012) : 0
    for (let i = 0; i < size; i++) {
      const at = outAt + i
      if (at < 0 || at >= output.length) continue
      const shaped = re[i] * useWindow[i]
      const cover = useWindow[i]
      if (attack && i < attack) {
        const keep = 1 - i / attack
        output[at] += shaped * (1 + keep)
        weight[at] += cover * (1 + keep)
      } else {
        output[at] += shaped
        weight[at] += cover
      }
    }
  }
  for (let i = 0; i < output.length; i++) {
    const cover = weight[i]
    output[i] = cover > 1e-6 ? sanitize(output[i] / cover) : 0
  }
  return output
}

function limitPeak(channel: Float32Array) {
  let peak = 0
  for (let i = 0; i < channel.length; i++) {
    const mag = Math.abs(channel[i])
    if (mag > peak) peak = mag
  }
  if (peak <= 1) return channel
  const gain = 0.99 / peak
  for (let i = 0; i < channel.length; i++) channel[i] *= gain
  return channel
}

function rms(channel: Float32Array) {
  let sum = 0
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i]
  return Math.sqrt(sum / Math.max(1, channel.length))
}

function shiftBody(input: Float32Array, sampleRate: number, factor: number, formant: boolean, forcedSize?: number) {
  const size = forcedSize ?? chooseSize(input, sampleRate)
  return synthesize(input, sampleRate, factor, formant, planFor(size))
}

/** Sample index of each strong attack. */
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
 */
function restoreAttacks(input: Float32Array, shifted: Float32Array, sampleRate: number, factor: number, formant: boolean) {
  if (input.length < 2048) return
  const hits = findOnsets(input, sampleRate)
  const keep = Math.max(64, Math.round(sampleRate * 0.016))
  for (const hit of hits) {
    const start = Math.max(0, hit - 48)
    const end = Math.min(input.length, start + 2048)
    if (end - start < MIN_SIZE) continue
    const slice = input.subarray(start, end)
    const local = shiftBody(slice, sampleRate, factor, formant, 1024)
    const fade = Math.min(keep, local.length, shifted.length - start)
    const lead = Math.min(Math.round(sampleRate * 0.004), fade)
    for (let i = 0; i < fade; i++) {
      const localGain = i < lead ? 1 : 1 - (i - lead) / Math.max(1, fade - lead)
      shifted[start + i] = local[i] * localGain + shifted[start + i] * (1 - localGain)
    }
    // An isolated hit should not ring in the silence before it. The rise
    // itself is not "before", so the quiet test stops a few milliseconds early.
    // A note that was already sounding is left alone.
    const gap = Math.round(sampleRate * 0.008)
    const duck = Math.round(sampleRate * 0.02)
    const earlyTo = Math.max(0, hit - gap)
    const earlyFrom = Math.max(0, earlyTo - duck)
    let early = 0
    for (let i = earlyFrom; i < earlyTo; i++) early += (input[i] || 0) ** 2
    let burst = 0
    const burstTo = Math.min(input.length, hit + gap)
    for (let i = hit; i < burstTo; i++) burst += (input[i] || 0) ** 2
    if (burst > 1e-8 && early / burst < 0.02) {
      for (let i = earlyFrom; i < start; i++) {
        const gain = (i - earlyFrom) / Math.max(1, start - earlyFrom)
        shifted[i] *= gain * gain
      }
    }
  }
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
    return limitPeak(output)
  }
  const shifted = shiftBody(input, sampleRate, factor, formant)
  if (shifted.length !== input.length) {
    const fitted = new Float32Array(input.length)
    fitted.set(shifted.subarray(0, Math.min(shifted.length, input.length)))
    return limitPeak(fitted)
  }
  if (rms(shifted) < rms(input) * 0.08) {
    output.set(input)
    return output
  }
  restoreAttacks(input, shifted, sampleRate, factor, formant)
  return limitPeak(shifted)
}

export function pitchFactorOf(semitones = 0, cents = 0) {
  return 2 ** ((semitones + cents / 100) / 12)
}

/** Stereo-safe. Each channel is shifted. Length matches the source. */
export function formantPitchChannels(channels: Float32Array[], sampleRate: number, options: FormantPitchOptions) {
  const factor = pitchFactorOf(options.semitones ?? 0, options.cents ?? 0)
  const formant = options.formant !== false
  return channels.map((channel) => formantPitchShift(channel, sampleRate, factor, formant))
}
