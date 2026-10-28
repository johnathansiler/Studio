/** Local harmony: roman numerals, transition weights, and one-line reasons. No network. */

import type { Mode } from '../model/progressions'
import { pitchClass } from '../model/scale'
import type { SectionKind } from './types'

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]
const DEGREE = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']

const TEMPLATES: { id: string; intervals: number[] }[] = [
  { id: 'maj7', intervals: [0, 4, 7, 11] },
  { id: '7', intervals: [0, 4, 7, 10] },
  { id: 'm7', intervals: [0, 3, 7, 10] },
  { id: 'm7b5', intervals: [0, 3, 6, 10] },
  { id: 'dim7', intervals: [0, 3, 6, 9] },
  { id: 'maj', intervals: [0, 4, 7] },
  { id: 'min', intervals: [0, 3, 7] },
  { id: 'dim', intervals: [0, 3, 6] },
  { id: 'aug', intervals: [0, 4, 8] },
  { id: 'sus4', intervals: [0, 5, 7] },
  { id: 'sus2', intervals: [0, 2, 7] },
]

/** Unnormalized P(next | current). Case is the quality: iv is minor, IV is major. */
const MAJOR_NEXT: Record<string, [string, number][]> = {
  I: [['V', 5], ['IV', 4], ['vi', 4], ['ii', 2], ['bVII', 2], ['iii', 1]],
  ii: [['V', 6], ['IV', 1], ['vi', 1]],
  iii: [['vi', 4], ['IV', 2], ['ii', 1]],
  IV: [['V', 4], ['I', 3], ['vi', 2], ['iv', 2]],
  V: [['I', 6], ['vi', 3], ['IV', 1]],
  vi: [['IV', 4], ['ii', 2], ['V', 2], ['I', 1]],
  vii: [['I', 3], ['V', 2]],
  iv: [['I', 4], ['bVII', 2], ['V', 1]],
  bVII: [['IV', 3], ['I', 3]],
  bVI: [['bVII', 3], ['iv', 2], ['I', 1]],
  bIII: [['bVI', 2], ['IV', 2], ['I', 1]],
  bII: [['I', 2], ['V', 2]],
}

const MINOR_NEXT: Record<string, [string, number][]> = {
  i: [['VI', 4], ['VII', 3], ['iv', 3], ['III', 2], ['V', 2], ['v', 2]],
  ii: [['V', 4], ['v', 2]],
  III: [['VII', 3], ['VI', 2], ['iv', 2]],
  iv: [['i', 3], ['VII', 3], ['V', 2], ['v', 1]],
  v: [['i', 3], ['VI', 2]],
  V: [['i', 6], ['VI', 1]],
  VI: [['III', 3], ['VII', 3], ['iv', 2], ['i', 1]],
  VII: [['i', 4], ['VI', 2], ['III', 1]],
  bII: [['i', 2], ['V', 2]],
}

/** P(next section | current). The heaviest edge is the usual pop form. */
const NEXT_SECTION: Record<SectionKind, [SectionKind, number][]> = {
  intro: [['verse', 5], ['chorus', 2], ['drop', 1]],
  verse: [['pre-chorus', 4], ['chorus', 4], ['bridge', 1]],
  'pre-chorus': [['chorus', 6], ['drop', 2]],
  chorus: [['verse', 3], ['bridge', 3], ['drop', 2], ['outro', 1]],
  'post-chorus': [['verse', 4], ['chorus', 2]],
  bridge: [['chorus', 5], ['verse', 2], ['outro', 1]],
  drop: [['breakdown', 4], ['chorus', 3], ['verse', 1]],
  breakdown: [['drop', 3], ['chorus', 3], ['verse', 2]],
  outro: [['chorus', 1]],
}

const MAJOR_SECTIONS: Record<SectionKind, string[]> = {
  intro: ['I', 'V'],
  verse: ['I', 'vi', 'IV', 'V'],
  'pre-chorus': ['vi', 'IV', 'I', 'V'],
  chorus: ['I', 'V', 'vi', 'IV'],
  'post-chorus': ['IV', 'V', 'I'],
  bridge: ['vi', 'IV', 'ii', 'V'],
  drop: ['vi', 'IV'],
  breakdown: ['I', 'IV'],
  outro: ['IV', 'I'],
}

