/** Chord qualities. Intervals are cents above the chord root. */

import { NOTE_NAMES, spellPitch, splitTuned } from './pitch'

export type ChordGroup = 'triad' | 'sixth' | 'seventh' | 'added' | 'ninth' | 'eleventh' | 'thirteenth' | 'maqam'

export interface ChordSpec {
  id: string
  name: string
  /** Appended to the root spelling. A leading space marks a word suffix such as " rast". */
  suffix: string
  group: ChordGroup
  cents: readonly number[]
}

export interface SpelledChord {
  id: string
  name: string
  /** MIDI positions, octave placed. Fractional when the chord uses a quarter tone. */
  pitches: number[]
  /** Cents of each note above the chord root. */
  intervals: number[]
  rootMidi: number
}

const CHORD_LIBRARY: ChordSpec[] = [
  { id: 'maj9', name: 'Major 9', suffix: 'maj9', group: 'ninth', cents: [0, 200, 400, 700, 1100] },
  { id: '9', name: 'Dominant 9', suffix: '9', group: 'ninth', cents: [0, 200, 400, 700, 1000] },
  { id: 'm9', name: 'Minor 9', suffix: 'm9', group: 'ninth', cents: [0, 200, 300, 700, 1000] },
  { id: 'm9b5', name: 'Minor 9 flat 5', suffix: 'm9b5', group: 'ninth', cents: [0, 200, 300, 600, 1000] },
  { id: '69', name: '6/9', suffix: '6/9', group: 'ninth', cents: [0, 200, 400, 700, 900] },
  { id: '9sus4', name: '9 sus4', suffix: '9sus4', group: 'ninth', cents: [0, 200, 500, 700, 1000] },
  { id: '7b9', name: '7 flat 9', suffix: '7b9', group: 'ninth', cents: [0, 100, 400, 700, 1000] },
  { id: '7#9', name: '7 sharp 9', suffix: '7#9', group: 'ninth', cents: [0, 300, 400, 700, 1000] },
  { id: 'maj7', name: 'Major 7', suffix: 'maj7', group: 'seventh', cents: [0, 400, 700, 1100] },
  { id: '7', name: 'Dominant 7', suffix: '7', group: 'seventh', cents: [0, 400, 700, 1000] },
  { id: 'm7', name: 'Minor 7', suffix: 'm7', group: 'seventh', cents: [0, 300, 700, 1000] },
  { id: 'm7b5', name: 'Half diminished', suffix: 'm7b5', group: 'seventh', cents: [0, 300, 600, 1000] },
  { id: 'dim7', name: 'Diminished 7', suffix: 'dim7', group: 'seventh', cents: [0, 300, 600, 900] },
  { id: 'mMaj7', name: 'Minor major 7', suffix: 'mMaj7', group: 'seventh', cents: [0, 300, 700, 1100] },
  { id: 'aug7', name: 'Augmented 7', suffix: 'aug7', group: 'seventh', cents: [0, 400, 800, 1000] },
  { id: 'maj7#5', name: 'Major 7 sharp 5', suffix: 'maj7#5', group: 'seventh', cents: [0, 400, 800, 1100] },
  { id: '7b5', name: '7 flat 5', suffix: '7b5', group: 'seventh', cents: [0, 400, 600, 1000] },
  { id: '7#5', name: '7 sharp 5', suffix: '7#5', group: 'seventh', cents: [0, 400, 800, 1000] },
  { id: '7sus4', name: '7 sus4', suffix: '7sus4', group: 'seventh', cents: [0, 500, 700, 1000] },
  { id: 'dimMaj7', name: 'Diminished major 7', suffix: 'dimMaj7', group: 'seventh', cents: [0, 300, 600, 1100] },
  { id: '7#11', name: '7 sharp 11', suffix: '7#11', group: 'eleventh', cents: [0, 400, 600, 700, 1000] },
  { id: '11', name: 'Dominant 11', suffix: '11', group: 'eleventh', cents: [0, 400, 500, 700, 1000, 1400] },
  { id: 'm11', name: 'Minor 11', suffix: 'm11', group: 'eleventh', cents: [0, 300, 500, 700, 1000, 1400] },
  { id: '13', name: 'Dominant 13', suffix: '13', group: 'thirteenth', cents: [0, 400, 700, 900, 1000, 1400] },
  { id: 'maj13', name: 'Major 13', suffix: 'maj13', group: 'thirteenth', cents: [0, 400, 700, 900, 1100, 1400] },
  { id: 'm13', name: 'Minor 13', suffix: 'm13', group: 'thirteenth', cents: [0, 300, 700, 900, 1000, 1400] },
  { id: '7alt', name: 'Altered 7', suffix: 'alt', group: 'seventh', cents: [0, 100, 400, 600, 800, 1000] },
  { id: 'add9', name: 'Add 9', suffix: 'add9', group: 'added', cents: [0, 200, 400, 700] },
  { id: 'madd9', name: 'Minor add 9', suffix: 'madd9', group: 'added', cents: [0, 200, 300, 700] },
  { id: 'add11', name: 'Add 11', suffix: 'add11', group: 'added', cents: [0, 400, 500, 700] },
  { id: '6', name: 'Major 6', suffix: '6', group: 'sixth', cents: [0, 400, 700, 900] },
  { id: 'm6', name: 'Minor 6', suffix: 'm6', group: 'sixth', cents: [0, 300, 700, 900] },
  { id: 'aug', name: 'Augmented', suffix: 'aug', group: 'triad', cents: [0, 400, 800] },
  { id: 'dim', name: 'Diminished', suffix: 'dim', group: 'triad', cents: [0, 300, 600] },
  { id: 'sus2', name: 'Sus 2', suffix: 'sus2', group: 'triad', cents: [0, 200, 700] },
  { id: 'sus4', name: 'Sus 4', suffix: 'sus4', group: 'triad', cents: [0, 500, 700] },
  { id: '5', name: 'Power', suffix: '5', group: 'triad', cents: [0, 700] },
  { id: 'maj', name: 'Major', suffix: '', group: 'triad', cents: [0, 400, 700] },
  { id: 'min', name: 'Minor', suffix: 'm', group: 'triad', cents: [0, 300, 700] },
  { id: 'rast', name: 'Rast', suffix: ' rast', group: 'maqam', cents: [0, 350, 700] },
  { id: 'bayati', name: 'Bayati', suffix: ' bayati', group: 'maqam', cents: [0, 150, 300, 500] },
  { id: 'sikah', name: 'Sikah', suffix: ' sikah', group: 'maqam', cents: [0, 150, 350] },
  { id: 'hijaz', name: 'Hijaz', suffix: ' hijaz', group: 'maqam', cents: [0, 100, 400, 500] },
  { id: 'saba', name: 'Saba', suffix: ' saba', group: 'maqam', cents: [0, 150, 300, 400] },
  { id: 'ajam', name: 'Ajam', suffix: ' ajam', group: 'maqam', cents: [0, 200, 400, 500] },
  { id: 'kurd', name: 'Kurd', suffix: ' kurd', group: 'maqam', cents: [0, 100, 300, 500] },
  { id: 'nahawand', name: 'Nahawand', suffix: ' nahawand', group: 'maqam', cents: [0, 200, 300, 500] },
]

