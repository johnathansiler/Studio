import { analyze, frameCount, hann, mirror, synthesize } from './fft'
import { broadband, frameWeights, regionHz, regionTime } from './mask'
import { HQ_SPECTRAL, NOISE_BANDS, type SpectralOp, type SpectralRegion, type SpectralRepair, type SpectralSettings } from './types'

const PAD_FACTOR = 1

export function renderSpectral(
  channels: Float32Array[],
  sampleRate: number,
  repair: Pick<SpectralRepair, 'ops' | 'noiseBands' | 'noiseRate' | 'enabled'>,
  settings: SpectralSettings = HQ_SPECTRAL,
  onProgress?: (ratio: number) => void,
): Float32Array[] {
  if (repair.enabled === false || !repair.ops.length) return channels.map((channel) => Float32Array.from(channel))
  let audio = channels.map((channel) => Float32Array.from(channel))
  let index = 0
  while (index < repair.ops.length) {
    const op = repair.ops[index]
    if (op.action === 'dehum' || (op.action === 'declick' && broadband(op.region, sampleRate))) {
      audio = audio.map((channel) => (op.action === 'dehum' ? dehum(channel, sampleRate, op) : declick(channel, sampleRate, op)))
      index += 1
      onProgress?.(index / repair.ops.length)
      continue
    }
    let end = index
    while (end < repair.ops.length) {
      const next = repair.ops[end]
      if (next.action === 'dehum' || (next.action === 'declick' && broadband(next.region, sampleRate))) break
      end += 1
    }
    audio = spectralPass(audio, sampleRate, repair.ops.slice(index, end), repair, settings, (inner) => {
      onProgress?.((index + inner * (end - index)) / repair.ops.length)
    })
    index = end
  }
  onProgress?.(1)
  return audio
}

export function learnNoise(
  channels: Float32Array[],
  sampleRate: number,
  region: SpectralRegion,
  settings: SpectralSettings = HQ_SPECTRAL,
): number[] {
  const edges = bandEdges(sampleRate / 2)
  const sums = new Float64Array(NOISE_BANDS)
  const counts = new Float64Array(NOISE_BANDS)
  for (const channel of channels) {
    const { padded, pad } = padChannel(channel, settings.fftSize)
    const window = hann(settings.fftSize)
    const spec = analyze(padded, settings.fftSize, settings.hop, window)
    const frames = spec.re.length
    const bins = (settings.fftSize >> 1) + 1
    for (let frame = 0; frame < frames; frame++) {
      const t = (frame * settings.hop + settings.fftSize / 2 - pad) / Math.max(1, channel.length)
      for (let bin = 1; bin < bins - 1; bin++) {
        const hz = (bin * sampleRate) / settings.fftSize
        if (!containsLoose(region, t, hz)) continue
        const mag = Math.hypot(spec.re[frame][bin], spec.im[frame][bin])
        const band = bandIndex(hz, edges)
        sums[band] += mag
        counts[band] += 1
      }
    }
  }
  const bands: number[] = []
  let last = 0
  for (let i = 0; i < NOISE_BANDS; i++) {
    const value = counts[i] > 0 ? sums[i] / counts[i] : last
    last = value
    bands.push(Math.round(value * 1e5) / 1e5)
  }
  return bands
}

export function bandEdges(nyquist: number) {
  const low = 30
  const high = Math.max(low * 1.01, nyquist)
  const edges: number[] = []
  for (let i = 0; i <= NOISE_BANDS; i++) edges.push(low * (high / low) ** (i / NOISE_BANDS))
  return edges
}

function spectralPass(
  channels: Float32Array[],
  sampleRate: number,
  ops: SpectralOp[],
  repair: Pick<SpectralRepair, 'noiseBands' | 'noiseRate'>,
  settings: SpectralSettings,
  onFrame?: (ratio: number) => void,
) {
  return channels.map((channel) => {
    const { padded, pad } = padChannel(channel, settings.fftSize)
    const window = hann(settings.fftSize)
    const spec = analyze(padded, settings.fftSize, settings.hop, window)
    const frames = spec.re.length
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex]
      const action = op.action === 'declick' ? 'heal' : op.action
      const weights = frameWeights(op.region, frames, settings.fftSize, settings.hop, sampleRate, channel.length, pad)
      if (action === 'attenuate') attenuate(spec, weights, op.amount)
      else if (action === 'heal') heal(spec, weights, op.amount, settings)
      else if (action === 'denoise') denoise(spec, weights, op.amount, repair, settings, sampleRate)
      onFrame?.((opIndex + 1) / ops.length)
    }
    for (let frame = 0; frame < frames; frame++) mirror(spec.re[frame], spec.im[frame])
    const rendered = synthesize(spec, padded.length, settings.fftSize, settings.hop, window)
    return Float32Array.from(rendered.subarray(pad, pad + channel.length))
  })
}

