/** Mastering processors. Offline renders use linear-phase EQ and 4x oversampling. Live nonlinear stages stay at 2x. */

import { clamp, copyCoeffs, dbToGain, designBiquad, gainToDb, sanitize, tickBiquad, type Biquad } from '../plugins/dsp'
import type { BlockContext, Processor } from '../plugins/types'
import { createDownsample, createFir, createOversample, linearKernel, truePeakLinear } from './fir'
import { createMeter, feedMeter, measureProgram } from './meter'

export function encodeMS(left: number, right: number): [number, number] {
  return [(left + right) * 0.5, (left - right) * 0.5]
}

export function decodeMS(mid: number, side: number): [number, number] {
  return [mid + side, mid - side]
}

export function roundtripMS(left: Float32Array, right: Float32Array) {
  const outL = new Float32Array(left.length)
  const outR = new Float32Array(right.length)
  for (let i = 0; i < left.length; i++) {
    const [mid, side] = encodeMS(left[i] || 0, right[i] || 0)
    const [l, r] = decodeMS(mid, side)
    outL[i] = l
    outR[i] = r
  }
  return [outL, outR]
}

function ctxOf(sampleRate: number, offline: boolean, sampleTime = 0): BlockContext {
  return {
    sampleRate,
    tempo: 120,
    sampleTime,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: offline ? 'full' : 'eco',
    offline,
  }
}

export function processBlocks(processor: Processor, params: Record<string, number>, channels: Float32Array[], sampleRate: number, offline: boolean) {
  const n = channels[0]?.length ?? 0
  const out = [new Float32Array(n), new Float32Array(n)]
  const block = 128
  for (let offset = 0; offset < n; offset += block) {
    const count = Math.min(block, n - offset)
    processor.process(
      channels.map((channel) => channel.subarray(offset, offset + count)),
      out.map((channel) => channel.subarray(offset, offset + count)),
      params,
      ctxOf(sampleRate, offline, offset),
    )
  }
  return out
}

function pair(input: Float32Array[]) {
  const left = input[0] ?? new Float32Array(0)
  const right = input[1] ?? left
  return [left, right] as const
}

function fillSpectrum(input: Float32Array | undefined, spectrum: Float32Array) {
  if (!input) return
  const n = Math.min(input.length, 256)
  for (let bin = 0; bin < spectrum.length; bin++) {
    const freq = ((bin + 1) / spectrum.length) * Math.PI
    let real = 0
    let imag = 0
    for (let i = 0; i < n; i++) {
      const sample = input[i] || 0
      real += sample * Math.cos(freq * i)
      imag -= sample * Math.sin(freq * i)
    }
    spectrum[bin] = Math.sqrt(real * real + imag * imag) / Math.max(1, n)
  }
}

function coef(ms: number, sampleRate: number) {
  return 1 - Math.exp(-1 / Math.max(1, (ms / 1000) * sampleRate))
}

function biquadMagnitude(filter: Biquad, freq: number, sampleRate: number) {
  const w = (2 * Math.PI * clamp(freq, 1, sampleRate * 0.49)) / sampleRate
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const br = filter.b0 + filter.b1 * c1 + filter.b2 * c2
  const bi = -(filter.b1 * s1 + filter.b2 * s2)
  const ar = 1 + filter.a1 * c1 + filter.a2 * c2
  const ai = -(filter.a1 * s1 + filter.a2 * s2)
  const den = ar * ar + ai * ai
  if (den < 1e-18) return 1
  return Math.sqrt((br * br + bi * bi) / den)
}

function eqBiquads(params: Record<string, number>, sampleRate: number, side: boolean) {
  const low = side ? params.sLow : params.lowG
  const mid = side ? params.sMid : params.midG
  const high = side ? params.sHigh : params.highG
  return [
    designBiquad('highpass', sampleRate, params.hp || 30, 0.707),
    designBiquad('lowshelf', sampleRate, 140, 0.7, low || 0),
    designBiquad('peaking', sampleRate, params.midF || 1200, params.midQ || 1, mid || 0),
    designBiquad('highshelf', sampleRate, 8000, 0.7, high || 0),
    designBiquad('lowpass', sampleRate, params.lp || 19000, 0.707),
  ]
}