const MAJOR_SECTION_ALT: Record<SectionKind, string[]> = {
  intro: ['I', 'IV'],
  verse: ['I', 'IV', 'vi', 'V'],
  'pre-chorus': ['ii', 'V', 'vi', 'V'],
  chorus: ['IV', 'V', 'iii', 'vi'],
  'post-chorus': ['vi', 'IV', 'V'],
  bridge: ['iii', 'vi', 'ii', 'V'],
  drop: ['I', 'bVII'],
  breakdown: ['vi', 'IV'],
  outro: ['I', 'V', 'I'],
}

const MINOR_SECTIONS: Record<SectionKind, string[]> = {
  intro: ['i', 'VII'],
  verse: ['i', 'VI', 'III', 'VII'],
  'pre-chorus': ['VI', 'III', 'VII', 'v'],
  chorus: ['i', 'VI', 'III', 'VII'],
  'post-chorus': ['VI', 'VII', 'i'],
  bridge: ['iv', 'VI', 'V', 'i'],
  drop: ['i', 'VII'],
  breakdown: ['i', 'iv'],
  outro: ['iv', 'i'],
}

const MINOR_SECTION_ALT: Record<SectionKind, string[]> = {
  intro: ['i', 'v'],
  verse: ['i', 'iv', 'VI', 'VII'],
  'pre-chorus': ['iv', 'VI', 'VII', 'V'],
  chorus: ['VI', 'VII', 'i', 'V'],
  'post-chorus': ['VII', 'VI', 'i'],
  bridge: ['bII', 'V', 'i', 'V'],
  drop: ['i', 'VI'],
  breakdown: ['i', 'VII'],
  outro: ['i', 'V', 'i'],
}

const MOVE_WHY: Record<string, string> = {
  'I>V': 'V leans forward and asks the phrase to resolve.',
  'I>IV': 'IV keeps two notes of I and opens the phrase.',
  'I>vi': 'vi shares the tonic note, so the color softens without a jump.',
  'I>ii': 'ii steps away from I and points toward V.',
  'I>bVII': 'bVII drops the seventh and keeps the loop from feeling finished.',
  'I>iii': 'iii keeps the tonic note and moves the bass.',
  'ii>V': 'ii prepares V, the cadence that wants the tonic.',
  'iii>vi': 'vi catches iii by stepping down a third.',
  'IV>V': 'IV rises to V, the usual lift into a cadence.',
  'IV>I': 'IV falls back to I, a plagal ending.',
  'IV>iv': 'iv borrows the minor four and darkens the major key.',
  'IV>vi': 'vi answers IV and delays the tonic.',
  'V>I': 'V resolves to I, the cadence that feels like home.',
  'V>vi': 'V goes to vi instead of I, a deceptive turn.',
  'V>i': 'Major V resolves to i.',
  'vi>IV': 'IV lifts vi without giving the tonic away yet.',
  'vi>V': 'V takes over from vi and aims the phrase home.',
  'vi>ii': 'ii follows vi down a fifth and heads for V.',
  'iv>I': 'The borrowed iv still resolves to I.',
  'iv>i': 'iv falls back to i without a dominant.',
  'iv>V': 'iv rises to a major V so the minor key can cadence.',
  'iv>VII': 'VII pushes iv back toward i.',
  'bVII>I': 'bVII shares a tone with V, so it can still fall to I.',
  'bVII>IV': 'bVII steps down into IV and stays open.',
  'bVI>bVII': 'bVI climbs to bVII, the flat side of the key.',
  'i>VI': 'VI is the major color inside the minor loop.',
  'i>VII': 'VII keeps the minor loop moving without a leading tone.',
  'i>iv': 'iv answers i the way IV answers I.',
  'i>III': 'III is the relative major, a brighter color on i.',
  'i>V': 'The major V is the leading-tone cadence back to i.',
  'i>v': 'Minor v stays inside the key and still points at i.',
  'VI>III': 'III follows VI down a fifth.',
  'VI>VII': 'VI rises to VII, the minor loop\'s climb.',
  'III>VII': 'VII takes III around the minor loop.',
  'VII>i': 'VII drops back to i.',
  'V>VI': 'V resolves to VI, the brighter minor chord.',
}

