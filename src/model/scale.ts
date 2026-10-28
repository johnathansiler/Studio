/** Key, scale, chords, voicing, and performance patterns for the MIDI helper. */

import {
  NOTE_NAMES as THEORY_NOTES,
  FAMILY_LABEL,
  SCALE_FAMILIES,
  TUNER_SCALE_COUNT,
  chordsInKey,
  inScale as theoryInScale,
  movement as theoryMovement,
  nameChord as theoryName,
  nearQuarter,
  scaleById as theoryScale,
  scaleDegreePitches,
  scales,
  searchScales,
  snapToScale,
  spellPitch,
  voiceNotes,
  type ChordSet,
  type ScaleId as TheoryScaleId,
} from '../theory'

export const NOTE_NAMES = THEORY_NOTES

export type ScaleId = TheoryScaleId
export type ChordSource = ChordSet

/** Semitone intervals (fractional for maqam). The first 19 match the tuner index. */
export const SCALES = scales().map((scale) => ({
  id: scale.id,
  name: scale.name,
  family: scale.family,
  cents: scale.cents,
  microtonal: scale.microtonal,
  intervals: scale.cents.map((cents) => cents / 100),
}))

export { nearQuarter, searchScales, FAMILY_LABEL, SCALE_FAMILIES, TUNER_SCALE_COUNT }

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
  drop3: boolean
  shell: boolean
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
  /** Id of the idea last dropped onto the chord, bass, and drum tracks. */
  idea: string
  favorites: string[]
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

export function defaultScale(): ScaleState {
  return {
    root: 0,
    scale: 'ionian',
    snap: false,
    source: 'triads',
    inversion: 0,
    spread: false,
    drop2: false,
    drop3: false,
    shell: false,
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
    idea: '',
    favorites: [],
  }
}

export function scaleById(id: string | undefined): (typeof SCALES)[number] {
  const found = theoryScale(id)
  return SCALES.find((scale) => scale.id === found.id) ?? SCALES[0]
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
    drop3: !!value.drop3,
    shell: !!value.shell,
    rate: clamp(value.rate ?? base.rate, 0.125, 2),
    gate: clamp(value.gate ?? base.gate, 0.05, 1),
    octaves: clamp(Math.round(value.octaves ?? 1), 1, 3),
    timing: clamp(value.timing ?? base.timing, 0, 0.2),
    velocity: clamp(value.velocity ?? 0, 0, 1),
    lastVoicing: Array.isArray(value.lastVoicing) ? value.lastVoicing.filter((n) => Number.isFinite(n)) : [],
    idea: typeof value.idea === 'string' ? value.idea : '',
    favorites: Array.isArray(value.favorites) ? value.favorites.filter((item): item is string => typeof item === 'string') : [],
  }
}

export function pitchClass(pitch: number) {
  return ((Math.round(pitch) % 12) + 12) % 12
}

export function noteName(pitch: number) {
  if (Math.abs(pitch - Math.round(pitch)) > 0.02) return spellPitch(pitch)
  return NOTE_NAMES[pitchClass(pitch)]
}

export function inScale(pitch: number, root: number, scale: ScaleId) {
  return theoryInScale(pitch, root, scale)
}

/** Nearest scale tone. Ties resolve downward. Maqam snaps land on the quarter tone via `placePitch`. */
export function snapPitch(pitch: number, root: number, scale: ScaleId) {
  return placePitch(pitch, root, scale).pitch
}

/** Integer MIDI note plus the cents offset stored on `MidiNote.fine`. */
export function placePitch(pitch: number, root: number, scale: ScaleId) {
  return snapToScale(pitch, root, scale)
}

export function scaleTones(root: number, scale: ScaleId, octave = 4) {
  return scaleDegreePitches(root, scale, octave)
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
    for (const scale of SCALES.slice(0, TUNER_SCALE_COUNT)) {
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
  const intervals = scaleById(scale).intervals.map((interval) => Math.round(interval))
  intervals.forEach((interval, index) => {
    if (interval < 0 || interval > 11) return
    profile[interval] = index === 0 ? 6.2 : 3.2
  })
  if (intervals.some((interval) => interval === 7)) profile[7] = 5.1
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
  return theoryName(pitches)
}

export interface VoicingOptions {
  inversion?: number
  spread?: boolean
  drop2?: boolean
  drop3?: boolean
  drop24?: boolean
  shell?: boolean
  octave?: boolean
  voiceLead?: boolean
  previous?: number[]
}

export function voiceChord(pitchClassesOrMidi: number[], options: VoicingOptions = {}): number[] {
  return voiceNotes(pitchClassesOrMidi, options)
}

export function diatonicPads(root: number, scale: ScaleId, source: ChordSource): ChordPad[] {
  return chordsInKey(root, scale, source).map((chord) => ({ label: chord.name, pitches: chord.pitches }))
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
  return theoryMovement(a, b)
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
