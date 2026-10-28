import { clampMidi, mod, pitchClassName, toneFromCents, toneName } from './pitch'
import { getScale, nearestDegree } from './scales'
import type { ChordGroup, ChordSpec, DiatonicChord, ScaleChord, SpelledChord, Tone } from './types'

const FIT_CENTS = 30

function chord(id: string, suffix: string, name: string, group: ChordGroup, semitones: number[], description: string): ChordSpec {
  return { id, suffix, name, group, cents: semitones.map((step) => Math.round(step * 100)), description }
}

export const CHORDS: ChordSpec[] = [
  chord('maj', '', 'Major', 'triad', [0, 4, 7], 'Major triad.'),
  chord('min', 'm', 'Minor', 'triad', [0, 3, 7], 'Minor triad.'),
  chord('dim', 'dim', 'Diminished', 'triad', [0, 3, 6], 'Diminished triad.'),
  chord('aug', 'aug', 'Augmented', 'triad', [0, 4, 8], 'Augmented triad.'),
  chord('5', '5', 'Power', 'triad', [0, 7], 'Root and fifth, no third.'),
  chord('neutral', 'n', 'Neutral', 'triad', [0, 3.5, 7], 'Quarter-tone third, between major and minor.'),
  chord('6', '6', 'Major 6', 'sixth', [0, 4, 7, 9], 'Major triad plus the sixth.'),
  chord('m6', 'm6', 'Minor 6', 'sixth', [0, 3, 7, 9], 'Minor triad plus the sixth.'),
  chord('69', '6/9', 'Six nine', 'sixth', [0, 4, 7, 9, 14], 'Major six plus the ninth.'),
  chord('maj7', 'maj7', 'Major 7', 'seventh', [0, 4, 7, 11], 'Major triad plus a major seventh.'),
  chord('7', '7', 'Dominant 7', 'seventh', [0, 4, 7, 10], 'Major triad plus a minor seventh.'),
  chord('m7', 'm7', 'Minor 7', 'seventh', [0, 3, 7, 10], 'Minor triad plus a minor seventh.'),
  chord('mMaj7', 'mMaj7', 'Minor major 7', 'seventh', [0, 3, 7, 11], 'Minor triad plus a major seventh.'),
  chord('dim7', 'dim7', 'Diminished 7', 'seventh', [0, 3, 6, 9], 'Diminished triad plus a diminished seventh.'),
  chord('m7b5', 'm7b5', 'Half-diminished', 'seventh', [0, 3, 6, 10], 'Diminished triad plus a minor seventh.'),
  chord('dimMaj7', 'dimMaj7', 'Diminished major 7', 'seventh', [0, 3, 6, 11], 'Diminished triad plus a major seventh.'),
  chord('neutral7', 'n7', 'Neutral 7', 'seventh', [0, 3.5, 7, 10], 'Neutral third with a minor seventh.'),
  chord('maj9', 'maj9', 'Major 9', 'ninth', [0, 4, 7, 11, 14], 'Major seventh plus the ninth.'),
  chord('9', '9', 'Dominant 9', 'ninth', [0, 4, 7, 10, 14], 'Dominant seventh plus the ninth.'),
  chord('m9', 'm9', 'Minor 9', 'ninth', [0, 3, 7, 10, 14], 'Minor seventh plus the ninth.'),
  chord('mMaj9', 'mMaj9', 'Minor major 9', 'ninth', [0, 3, 7, 11, 14], 'Minor major seventh plus the ninth.'),
  chord('69add', '6add9', '6 add 9', 'ninth', [0, 4, 7, 9, 14], 'Six-nine voicing without the seventh.'),
  chord('11', '11', 'Dominant 11', 'eleventh', [0, 4, 7, 10, 14, 17], 'Dominant ninth plus the eleventh.'),
  chord('m11', 'm11', 'Minor 11', 'eleventh', [0, 3, 7, 10, 14, 17], 'Minor ninth plus the eleventh.'),
  chord('maj11', 'maj11', 'Major 11', 'eleventh', [0, 4, 7, 11, 14, 17], 'Major ninth plus the eleventh.'),
  chord('13', '13', 'Dominant 13', 'thirteenth', [0, 4, 7, 10, 14, 21], 'Dominant thirteenth. The eleventh is left out so the third can speak.'),
  chord('maj13', 'maj13', 'Major 13', 'thirteenth', [0, 4, 7, 11, 14, 21], 'Major ninth plus the thirteenth.'),
  chord('m13', 'm13', 'Minor 13', 'thirteenth', [0, 3, 7, 10, 14, 21], 'Minor ninth plus the thirteenth.'),
  chord('7b5', '7b5', '7 flat 5', 'altered', [0, 4, 6, 10], 'Dominant seventh with a flat fifth.'),
  chord('7#5', '7#5', '7 sharp 5', 'altered', [0, 4, 8, 10], 'Dominant seventh with a sharp fifth.'),
  chord('aug7', 'aug7', 'Augmented 7', 'altered', [0, 4, 8, 10], 'Augmented triad plus a minor seventh.'),
  chord('maj7#5', 'maj7#5', 'Major 7 sharp 5', 'altered', [0, 4, 8, 11], 'Augmented triad plus a major seventh.'),
  chord('7b9', '7b9', '7 flat 9', 'altered', [0, 4, 7, 10, 13], 'Dominant seventh with a flat ninth.'),
  chord('7#9', '7#9', '7 sharp 9', 'altered', [0, 4, 7, 10, 15], 'Dominant seventh with a sharp ninth.'),
  chord('7b9#9', '7b9#9', '7 flat-sharp 9', 'altered', [0, 4, 7, 10, 13, 15], 'Both altered ninths on a dominant seventh.'),
  chord('9b5', '9b5', '9 flat 5', 'altered', [0, 4, 6, 10, 14], 'Dominant ninth with a flat fifth.'),
  chord('9#5', '9#5', '9 sharp 5', 'altered', [0, 4, 8, 10, 14], 'Dominant ninth with a sharp fifth.'),
  chord('7#11', '7#11', '7 sharp 11', 'altered', [0, 4, 7, 10, 18], 'Dominant seventh with a sharp eleventh.'),
  chord('9#11', '9#11', '9 sharp 11', 'altered', [0, 4, 7, 10, 14, 18], 'Dominant ninth with a sharp eleventh.'),
  chord('maj9#11', 'maj9#11', 'Major 9 sharp 11', 'altered', [0, 4, 7, 11, 14, 18], 'Lydian major ninth.'),
  chord('7b13', '7b13', '7 flat 13', 'altered', [0, 4, 7, 10, 20], 'Dominant seventh with a flat thirteenth.'),
  chord('13b9', '13b9', '13 flat 9', 'altered', [0, 4, 7, 10, 13, 21], 'Dominant thirteenth with a flat ninth.'),
  chord('alt', 'alt', 'Altered', 'altered', [0, 4, 6, 10, 13, 20], 'Altered dominant: flat five, flat nine, flat thirteen.'),
  chord('7alt', '7alt', 'Altered sharp 5', 'altered', [0, 4, 8, 10, 13, 15], 'Sharp fifth with both altered ninths.'),
  chord('sus2', 'sus2', 'Suspended 2', 'sus', [0, 2, 7], 'The second replaces the third.'),
  chord('sus4', 'sus4', 'Suspended 4', 'sus', [0, 5, 7], 'The fourth replaces the third.'),
  chord('7sus2', '7sus2', '7 sus 2', 'sus', [0, 2, 7, 10], 'Suspended second with a minor seventh.'),
  chord('7sus4', '7sus4', '7 sus 4', 'sus', [0, 5, 7, 10], 'Suspended fourth with a minor seventh.'),
  chord('9sus4', '9sus4', '9 sus 4', 'sus', [0, 5, 7, 10, 14], 'Suspended fourth with a ninth and a seventh.'),
  chord('13sus', '13sus', '13 sus', 'sus', [0, 5, 7, 10, 14, 21], 'Suspended thirteenth.'),
  chord('add4', 'add4', 'Add 4', 'add', [0, 4, 5, 7], 'Major triad plus the fourth.'),
  chord('add9', 'add9', 'Add 9', 'add', [0, 2, 4, 7], 'Major triad plus the ninth.'),
  chord('madd9', 'madd9', 'Minor add 9', 'add', [0, 2, 3, 7], 'Minor triad plus the ninth.'),
  chord('add11', 'add11', 'Add 11', 'add', [0, 4, 7, 17], 'Major triad plus the eleventh.'),
  chord('madd11', 'madd11', 'Minor add 11', 'add', [0, 3, 7, 17], 'Minor triad plus the eleventh.'),
  chord('quartal', 'quart', 'Quartal', 'quartal', [0, 5, 10, 15], 'Stacked fourths.'),
  chord('quartal5', 'quart5', 'Quartal 5', 'quartal', [0, 5, 10, 15, 20], 'Five stacked fourths.'),
  chord('sowhat', 'so', 'So What', 'quartal', [0, 5, 10, 15, 19], 'Quartal voicing with a major third on top.'),
  chord('cluster', 'clust', 'Cluster', 'cluster', [0, 2, 4], 'Whole-tone cluster.'),
  chord('cluster2', 'clust2', 'Chromatic cluster', 'cluster', [0, 1, 2], 'Three chromatic neighbors.'),
  chord('cluster4', 'clust4', 'Tone cluster', 'cluster', [0, 2, 3, 5], 'A tight four-note cluster.'),
]

