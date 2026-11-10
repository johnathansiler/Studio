import { transparentLimit } from './liveStage'

/** About -12 dBFS. One note or one-shot should land here before the fader. */
export const NOTE_PEAK = 10 ** (-12 / 20)

export function measurePeak(channels: ArrayLike<number>[]) {
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.abs(channel[i] ?? 0)
      if (sample > peak) peak = sample
    }
  }
  return peak
}

/**
 * Bring a buffer to `target` peak.
 * A silent buffer stays silent. Boost is capped so a noise floor cannot jump to full scale.
 */
export function normalizePeak(channels: Float32Array[], target = NOTE_PEAK, maxBoostDb = 18) {
  const peak = measurePeak(channels)
  if (!(peak > 1e-8)) return channels.map((channel) => channel.slice())
  const cap = 10 ** (maxBoostDb / 20)
  const gain = Math.min(cap, target / peak)
  return channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = channel[i] * gain
    return out
  })
}

/**
 * Notes this close to center skip a one-shot panner.
 * 0.005 is half a pan unit, so −3 and +2 (0.03 and 0.02) still pan.
 */
export const PAN_APPLY = 0.005

/** Equal-power pan. Center is −3 dB on each side. −1 is full left. */
export function panGains(pan: number) {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0))
  const angle = ((clamped + 1) * Math.PI) / 4
  return { left: Math.cos(angle), right: Math.sin(angle) }
}

/**
 * Linear through ±0.98, then the same smooth ceiling as the live voices.
 * A DynamicsCompressor is not used here: its detector and makeup gain color
 * every sample, including sounds well below the threshold.
 */
export function safetyCurve(length = 2049) {
  const curve = new Float32Array(length)
  const last = Math.max(1, length - 1)
  for (let i = 0; i < length; i++) {
    const x = (i / last) * 2 - 1
    curve[i] = Math.abs(x) <= 0.98 ? x : transparentLimit(x)
  }
  return curve
}

export function db(value: number) {
  return 20 * Math.log10(Math.max(1e-12, Math.abs(value)))
}
