/** Key, scale, chords, voicing, and performance patterns for the MIDI helper. */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

export const SCALES = [
  { id: 'ionian', name: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'dorian', name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', name: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', name: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'aeolian', name: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'locrian', name: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'harmonicMinor', name: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodicMinor', name: 'Melodic minor', intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'majorPentatonic', name: 'Maj pentatonic', intervals: [0, 2, 4, 7, 9] },
  { id: 'minorPentatonic', name: 'Min pentatonic', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'wholeTone', name: 'Whole tone', intervals: [0, 2, 4, 6, 8, 10] },
  { id: 'dimHalfWhole', name: 'Half-whole', intervals: [0, 1, 3, 4, 6, 7, 9, 10] },
  { id: 'dimWholeHalf', name: 'Whole-half', intervals: [0, 2, 3, 5, 6, 8, 9, 11] },
  { id: 'hirajoshi', name: 'Hirajoshi', intervals: [0, 2, 3, 7, 8] },
  { id: 'phrygianDominant', name: 'Phrygian dom', intervals: [0, 1, 4, 5, 7, 8, 10] },
  { id: 'hungarianMinor', name: 'Hungarian min', intervals: [0, 2, 3, 6, 7, 8, 11] },
  { id: 'insen', name: 'In Sen', intervals: [0, 1, 5, 7, 10] },
] as const

export type ScaleId = (typeof SCALES)[number]['id']

export type ChordSource =
  | 'triads'
  | 'sevenths'
  | 'ninths'
  | 'sus'
  | 'add'
  | 'borrowed'
  | 'secondary'
  | 'pop'
  | 'rnb'
  | 'edm'
  | 'cinematic'
  | 'rock'
  | 'jazz'
  | 'gospel'

export type ArpDirection = 'off' | 'up' | 'down' | 'upDown' | 'random'
export type RhythmPattern = 'block' | 'quarter' | 'eighth' | 'sync' | 'strum'

export interface ScaleState {
  root: number
  scale: ScaleId
  snap: boolean
  source: ChordSource
  inversion: number
  spread: boolean
  drop2: boolean
  octave: boolean
  voiceLead: boolean
  arp: ArpDirection
  rate: number
  gate: number
  octaves: number
  rhythm: RhythmPattern
  timing: number
  velocity: number
  lastVoicing: number[]
}

export interface ChordPad {
  label: string
  pitches: number[]
}

export interface PlayNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const CHORD_TEMPLATES: { id: string; intervals: number[] }[] = [
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

const SUFFIX: Record<string, string> = {
  maj9: 'maj9',
  '9': '9',
  m9: 'm9',
  maj7: 'maj7',
  '7': '7',
  m7: 'm7',
  m7b5: 'm7b5',
  dim7: 'dim7',
  mMaj7: 'mMaj7',
  add9: 'add9',
  madd9: 'madd9',
  '6': '6',
  m6: 'm6',
  aug: 'aug',
  dim: 'dim',
  sus2: 'sus2',
  sus4: 'sus4',
  maj: '',
  min: 'm',
}

export function defaultScale(): ScaleState {
  return {
    root: 0,
    scale: 'ionian',
    snap: false,
    source: 'triads',
    inversion: 0,
    spread: false,
    drop2: false,
    octave: false,
    voiceLead: true,
    arp: 'off',
    rate: 0.5,
    gate: 0.8,
    octaves: 1,
    rhythm: 'block',
    timing: 0.02,
    velocity: 0,
    lastVoicing: [],
  }
}

export function scaleById(id: string | undefined): (typeof SCALES)[number] {
  return SCALES.find((scale) => scale.id === id) ?? SCALES[0]
}

export function normalizeScale(value: Partial<ScaleState> | undefined): ScaleState {
  const base = defaultScale()
  if (!value) return base
  const scale = scaleById(value.scale).id
  return {
    ...base,
    ...value,
    root: ((value.root ?? 0) % 12 + 12) % 12,
    scale,
    inversion: Math.max(0, Math.round(value.inversion ?? 0)),
    rate: clamp(value.rate ?? base.rate, 0.125, 2),
    gate: clamp(value.gate ?? base.gate, 0.05, 1),
    octaves: clamp(Math.round(value.octaves ?? 1), 1, 3),
    timing: clamp(value.timing ?? base.timing, 0, 0.2),
    velocity: clamp(value.velocity ?? 0, 0, 1),
    lastVoicing: Array.isArray(value.lastVoicing) ? value.lastVoicing.filter((n) => Number.isFinite(n)) : [],
  }
}

export function pitchClass(pitch: number) {
  return ((Math.round(pitch) % 12) + 12) % 12
}

export function noteName(pitch: number) {
  return NOTE_NAMES[pitchClass(pitch)]
}

export function inScale(pitch: number, root: number, scale: ScaleId) {
  const rel = pitchClass(pitch - root)
  return hasInterval(scaleById(scale).intervals, rel)
}

function hasInterval(intervals: readonly number[], value: number) {
  return intervals.some((interval) => interval === value)
}

/** Nearest scale tone. Ties resolve downward so a leading tone falls to the chord tone below. */
export function snapPitch(pitch: number, root: number, scale: ScaleId) {
  const rounded = Math.round(pitch)
  const intervals = scaleById(scale).intervals
  let best = rounded
  let bestDist = 99
  for (let candidate = rounded - 6; candidate <= rounded + 6; candidate++) {
    if (!hasInterval(intervals, pitchClass(candidate - root))) continue
    const dist = Math.abs(candidate - rounded)
    if (dist < bestDist || (dist === bestDist && candidate < best)) {
      best = candidate
      bestDist = dist
    }
  }
  return best
}

export function scaleTones(root: number, scale: ScaleId, octave = 4) {
  const base = (octave + 1) * 12 + pitchClass(root)
  return scaleById(scale).intervals.map((interval) => base + interval)
}

interface WeightedNote {
  pitch: number
  weight?: number
}

/** Krumhansl-style correlation across every scale we ship, weighted by note length. */
export function detectKey(notes: WeightedNote[]): { root: number; scale: ScaleId; score: number } {
  const hist = new Array(12).fill(0)
  for (const note of notes) hist[pitchClass(note.pitch)] += Math.max(0.01, note.weight ?? 1)
  let best = { root: 0, scale: 'ionian' as ScaleId, score: -Infinity }
  for (let root = 0; root < 12; root++) {
    for (const scale of SCALES) {
      const profile = profileFor(scale.id)
      const score = correlate(rotate(hist, root), profile)
      if (score > best.score) best = { root, scale: scale.id, score }
    }
  }
  if (!notes.length) return { root: 0, scale: 'ionian', score: 0 }
  return best
}

function profileFor(scale: ScaleId) {
  if (scale === 'ionian') return MAJOR_PROFILE
  if (scale === 'aeolian' || scale === 'harmonicMinor' || scale === 'melodicMinor') return MINOR_PROFILE
  const profile = new Array(12).fill(0)
  const intervals = scaleById(scale).intervals
  intervals.forEach((interval, index) => {
    profile[interval] = index === 0 ? 6.2 : 3.2
  })
  if (hasInterval(intervals, 7)) profile[7] = 5.1
  const third = intervals.find((interval) => interval === 3 || interval === 4)
  if (third != null) profile[third] = 4.4
  return profile
}

function rotate(values: number[], root: number) {
  return values.map((_, index) => values[(index + root) % 12])
}

function correlate(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length)
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    sa += a[i]
    sb += b[i]
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma
    const xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

export function nameChord(pitches: number[]): string {
  const pcs = [...new Set(pitches.map(pitchClass))].sort((a, b) => a - b)
  if (!pcs.length) return ''
  if (pcs.length === 1) return NOTE_NAMES[pcs[0]]
  const bass = pitchClass(Math.min(...pitches))
  let best: { root: number; id: string; score: number } | null = null
  for (const root of pcs) {
    const rel = pcs.map((pc) => (pc - root + 12) % 12).sort((a, b) => a - b)
    for (const template of CHORD_TEMPLATES) {
      if (template.intervals.length !== rel.length) continue
      if (template.intervals.every((interval, index) => interval === rel[index])) {
        const score = template.intervals.length + (root === bass ? 0.5 : 0)
        if (!best || score > best.score) best = { root, id: template.id, score }
      }
    }
  }
  if (!best) {
    const root = pcs[0]
    return NOTE_NAMES[root]
  }
  return `${NOTE_NAMES[best.root]}${SUFFIX[best.id] ?? ''}`
}

export interface VoicingOptions {
  inversion?: number
  spread?: boolean
  drop2?: boolean
  octave?: boolean
  voiceLead?: boolean
  previous?: number[]
}

export function voiceChord(pitchClassesOrMidi: number[], options: VoicingOptions = {}): number[] {
  const raw = pitchClassesOrMidi.map((pitch) => Math.round(pitch))
  const looksMidi = raw.some((pitch) => pitch > 24)
  let notes = (looksMidi ? raw : raw.map((pc) => 60 + pitchClass(pc))).sort((a, b) => a - b)
  notes = unique(notes)
  const inversion = Math.max(0, options.inversion ?? 0) % Math.max(1, notes.length)
  notes = invert(notes, inversion)
  if (options.spread && notes.length > 2) notes = notes.map((pitch, index) => (index === 1 ? pitch + 12 : pitch)).sort((a, b) => a - b)
  if (options.drop2 && notes.length > 2) {
    const sorted = [...notes].sort((a, b) => a - b)
    const second = sorted[sorted.length - 2]
    notes = sorted.map((pitch) => (pitch === second ? pitch - 12 : pitch)).sort((a, b) => a - b)
  }
  if (options.octave) {
    const root = Math.min(...notes)
    notes = unique([...notes, root + 12]).sort((a, b) => a - b)
  }
  if (options.voiceLead && options.previous && options.previous.length) notes = leadVoices(notes, options.previous)
  return notes
}

function invert(notes: number[], times: number) {
  let next = [...notes]
  for (let i = 0; i < times; i++) {
    const bass = next[0]
    next = [...next.slice(1), bass + 12]
  }
  return next
}

function leadVoices(target: number[], previous: number[]) {
  let best = target
  let bestCost = Infinity
  const span = Math.max(1, target.length)
  for (let inv = 0; inv < span; inv++) {
    const inverted = invert([...target].sort((a, b) => a - b), inv)
    for (const shift of [-12, 0, 12]) {
      const candidate = inverted.map((pitch) => pitch + shift).sort((a, b) => a - b)
      const cost = matchCost(candidate, previous)
      if (cost < bestCost) {
        bestCost = cost
        best = candidate
      }
    }
  }
  return best
}

function matchCost(candidate: number[], previous: number[]) {
  const used = new Set<number>()
  let cost = 0
  for (const pitch of candidate) {
    let best = 99
    let index = -1
    previous.forEach((other, i) => {
      if (used.has(i)) return
      const dist = Math.abs(other - pitch)
      if (dist < best) {
        best = dist
        index = i
      }
    })
    if (index >= 0) used.add(index)
    cost += index >= 0 ? best : 12
  }
  return cost
}

function unique(notes: number[]) {
  return [...new Set(notes)]
}

export function diatonicPads(root: number, scale: ScaleId, source: ChordSource): ChordPad[] {
  if (source === 'borrowed') return borrowedPads(root, scale)
  if (source === 'secondary') return secondaryPads(root, scale)
  if (isGenre(source)) return progressionPads(root, source)
  const intervals = scaleById(scale).intervals
  const count = Math.min(7, intervals.length)
  const pads: ChordPad[] = []
  for (let degree = 0; degree < count; degree++) {
    const tones = chordIntervals(intervals, degree, source)
    const degreeRoot = intervals[degree % intervals.length]
    const midi = tones.map((interval) => 60 + pitchClass(root) + degreeRoot + interval)
    pads.push({ label: nameChord(midi), pitches: midi })
  }
  return pads.filter((pad) => pad.label)
}

function chordIntervals(scaleIntervals: readonly number[], degree: number, source: ChordSource) {
  const len = scaleIntervals.length
  const walk = (steps: number[]) => {
    const rootTone = scaleIntervals[degree % len]
    return steps.map((step) => {
      const index = degree + step
      const wrapped = ((index % len) + len) % len
      const octaves = Math.floor(index / len)
      let interval = scaleIntervals[wrapped] + octaves * 12 - rootTone
      if (interval < 0) interval += 12
      return interval
    })
  }
  if (source === 'sevenths') return walk([0, 2, 4, 6])
  if (source === 'ninths') return walk([0, 2, 4, 6, 8])
  if (source === 'sus') return degree % 2 === 0 ? [0, 5, 7] : [0, 2, 7]
  if (source === 'add') return [...walk([0, 2, 4]), 14]
  return walk([0, 2, 4])
}

function isGenre(source: ChordSource): source is 'pop' | 'rnb' | 'edm' | 'cinematic' | 'rock' | 'jazz' | 'gospel' {
  return ['pop', 'rnb', 'edm', 'cinematic', 'rock', 'jazz', 'gospel'].includes(source)
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

function progressionPads(root: number, source: 'pop' | 'rnb' | 'edm' | 'cinematic' | 'rock' | 'jazz' | 'gospel'): ChordPad[] {
  return GENRE[source].map((intervals) => {
    const midi = intervals.map((interval) => 60 + pitchClass(root) + interval)
    return { label: nameChord(midi), pitches: midi }
  })
}

function borrowedPads(root: number, scale: ScaleId): ChordPad[] {
  const intervals = scaleById(scale).intervals
  const minorish = hasInterval(intervals, 3) && !hasInterval(intervals, 4)
  const recipes = minorish
    ? [[0, 4, 7], [5, 9, 12], [7, 11, 14]]
    : [[3, 7, 10], [8, 12, 15], [10, 14, 17], [5, 8, 12], [2, 5, 8]]
  return recipes.map((intervals) => {
    const midi = intervals.map((interval) => 60 + pitchClass(root) + interval)
    return { label: nameChord(midi), pitches: midi }
  })
}

function secondaryPads(root: number, scale: ScaleId): ChordPad[] {
  const diatonic = diatonicPads(root, scale, 'triads').slice(1, 6)
  return diatonic.map((target) => {
    const targetRoot = pitchClass(Math.min(...target.pitches))
    const dominant = [0, 4, 7, 10].map((interval) => 60 + pitchClass(targetRoot + 7) + interval)
    return { label: nameChord(dominant), pitches: dominant }
  })
}

export interface PatternOptions {
  arp?: ArpDirection
  rate?: number
  gate?: number
  octaves?: number
  rhythm?: RhythmPattern
  timing?: number
  velocity?: number
  spanBeats?: number
  rng?: () => number
}

export function patternNotes(pitches: number[], options: PatternOptions = {}): PlayNote[] {
  const rng = options.rng ?? Math.random
  const span = Math.max(0.25, options.spanBeats ?? 4)
  const velocity = 0.8
  let notes: PlayNote[] = []
  const arp = options.arp ?? 'off'
  if (arp !== 'off') {
    const rate = clamp(options.rate ?? 0.5, 0.125, 2)
    const gate = clamp(options.gate ?? 0.8, 0.05, 1)
    const octaves = clamp(Math.round(options.octaves ?? 1), 1, 3)
    const line = arpLine(pitches, arp, octaves, rng)
    const steps = Math.max(1, Math.round(span / rate))
    for (let step = 0; step < steps; step++) {
      const pitch = line[step % line.length]
      notes.push({ pitch, startBeat: step * rate, durationBeats: rate * gate, velocity })
    }
  } else {
    notes = rhythmHits(pitches, options.rhythm ?? 'block', span, velocity, options.timing ?? 0)
  }
  const timing = options.rhythm === 'strum' ? 0 : clamp(options.timing ?? 0, 0, 0.2)
  const vel = clamp(options.velocity ?? 0, 0, 1)
  return notes.map((note) => ({
    ...note,
    startBeat: Math.max(0, note.startBeat + (rng() - 0.5) * 2 * timing),
    velocity: clamp(note.velocity * (1 + (rng() - 0.5) * 2 * vel), 0.05, 1),
  }))
}

function arpLine(pitches: number[], direction: ArpDirection, octaves: number, rng: () => number) {
  const base = [...pitches].sort((a, b) => a - b)
  const extended: number[] = []
  for (let oct = 0; oct < octaves; oct++) base.forEach((pitch) => extended.push(pitch + oct * 12))
  if (direction === 'down') return [...extended].reverse()
  if (direction === 'upDown') {
    const down = [...extended].reverse().slice(1, -1)
    return [...extended, ...down]
  }
  if (direction === 'random') {
    const copy = [...extended]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy.length ? copy : extended
  }
  return extended
}

function rhythmHits(pitches: number[], rhythm: RhythmPattern, span: number, velocity: number, strum: number): PlayNote[] {
  if (rhythm === 'quarter' || rhythm === 'eighth') {
    const step = rhythm === 'quarter' ? 1 : 0.5
    const notes: PlayNote[] = []
    for (let beat = 0; beat < span - 0.01; beat += step) {
      for (const pitch of pitches) notes.push({ pitch, startBeat: beat, durationBeats: step * 0.9, velocity })
    }
    return notes
  }
  if (rhythm === 'sync') {
    const beats = [0, 0.75, 1.5, 2.5, 3].filter((beat) => beat < span)
    return beats.flatMap((beat, index) => {
      const next = beats[index + 1] ?? span
      return pitches.map((pitch) => ({ pitch, startBeat: beat, durationBeats: Math.max(0.2, next - beat - 0.05), velocity }))
    })
  }
  if (rhythm === 'strum') {
    const gap = clamp(strum || 0.03, 0.01, 0.08)
    return pitches.map((pitch, index) => ({ pitch, startBeat: index * gap, durationBeats: Math.max(0.25, span - index * gap), velocity }))
  }
  return pitches.map((pitch) => ({ pitch, startBeat: 0, durationBeats: span, velocity }))
}

export function movement(a: number[], b: number[]) {
  return matchCost(a, b)
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
