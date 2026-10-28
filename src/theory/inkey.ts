/** Chords that belong to a key: tertian stacks, borrowed color, and genre sets. */

import { nameChord, nameTunedChord } from './chords'
import { spellPitch } from './pitch'
import { scaleById } from './scales'

export type ChordSet =
  | 'triads'
  | 'sevenths'
  | 'ninths'
  | 'sixths'
  | 'sus'
  | 'add'
  | 'jins'
  | 'borrowed'
  | 'secondary'
  | 'pop'
  | 'rnb'
  | 'edm'
  | 'cinematic'
  | 'rock'
  | 'jazz'
  | 'gospel'

export interface KeyChord {
  name: string
  /** 1-based scale degree. 0 when the chord is borrowed or a genre color. */
  degree: number
  pitches: number[]
  /** Cents above the chord root. */
  intervals: number[]
}

const GENRE: Record<'pop' | 'rnb' | 'edm' | 'cinematic' | 'rock' | 'jazz' | 'gospel', number[][]> = {
  pop: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]],
  rnb: [[2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11], [9, 12, 16, 19]],
  edm: [[9, 12, 16], [5, 9, 12], [0, 4, 7], [7, 11, 14]],
  cinematic: [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]],
  rock: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [5, 9, 12]],
  jazz: [[2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11], [9, 12, 16, 19]],
  gospel: [[0, 4, 7], [0, 4, 7, 10], [5, 9, 12], [5, 8, 12]],
}

const JINS: { name: string; cents: number[] }[] = [
  { name: 'rast', cents: [0, 200, 350, 500] },
  { name: 'bayati', cents: [0, 150, 300, 500] },
  { name: 'hijaz', cents: [0, 100, 400, 500] },
  { name: 'nahawand', cents: [0, 200, 300, 500] },
  { name: 'ajam', cents: [0, 200, 400, 500] },
  { name: 'kurd', cents: [0, 100, 300, 500] },
  { name: 'saba', cents: [0, 150, 300, 400] },
  { name: 'sikah', cents: [0, 150, 350] },
]

export function chordsInKey(root: number, scaleId: string, source: ChordSet = 'triads'): KeyChord[] {
  if (source === 'borrowed') return borrowed(root, scaleId)
  if (source === 'secondary') return secondary(root, scaleId)
  if (source === 'sus' || source === 'add') return susOrAdd(root, scaleId, source)
  if (isGenre(source)) return genre(root, source)
  const scale = scaleById(scaleId)
  const count = Math.min(source === 'jins' ? scale.cents.length : 7, scale.cents.length)
  const chords: KeyChord[] = []
  for (let degree = 0; degree < count; degree++) {
    const steps = stepsFor(source, scale.cents.length)
    const intervals = stack(scale.cents, degree, steps)
    const degreeRoot = scale.cents[degree % scale.cents.length]
    const pitches = intervals.map((cents) => 60 + mod(root, 12) + (degreeRoot + cents) / 100)
    chords.push({
      name: label(pitches, intervals, source),
      degree: degree + 1,
      pitches,
      intervals,
    })
  }
  return chords.filter((chord) => chord.name)
}

/** One scale degree, voiced as the requested stack. Degree is 1-based. */
export function chordOnDegree(root: number, scaleId: string, degree: number, source: ChordSet = 'triads'): KeyChord | null {
  const all = chordsInKey(root, scaleId, source === 'borrowed' || source === 'secondary' || isGenre(source) ? 'triads' : source)
  return all[(Math.max(1, degree) - 1) % Math.max(1, all.length)] ?? null
}

export function scaleDegreePitches(root: number, scaleId: string, octave = 4): number[] {
  const scale = scaleById(scaleId)
  const base = (octave + 1) * 12 + mod(root, 12)
  return scale.cents.map((cents) => base + cents / 100)
}

function stepsFor(source: ChordSet, length: number) {
  if (source === 'sevenths') return [0, 2, 4, 6]
  if (source === 'ninths') return [0, 2, 4, 6, 8]
  if (source === 'sixths') return [0, 2, 4, 5]
  if (source === 'jins') return Array.from({ length: Math.min(4, length) }, (_, index) => index)
  return [0, 2, 4]
}

