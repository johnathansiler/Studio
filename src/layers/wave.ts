/**
 * Original single-cycle-style tones for layers that have no user sample.
 * Written for CueHarbor and dedicated to the public domain under CC0 1.0.
 * Nothing here is fetched from a host.
 */

const cache = new Map<number, Float32Array>()

export function freeWaveform(sampleRate: number): Float32Array {
  const rate = Math.max(8000, Math.round(sampleRate) || 48000)
  const found = cache.get(rate)
  if (found) return found
  const length = Math.max(2, Math.round(rate * 2))
  const data = new Float32Array(length)
  const hz = 440 * 2 ** ((60 - 69) / 12)
  for (let i = 0; i < length; i++) {
    const t = i / rate
    const fade = Math.min(1, i / 64) * Math.min(1, (length - 1 - i) / 64)
    const partials = 1 + Math.floor((i / length) * 10)
    let sum = 0
    for (let k = 1; k <= partials; k++) sum += Math.sin(2 * Math.PI * hz * k * t) / k
    data[i] = sum * fade
  }
  let peak = 1e-8
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(data[i]))
  const gain = 0.9 / peak
  for (let i = 0; i < length; i++) data[i] *= gain
  cache.set(rate, data)
  return data
}
