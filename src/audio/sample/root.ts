function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function estimateHz(channel: Float32Array, sampleRate: number) {
  const start = Math.min(channel.length - 2, Math.round(sampleRate * 0.02))
  if (start < 0) return 0
  let prev = channel[start] || 0
  let last = -1
  const periods: number[] = []
  for (let i = start + 1; i < channel.length; i++) {
    const value = channel[i] || 0
    if (prev <= 0 && value > 0) {
      const at = i - 1 + prev / (prev - value || 1)
      if (last >= 0) periods.push(at - last)
      last = at
    }
    prev = value
  }
  if (periods.length < 3) return 0
  const window = periods.slice(1, 10)
  const mean = window.reduce((sum, period) => sum + period, 0) / window.length
  return mean > 0 ? sampleRate / mean : 0
}

/** MIDI root of a stem, from the zero crossings after the attack. */
export function detectRoot(channel: Float32Array, sampleRate: number) {
  const hz = estimateHz(channel, sampleRate)
  if (!hz) return 60
  const midi = Math.round(69 + 12 * Math.log2(hz / 440))
  return clamp(midi, 0, 127)
}