function attenuate(spec: { re: Float64Array[]; im: Float64Array[] }, weights: Float32Array[], amount: number) {
  for (let frame = 0; frame < spec.re.length; frame++) {
    const row = weights[frame]
    for (let bin = 0; bin < row.length; bin++) {
      const gain = 1 - amount * row[bin]
      spec.re[frame][bin] *= gain
      spec.im[frame][bin] *= gain
    }
  }
}

function heal(
  spec: { re: Float64Array[]; im: Float64Array[] },
  weights: Float32Array[],
  amount: number,
  settings: SpectralSettings,
) {
  const originalRe = spec.re.map((row) => Float64Array.from(row))
  const originalIm = spec.im.map((row) => Float64Array.from(row))
  const frames = spec.re.length
  for (let frame = 0; frame < frames; frame++) {
    const row = weights[frame]
    for (let bin = 1; bin < row.length - 1; bin++) {
      const weight = row[bin] * amount
      if (weight <= 0) continue
      const clearance = Math.max(1, Math.round(settings.fftSize / (2 * settings.hop)))
      let left = frame - 1
      while (left >= 0 && weights[left][bin] > 0.5) left -= 1
      let right = frame + 1
      while (right < frames && weights[right][bin] > 0.5) right += 1
      if (left >= 0) left = Math.max(0, left - clearance)
      if (right < frames) right = Math.min(frames - 1, right + clearance)
      if (left >= 0 && weights[left][bin] > 0.5) left = -1
      if (right < frames && weights[right][bin] > 0.5) right = frames
      const expected = (2 * Math.PI * bin * settings.hop) / settings.fftSize
      let mag = 0
      let phase = 0
      let anchor = -1
      let hopAdvance = expected
      if (left >= 1 && weights[left][bin] <= 0.5 && weights[left - 1][bin] <= 0.5) {
        anchor = left
        hopAdvance = unwrap(angle(originalIm[left][bin], originalRe[left][bin]) - angle(originalIm[left - 1][bin], originalRe[left - 1][bin]) - expected) + expected
      } else if (right + 1 < frames && right >= 0 && weights[right][bin] <= 0.5 && weights[right + 1][bin] <= 0.5) {
        anchor = right
        hopAdvance = unwrap(angle(originalIm[right + 1][bin], originalRe[right + 1][bin]) - angle(originalIm[right][bin], originalRe[right][bin]) - expected) + expected
      } else if (left >= 0) anchor = left
      else if (right < frames) anchor = right
      else continue
      const magL = left >= 0 ? Math.hypot(originalRe[left][bin], originalIm[left][bin]) : 0
      const magR = right < frames ? Math.hypot(originalRe[right][bin], originalIm[right][bin]) : magL
      if (left >= 0 && right < frames && right > left) {
        const t = (frame - left) / (right - left)
        mag = magL * (1 - t) + magR * t
      } else mag = anchor === right ? magR : magL
      phase = angle(originalIm[anchor][bin], originalRe[anchor][bin]) + hopAdvance * (frame - anchor)
      const keep = 1 - weight
      const re = spec.re[frame][bin] * keep + mag * Math.cos(phase) * weight
      const im = spec.im[frame][bin] * keep + mag * Math.sin(phase) * weight
      spec.re[frame][bin] = re
      spec.im[frame][bin] = im
    }
  }
}