function stack(cents: readonly number[], degree: number, steps: number[]) {
  const len = cents.length
  const rootTone = cents[degree % len]
  return steps.map((step) => {
    const index = degree + step
    const wrapped = ((index % len) + len) % len
    const octaves = Math.floor(index / len)
    let interval = cents[wrapped] + octaves * 1200 - rootTone
    if (interval < 0) interval += 1200
    return interval
  })
}

function label(pitches: number[], intervals: number[], source: ChordSet) {
  if (source === 'jins') {
    const hit = JINS.find((jins) => jins.cents.length === intervals.length && jins.cents.every((cents, index) => Math.abs(cents - intervals[index]) <= 15))
    if (hit) return `${spellPitch(pitches[0])} ${hit.name}`
  }
  if (intervals.some((interval) => interval % 100 !== 0)) return nameTunedChord(pitches)
  return nameChord(pitches.map((pitch) => Math.round(pitch)))
}

function isGenre(source: ChordSet): source is 'pop' | 'rnb' | 'edm' | 'cinematic' | 'rock' | 'jazz' | 'gospel' {
  return ['pop', 'rnb', 'edm', 'cinematic', 'rock', 'jazz', 'gospel'].includes(source)
}

function genre(root: number, source: 'pop' | 'rnb' | 'edm' | 'cinematic' | 'rock' | 'jazz' | 'gospel'): KeyChord[] {
  return GENRE[source].map((intervals) => {
    const pitches = intervals.map((interval) => 60 + mod(root, 12) + interval)
    return { name: nameChord(pitches), degree: 0, pitches, intervals: intervals.map((interval) => (interval % 12) * 100) }
  })
}

function borrowed(root: number, scaleId: string): KeyChord[] {
  const scale = scaleById(scaleId)
  const minorish = scale.cents.some((cents) => cents === 300) && !scale.cents.some((cents) => cents === 400)
  const recipes = minorish
    ? [[0, 4, 7], [5, 9, 12], [7, 11, 14]]
    : [[3, 7, 10], [8, 12, 15], [10, 14, 17], [5, 8, 12], [2, 5, 8]]
  return recipes.map((intervals) => {
    const pitches = intervals.map((interval) => 60 + mod(root, 12) + interval)
    return { name: nameChord(pitches), degree: 0, pitches, intervals: intervals.map((interval) => (interval % 12) * 100) }
  })
}

function secondary(root: number, scaleId: string): KeyChord[] {
  const diatonic = chordsInKey(root, scaleId, 'triads').slice(1, 6)
  return diatonic.map((target) => {
    const lowest = Math.min(...target.pitches)
    const fractional = Math.abs(lowest - Math.round(lowest)) > 0.02
    if (fractional) {
      const pitches = [0, 4, 7, 10].map((interval) => lowest + 7 + interval)
      return { name: nameTunedChord(pitches), degree: 0, pitches, intervals: [0, 400, 700, 1000] }
    }
    const targetRoot = mod(Math.round(lowest), 12)
    const dominantRoot = mod(targetRoot + 7, 12)
    const pitches = [0, 4, 7, 10].map((interval) => 60 + dominantRoot + interval)
    return { name: nameChord(pitches), degree: 0, pitches, intervals: [0, 400, 700, 1000] }
  })
}

function mod(value: number, span: number) {
  return ((value % span) + span) % span
}

/** Sus and add keep absolute recipes: sus alternates sus4/sus2, add stacks a ninth on the triad. */
function susOrAdd(root: number, scaleId: string, source: 'sus' | 'add'): KeyChord[] {
  const scale = scaleById(scaleId)
  const count = Math.min(7, scale.cents.length)
  const chords: KeyChord[] = []
  for (let degree = 0; degree < count; degree++) {
    const degreeRoot = scale.cents[degree % scale.cents.length] / 100
    let semitones: number[]
    if (source === 'sus') semitones = degree % 2 === 0 ? [0, 5, 7] : [0, 2, 7]
    else {
      const triad = stack(scale.cents, degree, [0, 2, 4]).map((cents) => cents / 100)
      semitones = [...triad, 14]
    }
    const pitches = semitones.map((interval) => 60 + mod(root, 12) + degreeRoot + interval)
    const rounded = pitches.every((pitch) => Math.abs(pitch - Math.round(pitch)) < 1e-6)
    chords.push({
      name: rounded ? nameChord(pitches.map((pitch) => Math.round(pitch))) : nameTunedChord(pitches),
      degree: degree + 1,
      pitches,
      intervals: semitones.map((interval) => Math.round(interval * 100)),
    })
  }
  return chords
}
