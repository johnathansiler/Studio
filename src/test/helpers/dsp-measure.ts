/** Offline measurements for control audits. Safe to share with the effects audit. */

export function rms(channel: ArrayLike<number>, from = 0, to = channel.length): number {
  const start = Math.max(0, from | 0)
  const end = Math.min(channel.length, to | 0)
  const n = Math.max(1, end - start)
  let sum = 0
  for (let i = start; i < end; i++) {
    const sample = channel[i] || 0
    sum += sample * sample
  }
  return Math.sqrt(sum / n)
}

export function peak(channel: ArrayLike<number>, from = 0, to = channel.length): number {
  let max = 0
  const end = Math.min(channel.length, to)
  for (let i = Math.max(0, from); i < end; i++) max = Math.max(max, Math.abs(channel[i] || 0))
  return max
}

/** Fundamental from rising zero crossings. */
export function measureHz(channel: ArrayLike<number>, sampleRate: number, from = 0): number {
  const start = Math.min(channel.length - 2, Math.max(0, from | 0))
  let prev = channel[start] || 0
  let last = -1
  const periods: number[] = []
  for (let i = start + 1; i < channel.length; i++) {
    const value = channel[i] || 0
    if (prev <= 0 && value > 0) {
      const at = i - 1 + prev / (prev - value)
      if (last >= 0) periods.push(at - last)
      last = at
    }
    prev = value
  }
  const window = periods.slice(1, 10)
  if (window.length < 2) return 0
  const mean = window.reduce((sum, period) => sum + period, 0) / window.length
  return mean > 0 ? sampleRate / mean : 0
}

export function centsOff(hz: number, target: number): number {
  if (!(hz > 0) || !(target > 0)) return 9999
  return Math.abs(1200 * Math.log2(hz / target))
}

export function sine(sampleRate: number, freq: number, length: number, amp = 0.6): Float32Array {
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp
  return data
}

/** Energy of one bin from a short DFT. */
export function binEnergy(channel: ArrayLike<number>, sampleRate: number, freq: number, from = 0, frames = 2048): number {
  const n = Math.min(frames, channel.length - from)
  if (n < 32) return 0
  let real = 0
  let imag = 0
  const step = (2 * Math.PI * freq) / sampleRate
  for (let i = 0; i < n; i++) {
    const sample = channel[from + i] || 0
    real += sample * Math.cos(step * i)
    imag -= sample * Math.sin(step * i)
  }
  return Math.sqrt(real * real + imag * imag) / n
}

/** Separate amplitude bumps. A repeated note raises the count. */
export function onsetCount(channel: ArrayLike<number>, sampleRate: number, gapSec = 0.04): number {
  const hop = Math.max(1, Math.round(sampleRate * 0.005))
  const gap = Math.max(hop, Math.round(sampleRate * gapSec))
  let count = 0
  let last = -gap
  let prev = 0
  for (let i = 0; i + hop < channel.length; i += hop) {
    let energy = 0
    for (let j = 0; j < hop; j++) {
      const sample = channel[i + j] || 0
      energy += sample * sample
    }
    const level = Math.sqrt(energy / hop)
    if (level > 0.02 && level > prev * 1.4 && i - last >= gap) {
      count += 1
      last = i
    }
    prev = level * 0.6 + prev * 0.4
  }
  return count
}

export function activeLength(channel: ArrayLike<number>, floor = 0.01): number {
  let end = 0
  for (let i = 0; i < channel.length; i++) if (Math.abs(channel[i] || 0) > floor) end = i
  return end
}
