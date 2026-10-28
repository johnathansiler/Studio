/**
 * Turn an analysis result into the roman-numeral SongContext Unstuck reads.
 * Chord symbols arrive spelled (`Am`, `G7`, `Am/G`). Section kinds arrive
 * as `prechorus` and the like.
 */

import type { AnalysisResult, AnalysisSection } from '../analysis/types'
import type { Mode, SectionKind, SongSection } from './types'
import { modeOfScale, romanFor } from './theory'

const SPELL: [string, number][] = [
  ['C#', 1], ['Db', 1], ['D#', 3], ['Eb', 3], ['F#', 6], ['Gb', 6],
  ['G#', 8], ['Ab', 8], ['A#', 10], ['Bb', 10],
  ['C', 0], ['D', 2], ['E', 4], ['F', 5], ['G', 7], ['A', 9], ['B', 11],
]

const QUALITY: [string, number[]][] = [
  ['m7b5', [0, 3, 6, 10]],
  ['dim7', [0, 3, 6, 9]],
  ['mmaj7', [0, 3, 7, 11]],
  ['maj7', [0, 4, 7, 11]],
  ['m7', [0, 3, 7, 10]],
  ['sus2', [0, 2, 7]],
  ['sus4', [0, 5, 7]],
  ['aug', [0, 4, 8]],
  ['dim', [0, 3, 6]],
  ['m', [0, 3, 7]],
  ['7', [0, 4, 7, 10]],
]

/** Spelled chord, or a slash chord, as a roman numeral in `key`. `Am/G` is the Am. */
export function spellToRoman(symbol: string, key: number, mode: Mode): string {
  const text = symbol.trim()
  if (!text) return ''
  if (isRoman(text)) return text
  const head = text.split('/')[0]?.trim() ?? ''
  const parsed = parseSpelled(head)
  if (!parsed) return ''
  return romanFor(parsed.root, parsed.intervals, ((key % 12) + 12) % 12, mode)
}

/** `prechorus` and `post chorus` become the kinds the section model uses. A bare `section` is a verse. */
export function normalizeSectionKind(kind: string, label = ''): SectionKind {
  const text = `${kind} ${label}`.toLowerCase().replace(/_/g, ' ')
  if (/pre[-\s]?chorus/.test(text)) return 'pre-chorus'
  if (/post[-\s]?chorus/.test(text)) return 'post-chorus'
  if (/break/.test(text)) return 'breakdown'
  if (/chorus/.test(text)) return 'chorus'
  if (/bridge/.test(text)) return 'bridge'
  if (/drop/.test(text)) return 'drop'
  if (/intro/.test(text)) return 'intro'
  if (/outro|ending/.test(text)) return 'outro'
  if (/verse/.test(text)) return 'verse'
  return 'verse'
}

export function analysisMode(result: AnalysisResult): Mode {
  const named = result.key.mode.toLowerCase()
  if (named === 'major' || named === 'minor') return named
  return modeOfScale(result.scale || named)
}

export function sectionsFromAnalysis(sections: AnalysisSection[]): SongSection[] {
  return sections
    .map((section) => ({
      kind: normalizeSectionKind(section.kind, section.label),
      startBar: Math.max(0, section.startBar),
      bars: Math.max(1, section.endBar - section.startBar),
    }))
    .filter((section) => section.bars > 0)
}

export function analysisHasMusic(result: AnalysisResult): boolean {
  return result.chordsByBar.length > 0 || result.sections.length > 0
}

/** Prefer a reading that has chords. A sections-only reading still counts when nothing else does. */
export function pickAnalysis(results: readonly AnalysisResult[]): AnalysisResult | null {
  const usable = results.filter(analysisHasMusic)
  if (!usable.length) return null
  const withChords = usable.filter((result) => result.chordsByBar.length > 0)
  const pool = withChords.length ? withChords : usable
  return [...pool].sort((a, b) => analysisScore(b) - analysisScore(a))[0]
}

/** Longest section list remembered anywhere, including a result that is not the chord source. */
export function sharedSections(results: readonly AnalysisResult[]): SongSection[] {
  let best: AnalysisSection[] = []
  for (const result of results) {
    if (result.sections.length > best.length) best = result.sections
  }
  return sectionsFromAnalysis(best)
}

function analysisScore(result: AnalysisResult): number {
  return result.chordsByBar.length * 4 + result.sections.length
}

function parseSpelled(symbol: string): { root: number; intervals: number[] } | null {
  const match = SPELL.find(([name]) => symbol.startsWith(name) || symbol.toLowerCase().startsWith(name.toLowerCase()))
  if (!match) return null
  const rest = symbol.slice(match[0].length).toLowerCase()
  const quality = QUALITY.find(([name]) => rest.startsWith(name))
  return { root: match[1], intervals: quality ? quality[1] : [0, 4, 7] }
}

function isRoman(symbol: string): boolean {
  return /^[#b]*(i{1,3}|iv|vi{0,3}|v)/i.test(symbol)
}