const SECTION_WHY: Record<string, string> = {
  'intro>verse': 'The intro hands the first statement to a verse.',
  'intro>chorus': 'Starting on the chorus states the hook before the verse.',
  'intro>drop': 'A short intro can fall straight into the drop.',
  'verse>pre-chorus': 'A verse usually climbs into a pre-chorus that ends on the dominant.',
  'verse>chorus': 'The chorus can answer the verse with a more open loop.',
  'verse>bridge': 'A bridge leaves the verse loop before the chorus returns.',
  'pre-chorus>chorus': 'The pre-chorus is built to land on the chorus.',
  'pre-chorus>drop': 'Holding the tension lets the drop feel empty and big.',
  'chorus>verse': 'After the chorus, a verse brings the line back down.',
  'chorus>bridge': 'A bridge changes the chords so the chorus is worth repeating.',
  'chorus>drop': 'A drop strips the chorus down to its hook.',
  'chorus>outro': 'The outro keeps the chorus color and lets it end.',
  'post-chorus>verse': 'The post-chorus hands the song back to a verse.',
  'bridge>chorus': 'The bridge cadences so the chorus can return.',
  'bridge>verse': 'The bridge can fall back into a verse instead of the hook.',
  'drop>breakdown': 'After a drop, a breakdown clears space.',
  'drop>chorus': 'The chorus can return once the drop has landed.',
  'breakdown>drop': 'The breakdown leads back into the drop.',
  'breakdown>chorus': 'The chorus is the way out of a breakdown.',
  'outro>chorus': 'One more chorus can follow the outro tag.',
}

export function modeOfScale(scale: string): Mode {
  const minor = ['aeolian', 'dorian', 'phrygian', 'locrian', 'harmonicMinor', 'melodicMinor', 'minorPentatonic', 'blues', 'phrygianDominant', 'hungarianMinor', 'hirajoshi', 'insen', 'minor']
  return minor.includes(scale) ? 'minor' : 'major'
}

export function scaleForMode(mode: Mode): string {
  return mode === 'minor' ? 'aeolian' : 'ionian'
}

export function degreeKey(symbol: string): string {
  const stripped = symbol.trim().replace(/maj9|maj7|m7b5|add9|sus4|sus2|sus|dim7|dim|°7|°|7|9|6/gi, '')
  return stripped || (symbol === symbol.toLowerCase() ? 'i' : 'I')
}

export function nextWeights(symbol: string, mode: Mode): [string, number][] {
  const table = mode === 'minor' ? MINOR_NEXT : MAJOR_NEXT
  const key = degreeKey(symbol)
  return table[key] ?? table[mode === 'minor' ? 'i' : 'I']
}

export function sectionWeights(kind: SectionKind): [SectionKind, number][] {
  return NEXT_SECTION[kind] ?? NEXT_SECTION.verse
}

export function sectionSymbols(kind: SectionKind, mode: Mode, recent: string[]): string[] {
  const primary = mode === 'minor' ? MINOR_SECTIONS : MAJOR_SECTIONS
  const alt = mode === 'minor' ? MINOR_SECTION_ALT : MAJOR_SECTION_ALT
  const main = primary[kind]
  if (!sameChords(main, recent)) return main
  return alt[kind]
}

export function sameChords(symbols: string[], recent: string[]): boolean {
  if (!symbols.length || recent.length < symbols.length) return false
  const tail = recent.slice(-symbols.length).map(degreeKey).join('|')
  return tail === symbols.map(degreeKey).join('|')
}

export function tonic(mode: Mode): string {
  return mode === 'minor' ? 'i' : 'I'
}

export function moveWhy(from: string, to: string, mode: Mode): string {
  const key = `${degreeKey(from)}>${degreeKey(to)}`
  const known = MOVE_WHY[key]
  if (known) return known
  if (degreeKey(to) === tonic(mode)) return `${degreeKey(to)} brings the phrase home.`
  return `${degreeKey(to)} follows ${degreeKey(from)} and keeps a common tone with it.`
}

export function progressionWhy(from: string, symbols: string[], mode: Mode): string {
  const home = from || tonic(mode)
  const first = moveWhy(home, symbols[0] || tonic(mode), mode)
  if (symbols.length < 3) return first
  const ending = moveWhy(symbols.at(-2) || home, symbols.at(-1) || tonic(mode), mode)
  if (ending === first) return first
  const line = `${first.replace(/\.$/, '')}, then ${ending.charAt(0).toLowerCase()}${ending.slice(1)}`
  return line.length > 150 ? first : line
}

export function sectionWhy(from: SectionKind, to: SectionKind): string {
  return SECTION_WHY[`${from}>${to}`] ?? `A ${sectionLabel(to)} is a natural next section after a ${sectionLabel(from)}.`
}

export function sectionLabel(kind: SectionKind): string {
  if (kind === 'pre-chorus') return 'pre-chorus'
  if (kind === 'post-chorus') return 'post-chorus'
  return kind
}

