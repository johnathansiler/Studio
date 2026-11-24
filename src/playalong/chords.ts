/** Chord symbol from the notes that are sounding. Exact pitch-class match, bass in the name. */

import { pitchClassOf, preferFlats, spellPc, type KeySpell } from './names'

interface Template {
  id: string
  suffix: string
  intervals: number[]
}

/** Longer templates first so Am7 wins over Am when the seventh is actually there. */
const TEMPLATES: Template[] = [
  { id: 'maj9', suffix: 'maj9', intervals: [0, 4, 7, 11, 2] },
  { id: 'm9', suffix: 'm9', intervals: [0, 3, 7, 10, 2] },
  { id: '9', suffix: '9', intervals: [0, 4, 7, 10, 2] },
  { id: 'm7b5', suffix: 'm7b5', intervals: [0, 3, 6, 10] },
  { id: 'dim7', suffix: 'dim7', intervals: [0, 3, 6, 9] },
  { id: 'maj7', suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { id: 'm7', suffix: 'm7', intervals: [0, 3, 7, 10] },
  { id: '7', suffix: '7', intervals: [0, 4, 7, 10] },
  { id: 'mMaj7', suffix: 'mMaj7', intervals: [0, 3, 7, 11] },
  { id: '6', suffix: '6', intervals: [0, 4, 7, 9] },
  { id: 'm6', suffix: 'm6', intervals: [0, 3, 7, 9] },
  { id: 'add9', suffix: 'add9', intervals: [0, 4, 7, 2] },
  { id: 'dim', suffix: 'dim', intervals: [0, 3, 6] },
  { id: 'aug', suffix: 'aug', intervals: [0, 4, 8] },
  { id: 'sus4', suffix: 'sus4', intervals: [0, 5, 7] },
  { id: 'sus2', suffix: 'sus2', intervals: [0, 2, 7] },
  { id: 'maj', suffix: '', intervals: [0, 4, 7] },
  { id: 'min', suffix: 'm', intervals: [0, 3, 7] },
  { id: '5', suffix: '5', intervals: [0, 7] },
]

const SCALE_TONES: Record<string, number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
}

export interface NamedChord {
  symbol: string
  root: number
  /** Lowest sounding MIDI note. */
  bass: number
  tones: number[]
}

function sameSet(a: number[], b: number[]) {
  if (a.length !== b.length) return false
  const have = new Set(a)
  return b.every((tone) => have.has(tone))
}

function inScale(root: number, intervals: number[], key: KeySpell) {
  const scale = SCALE_TONES[key.scale] ?? SCALE_TONES.ionian
  const tonic = ((key.root % 12) + 12) % 12
  return intervals.every((interval) => scale.includes((root + interval - tonic + 12) % 12))
}

/**
 * Name the chord the sounding pitches make.
 * One note is not a chord. The bass note is the lowest pitch, and it is written
 * after a slash when it is not the root.
 */
export function nameChord(pitches: number[], key?: KeySpell | null): NamedChord | null {
  const sounding = pitches.filter((pitch) => Number.isFinite(pitch)).map((pitch) => Math.round(pitch))
  if (sounding.length < 2) return null
  const classes = [...new Set(sounding.map(pitchClassOf))]
  if (classes.length < 2) return null
  const bass = Math.min(...sounding)
  const bassPc = pitchClassOf(bass)
  let best: { root: number; template: Template; scale: boolean } | null = null
  for (let root = 0; root < 12; root++) {
    const heard = classes.map((pc) => (pc - root + 12) % 12)
    for (const template of TEMPLATES) {
      if (!sameSet(heard, template.intervals)) continue
      const scale = key ? inScale(root, template.intervals, key) : false
      const better = !best
        || template.intervals.length > best.template.intervals.length
        || (template.intervals.length === best.template.intervals.length && scale && !best.scale)
        || (template.intervals.length === best.template.intervals.length && scale === best.scale && root === bassPc && best.root !== bassPc)
      if (better) best = { root, template, scale }
    }
  }
  if (!best) return null
  const flats = preferFlats(key)
  const rootName = spellPc(best.root, flats)
  const bassName = spellPc(bassPc, flats)
  const slash = bassPc === best.root ? '' : `/${bassName}`
  const low = Math.floor(bass / 12) * 12
  const tones = best.template.intervals.map((interval) => {
    let midi = low + ((best.root + interval) % 12)
    while (midi < bass) midi += 12
    return midi
  })
  if (!tones.includes(bass)) tones.unshift(bass)
  return {
    symbol: `${rootName}${best.template.suffix}${slash}`,
    root: best.root,
    bass,
    tones,
  }
}