function eqMagnitude(params: Record<string, number>, sampleRate: number, side: boolean) {
  const filters = eqBiquads(params, sampleRate, side)
  return (freq: number) => filters.reduce((gain, filter) => gain * biquadMagnitude(filter, freq, sampleRate), 1)
}

export function createMasterEq(sampleRate: number): Processor {
  const spectrum = new Float32Array(32)
  const banks = Array.from({ length: 4 }, () => eqBiquads({}, sampleRate, false))
  let firs = [createFir(linearKernel(() => 1, sampleRate, 1024)), createFir(linearKernel(() => 1, sampleRate, 1024))]
  let designed = ''
  let latency = 0
  const scratch = [new Float32Array(2048), new Float32Array(2048), new Float32Array(2048), new Float32Array(2048)]
  return {
    latencySamples: 0,
    spectrum,
    reset() {
      for (const bank of banks) for (const filter of bank) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
      for (const fir of firs) fir.reset()
      designed = ''
    },
    process(input, output, params, ctx) {
      const heavy = ctx.offline === true && (params.phase ?? 1) >= 0.5
      const ms = (params.ms ?? 0) >= 0.5
      const n = input[0]?.length ?? 0
      const key = `${heavy}:${ms}:${params.hp}:${params.lp}:${params.lowG}:${params.midF}:${params.midG}:${params.midQ}:${params.highG}:${params.sLow}:${params.sMid}:${params.sHigh}`
      if (key !== designed) {
        if (heavy) {
          firs = [
            createFir(linearKernel(eqMagnitude(params, ctx.sampleRate, false), ctx.sampleRate, 1024)),
            createFir(linearKernel(eqMagnitude(params, ctx.sampleRate, ms), ctx.sampleRate, 1024)),
          ]
          latency = firs[0].latency
        } else {
          const next = [eqBiquads(params, ctx.sampleRate, false), eqBiquads(params, ctx.sampleRate, ms)]
          next.forEach((bank, index) => bank.forEach((filter, band) => copyCoeffs(banks[index][band], filter)))
          next.forEach((bank, index) => bank.forEach((filter, band) => copyCoeffs(banks[index + 2][band], filter)))
          latency = 0
        }
        designed = key
      }
      this.latencySamples = latency
      const [left, right] = pair(input)
      const ensure = (index: number) => {
        if (scratch[index].length < n) scratch[index] = new Float32Array(n)
        return scratch[index]
      }
      if (!heavy) {
        for (let c = 0; c < 2; c++) {
          const src = c === 0 ? left : right
          const bank = ms ? banks[c] : banks[c]
          for (let i = 0; i < n; i++) {
            let sample = src[i] || 0
            if (ms) {
              const other = c === 0 ? right[i] || 0 : left[i] || 0
              const [mid, side] = encodeMS(c === 0 ? sample : other, c === 0 ? other : sample)
              sample = c === 0 ? mid : side
            }
            for (const filter of bank) sample = tickBiquad(filter, sample)
            ensure(c)[i] = sample
          }
        }
        for (let i = 0; i < n; i++) {
          const [l, r] = ms ? decodeMS(scratch[0][i], scratch[1][i]) : [scratch[0][i], scratch[1][i]]
          if (output[0]) output[0][i] = sanitize(l)
          if (output[1]) output[1][i] = sanitize(r)
        }
      } else {
        const mid = ensure(0)
        const side = ensure(1)
        const filteredM = ensure(2)
        const filteredS = ensure(3)
        for (let i = 0; i < n; i++) {
          if (ms) {
            const [m, s] = encodeMS(left[i] || 0, right[i] || 0)
            mid[i] = m
            side[i] = s
          } else {
            mid[i] = left[i] || 0
            side[i] = right[i] || 0
          }
        }
        firs[0].process(mid.subarray(0, n), filteredM.subarray(0, n))
        firs[1].process(side.subarray(0, n), filteredS.subarray(0, n))
        for (let i = 0; i < n; i++) {
          const [l, r] = ms ? decodeMS(filteredM[i], filteredS[i]) : [filteredM[i], filteredS[i]]
          if (output[0]) output[0][i] = sanitize(l)
          if (output[1]) output[1][i] = sanitize(r)
        }
      }
      if (ctx.quality === 'full') fillSpectrum(output[0], spectrum)
      void sampleRate
    },
  }
}

