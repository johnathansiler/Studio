import { SCALES } from '../../model/scale'
import { harmonize, nearestDegree, getScale, NOTE_NAMES } from '../../theory'
import type { ScaleSpec } from '../../theory'

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

export function moodOf(symbol: string, scaleId: string): Mood {
  const suffix = symbol.replace(/^[A-G](?:#|b)?/u, '').toLowerCase()
  let score = 0.05
  if (/dim|ø|m7b5|mb5/.test(suffix)) score -= 0.75
  else if (/aug|\+/.test(suffix)) score -= 0.25
  else if (/min|^m(?!aj)/.test(suffix)) score -= 0.5
  else if (/maj|add|6|sus2|^$/.test(suffix) || suffix === '') score += 0.62
  else if (/7/.test(suffix)) score += 0.12
  else if (/sus/.test(suffix)) score += 0.05
  const id = scaleId.toLowerCase()
  if (/aeolian|phrygian|locrian|harmonicminor|minorpent|blues/.test(id)) score -= 0.22
  if (/ionian|lydian|majorpent|melodicminor/.test(id)) score += 0.16
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

export function detectedScales(notes: { midi: number; cents?: number }[], root: number, scaleId: string): DetectedScale[] {
  const pool = new Map(builtinSpecs().map((scale) => [scale.id, scale]))
  if (notes.length >= 3) {
    const ranked = rank(notes, [...pool.values()])
    return ranked.slice(0, 5).map((row) => describe(row.root, row.scaleId, notes))
  }
  const offset = OFFSET[scaleId] ?? 0
  const parent = (root - offset + 12) % 12
  return CHURCH.map((id) => describe((parent + OFFSET[id]) % 12, id, notes))
}

export function modulationChords(kind: 'secondary' | 'parallel' | 'mediant', root: number, scaleId: string) {
  if (kind === 'secondary') {
    const target = (root + 7) % 12
    return [
      { label: NOTE_NAMES[root], root, scaleId },
      { label: `${NOTE_NAMES[target]} dominant`, root: target, scaleId: 'mixolydian' },
      { label: `${NOTE_NAMES[target]} major`, root: target, scaleId: 'ionian' },
    ]
  }
  if (kind === 'parallel') {
    const minor = thirdIsMinor(scaleId) ? 'ionian' : 'aeolian'
    return [0, 5, 8, 10].map((step) => ({
      label: NOTE_NAMES[(root + step) % 12],
      root,
      scaleId: step === 0 ? scaleId : minor,
      degree: step,
    }))
  }
  return [3, 4, 8, 9].map((step) => ({
    label: NOTE_NAMES[(root + step) % 12],
    root: (root + step) % 12,
    scaleId: step === 3 || step === 8 ? 'aeolian' : 'ionian',
  }))
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

function rank(notes: { midi: number; cents?: number }[], scales: ScaleSpec[]) {
  const rows: { root: number; scaleId: string; score: number }[] = []
  for (const scale of scales) {
    for (let root = 0; root < 12; root++) {
      let score = 0
      for (const note of notes) {
        const relative = ((note.midi - root) * 100 + (note.cents ?? 0) + 12000) % 1200
        score += Math.exp(-(nearestDegree(relative, scale.cents).distance ** 2) / (2 * 40 * 40))
      }
      rows.push({ root, scaleId: scale.id, score })
    }
  }
  rows.sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.root}:${row.scaleId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function builtinSpecs(): ScaleSpec[] {
  return SCALES.map((scale) => getScale(scale.id))
}

function thirdIsMinor(scaleId: string) {
  const third = getScale(scaleId).cents.find((cents) => cents >= 250 && cents <= 450) ?? 400
  return Math.abs(third - 300) <= Math.abs(third - 400)
}