const byId = new Map(CHORDS.map((item) => [item.id, item]))

export function listChords(group?: ChordGroup) {
  return group ? CHORDS.filter((item) => item.group === group) : CHORDS.slice()
}

export function getChord(id: string): ChordSpec {
  return byId.get(id) ?? CHORDS[0]
}

export function spellChord(rootPc: number, chordId: string, octave = 4, bassPc?: number): SpelledChord {
  const chordSpec = getChord(chordId)
  const root = mod(Math.round(rootPc), 12)
  const rootMidi = (octave + 1) * 12 + root
  let tones = chordSpec.cents.map((cents) => {
    const tone = toneFromCents(rootMidi * 100 + cents)
    return { midi: clampMidi(tone.midi), cents: tone.cents }
  })
  const bass = bassPc == null ? root : mod(Math.round(bassPc), 12)
  let symbol = `${pitchClassName(root)}${chordSpec.suffix}`
  if (bass !== root) {
    tones = withBass(tones, bass)
    symbol = `${symbol}/${pitchClassName(bass)}`
  }
  return { id: chordSpec.id, symbol, rootPc: root, bassPc: bass, tones }
}

export function withBass(tones: Tone[], bassPc: number): Tone[] {
  if (!tones.length) return tones
  const lowest = Math.min(...tones.map((tone) => tone.midi))
  let bassMidi = lowest - mod(lowest - bassPc, 12)
  if (bassMidi > lowest - 1) bassMidi -= 12
  if (bassMidi < 0) bassMidi += 12
  const rest = tones.filter((tone) => !(tone.midi === bassMidi && tone.cents === 0))
  return [{ midi: clampMidi(bassMidi), cents: 0 }, ...rest]
}