export function createDynamicEq(sampleRate: number): Processor {
  const detect = [designBiquad('bandpass', sampleRate, 3000, 1.2), designBiquad('bandpass', sampleRate, 3000, 1.2)]
  const peak = [designBiquad('peaking', sampleRate, 3000, 1.2, 0), designBiquad('peaking', sampleRate, 3000, 1.2, 0)]
  let env = 0
  let applied = 999
  return {
    latencySamples: 0,
    reset() {
      env = 0
      applied = 999
      for (const filter of [...detect, ...peak]) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    },
    process(input, output, params, ctx) {
      const freq = params.freq || 3000
      const q = params.q || 1.2
      const amount = params.gain || 0
      const threshold = dbToGain(params.threshold ?? -24)
      const follow = coef(params.attack || 10, ctx.sampleRate)
      const release = coef(params.release || 80, ctx.sampleRate)
      const n = input[0]?.length ?? 0
      const [left, right] = pair(input)
      for (let i = 0; i < n; i++) {
        const det = Math.max(Math.abs(tickBiquad(detect[0], left[i] || 0)), Math.abs(tickBiquad(detect[1], right[i] || 0)))
        const rate = det > env ? follow : release
        env += (det - env) * rate
        const active = env > threshold ? amount : 0
        if (Math.abs(active - applied) > 0.05) {
          const next = designBiquad('peaking', ctx.sampleRate, freq, q, active)
          copyCoeffs(peak[0], next)
          copyCoeffs(peak[1], next)
          const band = designBiquad('bandpass', ctx.sampleRate, freq, q)
          copyCoeffs(detect[0], band)
          copyCoeffs(detect[1], band)
          applied = active
        }
        if (output[0]) output[0][i] = sanitize(tickBiquad(peak[0], left[i] || 0))
        if (output[1]) output[1][i] = sanitize(tickBiquad(peak[1], right[i] || 0))
      }
    },
  }
}

function compress(level: number, threshold: number, ratio: number, makeup: number) {
  const over = gainToDb(level) - threshold
  const reduction = over > 0 ? over * (1 - 1 / Math.max(1, ratio)) : 0
  return dbToGain(-reduction + makeup)
}

export function createMultiband(sampleRate: number): Processor {
  const filters: Biquad[][] = Array.from({ length: 2 }, () => Array.from({ length: 4 }, () => designBiquad('lowpass', sampleRate, 200, 0.707)))
  const sideFilters: Biquad[][] = Array.from({ length: 2 }, () => Array.from({ length: 4 }, () => designBiquad('lowpass', sampleRate, 200, 0.707)))
  const env = [0, 0, 0, 0, 0]
  const sideEnv = [0, 0, 0, 0, 0]
  let designed = ''
  return {
    latencySamples: 0,
    reset() {
      env.fill(0)
      sideEnv.fill(0)
      for (const bank of [...filters, ...sideFilters]) for (const filter of bank) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    },
    process(input, output, params, ctx) {
      const count = clamp(Math.round(params.bands || 4), 3, 5)
      const freqs = [params.x1 || 120, params.x2 || 500, params.x3 || 2000, params.x4 || 6000].slice(0, count - 1)
      const key = freqs.join(':')
      if (key !== designed) {
        for (const bank of [...filters, ...sideFilters]) {
          freqs.forEach((freq, index) => copyCoeffs(bank[index], designBiquad('lowpass', ctx.sampleRate, freq, 0.707)))
        }
        designed = key
      }
      const attack = coef(params.attack || 10, ctx.sampleRate)
      const release = coef(params.release || 80, ctx.sampleRate)
      const ms = (params.ms ?? 0) >= 0.5
      const n = input[0]?.length ?? 0
      const [left, right] = pair(input)
      for (let i = 0; i < n; i++) {
        const sources = ms ? encodeMS(left[i] || 0, right[i] || 0) : [left[i] || 0, right[i] || 0]
        const outs = sources.map((sample, channel) => {
          const bank = ms && channel === 1 ? sideFilters[0] : filters[channel]
          const levels = ms && channel === 1 ? sideEnv : env
          let rest = sample
          let mixed = 0
          for (let band = 0; band < count; band++) {
            let piece = rest
            if (band < count - 1) {
              const low = tickBiquad(bank[band], rest)
              piece = low
              rest -= low
            }
            const detector = Math.abs(piece)
            const rate = detector > levels[band] ? attack : release
            levels[band] += (detector - levels[band]) * rate
            mixed += piece * compress(levels[band], params.threshold ?? -18, params.ratio || 1, params.makeup || 0)
          }
          return mixed
        })
        const [l, r] = ms ? decodeMS(outs[0], outs[1]) : [outs[0], outs[1]]
        if (output[0]) output[0][i] = sanitize(l)
        if (output[1]) output[1][i] = sanitize(r)
      }
    },
  }
}

