import { SCALES } from '../../model/scale'
import { detectScale, getScale, harmonize, nearestDegree, NOTE_NAMES, spellChord } from '../../theory'
import type { ScaleSpec, Tone } from '../../theory'
import type { ScalerNote } from './types'

export interface Mood {
  /** -1 is dark and tense, 1 is bright and lifting. */
  score: number
  word: 'Bright' | 'Mixed' | 'Dark'
  feel: 'Uplifting' | 'Mixed' | 'Tense'
}

export interface DetectedScale {
  root: number
  scaleId: string
  name: string
  style: string
  mode: string
  notes: string
  chords: string
}

const STYLE: Record<string, string> = {
  ionian: 'Happy, Light, Bright, Positive',
  dorian: 'Warm, Modal, Hopeful',
  phrygian: 'Exotic, Dark, Tense',
  lydian: 'Hopeful, Dreamy, Yearning, Ethereal',
  mixolydian: 'Positive, Bluesy, Rocky, Poppy',
  aeolian: 'Serious, Sad, Emotional, Sentimental',
  locrian: 'Unstable, Dark, Tense',
  harmonicMinor: 'Dramatic, Dark, Yearning',
  melodicMinor: 'Jazz, Bright minor, Lifting',
  majorPentatonic: 'Open, Bright, Simple',
  minorPentatonic: 'Bluesy, Gritty, Direct',
  blues: 'Gritty, Vocal, Blue',
  wholeTone: 'Dreamy, Floating, Unresolved',
  phrygianDominant: 'Exotic, Tense, Bright edge',
}

const MODE: Record<string, string> = {
  ionian: 'Major 1st',
  dorian: 'Major 2nd',
  phrygian: 'Major 3rd',
  lydian: 'Major 4th',
  mixolydian: 'Major 5th',
  aeolian: 'Major 6th',
  locrian: 'Major 7th',
}

const OFFSET: Record<string, number> = {
  ionian: 0,
  dorian: 2,
  phrygian: 4,
  lydian: 5,
  mixolydian: 7,
  aeolian: 9,
  locrian: 11,
}

const CHURCH = ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian'] as const

/** Circle of fifths, clockwise from C. */
export const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]

function scaleBias(scaleId: string) {
  const id = scaleId.toLowerCase()
  if (id === 'mixolydian') return 0.08
  if (id === 'phrygiandominant') return -0.05
  if (id === 'ionian' || id === 'lydian' || id === 'majorpentatonic' || id === 'melodicminor') return 0.16
  if (id === 'aeolian' || id === 'phrygian' || id === 'locrian' || id === 'harmonicminor' || id === 'minorpentatonic' || id === 'blues') return -0.22
  if (id.includes('minor') && !id.includes('melodic')) return -0.12
  if (id.includes('major') || (id.includes('lydian') && !id.includes('mixo'))) return 0.1
  return 0
}

