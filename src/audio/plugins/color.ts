import { SampleGlide } from '../core/smooth'
import { createShaperState, oversampleShape, resetShaperState, SHAPER_FACTOR, shaperLatencySamples, type ShaperState } from '../quality/oversample'
import { clamp, copyCoeffs, designBiquad, sanitize, type Biquad } from './dsp'
import type { Processor } from './types'

const SAT_FADE = 128

export function createSaturator(sampleRate: number): Processor {
  const toneRate = sampleRate * SHAPER_FACTOR
  const tone = [designBiquad('lowpass', toneRate, 8000, 0.7), designBiquad('lowpass', toneRate, 8000, 0.7)]
  const toneTarget = designBiquad('lowpass', toneRate, 8000, 0.7)
  let freq = Number.NaN
  let toneReady = false
  let toneMove = false
  const shapers: ShaperState[] = [createShaperState(), createShaperState()]
  const driveGlide = new SampleGlide()
  const mixGlide = new SampleGlide()
  let warm = 0
  let fade = 0
  return {
    latencySamples: 0,
    reset() {
      clearTone(tone)
      resetShaperState(shapers[0])
      resetShaperState(shapers[1])
      driveGlide.reset()
      mixGlide.reset()
      warm = 0
      fade = 0
      toneReady = false
      toneMove = false
      freq = Number.NaN
    },
    process(input, output, params, ctx) {
      if (params.tone !== freq) {
        const next = designBiquad('lowpass', ctx.sampleRate * SHAPER_FACTOR, params.tone, 0.7)
        copyCoeffs(toneTarget, next)
        freq = params.tone
        if (!toneReady) {
          copyCoeffs(tone[0], toneTarget)
          copyCoeffs(tone[1], toneTarget)
          toneReady = true
          toneMove = false
        } else toneMove = true
      }
      const driveTarget = clamp(params.drive, 0, 1)
      const mixTarget = clamp(params.mix ?? 1, 0, 1)
      driveGlide.prepare(ctx.sampleRate)
      mixGlide.prepare(ctx.sampleRate)
      const rate = ctx.sampleRate > 0 ? ctx.sampleRate : 48000
      const alpha = 1 - Math.exp(-1 / (0.008 * rate))
      const latency = shaperLatencySamples()
      this.latencySamples = driveTarget <= 0.0001 ? 0 : latency
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        if (toneMove) toneMove = !slewTone(tone, toneTarget, alpha)
        const drive = driveGlide.next(driveTarget)
        const mix = mixGlide.next(mixTarget)
        const want = driveTarget > 0.0001 || drive > 0.0001
        let wetL = 0
        let wetR = 0
        if (want || fade > 0) {
          const dryL = input[0]?.[i] ?? 0
          const dryR = input[1]?.[i] ?? dryL
          const shape = 1 + drive * 8
          wetL = oversampleShape(shapers[0], dryL, drive, shape, tone[0])
          wetR = oversampleShape(shapers[1], dryR, drive, shape, tone[1])
          if (warm < 1000000) warm += 1
          if (warm > latency) fade = want ? Math.min(SAT_FADE, fade + 1) : Math.max(0, fade - 1)
        } else if (warm !== 0) {
          resetShaperState(shapers[0])
          resetShaperState(shapers[1])
          clearTone(tone)
          warm = 0
          fade = 0
        }
        const open = fade / SAT_FADE
        for (let c = 0; c < output.length; c++) {
          const dry = input[Math.min(c, input.length - 1)]?.[i] ?? 0
          const wet = c === 0 ? wetL : wetR
          const amount = open * mix
          output[c][i] = sanitize(dry * (1 - amount) + wet * amount)
        }
      }
    },
  }
}

function clearTone(tone: Biquad[]) {
  for (const filter of tone) filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
}

