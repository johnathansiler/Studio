function sanitize(sample: number) {
  if (!Number.isFinite(sample) || Math.abs(sample) < 1e-15) return 0
  return sample
}

function hann(index: number, length: number) {
  if (length <= 1) return 1
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1))
}

export interface PitchFrame {
  hz: number
  confidence: number
}

/** YIN pitch estimate. hz is 0 when the frame is unvoiced. */
export function yinPitch(frame: Float32Array, sampleRate: number, minHz: number, maxHz: number): PitchFrame {
  const n = frame.length
  const tauMin = Math.max(2, Math.floor(sampleRate / Math.max(40, maxHz)))
  const tauMax = Math.min(Math.floor(n / 2) - 2, Math.floor(sampleRate / Math.max(40, minHz)))
  if (tauMax <= tauMin + 2) return { hz: 0, confidence: 0 }
  let energy = 0
  for (let i = 0; i < n; i++) energy += frame[i] * frame[i]
  if (energy / n < 1e-8) return { hz: 0, confidence: 0 }
  const diff = new Float32Array(tauMax + 1)
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0
    for (let i = 0; i < n - tau; i += 2) {
      const delta = frame[i] - frame[i + tau]
      sum += delta * delta
    }
    diff[tau] = sum
  }
  const cmnd = new Float32Array(tauMax + 1)
  let running = 0
  cmnd[tauMin] = 1
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += diff[tau]
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1
  }
  let tau = -1
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < 0.18) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++
      tau = t
      break
    }
  }
  if (tau < 0) {
    let best = tauMin
    for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t
    if (cmnd[best] > 0.5) return { hz: 0, confidence: clamp01(1 - cmnd[best]) }
    tau = best
  }
  const prev = cmnd[Math.max(0, tau - 1)]
  const mid = cmnd[tau]
  const next = cmnd[Math.min(tauMax, tau + 1)]
  const denom = prev + next - 2 * mid
  const shift = denom === 0 ? 0 : (prev - next) / (2 * denom)
  const period = Math.max(1, tau + shift)
  return { hz: sampleRate / period, confidence: clamp01(1 - mid) }
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}

/**
 * Time-domain PSOLA. Grain centers stay on the input timeline so duration does
 * not change; only the distance between centers changes the pitch.
 */
export class Psola {
  readonly latencySamples: number
  private readonly channels: number
  private readonly span: number
  private readonly ring: Float32Array[]
  private readonly mix: Float32Array[]
  private readonly weight: Float32Array
  private written = 0
  private nextOut = 0
  private emitted = 0
  private epoch = 0
  private epochSet = false

  constructor(sampleRate: number, channels = 2) {
    this.channels = Math.max(1, Math.min(2, channels))
    this.span = Math.max(1024, Math.round(1536 * (sampleRate / 48000)))
    this.latencySamples = this.span + Math.floor(this.span / 2)
    const size = this.span * 8
    this.ring = Array.from({ length: this.channels }, () => new Float32Array(size))
    this.mix = Array.from({ length: this.channels }, () => new Float32Array(size))
    this.weight = new Float32Array(size)
  }

  reset() {
    for (const buffer of this.ring) buffer.fill(0)
    for (const buffer of this.mix) buffer.fill(0)
    this.weight.fill(0)
    this.written = 0
    this.nextOut = 0
    this.emitted = 0
    this.epoch = 0
    this.epochSet = false
  }

  process(
    input: Float32Array[],
    output: Float32Array[],
    targetFor: (frame: PitchFrame) => number,
    sampleRate: number,
    minHz: number,
    maxHz: number,
    analyzeEvery: number,
  ) {
    const n = input[0]?.length ?? 0
    const hop = Math.max(32, Math.round(analyzeEvery))
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) {
        this.ring[c][this.written % this.ring[c].length] = input[Math.min(c, input.length - 1)]?.[i] ?? 0
      }
      this.written += 1
      this.synthesize(targetFor, sampleRate, minHz, maxHz, hop)
      const sample = this.take(hop)
      for (let c = 0; c < output.length; c++) output[c][i] = sample[Math.min(c, sample.length - 1)] ?? 0
    }
  }

  private synthesize(targetFor: (frame: PitchFrame) => number, sampleRate: number, minHz: number, maxHz: number, hop: number) {
    let guard = 0
    while (this.written - this.nextOut > this.span && guard < 4) {
      guard += 1
      const frame = new Float32Array(this.span)
      for (let i = 0; i < this.span; i++) frame[i] = this.read(0, this.nextOut - this.span + i)
      const pitch = yinPitch(frame, sampleRate, minHz, maxHz)
      const target = targetFor(pitch)
      const voiced = pitch.hz > 0 && pitch.confidence >= 0.7 && target > 30
      if (!voiced) {
        this.epochSet = false
        this.stamp(this.nextOut, this.nextOut, hop, false)
        this.nextOut += hop
        continue
      }
      const period = clamp(Math.round(sampleRate / pitch.hz), 8, Math.floor(this.span / 2))
      const outPeriod = clamp(Math.round(sampleRate / target), 8, Math.floor(this.span / 2))
      if (!this.epochSet) {
        this.epoch = this.nextOut
        this.epochSet = true
      }
      const mark = this.epoch + Math.round((this.nextOut - this.epoch) / period) * period
      const grain = clamp(period * 2, 16, this.span - 1)
      this.stamp(mark, this.nextOut, grain, true)
      this.nextOut += outPeriod
    }
  }

  /** Repeat the pitch-locked input grain at the target spacing. */
  private stamp(inputCenter: number, outputCenter: number, grain: number, windowed: boolean) {
    const half = Math.floor(grain / 2)
    for (let i = 0; i < grain; i++) {
      const at = outputCenter - half + i
      if (at < this.emitted) continue
      const win = windowed ? hann(i, grain) : 1
      const slot = at % this.weight.length
      this.weight[slot] += win
      for (let c = 0; c < this.channels; c++) this.mix[c][slot] += this.read(c, inputCenter - half + i) * win
    }
  }

  private take(hop: number) {
    const ready = this.nextOut - Math.max(hop, Math.floor(this.span / 2))
    if (this.emitted >= ready) return this.channels === 2 ? [0, 0] : [0]
    const slot = this.emitted % this.weight.length
    const weight = this.weight[slot]
    const sample: number[] = []
    for (let c = 0; c < this.channels; c++) {
      sample.push(sanitize(weight > 1e-5 ? this.mix[c][slot] / weight : 0))
      this.mix[c][slot] = 0
    }
    this.weight[slot] = 0
    this.emitted += 1
    return sample
  }

  private read(channel: number, index: number) {
    if (index < 0 || index >= this.written) return 0
    return this.ring[channel][index % this.ring[channel].length]
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