export function createGlue(sampleRate: number): Processor {
  let env = 0
  void sampleRate
  return {
    latencySamples: 0,
    reset() {
      env = 0
    },
    process(input, output, params, ctx) {
      const attack = coef(params.attack || 10, ctx.sampleRate)
      const releaseMs = Math.round(params.releaseMode ?? 1) <= 0 ? 30 : Math.round(params.releaseMode ?? 1) >= 2 ? 200 : params.release || 100
      const release = coef(releaseMs, ctx.sampleRate)
      const n = input[0]?.length ?? 0
      const [left, right] = pair(input)
      const mix = clamp(params.mix ?? 1, 0, 1)
      for (let i = 0; i < n; i++) {
        const detector = Math.max(Math.abs(left[i] || 0), Math.abs(right[i] || 0))
        const rate = detector > env ? attack : release
        env += (detector - env) * rate
        const gain = compress(env, params.threshold ?? -12, params.ratio || 2, params.makeup || 0)
        if (output[0]) output[0][i] = sanitize((left[i] || 0) * (1 - mix) + (left[i] || 0) * gain * mix)
        if (output[1]) output[1][i] = sanitize((right[i] || 0) * (1 - mix) + (right[i] || 0) * gain * mix)
      }
    },
  }
}

interface BrickState {
  factor: number
  look: number
  delayL: Float32Array
  delayR: Float32Array
  index: number
  gain: number
  peak: number
  since: number
  upL: ReturnType<typeof createOversample>
  upR: ReturnType<typeof createOversample>
  downL: ReturnType<typeof createDownsample>
  downR: ReturnType<typeof createDownsample>
}

function brickFactor(offline: boolean): 2 | 4 {
  return offline ? 4 : 2
}

function prepareBrick(state: BrickState | null, sampleRate: number, lookaheadMs: number, offline: boolean): BrickState {
  const factor = brickFactor(offline)
  if (state && state.factor === factor) return state
  const look = Math.max(8, Math.round((lookaheadMs / 1000) * sampleRate * factor))
  const taps = offline ? 48 : 32
  return {
    factor,
    look,
    delayL: new Float32Array(look),
    delayR: new Float32Array(look),
    index: 0,
    gain: 1,
    peak: 1e-8,
    since: 0,
    upL: createOversample(factor, taps),
    upR: createOversample(factor, taps),
    downL: createDownsample(factor, taps),
    downR: createDownsample(factor, taps),
  }
}

function limitHigh(state: BrickState, left: number, right: number, ceiling: number, release: number) {
  const slot = state.index % state.look
  const outL = state.delayL[slot]
  const outR = state.delayR[slot]
  state.delayL[slot] = left
  state.delayR[slot] = right
  const entered = Math.max(Math.abs(left), Math.abs(right))
  if (entered >= state.peak) {
    state.peak = entered
    state.since = 0
  } else if (state.since >= state.look) {
    let peak = 1e-8
    for (let k = 0; k < state.look; k++) peak = Math.max(peak, Math.abs(state.delayL[k]), Math.abs(state.delayR[k]))
    state.peak = peak
    state.since = 0
  } else state.since += 1
  const needed = Math.min(1, ceiling / Math.max(state.peak, 1e-8))
  if (needed < state.gain) state.gain = needed
  else state.gain += (needed - state.gain) * release
  state.index += 1
  return [outL * state.gain, outR * state.gain] as const
}

