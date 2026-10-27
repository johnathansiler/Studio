import { descriptor, FACTORY } from '../catalog'
import { tickBiquad, type Biquad } from '../dsp'
import type { PluginModule, Processor } from '../types'
import {
  applyFilters,
  cascadeDb,
  channelQ,
  clamp,
  copyFilter,
  createMeter,
  createShaper,
  designBiquad,
  oversample,
  passiveFilters,
  preFilters,
  propQ,
  sanitize,
  trackVu,
} from './analog'

function refresh(filters: Biquad[], next: Biquad[]) {
  for (let i = 0; i < filters.length; i++) {
    if (!next[i]) continue
    copyFilter(filters[i], next[i])
  }
}

function stereoWrite(output: Float32Array[], index: number, left: number, right: number) {
  if (output[0]) output[0][index] = sanitize(left)
  if (output[1]) output[1][index] = sanitize(right)
}

export function createPassive(sampleRate: number): Processor {
  const filters = passiveFilters(sampleRate, {})
  const right = passiveFilters(sampleRate, {})
  let key = ''
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      for (const bank of [filters, right]) for (const filter of bank) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    },
    process(input, output, params, ctx) {
      const nextKey = JSON.stringify([params.lowF, params.lowBoost, params.lowAtten, params.highF, params.highBoost, params.highBw, params.highAtten, params.highAttenF])
      if (nextKey !== key) {
        refresh(filters, passiveFilters(ctx.sampleRate, params))
        refresh(right, passiveFilters(ctx.sampleRate, params))
        key = nextKey
      }
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const left = applyFilters(filters, input[0]?.[i] || 0)
        const rightIn = input[1]?.[i] ?? input[0]?.[i] ?? 0
        stereoWrite(output, i, left, applyFilters(right, rightIn))
        trackVu(meter, left, ctx.sampleRate)
      }
    },
  }
}

export function createPre(sampleRate: number): Processor {
  const filters = preFilters(sampleRate, {})
  const right = preFilters(sampleRate, {})
  let key = ''
  const shapers = [createShaper(4), createShaper(4)]
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      for (const bank of [filters, right]) for (const filter of bank) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    },
    process(input, output, params, ctx) {
      const factor = ctx.quality === 'eco' ? 2 : 4
      if (shapers[0].factor !== factor) {
        shapers[0] = createShaper(factor)
        shapers[1] = createShaper(factor)
      }
      const nextKey = JSON.stringify([params.hp, params.lowF, params.lowG, params.midF, params.midG, params.highF, params.highG])
      if (nextKey !== key) {
        const designed = preFilters(ctx.sampleRate, params)
        while (filters.length < designed.length) filters.push(designBiquad('peaking', ctx.sampleRate, 1000, 1, 0))
        while (right.length < designed.length) right.push(designBiquad('peaking', ctx.sampleRate, 1000, 1, 0))
        refresh(filters, designed)
        refresh(right, designed)
        key = nextKey
      }
      const drive = clamp(params.drive ?? 0, 0, 1)
      const n = input[0]?.length ?? 0
      const count = preFilters(ctx.sampleRate, params).length
      for (let i = 0; i < n; i++) {
        const left = oversample(shapers[0], applyCounted(filters, count, input[0]?.[i] || 0), drive)
        const rightIn = input[1]?.[i] ?? input[0]?.[i] ?? 0
        stereoWrite(output, i, left, oversample(shapers[1], applyCounted(right, count, rightIn), drive))
        trackVu(meter, left, ctx.sampleRate)
      }
    },
  }
}

const CHANNEL_LF = [60, 110, 220, 360]
const CHANNEL_LMF = [200, 400, 800, 1500]
const CHANNEL_HMF = [800, 1500, 3000, 6000]
const CHANNEL_HF = [6000, 8000, 12000, 16000]

function channelFilters(sampleRate: number, params: Record<string, number>) {
  const q = channelQ(params.curve ?? 0)
  return [
    designBiquad('lowshelf', sampleRate, CHANNEL_LF[clamp(Math.round(params.lfF ?? 1), 0, 3)], 0.7, clamp(params.lfG ?? 0, -15, 15)),
    designBiquad('peaking', sampleRate, CHANNEL_LMF[clamp(Math.round(params.lmfF ?? 1), 0, 3)], q, clamp(params.lmfG ?? 0, -15, 15)),
    designBiquad('peaking', sampleRate, CHANNEL_HMF[clamp(Math.round(params.hmfF ?? 2), 0, 3)], q, clamp(params.hmfG ?? 0, -15, 15)),
    designBiquad('highshelf', sampleRate, CHANNEL_HF[clamp(Math.round(params.hfF ?? 2), 0, 3)], 0.7, clamp(params.hfG ?? 0, -15, 15)),
  ]
}