const BY_ID = new Map(CHORD_LIBRARY.map((chord) => [chord.id, chord]))

/** Legacy integer templates, longest first, so 12-tone names stay stable. */
const LEGACY: { id: string; intervals: number[] }[] = [
  { id: 'maj9', intervals: [0, 2, 4, 7, 11] },
  { id: '9', intervals: [0, 2, 4, 7, 10] },
  { id: 'm9', intervals: [0, 2, 3, 7, 10] },
  { id: 'maj7', intervals: [0, 4, 7, 11] },
  { id: '7', intervals: [0, 4, 7, 10] },
  { id: 'm7', intervals: [0, 3, 7, 10] },
  { id: 'm7b5', intervals: [0, 3, 6, 10] },
  { id: 'dim7', intervals: [0, 3, 6, 9] },
  { id: 'mMaj7', intervals: [0, 3, 7, 11] },
  { id: 'add9', intervals: [0, 2, 4, 7] },
  { id: 'madd9', intervals: [0, 2, 3, 7] },
  { id: '6', intervals: [0, 4, 7, 9] },
  { id: 'm6', intervals: [0, 3, 7, 9] },
  { id: 'aug', intervals: [0, 4, 8] },
  { id: 'dim', intervals: [0, 3, 6] },
  { id: 'sus2', intervals: [0, 2, 7] },
  { id: 'sus4', intervals: [0, 5, 7] },
  { id: 'maj', intervals: [0, 4, 7] },
  { id: 'min', intervals: [0, 3, 7] },
]

