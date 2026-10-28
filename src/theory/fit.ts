/** Nearest scale degree, in cents, for snap, highlighting, and maqam pitch bend. */

import { splitTuned, type TunedPitch } from './pitch'
import { scaleById } from './scales'

export function centsOffScale(pitch: number, root: number, scaleId: string) {
  return Math.abs(nearestCents(pitch, root, scaleId) - pitch * 100)
}

/** Snap to the nearest scale degree. Ties resolve to the lower degree. */
export function snapToScale(pitch: number, root: number, scaleId: string): TunedPitch {
  return splitTuned(nearestCents(pitch, root, scaleId) / 100)
}

export function inScale(pitch: number, root: number, scaleId: string, tolerance = 15) {
  return centsOffScale(pitch, root, scaleId) <= tolerance
}

/** Within a quarter tone of a degree, but not close enough to call it the same semitone. */
export function nearQuarter(pitch: number, root: number, scaleId: string) {
  const distance = centsOffScale(pitch, root, scaleId)
  return distance > 15 && distance <= 50
}

function nearestCents(pitch: number, root: number, scaleId: string) {
  const scale = scaleById(scaleId)
  const target = pitch * 100
  const rootCents = mod(root, 12) * 100
  const center = Math.floor(pitch / 12)
  let best = target
  let bestDist = Infinity
  for (let oct = center - 1; oct <= center + 1; oct++) {
    for (const interval of scale.cents) {
      const candidate = oct * 1200 + rootCents + interval
      const dist = Math.abs(candidate - target)
      if (dist < bestDist - 0.01 || (Math.abs(dist - bestDist) <= 0.01 && candidate < best)) {
        best = candidate
        bestDist = dist
      }
    }
  }
  return best
}

function mod(value: number, span: number) {
  return ((value % span) + span) % span
}