export function createChannel(sampleRate: number): Processor {
  return biquadPlugin(sampleRate, channelFilters, 'channel')
}

const PROP_FREQS = [50, 80, 150, 300, 500, 800, 1500, 2500, 5000, 8000, 12000]

function propFilters(sampleRate: number, params: Record<string, number>) {
  const gain = clamp(params.gain ?? 0, -12, 12)
  const freq = PROP_FREQS[clamp(Math.round(params.freq ?? 5), 0, PROP_FREQS.length - 1)]
  return [designBiquad('peaking', sampleRate, freq, propQ(gain), gain)]
}

export function createProp(sampleRate: number): Processor {
  return biquadPlugin(sampleRate, propFilters, 'prop')
}

function biquadPlugin(sampleRate: number, design: (sampleRate: number, params: Record<string, number>) => Biquad[], id: string): Processor {
  const left = design(sampleRate, {})
  const right = design(sampleRate, {})
  let key = ''
  const meter = createMeter()
  return {
    latencySamples: 0,
    meter,
    reset() {
      for (const bank of [left, right]) for (const filter of bank) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    },
    process(input, output, params, ctx) {
      const nextKey = JSON.stringify(params)
      if (nextKey !== key) {
        refresh(left, design(ctx.sampleRate, params))
        refresh(right, design(ctx.sampleRate, params))
        key = nextKey
      }
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const sample = applyFilters(left, input[0]?.[i] || 0)
        const other = applyFilters(right, input[1]?.[i] ?? input[0]?.[i] ?? 0)
        stereoWrite(output, i, sample, other)
        trackVu(meter, sample, ctx.sampleRate)
      }
      void id
    },
  }
}

/** Modern parametric: dynamic bands, optional zero-phase linear mode, and mid/side. */
export function createFocus(sampleRate: number): Processor {
  const spectrum = new Float32Array(32)
  const meter = createMeter()
  let left = focusFilters(sampleRate, {})
  let right = focusFilters(sampleRate, {})
  let key = ''
  let env = 0
  const size = 512
  const window = new Float32Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  const collect = [new Float32Array(size), new Float32Array(size)]
  const overlap = [new Float32Array(size), new Float32Array(size)]
  let filled = 0
  let read = 0
  return {
    latencySamples: 0,
    spectrum,
    meter,
    reset() {
      for (const bank of [left, right]) for (const filter of bank) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
      env = 0
      filled = 0
      read = 0
      overlap[0].fill(0)
      overlap[1].fill(0)
    },
    process(input, output, params, ctx) {
      const linear = (params.linear ?? 0) >= 0.5 && ctx.quality !== 'eco'
      this.latencySamples = linear ? size / 2 : 0
      const nextKey = JSON.stringify([params.f0, params.g0, params.q0, params.f1, params.g1, params.q1, params.f2, params.g2, params.q2])
      if (nextKey !== key) {
        left = focusFilters(ctx.sampleRate, params)
        right = focusFilters(ctx.sampleRate, params)
        key = nextKey
      }
      const dynamic = clamp(params.dynamic ?? 0, 0, 1)
      const mode = Math.round(params.ms ?? 0)
      const threshold = dbToGain(params.threshold ?? -18)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        let dryL = input[0]?.[i] || 0
        let dryR = input[1]?.[i] ?? dryL
        if (mode === 1) {
          const mid = (dryL + dryR) * 0.5
          const side = (dryL - dryR) * 0.5
          dryL = mid
          dryR = side
        } else if (mode === 2) {
          const mid = (dryL + dryR) * 0.5
          const side = (dryL - dryR) * 0.5
          dryL = side
          dryR = mid
        }
        if (linear) {
          collect[0][filled] = dryL
          collect[1][filled] = dryR
          filled += 1
          if (filled === size) {
            const shaped = [zeroPhase(collect[0], left, ctx.sampleRate, window), zeroPhase(collect[1], right, ctx.sampleRate, window)]
            for (let k = 0; k < size; k++) {
              overlap[0][(read + k) % size] += shaped[0][k]
              overlap[1][(read + k) % size] += shaped[1][k]
            }
            collect[0].copyWithin(0, size / 2)
            collect[1].copyWithin(0, size / 2)
            filled = size / 2
          }
          const outL = overlap[0][read % size]
          const outR = overlap[1][read % size]
          overlap[0][read % size] = 0
          overlap[1][read % size] = 0
          read += 1
          decode(output, i, outL, outR, mode, input, i)
        } else {
          const shapedL = applyFilters(left, dryL)
          const shapedR = applyFilters(right, dryR)
          const band = Math.max(Math.abs(shapedL), Math.abs(shapedR))
          env += (band - env) * (band > env ? 0.15 : 0.01)
          const duck = dynamic > 0 && env > threshold ? dynamic : 0
          const wet = 1 - duck
          decode(output, i, dryL * duck + shapedL * wet, dryR * duck + shapedR * wet, mode, input, i)
        }
        trackVu(meter, output[0]?.[i] || 0, ctx.sampleRate)
      }
      fillSpectrum(output[0], spectrum)
    },
  }
}