function denoise(
  spec: { re: Float64Array[]; im: Float64Array[] },
  weights: Float32Array[],
  amount: number,
  repair: Pick<SpectralRepair, 'noiseBands' | 'noiseRate'>,
  settings: SpectralSettings,
  sampleRate: number,
) {
  const bands = repair.noiseBands
  if (!bands?.length) return
  const edges = bandEdges((repair.noiseRate || sampleRate) / 2)
  const frames = spec.re.length
  const bins = weights[0]?.length ?? 0
  const gains = spec.re.map(() => new Float64Array(bins).fill(1))
  const over = 1 + amount
  const floor = 0.02 * (1 - amount) + 0.002
  for (let frame = 0; frame < frames; frame++) {
    for (let bin = 1; bin < bins - 1; bin++) {
      const mag = Math.hypot(spec.re[frame][bin], spec.im[frame][bin])
      const hz = (bin * sampleRate) / settings.fftSize
      const noise = noiseMag(hz, bands, edges)
      const power = mag * mag + 1e-12
      const raw = 1 - over * ((noise * noise) / power)
      const wet = Math.max(floor, Math.min(1, raw))
      const mix = weights[frame][bin] * amount
      gains[frame][bin] = 1 - mix * (1 - wet)
    }
  }
  const smooth = gains.map((row) => Float64Array.from(row))
  for (let frame = 0; frame < frames; frame++) {
    for (let bin = 1; bin < bins - 1; bin++) {
      let sum = 0
      let count = 0
      for (let df = -1; df <= 1; df++) {
        const other = gains[frame + df]
        if (!other) continue
        for (let db = -1; db <= 1; db++) {
          sum += other[bin + db] ?? other[bin]
          count += 1
        }
      }
      smooth[frame][bin] = sum / count
    }
    for (let bin = 0; bin < bins; bin++) {
      spec.re[frame][bin] *= smooth[frame][bin]
      spec.im[frame][bin] *= smooth[frame][bin]
    }
  }
}

function angle(im: number, re: number) {
  return Math.atan2(im, re)
}

function unwrap(delta: number) {
  let value = delta
  while (value > Math.PI) value -= 2 * Math.PI
  while (value < -Math.PI) value += 2 * Math.PI
  return value
}

function declick(channel: Float32Array, sampleRate: number, op: SpectralOp) {
  const out = Float32Array.from(channel)
  const [t0, t1] = regionTime(op.region)
  const start = Math.max(1, Math.floor(t0 * channel.length))
  const end = Math.min(channel.length - 1, Math.ceil(t1 * channel.length))
  if (end - start < 4) return out
  const diffs: number[] = []
  for (let i = start; i < end; i++) diffs.push(Math.abs(channel[i] - channel[i - 1]))
  const median = percentile(diffs, 0.5)
  const absDev = diffs.map((value) => Math.abs(value - median))
  const mad = percentile(absDev, 0.5) || 1e-6
  const threshold = Math.max(0.45, median + 8 * mad)
  const margin = Math.max(1, Math.round(sampleRate * 0.001))
  const maxWidth = Math.max(4, Math.round(sampleRate * 0.01))
  let index = start
  while (index < end) {
    if (Math.abs(channel[index] - channel[index - 1]) < threshold) {
      index += 1
      continue
    }
    let run = index
    while (run < end && Math.abs(channel[run] - channel[run - 1]) >= threshold * 0.5) run += 1
    const from = Math.max(start, index - margin)
    const to = Math.min(end, run + margin)
    if (to - from <= maxWidth && to > from + 1) {
      const left = out[from - 1] ?? out[from]
      const right = out[to] ?? out[to - 1]
      const span = to - (from - 1)
      for (let sample = from; sample < to; sample++) {
        const t = (sample - (from - 1)) / span
        const wet = left + (right - left) * t
        out[sample] = channel[sample] * (1 - op.amount) + wet * op.amount
      }
    }
    index = Math.max(run, index + 1)
  }
  return out
}

function dehum(channel: Float32Array, sampleRate: number, op: SpectralOp) {
  const fundamental = op.humHz && op.humHz > 0 ? op.humHz : detectHum(channel, sampleRate, op.region)
  const harmonics = harmonicsInside(fundamental, op.region, sampleRate)
  if (!harmonics.length) return Float32Array.from(channel)
  let wet = Float32Array.from(channel)
  for (const freq of harmonics) wet = zeroPhaseNotch(wet, sampleRate, freq)
  return blendTime(channel, wet, op)
}

export function detectHum(channel: Float32Array, sampleRate: number, region: SpectralRegion) {
  const [t0, t1] = regionTime(region)
  const start = Math.max(0, Math.floor(t0 * channel.length))
  const end = Math.min(channel.length, Math.ceil(t1 * channel.length))
  const slice = channel.subarray(start, Math.max(start + 8, end))
  const stack = (base: number) => goertzelPower(slice, sampleRate, base) + goertzelPower(slice, sampleRate, base * 2) + goertzelPower(slice, sampleRate, base * 3)
  return stack(60) > stack(50) ? 60 : 50
}

