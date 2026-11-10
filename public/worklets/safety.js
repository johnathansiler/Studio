/**
 * Speaker and cue safety limiter.
 * Keep LOOK, ATTACK, RELEASE_SEC, and the gain law in sync with src/audio/master/safety.ts.
 * AudioWorklet rejects module loading, so this file stays self-contained.
 */
const LOOK = 32
const ATTACK = 8
const RELEASE_SEC = 0.05
const CEILING = 1

class SafetyProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.delayL = new Float32Array(LOOK)
    this.delayR = new Float32Array(LOOK)
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
      let peak = 0
      for (let k = 0; k < LOOK; k++) {
        const l = this.delayL[k]
        const r = this.delayR[k]
        const absL = l < 0 ? -l : l
        const absR = r < 0 ? -r : r
        if (absL > peak) peak = absL
        if (absR > peak) peak = absR
      }
      const needed = peak > CEILING ? CEILING / peak : 1
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