const LEGACY_SUFFIX: Record<string, string> = Object.fromEntries(CHORD_LIBRARY.map((chord) => [chord.id, chord.suffix]))

export function chords() {
  return CHORD_LIBRARY
}

export function chordById(id: string) {
  return BY_ID.get(id) ?? null
}

export function chordsInGroup(group: ChordGroup) {
  return CHORD_LIBRARY.filter((chord) => chord.group === group)
}

function mod12(value: number) {
  return ((Math.round(value) % 12) + 12) % 12
}

/** Name a 12-tone chord. Intervals must already be on semitones. */
export function nameChord(pitches: number[]): string {
  if (pitches.some((pitch) => Math.abs(pitch - Math.round(pitch)) > 0.02)) return nameTunedChord(pitches)
  const pcs = [...new Set(pitches.map(mod12))].sort((a, b) => a - b)
  if (!pcs.length) return ''
  if (pcs.length === 1) return NOTE_NAMES[pcs[0]]
  const bass = mod12(Math.min(...pitches))
  let best: { root: number; id: string; score: number } | null = null
  for (const root of pcs) {
    const rel = pcs.map((pc) => (pc - root + 12) % 12).sort((a, b) => a - b)
    for (const template of LEGACY) {
      if (template.intervals.length !== rel.length) continue
      if (template.intervals.every((interval, index) => interval === rel[index])) {
        const score = template.intervals.length + (root === bass ? 0.5 : 0)
        if (!best || score > best.score) best = { root, id: template.id, score }
      }
    }
  }
  if (!best) return NOTE_NAMES[pcs[0]]
  return `${NOTE_NAMES[best.root]}${LEGACY_SUFFIX[best.id] ?? ''}`
}

/** Name a chord that may include quarter tones. Tolerance is 15 cents. */
export function nameTunedChord(pitches: number[]): string {
  const unique = uniqueMidi(pitches)
  if (!unique.length) return ''
  if (unique.length === 1) return spellPitch(unique[0])
  const bass = Math.min(...unique)
  let best: { root: number; suffix: string; score: number } | null = null
  for (const root of unique) {
    const rel = relativeCents(unique, root)
    for (const template of CHORD_LIBRARY) {
      if (template.cents.length !== rel.length) continue
      if (!template.cents.every((interval, index) => Math.abs(interval - rel[index]) <= 15)) continue
      const score = template.cents.length * 10 + (Math.abs(root - bass) < 0.02 ? 1 : 0)
      if (!best || score > best.score) best = { root, suffix: template.suffix, score }
    }
  }
  if (!best) {
    const low = Math.min(...unique)
    const high = Math.max(...unique)
    return `${spellPitch(low)}–${spellPitch(high)}`
  }
  return `${spellPitch(best.root)}${best.suffix}`
}

function uniqueMidi(pitches: number[]) {
  const out: number[] = []
  for (const pitch of pitches) {
    if (!Number.isFinite(pitch)) continue
    const key = Math.round(mod(pitch, 12) * 100)
    if (out.some((item) => Math.round(mod(item, 12) * 100) === key)) continue
    out.push(pitch)
  }
  return out
}

function mod(value: number, span: number) {
  return ((value % span) + span) % span
}

function relativeCents(pitches: number[], root: number) {
  const rel = pitches.map((pitch) => {
    let cents = Math.round((pitch - root) * 100)
    cents = ((cents % 1200) + 1200) % 1200
    return cents
  })
  return [...new Set(rel)].sort((a, b) => a - b)
}

/**
 * Build a chord on a root.
 * A root of 0–11 (or a fractional pitch class such as 3.5) is placed in `octave`.
 * A root above 11 is already a MIDI note.
 */
export function spellChord(root: number, chordId: string, octave = 4): SpelledChord | null {
  const spec = chordById(chordId)
  if (!spec) return null
  const rootMidi = root > 11 ? root : (octave + 1) * 12 + root
  const pitches = spec.cents.map((cents) => rootMidi + cents / 100)
  return {
    id: spec.id,
    name: `${spellPitch(rootMidi)}${spec.suffix}`,
    pitches,
    intervals: [...spec.cents],
    rootMidi,
  }
}

export function tunedNotes(pitches: number[]) {
  return pitches.map((pitch) => splitTuned(pitch))
}
