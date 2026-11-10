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

/** Equal-power pan. Center is −3 dB on each side. −1 is full left. */
export function panGains(pan: number) {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0))
  const angle = ((clamped + 1) * Math.PI) / 4
  return { left: Math.cos(angle), right: Math.sin(angle) }
}

/**
 * How far a one-shot pan travels before it is pure equal-power.
 * Inside this span the law joins the direct (no panner) center, which is
 * unity on both sides, to equal-power. Past it, the gains match `panGains`.
 */
export const NOTE_PAN_BLEND = 0.25

/**
 * Pan for a one-shot note.
 * A centered hit connects with no extra panner, so both sides stay at unity.
 * Equal-power alone would sit 3 dB under that, and switching it on at the
 * first step off center is an audible jump. This curve keeps that center,
 * meets equal-power by ±0.25, and matches a hard pan exactly.
 */
export function notePanGains(pan: number) {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0))
  const equal = panGains(clamped)
  const amount = Math.min(1, Math.abs(clamped) / NOTE_PAN_BLEND)
  const mix = amount * amount * (3 - 2 * amount)
  return {
    left: (1 - mix) + equal.left * mix,
    right: (1 - mix) + equal.right * mix,
  }
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
