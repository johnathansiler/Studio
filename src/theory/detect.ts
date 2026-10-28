import { mod1200 } from './pitch'
import { allScales, nearestDegree } from './scales'
import type { Detection, ScaleSpec, WeightedPitch } from './types'

const PRIOR: Record<string, number> = {
  ionian: 0.08,
  aeolian: 0.07,
  harmonicMinor: 0.05,
  melodicMinor: 0.05,
  majorPentatonic: 0.04,
  minorPentatonic: 0.04,
  blues: 0.04,
  dorian: 0.03,
  mixolydian: 0.03,
  lydian: 0.02,
  phrygian: 0.02,
}

function prior(scale: ScaleSpec) {
  if (PRIOR[scale.id] != null) return PRIOR[scale.id]
  if (scale.family === 'western') return 0.02
  if (scale.family === 'blues' || scale.family === 'bebop' || scale.family === 'jazz' || scale.family === 'pentatonic') return 0.01
  return 0
}

/**
 * Rank key and scale candidates from MIDI. Notes with `cents` can pull a quarter-tone scale ahead of a 12-tone one.
 * Identical scales prefer the common Western name, so C major stays Ionian rather than a raga with the same notes.
 */
export function detectScale(notes: WeightedPitch[], pool?: ScaleSpec[]): Detection[] {
  const scales = pool ?? allScales()
  if (!notes.length) return [{ root: 0, scaleId: 'ionian', name: 'Major', score: 0 }]
  let total = 0
  for (const note of notes) total += Math.max(0.01, note.weight ?? 1)
  const ranked: Detection[] = []
  for (let root = 0; root < 12; root++) {
    for (const scale of scales) {
      let fit = 0
      let tonic = 0
      for (const note of notes) {
        const weight = Math.max(0.01, note.weight ?? 1)
        const relative = mod1200((note.midi - root) * 100 + (note.cents ?? 0))
        const distance = nearestDegree(relative, scale.cents).distance
        fit += weight * Math.exp(-(distance * distance) / (2 * 45 * 45))
        if (Math.min(relative, 1200 - relative) < 30) tonic += weight
      }
      ranked.push({
        root,
        scaleId: scale.id,
        name: scale.name,
        score: fit / total + (tonic / total) * 0.35 + prior(scale),
      })
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked
}