function decode(output: Float32Array[], index: number, left: number, right: number, mode: number, input: Float32Array[], at: number) {
  if (mode === 1) stereoWrite(output, index, left + right, left - right)
  else if (mode === 2) {
    const dryL = input[0]?.[at] || 0
    const dryR = input[1]?.[at] ?? dryL
    const mid = (dryL + dryR) * 0.5
    stereoWrite(output, index, mid + left, mid - left)
  } else stereoWrite(output, index, left, right)
}

function focusFilters(sampleRate: number, params: Record<string, number>) {
  return [0, 1, 2].map((band) =>
    designBiquad(
      'peaking',
      sampleRate,
      clamp(params[`f${band}`] ?? 1000 * (band + 1), 40, 16000),
      clamp(params[`q${band}`] ?? 1, 0.2, 12),
      clamp(params[`g${band}`] ?? 0, -18, 18),
    ),
  )
}

function dbToGain(db: number) {
  return 10 ** (db / 20)
}

function fillSpectrum(input: Float32Array | undefined, spectrum: Float32Array) {
  if (!input) return
  const n = Math.min(input.length, 256)
  for (let bin = 0; bin < spectrum.length; bin++) {
    const freq = ((bin + 1) / spectrum.length) * Math.PI
    let real = 0
    let imag = 0
    for (let i = 0; i < n; i++) {
      real += (input[i] || 0) * Math.cos(freq * i)
      imag -= (input[i] || 0) * Math.sin(freq * i)
    }
    spectrum[bin] = Math.sqrt(real * real + imag * imag) / n
  }
}

function zeroPhase(frame: Float32Array, filters: Biquad[], sampleRate: number, window: Float32Array) {
  const n = frame.length
  const out = new Float32Array(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = frame[i] * window[i]
  fft(re, im, false)
  for (let bin = 0; bin <= n / 2; bin++) {
    const freq = (bin * sampleRate) / n
    const mag = 10 ** (cascadeDb(filters, Math.max(20, freq), sampleRate) / 20)
    re[bin] *= mag
    im[bin] *= mag
    if (bin > 0 && bin < n / 2) {
      re[n - bin] *= mag
      im[n - bin] *= mag
    }
  }
  fft(re, im, true)
  for (let i = 0; i < n; i++) out[i] = re[i] * window[i]
  return out
}

function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
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
      let wr = 1
      let wi = 0
      const half = len >> 1
      for (let j = 0; j < half; j++) {
        const ur = re[i + j]
        const ui = im[i + j]
        const vr = re[i + j + half] * wr - im[i + j + half] * wi
        const vi = re[i + j + half] * wi + im[i + j + half] * wr
        re[i + j] = ur + vr
        im[i + j] = ui + vi
        re[i + j + half] = ur - vr
        im[i + j + half] = ui - vi
        const next = wr * wlenRe - wi * wlenIm
        wi = wr * wlenIm + wi * wlenRe
        wr = next
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] /= n
    im[i] /= n
  }
}

export function passiveModule(): PluginModule {
  return { descriptor: descriptor('passive')!, presets: FACTORY.passive, create: createPassive }
}
export function preModule(): PluginModule {
  return { descriptor: descriptor('pre')!, presets: FACTORY.pre, create: createPre }
}
export function channelModule(): PluginModule {
  return { descriptor: descriptor('channel')!, presets: FACTORY.channel, create: createChannel }
}
export function propModule(): PluginModule {
  return { descriptor: descriptor('prop')!, presets: FACTORY.prop, create: createProp }
}
export function focusModule(): PluginModule {
  return { descriptor: descriptor('focus')!, presets: FACTORY.focus, create: createFocus }
}

export { channelFilters, propFilters, focusFilters }

function applyCounted(filters: Biquad[], count: number, sample: number) {
  let value = sample
  const last = Math.min(count, filters.length)
  for (let i = 0; i < last; i++) value = tickBiquad(filters[i], value)
  return sanitize(value)
}