export function moodOf(symbol: string, scaleId: string): Mood {
  const suffix = symbol.replace(/^[A-G](?:#|b)?/u, '').toLowerCase()
  let score = 0.05
  if (/dim|ø|m7b5|mb5/.test(suffix)) score -= 0.75
  else if (/aug|\+/.test(suffix)) score -= 0.25
  else if (/min|^m(?!aj)/.test(suffix)) score -= 0.5
  else if (/maj|^$/.test(suffix) || suffix === '') score += 0.62
  else if (/add|6/.test(suffix)) score += 0.45
  else if (/sus/.test(suffix)) score += 0.08
  else if (/7|9|11|13/.test(suffix)) score += 0.12
  score += scaleBias(scaleId)
  score = Math.max(-1, Math.min(1, score))
  const word = score > 0.18 ? 'Bright' : score < -0.18 ? 'Dark' : 'Mixed'
  const feel = score > 0.12 ? 'Uplifting' : score < -0.12 ? 'Tense' : 'Mixed'
  return { score, word, feel }
}

export function progressionMood(symbols: string[], scaleId: string): Mood {
  if (!symbols.length) return moodOf('', scaleId)
  const score = symbols.reduce((sum, symbol) => sum + moodOf(symbol, scaleId).score, 0) / symbols.length
  const word = score > 0.18 ? 'Bright' : score < -0.18 ? 'Dark' : 'Mixed'
  const feel = score > 0.12 ? 'Uplifting' : score < -0.12 ? 'Tense' : 'Mixed'
  return { score, word, feel }
}

export function qualityLabel(symbol: string, roman: string) {
  const suffix = symbol.replace(/^[A-G](?:#|b)?/u, '')
  return `${roman} ${suffix || 'M'}`.trim()
}

export interface ModChord {
  label: string
  symbol: string
  roman: string
  root: number
  scaleId: string
  /** Choosing this chord moves the track into its key. */
  adopt: boolean
  tones: Tone[]
}

/** Still holds back, Animando spreads the notes, Push leans in. */
export function expressNotes(notes: ScalerNote[], expression: number): ScalerNote[] {
  return notes.map((note, index) => {
    let velocity = note.velocity
    let startBeat = note.startBeat
    let durationBeats = note.durationBeats
    if (expression <= 0) velocity *= 0.86
    else if (expression === 1) {
      startBeat += index * 0.03
      velocity *= 0.92 + Math.min(0.16, index * 0.04)
    } else {
      velocity *= 1.12
      durationBeats *= 0.82
    }
    return {
      ...note,
      startBeat: Math.max(0, startBeat),
      durationBeats: Math.max(0.05, durationBeats),
      velocity: Math.min(1, Math.max(0.05, velocity)),
    }
  })
}

export function detectedScales(notes: { midi: number; cents?: number }[], root: number, scaleId: string): DetectedScale[] {
  if (notes.length >= 3) {
    const ranked = detectScale(notes.map((note) => ({ midi: note.midi, cents: note.cents, weight: 1 })), builtinSpecs())
    const seen = new Set<string>()
    const top: { root: number; scaleId: string }[] = []
    for (const row of ranked) {
      const key = `${row.root}:${row.scaleId}`
      if (seen.has(key)) continue
      seen.add(key)
      top.push({ root: row.root, scaleId: row.scaleId })
      if (top.length === 5) break
    }
    return top.map((row) => describe(row.root, row.scaleId, notes))
  }
  const offset = OFFSET[scaleId] ?? 0
  const parent = (root - offset + 12) % 12
  return CHURCH.map((id) => describe((parent + OFFSET[id]) % 12, id, notes))
}

export function modulationChords(kind: 'secondary' | 'parallel' | 'mediant', homeRoot: number, homeScaleId: string, destRoot = (homeRoot + 7) % 12): ModChord[] {
  if (kind === 'secondary') return secondaryPathway(homeRoot, homeScaleId, destRoot)
  if (kind === 'parallel') return parallelChords(homeRoot, homeScaleId)
  return mediantChords(homeRoot)
}

function describe(root: number, scaleId: string, notes: { midi: number; cents?: number }[]): DetectedScale {
  const spec = getScale(scaleId)
  const classes = [...new Set(notes.map((note) => ((note.midi % 12) + 12) % 12))]
  let fit = 0
  for (const pc of classes) {
    const relative = ((pc - root + 12) % 12) * 100
    if (nearestDegree(relative, spec.cents).distance <= 50) fit += 1
  }
  const diatonic = harmonize(root, scaleId, 3)
  const hit = diatonic.filter((chord) => classes.includes(((chord.tones[0]?.midi ?? 0) % 12 + 12) % 12)).length
  const noteDen = Math.max(1, Math.min(8, classes.length || spec.cents.length))
  const noteNum = classes.length ? Math.min(noteDen, fit) : Math.min(noteDen, spec.cents.length)
  const chordDen = Math.max(1, Math.min(4, diatonic.length))
  const chordNum = classes.length ? Math.min(chordDen, hit) : Math.min(chordDen, diatonic.length)
  return {
    root,
    scaleId,
    name: spec.name,
    style: STYLE[scaleId] ?? spec.description,
    mode: MODE[scaleId] ?? spec.name,
    notes: `${noteNum}/${noteDen}`,
    chords: `${chordNum}/${chordDen}`,
  }
}

function fromDiatonic(chord: { symbol: string; roman: string; tones: Tone[] }, root: number, scaleId: string, adopt: boolean, label = chord.roman): ModChord {
  return { label, symbol: chord.symbol, roman: chord.roman, root, scaleId, adopt, tones: chord.tones }
}

function secondaryPathway(homeRoot: number, homeScaleId: string, destRoot: number): ModChord[] {
  const home = harmonize(homeRoot, homeScaleId, 3)
  const destScale = thirdIsMinor(homeScaleId) ? 'aeolian' : 'ionian'
  const dest = harmonize(destRoot, destScale, 3)
  const fifthUp = (homeRoot + 7) % 12 === destRoot
  const pivotDegrees = fifthUp && home.length >= 7 ? (thirdIsMinor(homeScaleId) ? [0, 3, 4] : [5, 4, 2, 0]) : [0]
  const pivots = pivotDegrees
    .map((index) => home[index])
    .filter((chord): chord is (typeof home)[number] => !!chord)
    .map((chord) => fromDiatonic(chord, homeRoot, homeScaleId, false))
  const dominantPc = (destRoot + 7) % 12
  const dominant = spellChord(dominantPc, '7')
  const destination = dest.map((chord, index) => fromDiatonic(chord, destRoot, destScale, true, index === 0 ? `${NOTE_NAMES[destRoot]} key` : chord.roman))
  return [
    ...pivots,
    { label: 'V7', symbol: dominant.symbol, roman: 'V7', root: destRoot, scaleId: destScale, adopt: false, tones: dominant.tones },
    ...destination,
  ]
}

function parallelChords(homeRoot: number, homeScaleId: string): ModChord[] {
  const other = thirdIsMinor(homeScaleId) ? 'ionian' : 'aeolian'
  return harmonize(homeRoot, other, 3).map((chord) => fromDiatonic(chord, homeRoot, other, false))
}

/** Both qualities a minor third and a major third above and below the tonic. */
function mediantChords(homeRoot: number): ModChord[] {
  const steps = [
    { semi: 8, scaleId: 'aeolian' },
    { semi: 8, scaleId: 'ionian' },
    { semi: 9, scaleId: 'aeolian' },
    { semi: 9, scaleId: 'ionian' },
    { semi: 3, scaleId: 'aeolian' },
    { semi: 3, scaleId: 'ionian' },
    { semi: 4, scaleId: 'aeolian' },
    { semi: 4, scaleId: 'ionian' },
  ]
  return steps.flatMap((step) => {
    const root = (homeRoot + step.semi) % 12
    const chord = harmonize(root, step.scaleId, 3)[0]
    return chord ? [fromDiatonic(chord, root, step.scaleId, true, NOTE_NAMES[root])] : []
  })
}

function builtinSpecs(): ScaleSpec[] {
  return SCALES.map((scale) => getScale(scale.id))
}

function thirdIsMinor(scaleId: string) {
  const third = getScale(scaleId).cents.find((cents) => cents >= 250 && cents <= 450) ?? 400
  return Math.abs(third - 300) <= Math.abs(third - 400)
}