export function sectionTitle(kind: SectionKind): string {
  if (kind === 'pre-chorus') return 'Pre-chorus'
  if (kind === 'post-chorus') return 'Post-chorus'
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** Cadence bonus added to the log-weight of a finished path. */
export function cadenceScore(symbols: string[], mode: Mode): number {
  const prev = degreeKey(symbols.at(-2) || '')
  const last = degreeKey(symbols.at(-1) || '')
  const home = tonic(mode)
  if ((prev === 'V' || prev === 'v') && last === home) return 1.3
  if (prev === 'IV' && last === home) return 0.7
  if (prev === 'iv' && last === home) return 0.85
  if (prev === 'ii' && (last === 'V' || last === 'v')) return 0.45
  if (prev === 'V' && last === 'vi') return 0.65
  if (prev === 'VII' && last === 'i') return 0.7
  if (last === home) return 0.35
  return 0
}

export function chordFromPitches(pitches: number[]): { root: number; intervals: number[] } | null {
  if (!pitches.length) return null
  const pcs = [...new Set(pitches.map(pitchClass))]
  const bass = pitchClass(Math.min(...pitches))
  let best: { root: number; intervals: number[]; score: number } | null = null
  for (const root of pcs) {
    const rel = pcs.map((pc) => (pc - root + 12) % 12).sort((a, b) => a - b)
    for (const template of TEMPLATES) {
      if (template.intervals.length !== rel.length) continue
      if (!template.intervals.every((interval, index) => interval === rel[index])) continue
      const score = template.intervals.length + (root === bass ? 0.5 : 0)
      if (!best || score > best.score) best = { root, intervals: template.intervals, score }
    }
  }
  if (best) return { root: best.root, intervals: best.intervals }
  return { root: bass, intervals: [0] }
}

export function romanFor(root: number, intervals: number[], key: number, mode: Mode): string {
  const rel = (root - key + 12) % 12
  const scale = mode === 'minor' ? MINOR : MAJOR
  const degree = scale.indexOf(rel)
  const set = new Set(intervals)
  const has = (interval: number) => set.has(interval)
  const dim = has(3) && has(6) && !has(7)
  const minorish = dim || (has(3) && !has(4))
  if (degree >= 0) {
    let token = DEGREE[degree]
    if (minorish) token = token.toLowerCase()
    return token + qualitySuffix(intervals)
  }
  const borrowed = borrowedSymbol(rel, minorish, dim)
  if (borrowed) return borrowed + qualitySuffix(intervals).replace('°', '')
  const nearest = nearestDegree(rel, scale)
  let token = DEGREE[nearest]
  if (minorish) token = token.toLowerCase()
  return token
}

export function romanLine(symbols: string[]): string {
  return symbols.join('–')
}

function qualitySuffix(intervals: number[]): string {
  const set = new Set(intervals)
  const has = (interval: number) => set.has(interval)
  if (has(3) && has(6) && has(9)) return 'dim7'
  if (has(3) && has(6) && has(10)) return 'm7b5'
  if (has(3) && has(6) && !has(7)) return '°'
  if (has(4) && has(8) && !has(7)) return 'aug'
  if (has(11) && has(4)) return 'maj7'
  if (has(10) && has(4) && has(7)) return '7'
  if (has(10) && has(3) && has(7)) return '7'
  if (has(5) && has(7) && !has(3) && !has(4)) return 'sus4'
  if (has(2) && has(7) && !has(3) && !has(4)) return 'sus2'
  if (has(9) && has(4) && has(7) && !has(10) && !has(11)) return '6'
  return ''
}

function borrowedSymbol(rel: number, minorish: boolean, dim: boolean): string | null {
  if (dim && rel === 6) return '#iv°'
  if (rel === 1 && !minorish) return 'bII'
  if (rel === 3 && !minorish) return 'bIII'
  if (rel === 5 && minorish) return 'iv'
  if (rel === 8 && !minorish) return 'bVI'
  if (rel === 8 && minorish) return 'bvi'
  if (rel === 10 && !minorish) return 'bVII'
  if (rel === 10 && minorish) return 'bvii'
  return null
}

function nearestDegree(rel: number, scale: number[]): number {
  let best = 0
  let distance = 12
  scale.forEach((interval, index) => {
    const delta = Math.min((rel - interval + 12) % 12, (interval - rel + 12) % 12)
    if (delta < distance) {
      distance = delta
      best = index
    }
  })
  return best
}
