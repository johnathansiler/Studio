import { SCALES } from '../model/scale'
import { centDistance, clampMidi, mod, mod1200, toneFromCents } from './pitch'
import type { ScaleSpec, Tone } from './types'

export const FAMILY_INFO: { id: string; name: string; description: string }[] = [
  { id: 'western', name: 'Western', description: 'Church modes, major, and natural minor.' },
  { id: 'harmonic', name: 'Harmonic minor', description: 'Modes of the harmonic minor scale.' },
  { id: 'melodic', name: 'Melodic minor', description: 'Jazz modes of the ascending melodic minor.' },
  { id: 'harmonic-major', name: 'Harmonic major', description: 'Major with a flat sixth, and its modes.' },
  { id: 'double', name: 'Double harmonic', description: 'Byzantine and Gypsy major colors.' },
  { id: 'pentatonic', name: 'Pentatonic', description: 'Five-note scales.' },
  { id: 'blues', name: 'Blues', description: 'Blues scales and the blue note.' },
  { id: 'bebop', name: 'Bebop', description: 'Eight-note scales with a chromatic passing tone.' },
  { id: 'symmetric', name: 'Symmetric', description: 'Whole tone, diminished, and augmented.' },
  { id: 'jazz', name: 'Jazz', description: 'Altered, acoustic, and other jazz colors.' },
  { id: 'japanese', name: 'Japanese', description: 'Yo, In, and koto scales.' },
  { id: 'raga', name: 'Raga', description: 'Hindustani thaats and Carnatic melakarta ragas.' },
  { id: 'maqam', name: 'Maqam', description: 'Arabic maqamat. Quarter tones play as pitch offsets.' },
  { id: 'dastgah', name: 'Dastgah', description: 'Persian dastgah and avaz, with koron offsets.' },
  { id: 'makam', name: 'Makam', description: 'Turkish makam in comma steps, played as cent offsets.' },
  { id: 'other', name: 'World', description: 'Other traditional and synthetic scales, including quarter tones.' },
]

const FAMILY: Record<string, string> = {
  ionian: 'western',
  dorian: 'western',
  phrygian: 'western',
  lydian: 'western',
  mixolydian: 'western',
  aeolian: 'western',
  locrian: 'western',
  harmonicMinor: 'harmonic',
  melodicMinor: 'melodic',
  majorPentatonic: 'pentatonic',
  minorPentatonic: 'pentatonic',
  blues: 'blues',
  wholeTone: 'symmetric',
  dimHalfWhole: 'symmetric',
  dimWholeHalf: 'symmetric',
  hirajoshi: 'japanese',
  phrygianDominant: 'harmonic',
  hungarianMinor: 'double',
  insen: 'japanese',
}

const ABOUT: Record<string, string> = {
  ionian: 'The major scale. Bright, and the usual home key.',
  dorian: 'Minor with a raised sixth. Minor, but not sad.',
  phrygian: 'Minor with a flat second. Dark, leaning down.',
  lydian: 'Major with a raised fourth. Bright and open.',
  mixolydian: 'Major with a flat seventh. Dominant, unresolved.',
  aeolian: 'Natural minor. The relative minor of major.',
  locrian: 'Minor with a flat second and a flat fifth. Unstable.',
  harmonicMinor: 'Natural minor with a raised seventh. Classical minor.',
  melodicMinor: 'Minor with a raised sixth and seventh. The jazz minor.',
  majorPentatonic: 'Five notes of the major scale, no half steps.',
  minorPentatonic: 'Five notes of the minor scale. The rock and blues frame.',
  blues: 'Minor pentatonic plus the blue note between four and five.',
  wholeTone: 'Only whole steps. Dreamlike, no clear center.',
  dimHalfWhole: 'Half step, whole step, repeating. The dominant diminished scale.',
  dimWholeHalf: 'Whole step, half step, repeating. The diminished scale.',
  hirajoshi: 'A Japanese koto scale, minor and spare.',
  phrygianDominant: 'Harmonic minor starting on the fifth. The Hijaz color in twelve tones.',
  hungarianMinor: 'Minor with a raised fourth and seventh. A Gypsy minor.',
  insen: 'A Japanese In scale. Dark, with no third.',
}

const registry = new Map<string, ScaleSpec>()

function builtinSpecs(): ScaleSpec[] {
  return SCALES.map((scale) => ({
    id: scale.id,
    name: scale.name,
    family: FAMILY[scale.id] ?? 'western',
    cents: scale.intervals.map((interval) => interval * 100),
    description: ABOUT[scale.id] ?? scale.name,
  }))
}

