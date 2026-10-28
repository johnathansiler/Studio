import { centDistance } from './pitch'
import { harmonize } from './chords'
import { getScale } from './scales'
import type { RealizedChord, TheoryProgression } from './types'

const MAJOR: TheoryProgression[] = [
  { id: 'axis', name: 'Axis', description: 'I–V–vi–IV. The open pop loop.', targets: [0, 700, 900, 500] },
  { id: 'sensitive', name: 'Sensitive', description: 'vi–IV–I–V. Starts away from home.', targets: [900, 500, 0, 700] },
  { id: 'fifties', name: 'Fifties', description: 'I–vi–IV–V. A familiar turnaround.', targets: [0, 900, 500, 700] },
  { id: 'cadence', name: 'Cadence', description: 'ii–V–I. The chord that asks to resolve, then home.', targets: [200, 700, 0] },
  { id: 'plagal', name: 'Plagal', description: 'I–IV–V–IV. The subdominant answers the tonic.', targets: [0, 500, 700, 500] },
  { id: 'circle', name: 'Circle', description: 'vi–ii–V–I. Roots falling by fifths.', targets: [900, 200, 700, 0] },
]

const MINOR: TheoryProgression[] = [
  { id: 'minor-loop', name: 'Minor loop', description: 'i–VI–III–VII. Major colors inside a minor loop.', targets: [0, 800, 300, 1000] },
  { id: 'andalusian', name: 'Andalusian', description: 'i–VII–VI–V. Each step falls.', targets: [0, 1000, 800, 700] },
  { id: 'cadence', name: 'Cadence', description: 'ii–V–i. A minor turn home.', targets: [200, 700, 0] },
  { id: 'plagal', name: 'Plagal', description: 'i–iv–i–VI. A minor amen, then the relative major.', targets: [0, 500, 0, 800] },
  { id: 'step', name: 'Climb', description: 'i–VII–VI–VII. The flat seven keeps it open.', targets: [0, 1000, 800, 1000] },
]

export function progressionsFor(scaleId: string): TheoryProgression[] {
  return thirdIsMinor(scaleId) ? MINOR : MAJOR
}

export function realizeProgression(rootPc: number, scaleId: string, progression: TheoryProgression, beats = 4, size: 3 | 4 = 3): RealizedChord[] {
  const diatonic = harmonize(rootPc, scaleId, size)
  if (!diatonic.length) return []
  return progression.targets.map((target) => {
    const degree = closestDegree(scaleId, target)
    const chord = diatonic[degree] ?? diatonic[0]
    return { symbol: chord.symbol, roman: chord.roman, degree: chord.degree, beats, tones: chord.tones }
  })
}

function thirdIsMinor(scaleId: string) {
  const spec = getScale(scaleId)
  const third = spec.cents.find((cents) => cents >= 250 && cents <= 450) ?? 400
  return Math.abs(third - 300) <= Math.abs(third - 400)
}

function closestDegree(scaleId: string, target: number) {
  const spec = getScale(scaleId)
  let best = 0
  let dist = 1200
  spec.cents.forEach((cents, index) => {
    const delta = centDistance(cents, target)
    if (delta < dist) {
      dist = delta
      best = index
    }
  })
  return best
}
