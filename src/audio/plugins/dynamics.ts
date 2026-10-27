import { descriptor, FACTORY } from './catalog'
import { clamp, dbToGain, designBiquad, gainToDb, sanitize, tickBiquad, type Biquad } from './dsp'
import type { Processor } from './types'

function coeff(ms: number, sampleRate: number) {
  const samples = Math.max(1, (ms / 1000) * sampleRate)
  return 1 - Math.exp(-1 / samples)
}

export function createCompressor(_sampleRate: number): Processor {
  let env = 0
  return envelopeProcessor(_sampleRate, (detector, params, sample) => {
    const db = gainToDb(detector)
    const threshold = params.threshold
    const knee = Math.max(0, params.knee)
    let over = db - threshold
    if (knee > 0 && over > -knee / 2 && over < knee / 2) {
      const soft = over + knee / 2
      over = (soft * soft) / (2 * knee)
    }
    const ratio = Math.max(1, params.ratio)
    const reduction = over > 0 ? over * (1 - 1 / ratio) : 0
    return sample * dbToGain(-reduction + (params.makeup || 0))
  }, () => env, (value) => {
    env = value
  })
}

export function createGate(_sampleRate: number): Processor {
  let env = 1
  let hold = 0
  let gateOpen = false
  return {
    latencySamples: 0,
    reset() {
      env = 1
      hold = 0
      gateOpen = false
    },
    process(input, output, params, ctx) {
      const n = input[0]?.length ?? 0
      const open = coeff(params.attack, ctx.sampleRate)
      const close = coeff(params.release, ctx.sampleRate)
      const threshold = dbToGain(params.threshold)
      const range = dbToGain(-Math.abs(params.range || 0))
      const ratio = Math.max(1, params.ratio)
      const holdSamples = Math.round(((params.hold || 0) / 1000) * ctx.sampleRate)
      for (let i = 0; i < n; i++) {
        const detector = Math.max(Math.abs(input[0][i] || 0), Math.abs(input[1]?.[i] || 0))
        const closeAt = threshold * 0.7
        if (detector >= threshold) gateOpen = true
        else if (detector < closeAt) gateOpen = false
        if (gateOpen) hold = holdSamples
        else if (hold > 0) hold -= 1
        const below = hold > 0 || open ? 1 : detector < threshold ? clamp(threshold > 0 ? detector / threshold : 1, 0, 1) : 1
        const expanded = below >= 1 ? 1 : Math.max(range, below ** (ratio - 1))
        const rate = expanded > env ? open : close
        env += (expanded - env) * rate
        for (let c = 0; c < output.length; c++) output[c][i] = sanitize((input[Math.min(c, input.length - 1)]?.[i] ?? 0) * env)
      }
    },
  }
}

export function createLimiter(sampleRate: number): Processor {
  const look = 64
  const delay: Float32Array[] = [new Float32Array(look), new Float32Array(look)]
  let index = 0
  let gain = 1
  return {
    latencySamples: look,
    reset() {
      delay[0].fill(0)
      delay[1].fill(0)
      index = 0
      gain = 1
    },
    process(input, output, params, ctx) {
      const ceiling = dbToGain(params.ceiling ?? -0.1)
      const threshold = dbToGain(params.threshold ?? 0)
      const release = coeff(params.release || 40, ctx.sampleRate)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const left = input[0][i] || 0
        const right = input[1]?.[i] ?? left
        const slot = index % look
        const outL = delay[0][slot]
        const outR = delay[1][slot]
        delay[0][slot] = left
        delay[1][slot] = right
        let peak = Math.max(Math.abs(left), Math.abs(right))
        for (let k = 0; k < look; k++) peak = Math.max(peak, Math.abs(delay[0][k]), Math.abs(delay[1][k]))
        const needed = Math.min(1, ceiling / Math.max(peak, threshold, 1e-8))
        gain += (needed - gain) * (needed < gain ? 1 : release)
        index += 1
        if (output[0]) output[0][i] = sanitize(outL * gain)
        if (output[1]) output[1][i] = sanitize(outR * gain)
      }
      void sampleRate
    },
  }
}

export function createDeesser(sampleRate: number): Processor {
  const band: Biquad[] = [designBiquad('bandpass', sampleRate, 6500, 2), designBiquad('bandpass', sampleRate, 6500, 2)]
  let env = 0
  let freq = 0
  return {
    latencySamples: 0,
    reset() {
      env = 0
      for (const filter of band) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
    },
    process(input, output, params, ctx) {
      if (params.freq !== freq) {
        copyBand(band[0], designBiquad('bandpass', ctx.sampleRate, params.freq, 2.2))
        copyBand(band[1], designBiquad('bandpass', ctx.sampleRate, params.freq, 2.2))
        freq = params.freq
      }
      const amount = clamp(params.amount, 0, 1)
      const threshold = dbToGain(params.threshold)
      const follow = coeff(8, ctx.sampleRate)
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const left = input[0][i] || 0
        const right = input[1]?.[i] ?? left
        const bandL = tickBiquad(band[0], left)
        const bandR = tickBiquad(band[1], right)
        const ess = Math.max(Math.abs(bandL), Math.abs(bandR))
        env += (ess - env) * follow
        const over = env > threshold && threshold > 0 ? clamp((env - threshold) / threshold, 0, 1) : 0
        const cut = amount * over
        if (output[0]) output[0][i] = sanitize(left - bandL * cut)
        if (output[1]) output[1][i] = sanitize(right - bandR * cut)
      }
    },
  }
}

function copyBand(target: Biquad, next: Biquad) {
  target.b0 = next.b0
  target.b1 = next.b1
  target.b2 = next.b2
  target.a1 = next.a1
  target.a2 = next.a2
}

function envelopeProcessor(
  _sampleRate: number,
  apply: (detector: number, params: Record<string, number>, sample: number) => number,
  read: () => number,
  write: (value: number) => void,
): Processor {
  return {
    latencySamples: 0,
    reset() {
      write(0)
    },
    process(input, output, params, ctx) {
      const n = input[0]?.length ?? 0
      const attack = coeff(params.attack || 10, ctx.sampleRate)
      const release = coeff(params.release || 80, ctx.sampleRate)
      const mix = params.mix == null ? 1 : clamp(params.mix, 0, 1)
      let env = read()
      for (let i = 0; i < n; i++) {
        const left = input[0][i] || 0
        const right = input[1]?.[i] ?? left
        const side = ctx.sidechain
        const detector = side ? Math.abs(side[Math.min(i, side.length - 1)] || 0) : Math.max(Math.abs(left), Math.abs(right))
        const target = detector
        const rate = target > env ? attack : release
        env += (target - env) * rate
        const wetL = apply(env, params, left)
        const wetR = apply(env, params, right)
        if (output[0]) output[0][i] = sanitize(left * (1 - mix) + wetL * mix)
        if (output[1]) output[1][i] = sanitize(right * (1 - mix) + wetR * mix)
      }
      write(env)
    },
  }
}

export function moduleFor(id: 'compressor' | 'gate' | 'limiter' | 'deesser', createFn: (sampleRate: number) => Processor) {
  return {
    descriptor: descriptor(id)!,
    presets: FACTORY[id],
    create: createFn,
  }
}