/** Name a stack of cent intervals by the closest chord formula of the same size. */
export function nameIntervals(intervals: number[]): { id: string; suffix: string; error: number } {
  const target = intervals.map((value) => Math.round(value))
  let best = { id: 'maj', suffix: '', error: Infinity }
  for (const chordSpec of CHORDS) {
    if (chordSpec.cents.length !== target.length) continue
    let error = 0
    for (let i = 0; i < target.length; i++) error += Math.abs(chordSpec.cents[i] - target[i])
    if (error < best.error) best = { id: chordSpec.id, suffix: chordSpec.suffix, error }
  }
  if (!Number.isFinite(best.error)) return { id: 'maj', suffix: '', error: 0 }
  return best
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']

export function romanNumeral(degree: number, intervals: number[], scaleLength: number) {
  const numeral = scaleLength === 7 ? ROMAN[degree] ?? String(degree + 1) : String(degree + 1)
  // The second interval is not always the third: sus2 and add9 put a second there.
  const third = intervals.find((interval) => interval >= 250 && interval <= 450)
  const fifth = intervals.find((interval) => interval >= 600 && interval <= 850)
  const neutral = third != null && Math.abs(third - 350) <= 20
  const minor = third != null && third < 360 && !neutral
  let text = minor || neutral ? numeral.toLowerCase() : numeral
  if (neutral) text += 'n'
  if (fifth != null && fifth < 660) text += '°'
  else if (fifth != null && fifth > 760) text += '+'
  const seventh = third == null ? undefined : intervals.find((interval) => interval >= 900 && interval <= 1200)
  if (seventh != null) text += seventh >= 1050 ? 'Δ' : '7'
  return text
}

/**
 * Tertian stacks on every scale degree. `size` 3 is triads, 4 is sevenths, up through 7 (13ths).
 */
export function harmonize(rootPc: number, scaleId: string, size: 3 | 4 | 5 | 6 | 7 = 3, octave = 4): DiatonicChord[] {
  const spec = getScale(scaleId)
  const count = Math.min(size, spec.cents.length)
  const tonic = (octave + 1) * 12 + mod(Math.round(rootPc), 12)
  const chords: DiatonicChord[] = []
  for (let degree = 0; degree < spec.cents.length; degree++) {
    const intervals: number[] = []
    const tones: Tone[] = []
    for (let step = 0; step < count; step++) {
      const index = degree + step * 2
      const wrapped = mod(index, spec.cents.length)
      const octaves = Math.floor(index / spec.cents.length)
      const fromTonic = spec.cents[wrapped] + octaves * 1200
      intervals.push(fromTonic - spec.cents[degree])
      const tone = toneFromCents(tonic * 100 + fromTonic)
      tones.push({ midi: clampMidi(tone.midi), cents: tone.cents })
    }
    const named = nameIntervals(intervals)
    const rootTone = tones[0] ?? { midi: tonic, cents: 0 }
    chords.push({
      degree,
      roman: romanNumeral(degree, intervals, spec.cents.length),
      chordId: named.id,
      symbol: `${toneName(rootTone)}${named.suffix}`,
      tones,
      intervals,
    })
  }
  return chords
}

/**
 * Chord formulas whose tones all land on scale degrees, transposed to every scale degree.
 */
export function chordsInScale(rootPc: number, scaleId: string, groups?: ChordGroup[], octave = 4): ScaleChord[] {
  const spec = getScale(scaleId)
  const tonic = (octave + 1) * 12 + mod(Math.round(rootPc), 12)
  const hits: ScaleChord[] = []
  spec.cents.forEach((degreeCents, degree) => {
    for (const chordSpec of CHORDS) {
      if (groups && !groups.includes(chordSpec.group)) continue
      if (chordSpec.cents.length < 3) continue
      let worst = 0
      let ok = true
      for (const interval of chordSpec.cents) {
        const found = nearestDegree(degreeCents + interval, spec.cents)
        if (found.distance > FIT_CENTS) {
          ok = false
          break
        }
        worst = Math.max(worst, found.distance)
      }
      if (!ok) continue
      const tones = chordSpec.cents.map((interval) => {
        const tone = toneFromCents(tonic * 100 + degreeCents + interval)
        return { midi: clampMidi(tone.midi), cents: tone.cents }
      })
      const rootTone = tones[0]
      hits.push({
        degree,
        roman: romanNumeral(degree, chordSpec.cents, spec.cents.length),
        chordId: chordSpec.id,
        symbol: `${toneName(rootTone)}${chordSpec.suffix}`,
        tones,
        intervals: chordSpec.cents.slice(),
        fit: 1 - worst / 100,
      })
    }
  })
  return hits
}