export function createBrick(sampleRate: number): Processor {
  let state: BrickState | null = null
  let latency = Math.round(0.005 * sampleRate)
  return {
    latencySamples: latency,
    reset() {
      state = null
    },
    process(input, output, params, ctx) {
      const offline = ctx.offline === true
      const lookahead = params.lookahead || 5
      state = prepareBrick(state, ctx.sampleRate, lookahead, offline)
      const releaseMs = Math.round(params.releaseMode ?? 1) <= 0 ? 40 : Math.round(params.releaseMode ?? 1) >= 2 ? 180 : params.release || 80
      const release = coef(releaseMs, ctx.sampleRate * state.factor)
      const margin = offline ? 0.25 : 0.6
      const ceiling = dbToGain((params.ceiling ?? -1) - margin)
      latency = state.look / state.factor + state.upL.latency
      this.latencySamples = Math.round(latency)
      const n = input[0]?.length ?? 0
      const [left, right] = pair(input)
      const highL: number[] = []
      const highR: number[] = []
      state.upL.process(left.subarray(0, n), new Float32Array(n), (sample) => {
        highL.push(sample)
        return sample
      })
      state.upR.process(right.subarray(0, n), new Float32Array(n), (sample) => {
        highR.push(sample)
        return sample
      })
      const count = Math.min(highL.length, highR.length)
      const limitedL = new Float32Array(count)
      const limitedR = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        const [l, r] = limitHigh(state, highL[i] || 0, highR[i] || 0, ceiling, release)
        limitedL[i] = l
        limitedR[i] = r
      }
      const outL = output[0] ?? new Float32Array(n)
      const outR = output[1] ?? new Float32Array(n)
      state.downL.process(limitedL, outL)
      state.downR.process(limitedR, outR)
      for (let i = 0; i < n; i++) {
        if (output[0]) output[0][i] = sanitize(outL[i] || 0)
        if (output[1]) output[1][i] = sanitize(outR[i] || 0)
      }
      void sampleRate
    },
  }
}

export function enforceTruePeak(channels: Float32Array[], sampleRate: number, ceilingDb: number) {
  void sampleRate
  const limit = dbToGain(ceilingDb)
  let peak = 0
  for (const channel of channels) peak = Math.max(peak, truePeakLinear(channel))
  if (peak <= limit || peak < 1e-8) return channels
  const gain = limit / peak
  return channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = (channel[i] || 0) * gain
    return out
  })
}

export function limitBuffer(channels: Float32Array[], sampleRate: number, ceilingDb: number, offline = true) {
  const processor = createBrick(sampleRate)
  const limited = processBlocks(processor, { ceiling: ceilingDb, release: 80, lookahead: 5, releaseMode: 1 }, channels, sampleRate, offline)
  return enforceTruePeak(limited, sampleRate, ceilingDb)
}

export function maximizeBuffer(channels: Float32Array[], sampleRate: number, targetLufs: number, ceilingDb: number, offline = true) {
  const reading = measureProgram(channels[0] ?? new Float32Array(0), channels[1] ?? null, sampleRate)
  const gain = reading.integrated <= -60 ? 1 : dbToGain(targetLufs - reading.integrated)
  const boosted = channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = (channel[i] || 0) * gain
    return out
  })
  return limitBuffer(boosted, sampleRate, ceilingDb, offline)
}