function harmonicsInside(fundamental: number, region: SpectralRegion, sampleRate: number) {
  const [hz0, hz1] = regionHz(region)
  const span = hz1 - hz0
  const full = span > sampleRate * 0.25
  const lo = full ? 20 : hz0
  const hi = full ? Math.min(sampleRate * 0.45, 8000) : hz1
  const out: number[] = []
  if (fundamental <= 0) return out
  for (let partial = 1; partial < 48; partial++) {
    const freq = fundamental * partial
    if (freq >= sampleRate * 0.45) break
    if (freq >= lo && freq <= hi) out.push(freq)
  }
  return out
}

function zeroPhaseNotch(channel: Float32Array, sampleRate: number, freq: number) {
  const bandwidth = Math.max(4, freq / 50)
  const q = freq / bandwidth
  const w0 = (2 * Math.PI * freq) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cos = Math.cos(w0)
  const b0 = 1
  const b1 = -2 * cos
  const b2 = 1
  const a0 = 1 + alpha
  const a1 = -2 * cos / a0
  const a2 = (1 - alpha) / a0
  const nb0 = b0 / a0
  const nb1 = b1 / a0
  const nb2 = b2 / a0
  const pad = Math.min(Math.max(0, channel.length - 1), Math.round(sampleRate * Math.min(0.35, 4 / bandwidth)))
  const extended = reflect(channel, pad)
  let y = biquad(extended, nb0, nb1, nb2, a1, a2)
  y.reverse()
  y = biquad(y, nb0, nb1, nb2, a1, a2)
  y.reverse()
  return y.subarray(pad, pad + channel.length)
}

function blendTime(dry: Float32Array, wet: Float32Array, op: SpectralOp) {
  const out = new Float32Array(dry.length)
  const [t0, t1] = regionTime(op.region)
  const start = Math.floor(t0 * dry.length)
  const end = Math.ceil(t1 * dry.length)
  const fade = Math.min(128, Math.max(0, Math.floor((end - start) / 8)))
  for (let i = 0; i < dry.length; i++) {
    let gate = 0
    if (i >= start && i < end) gate = 1
    if (fade > 0 && i >= start && i < start + fade) gate = (i - start) / fade
    if (fade > 0 && i >= end - fade && i < end) gate = Math.min(gate, (end - i) / fade)
    const mix = gate * op.amount
    out[i] = dry[i] * (1 - mix) + wet[i] * mix
  }
  return out
}

function biquad(input: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number) {
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = input[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    out[i] = y
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
  }
  return out
}

function reflect(channel: Float32Array, pad: number) {
  const out = new Float32Array(channel.length + pad * 2)
  for (let i = 0; i < pad; i++) out[i] = channel[Math.min(channel.length - 1, pad - i)] ?? 0
  out.set(channel, pad)
  for (let i = 0; i < pad; i++) out[pad + channel.length + i] = channel[Math.max(0, channel.length - 2 - i)] ?? 0
  return out
}

export function goertzelPower(samples: Float32Array, sampleRate: number, freq: number) {
  const n = samples.length
  if (n < 8 || freq <= 0) return 0
  const k = Math.round((freq * n) / sampleRate)
  const w = (2 * Math.PI * k) / n
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const s0 = samples[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

function padChannel(channel: Float32Array, fftSize: number) {
  const pad = fftSize * PAD_FACTOR
  const padded = new Float32Array(channel.length + pad * 2)
  padded.set(channel, pad)
  return { padded, pad }
}

function containsLoose(region: SpectralRegion, t: number, hz: number) {
  if (region.tool === 'harmonic') {
    const [t0, t1] = regionTime(region)
    return t >= t0 && t <= t1
  }
  const [t0, t1] = regionTime(region)
  const [f0, f1] = regionHz(region)
  if (region.tool === 'lasso') {
    return t >= t0 && t <= t1 && hz >= f0 && hz <= f1
  }
  return t >= t0 && t <= t1 && hz >= f0 && hz <= f1
}

function bandIndex(hz: number, edges: number[]) {
  let band = 0
  while (band < NOISE_BANDS - 1 && hz >= edges[band + 1]) band += 1
  return band
}

function noiseMag(hz: number, bands: number[], edges: number[]) {
  const band = bandIndex(hz, edges)
  const prev = bands[Math.max(0, band - 1)] || 0
  const next = bands[Math.min(bands.length - 1, band + 1)] || 0
  const mid = bands[band] || 0
  return (prev + mid * 2 + next) / 4
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[index]
}

export function usedFrameCount(length: number, settings: SpectralSettings) {
  return frameCount(length + settings.fftSize * 2, settings.fftSize, settings.hop)
}
