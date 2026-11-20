/** Scale membership for generated and varied notes. Quarter tones count. */

import { toneFromCents } from '../theory/pitch'
import { getScale } from '../theory/scales'

export function mod12(value: number) {
  return ((Math.round(value) % 12) + 12) % 12
}

/** True when the sounding pitch is a degree of the scale, within 15 cents. */
export function fitsScale(pitch: number, fine: number | undefined, scaleId: string, key: number) {
  const sounded = Math.round(pitch) * 100 + Math.round(fine ?? 0)
  const tonic = mod12(key) * 100
  const relative = ((sounded - tonic) % 1200 + 1200) % 1200
  return getScale(scaleId).cents.some((cents) => {
    const step = ((cents % 1200) + 1200) % 1200
    const delta = Math.abs(relative - step)
    return Math.min(delta, 1200 - delta) <= 15
  })
}

/** Nearest scale degree, keeping the note in the same register. */
export function nearestInScale(pitch: number, scaleId: string, key: number): { pitch: number; fine?: number } {
  const origin = Math.round(pitch) * 100
  const spec = getScale(scaleId)
  let best = { midi: Math.round(pitch), cents: 0, dist: 1e9 }
  const tonic = 60 + mod12(key)
  for (let octave = -2; octave <= 2; octave++) {
    for (const step of spec.cents) {
      const tone = toneFromCents(tonic * 100 + step + octave * 1200)
      const dist = Math.abs(tone.midi * 100 + tone.cents - origin)
      if (dist < best.dist) best = { midi: tone.midi, cents: tone.cents, dist }
    }
  }
  const midi = Math.max(0, Math.min(127, best.midi))
  return best.cents ? { pitch: midi, fine: best.cents } : { pitch: midi }
}