export function createMaxim(sampleRate: number): Processor {
  const meter = createMeter(sampleRate)
  const brick = createBrick(sampleRate)
  let gain = 1
  return {
    latencySamples: 0,
    reset() {
      gain = 1
      brick.reset()
    },
    process(input, output, params, ctx) {
      const [left, right] = pair(input)
      feedMeter(meter, left.subarray(0, left.length), right.subarray(0, left.length), ctx.sampleRate, false)
      const target = params.target ?? -14
      if (meter.integrated > -60) {
        const desired = dbToGain(target - meter.integrated)
        gain += (desired - gain) * 0.02
      }
      const n = input[0]?.length ?? 0
      const boosted = [new Float32Array(n), new Float32Array(n)]
      for (let i = 0; i < n; i++) {
        boosted[0][i] = (left[i] || 0) * gain
        boosted[1][i] = (right[i] || 0) * gain
      }
      brick.process(boosted, output, { ceiling: params.ceiling ?? -1, release: 80, lookahead: 5, releaseMode: 1 }, ctx)
      this.latencySamples = brick.latencySamples
    },
  }
}

function shapeSample(sample: number, drive: number, tube: boolean) {
  const driven = sample * (1 + drive * 6)
  if (tube) return Math.tanh(driven + 0.2 * driven * Math.abs(driven))
  return Math.tanh(driven)
}

export function createTape(sampleRate: number): Processor {
  let upL = createOversample(2, 32)
  let upR = createOversample(2, 32)
  let mode: 'full' | 'eco' | '' = ''
  void sampleRate
  return {
    latencySamples: 0,
    reset() {
      upL.reset()
      upR.reset()
    },
    process(input, output, params, ctx) {
      const heavy = ctx.offline === true
      const next = heavy ? 'full' : 'eco'
      if (next !== mode) {
        upL = createOversample(heavy ? 4 : 2, heavy ? 48 : 32)
        upR = createOversample(heavy ? 4 : 2, heavy ? 48 : 32)
        mode = next
      }
      const drive = clamp(params.drive ?? 0, 0, 1)
      const tube = (params.color ?? 0) >= 0.5
      const mix = clamp(params.mix ?? 1, 0, 1)
      const n = input[0]?.length ?? 0
      const [left, right] = pair(input)
      const wetL = new Float32Array(n)
      const wetR = new Float32Array(n)
      upL.process(left.subarray(0, n), wetL, (sample) => shapeSample(sample, drive, tube))
      upR.process(right.subarray(0, n), wetR, (sample) => shapeSample(sample, drive, tube))
      const norm = Math.tanh(1 + drive * 6)
      for (let i = 0; i < n; i++) {
        const dryL = left[i] || 0
        const dryR = right[i] || 0
        const shapedL = wetL[i] / Math.max(0.2, norm)
        const shapedR = wetR[i] / Math.max(0.2, norm)
        if (output[0]) output[0][i] = sanitize(dryL * (1 - mix) + shapedL * mix)
        if (output[1]) output[1][i] = sanitize(dryR * (1 - mix) + shapedR * mix)
      }
      this.latencySamples = heavy ? upL.latency : 0
    },
  }
}

export function createImager(sampleRate: number): Processor {
  const bass = [designBiquad('highpass', sampleRate, 120, 0.707), designBiquad('highpass', sampleRate, 120, 0.707)]
  const split = [designBiquad('lowpass', sampleRate, 2000, 0.707), designBiquad('lowpass', sampleRate, 2000, 0.707)]
  let freq = 0
  return {
    latencySamples: 0,
    reset() {
      for (const filter of [...bass, ...split]) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    },
    process(input, output, params, ctx) {
      const cutoff = params.bass || 120
      if (cutoff !== freq) {
        copyCoeffs(bass[0], designBiquad('highpass', ctx.sampleRate, cutoff, 0.707))
        copyCoeffs(bass[1], designBiquad('highpass', ctx.sampleRate, cutoff, 0.707))
        freq = cutoff
      }
      const width = params.width ?? 1
      const low = params.low ?? 1
      const high = params.high ?? 1
      const n = input[0]?.length ?? 0
      const [left, right] = pair(input)
      for (let i = 0; i < n; i++) {
        const mid = ((left[i] || 0) + (right[i] || 0)) * 0.5
        let side = ((left[i] || 0) - (right[i] || 0)) * 0.5
        side = tickBiquad(bass[0], side)
        const bottom = tickBiquad(split[0], side)
        const top = side - bottom
        side = (bottom * low + top * high) * width
        if (output[0]) output[0][i] = sanitize(mid + side)
        if (output[1]) output[1][i] = sanitize(mid - side)
      }
    },
  }
}

