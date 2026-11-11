/**
 * Speaker and cue safety limiter.
 * Keep LOOK, ATTACK, RELEASE_SEC, CEILING, the gain law, and the 16x peak
 * detector in sync with src/audio/master/safety.ts and src/audio/quality/truePeak.ts.
 * AudioWorklet rejects module loading, so this file stays self-contained.
 */
const LOOK = 32
const ATTACK = 8
const RELEASE_SEC = 0.05
const CEILING = 1
const SLACK = 1.0005
const FACTOR = 16
const PHASE_TAPS = 20
const BETA = 6

function bessel0(x) {
  let sum = 1
  let term = 1
  const half = x * 0.5
  for (let k = 1; k <= 12; k++) {
    term *= (half * half) / (k * k)
    sum += term
  }
  return sum
}

function designPhases() {
  const length = FACTOR * PHASE_TAPS
  const cutoff = 0.5 / FACTOR
  const mid = (length - 1) / 2
  const beta0 = bessel0(BETA)
  const kernel = new Float64Array(length)
  let sum = 0
  for (let i = 0; i < length; i++) {
    const x = i - mid
    const arg = 2 * cutoff * x
    const sinc = Math.abs(arg) < 1e-8 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg)
    const amount = mid === 0 ? 0 : x / mid
    const inside = 1 - amount * amount
    const win = inside > 0 ? bessel0(BETA * Math.sqrt(inside)) / beta0 : 0
    kernel[i] = 2 * cutoff * sinc * win
    sum += kernel[i]
  }
  const scale = FACTOR / (sum || 1)
  for (let i = 0; i < length; i++) kernel[i] *= scale
  const phases = []
  for (let phase = 0; phase < FACTOR; phase++) {
    const taps = new Float64Array(PHASE_TAPS)
    for (let tap = 0; tap < PHASE_TAPS; tap++) taps[tap] = kernel[tap * FACTOR + phase] || 0
    phases.push(taps)
  }
  return phases
}

const PHASES = designPhases()

function makeDetect() {
  return { hist: new Float64Array(PHASE_TAPS), write: 0 }
}

function readPeak(state, sample) {
  const hist = state.hist
  const at = state.write
  hist[at] = sample
  let best = sample < 0 ? -sample : sample
  for (let phase = 0; phase < FACTOR; phase++) {
    const branch = PHASES[phase]
    let acc = 0
    for (let tap = 0; tap < PHASE_TAPS; tap++) acc += hist[(at - tap + PHASE_TAPS) % PHASE_TAPS] * branch[tap]
    const abs = acc < 0 ? -acc : acc
    if (abs > best) best = abs
  }
  state.write = (at + 1) % PHASE_TAPS
  return best
}

class SafetyProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.delayL = new Float32Array(LOOK)
    this.delayR = new Float32Array(LOOK)
    this.peaks = new Float32Array(LOOK)
    this.detectL = makeDetect()
    this.detectR = makeDetect()
    this.index = 0
    this.gain = 1
    this.target = 1
    this.slope = 0
    this.release = 1 - Math.exp(-1 / Math.max(1, RELEASE_SEC * sampleRate))
  }

  process(inputs, outputs) {
    const input = inputs[0] || []
    const output = outputs[0]
    if (!output || !output[0]) return true
    const frames = output[0].length
    const inL = input[0]
    const inR = input[1] || inL
    for (let i = 0; i < frames; i++) {
      const left = finite(inL ? inL[i] : 0)
      const right = finite(inR ? inR[i] : left)
      const slot = this.index % LOOK
      const delayedL = this.delayL[slot]
      const delayedR = this.delayR[slot]
      this.delayL[slot] = left
      this.delayR[slot] = right
      this.peaks[slot] = Math.max(readPeak(this.detectL, left), readPeak(this.detectR, right))
      let peak = 0
      for (let k = 0; k < LOOK; k++) if (this.peaks[k] > peak) peak = this.peaks[k]
      const needed = peak > CEILING * SLACK ? CEILING / peak : 1
      if (needed < this.target - 1e-8) {
        this.target = needed
        this.slope = (this.gain - this.target) / ATTACK
      }
      if (this.gain > this.target) this.gain = Math.max(this.target, this.gain - this.slope)
      else {
        this.target = needed
        this.gain += (needed - this.gain) * this.release
        if (needed === 1 && this.gain > 1 - 1e-6) {
          this.gain = 1
          this.target = 1
          this.slope = 0
        }
      }
      const outL = delayedL * this.gain
      const outR = delayedR * this.gain
      output[0][i] = outL
      if (output[1]) output[1][i] = outR
      this.index += 1
    }
    return true
  }
}

function finite(sample) {
  return typeof sample === 'number' && Number.isFinite(sample) ? sample : 0
}

registerProcessor('cueharbor-safety', SafetyProcessor)
