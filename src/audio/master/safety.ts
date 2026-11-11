/**
 * Master safety.
 * Offline renders scale a hot mix in one gain so the waveform is not clipped.
 * Live playback uses the same gain law with a short lookahead (see public/worklets/safety.js).
 * Signals that already sit at or under full scale are left sample-for-sample.
 */

import { truePeakLinear } from './fir'
import { createTruePeakState, readTruePeak, resetTruePeak, TRUE_PEAK_SLACK } from '../quality/truePeak'

/** Samples of lookahead. 32 samples is 0.67 ms at 48 kHz. Keep in sync with the worklet. */
export const SAFETY_LOOK = 32
/** Samples the gain takes to reach a new lower target. Must stay under SAFETY_LOOK. */
export const SAFETY_ATTACK = 8
/** Release time constant. */
export const SAFETY_RELEASE_SEC = 0.05
/** Full-scale ceiling. Unity sine waves are not reduced. */
export const SAFETY_CEILING = 1

export function holdFullScale(channels: Float32Array[]) {
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i] || 0
      const abs = sample < 0 ? -sample : sample
      if (abs > peak) peak = abs
    }
    if (channel.length >= 64) peak = Math.max(peak, truePeakLinear(channel, 64))
  }
  if (!(peak > SAFETY_CEILING * TRUE_PEAK_SLACK) || !Number.isFinite(peak)) return channels
  const gain = SAFETY_CEILING / peak
  return channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = (channel[i] || 0) * gain
    return out
  })
}

/**
 * Linked stereo lookahead limiter.
 * While the window stays at or under the ceiling, the gain is exactly 1 and the
 * output is the delayed input. A hot peak ramps the gain down before that peak
 * leaves the delay, so the sample is turned down instead of flat-topped.
 */
export function createSafetyLimiter(sampleRate = 48000) {
  const look = SAFETY_LOOK
  const delayL = new Float32Array(look)
  const delayR = new Float32Array(look)
  const peaks = new Float32Array(look)
  const detectL = createTruePeakState()
  const detectR = createTruePeakState()
  let index = 0
  let gain = 1
  let target = 1
  let slope = 0
  const release = 1 - Math.exp(-1 / Math.max(1, SAFETY_RELEASE_SEC * (sampleRate > 0 ? sampleRate : 48000)))
  return {
    latency: look,
    reset() {
      delayL.fill(0)
      delayR.fill(0)
      peaks.fill(0)
      resetTruePeak(detectL)
      resetTruePeak(detectR)
      index = 0
      gain = 1
      target = 1
      slope = 0
    },
    process(left: ArrayLike<number>, right: ArrayLike<number>, outL: Float32Array, outR: Float32Array) {
      const n = Math.min(left.length, outL.length)
      for (let i = 0; i < n; i++) {
        const inL = finite(left[i])
        const inR = finite(right[i] ?? inL)
        const slot = index % look
        const delayedL = delayL[slot]
        const delayedR = delayR[slot]
        delayL[slot] = inL
        delayR[slot] = inR
        peaks[slot] = Math.max(readTruePeak(detectL, inL), readTruePeak(detectR, inR))
        let peak = 0
        for (let k = 0; k < look; k++) if (peaks[k] > peak) peak = peaks[k]
        const needed = peak > SAFETY_CEILING * TRUE_PEAK_SLACK ? SAFETY_CEILING / peak : 1
        if (needed < target - 1e-8) {
          target = needed
          slope = (gain - target) / SAFETY_ATTACK
        }
        if (gain > target) gain = Math.max(target, gain - slope)
        else {
          target = needed
          gain += (needed - gain) * release
          if (needed === 1 && gain > 1 - 1e-6) {
            gain = 1
            target = 1
            slope = 0
          }
        }
        outL[i] = delayedL * gain
        outR[i] = delayedR * gain
        index += 1
      }
    },
  }
}

function finite(sample: number | undefined) {
  return typeof sample === 'number' && Number.isFinite(sample) ? sample : 0
}