export function createMs(sampleRate: number): Processor {
  void sampleRate
  return {
    latencySamples: 0,
    reset() {},
    process(input, output, params) {
      const midGain = dbToGain(params.mid || 0)
      const sideGain = dbToGain(params.side || 0)
      const n = input[0]?.length ?? 0
      const [left, right] = pair(input)
      for (let i = 0; i < n; i++) {
        const [mid, side] = encodeMS(left[i] || 0, right[i] || 0)
        const [l, r] = decodeMS(mid * midGain, side * sideGain)
        if (output[0]) output[0][i] = sanitize(l)
        if (output[1]) output[1][i] = sanitize(r)
      }
    },
  }
}

export function createClip(sampleRate: number): Processor {
  let upL = createOversample(2, 32)
  let upR = createOversample(2, 32)
  let heavy = false
  void sampleRate
  return {
    latencySamples: 0,
    reset() {
      upL.reset()
      upR.reset()
    },
    process(input, output, params, ctx) {
      const offline = ctx.offline === true
      if (offline !== heavy) {
        upL = createOversample(offline ? 4 : 2, offline ? 48 : 32)
        upR = createOversample(offline ? 4 : 2, offline ? 48 : 32)
        heavy = offline
      }
      const ceiling = dbToGain(params.ceiling ?? -0.3)
      const drive = 1 + clamp(params.drive ?? 0, 0, 1) * 8
      const hard = (params.mode ?? 0) >= 0.5
      const n = input[0]?.length ?? 0
      const [left, right] = pair(input)
      const shape = (sample: number) => {
        const driven = sample * drive
        if (hard) return clamp(driven, -ceiling, ceiling)
        return Math.tanh(driven / Math.max(1e-6, ceiling)) * ceiling
      }
      const wetL = new Float32Array(n)
      const wetR = new Float32Array(n)
      upL.process(left.subarray(0, n), wetL, shape)
      upR.process(right.subarray(0, n), wetR, shape)
      for (let i = 0; i < n; i++) {
        if (output[0]) output[0][i] = sanitize(wetL[i] || 0)
        if (output[1]) output[1][i] = sanitize(wetR[i] || 0)
      }
      this.latencySamples = offline ? upL.latency : 0
    },
  }
}

export function createDither(): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      const n = input[0]?.length ?? 0
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)]
        for (let i = 0; i < n; i++) output[c][i] = src?.[i] || 0
      }
    },
  }
}

export function createMasterMeter(sampleRate: number): Processor {
  const meter = createMeter(sampleRate)
  const spectrum = new Float32Array(32)
  const meters: Record<string, number> = {}
  return {
    latencySamples: 0,
    spectrum,
    meters,
    scope: meter.scope,
    reset() {},
    process(input, output, _params, ctx) {
      const n = input[0]?.length ?? 0
      const [left, right] = pair(input)
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)]
        for (let i = 0; i < n; i++) output[c][i] = src?.[i] || 0
      }
      feedMeter(meter, left.subarray(0, n), right.subarray(0, n), ctx.sampleRate, ctx.offline === true || ctx.quality === 'full')
      meters.integrated = meter.integrated
      meters.shortTerm = meter.shortTerm
      meters.momentary = meter.momentary
      meters.lra = meter.lra
      meters.truePeak = meter.truePeak
      meters.rms = meter.rms
      meters.crest = meter.crest
      meters.correlation = meter.correlation
      if (ctx.quality !== 'eco') fillSpectrum(output[0], spectrum)
    },
  }
}

export function rmsDb(channel: Float32Array) {
  let sum = 0
  for (let i = 0; i < channel.length; i++) sum += (channel[i] || 0) ** 2
  const mean = channel.length ? sum / channel.length : 0
  return mean > 1e-12 ? 10 * Math.log10(mean) : -70
}
