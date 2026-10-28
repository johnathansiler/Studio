/** 8-point Lanczos. Integer positions pass the original sample through. */

const RADIUS = 8

function lanczos(distance: number) {
  const x = Math.abs(distance)
  if (x >= RADIUS) return 0
  if (x < 1e-8) return 1
  const pix = Math.PI * x
  return (Math.sin(pix) / pix) * (Math.sin(pix / RADIUS) / (pix / RADIUS))
}

export function readAt(channel: Float32Array, origin: number, pos: number) {
  const index = Math.floor(pos)
  const frac = pos - index
  let sum = 0
  let weight = 0
  for (let tap = 1 - RADIUS; tap <= RADIUS; tap++) {
    const w = lanczos(tap - frac)
    if (w === 0) continue
    const at = index + tap - origin
    const sample = at >= 0 && at < channel.length ? channel[at] || 0 : 0
    sum += sample * w
    weight += w
  }
  if (!weight) return 0
  const value = sum / weight
  return Number.isFinite(value) ? value : 0
}

export const INTERP_RADIUS = RADIUS