function slewTone(tone: Biquad[], target: Biquad, alpha: number) {
  let err = 0
  for (const filter of tone) {
    filter.b0 += (target.b0 - filter.b0) * alpha
    filter.b1 += (target.b1 - filter.b1) * alpha
    filter.b2 += (target.b2 - filter.b2) * alpha
    filter.a1 += (target.a1 - filter.a1) * alpha
    filter.a2 += (target.a2 - filter.a2) * alpha
    err = Math.max(err, Math.abs(target.b0 - filter.b0), Math.abs(target.b1 - filter.b1), Math.abs(target.b2 - filter.b2), Math.abs(target.a1 - filter.a1), Math.abs(target.a2 - filter.a2))
  }
  if (err < 1e-8) {
    copyCoeffs(tone[0], target)
    copyCoeffs(tone[1], target)
    return true
  }
  return false
}

export function createDoubler(sampleRate: number): Processor {
  const length = Math.ceil(sampleRate * 0.05)
  const lines = [new Float32Array(length), new Float32Array(length)]
  let write = 0
  let phase = 0
  const mixGlide = new SampleGlide()
  return {
    latencySamples: 0,
    reset() {
      lines[0].fill(0)
      lines[1].fill(0)
      write = 0
      phase = 0
      mixGlide.reset()
    },
    process(input, output, params, ctx) {
      mixGlide.prepare(ctx.sampleRate)
      const mixTarget = clamp(params.mix, 0, 1)
      const width = clamp(params.width, 0, 1)
      const base = clamp((params.delay / 1000) * ctx.sampleRate, 1, length - 2)
      const depth = clamp(params.depth, 0, 1) * ctx.sampleRate * 0.003
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const left = input[0][i] || 0
        const right = input[1]?.[i] ?? left
        lines[0][write] = left
        lines[1][write] = right
        phase += (0.35 * Math.PI * 2) / ctx.sampleRate
        const tapL = read(lines[0], write, base + Math.sin(phase) * depth)
        const tapR = read(lines[1], write, base * 1.3 + Math.cos(phase) * depth)
        const mid = (left + right) * 0.5
        const side = (left - right) * 0.5 * width
        const spread = 0.15 + width * 0.85
        const wetL = mid + side + (tapR - mid) * spread
        const wetR = mid - side + (tapL - mid) * spread
        const mix = mixGlide.next(mixTarget)
        if (output[0]) output[0][i] = sanitize(left * (1 - mix) + wetL * mix)
        if (output[1]) output[1][i] = sanitize(right * (1 - mix) + wetR * mix)
        write = (write + 1) % length
      }
    },
  }
}

export function createChorus(sampleRate: number): Processor {
  const length = Math.ceil(sampleRate * 0.04)
  const line = new Float32Array(length)
  let write = 0
  let phase = 0
  const mixGlide = new SampleGlide()
  return {
    latencySamples: 0,
    reset() {
      line.fill(0)
      write = 0
      phase = 0
      mixGlide.reset()
    },
    process(input, output, params, ctx) {
      mixGlide.prepare(ctx.sampleRate)
      const mixTarget = clamp(params.mix, 0, 1)
      const rate = clamp(params.rate, 0.05, 5)
      const depth = clamp(params.depth, 0, 1) * ctx.sampleRate * 0.008
      const base = ctx.sampleRate * 0.012
      const n = input[0]?.length ?? 0
      for (let i = 0; i < n; i++) {
        const left = input[0][i] || 0
        const right = input[1]?.[i] ?? left
        line[write] = (left + right) * 0.5
        phase += (rate * Math.PI * 2) / ctx.sampleRate
        const wetL = read(line, write, base + (0.5 + 0.5 * Math.sin(phase)) * depth)
        const wetR = read(line, write, base + (0.5 + 0.5 * Math.sin(phase + 2)) * depth)
        const mix = mixGlide.next(mixTarget)
        if (output[0]) output[0][i] = sanitize(left * (1 - mix) + wetL * mix)
        if (output[1]) output[1][i] = sanitize(right * (1 - mix) + wetR * mix)
        write = (write + 1) % length
      }
    },
  }
}

function read(line: Float32Array, write: number, delay: number) {
  const index = write - delay
  const i0 = Math.floor(index)
  const frac = index - i0
  const a = line[((i0 % line.length) + line.length) % line.length]
  const b = line[(((i0 + 1) % line.length) + line.length) % line.length]
  return a + (b - a) * frac
}