for (const scale of builtinSpecs()) registry.set(scale.id, scale)

export function registerScales(list: ScaleSpec[]) {
  for (const scale of list) {
    if (!scale.id || registry.has(scale.id)) continue
    const cents = [...scale.cents].map((value) => mod1200(value)).filter((value, index, all) => all.indexOf(value) === index).sort((a, b) => a - b)
    if (!cents.length) continue
    registry.set(scale.id, { ...scale, cents })
  }
}

export function allScales(): ScaleSpec[] {
  const order = new Map(FAMILY_INFO.map((family, index) => [family.id, index]))
  return [...registry.values()].sort((a, b) => (order.get(a.family) ?? 99) - (order.get(b.family) ?? 99) || a.name.localeCompare(b.name))
}

export function findScale(id: string | undefined | null): ScaleSpec | null {
  if (!id) return null
  return registry.get(id) ?? null
}

/** Always returns a scale. Unknown ids fall back to major. */
export function getScale(id: string | undefined | null): ScaleSpec {
  return findScale(id) ?? registry.get('ionian')!
}

export function scaleFamilies() {
  const present = new Set(allScales().map((scale) => scale.family))
  return FAMILY_INFO.filter((family) => present.has(family.id))
}

export function isTwelveTone(spec: ScaleSpec) {
  return spec.cents.every((cents) => Math.abs(cents - Math.round(cents / 100) * 100) < 0.6)
}

export function scalesInFamily(family: string) {
  return allScales().filter((scale) => scale.family === family)
}

/** Scale tones in one octave, starting at MIDI octave 4 when `octave` is 4. */
export function spellScale(rootPc: number, scaleId: string, octave = 4): Tone[] {
  const spec = getScale(scaleId)
  const tonic = (octave + 1) * 12 + mod(Math.round(rootPc), 12)
  return spec.cents.map((cents) => {
    const tone = toneFromCents(tonic * 100 + cents)
    return { midi: clampMidi(tone.midi), cents: tone.cents }
  })
}

export function nearestDegree(relativeCents: number, scaleCents: readonly number[]) {
  let best = 0
  let dist = 1200
  for (const step of scaleCents) {
    const delta = centDistance(relativeCents, step)
    if (delta < dist) {
      dist = delta
      best = step
    }
  }
  return { cents: best, distance: dist }
}

/** True when the sounding pitch is within `tolerance` cents of a scale degree. */
export function toneInScale(midi: number, cents: number, rootPc: number, scaleId: string, tolerance = 15) {
  const spec = findScale(scaleId)
  if (!spec) return false
  const relative = mod1200((midi - mod(Math.round(rootPc), 12)) * 100 + cents)
  return nearestDegree(relative, spec.cents).distance <= tolerance
}

/**
 * Nearest scale degree. Ties resolve downward so a leading tone falls to the chord tone below.
 * Quarter-tone degrees come back as a MIDI note plus a cent offset.
 */
export function snapToScale(midi: number, cents: number, rootPc: number, scaleId: string): Tone {
  const spec = getScale(scaleId)
  const target = Math.round(midi) * 100 + (cents || 0)
  const root = mod(Math.round(rootPc), 12)
  const center = Math.round(Math.round(midi) / 12) * 12 + root
  let bestAbs = target
  let bestDist = Infinity
  for (let oct = -3; oct <= 3; oct++) {
    const tonic = (center + oct * 12) * 100
    for (const degree of spec.cents) {
      const abs = tonic + degree
      const dist = Math.abs(abs - target)
      if (dist < bestDist - 0.01 || (Math.abs(dist - bestDist) <= 0.01 && abs < bestAbs)) {
        bestDist = dist
        bestAbs = abs
      }
    }
  }
  const tone = toneFromCents(bestAbs)
  return { midi: clampMidi(tone.midi), cents: tone.cents }
}

/** One scale degree, wrapped through octaves the way the pad grid counts. */
export function degreeTone(rootPc: number, degreeIndex: number, scaleId: string): Tone {
  const spec = getScale(scaleId)
  const span = spec.cents.length || 1
  const base = rootPc > 11 ? clampMidi(rootPc) : 60 + mod(Math.round(rootPc), 12)
  const oct = Math.floor(degreeIndex / span)
  const step = mod(degreeIndex, span)
  const tone = toneFromCents((base + oct * 12) * 100 + spec.cents[step])
  return { midi: clampMidi(tone.midi), cents: tone.cents }
}

export function rotateCents(cents: readonly number[], index: number) {
  const tonic = cents[index] ?? 0
  return cents.map((value) => mod1200(value - tonic)).sort((a, b) => a - b)
}
