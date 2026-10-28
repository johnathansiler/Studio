/**
 * One-tap part generators (chords, bass, melody, arp, strum, drums).
 *
 * A chord/scale library plugs in by handing `generate` a `GeneratorScale`:
 * the key pitch class, scale intervals, and a chord list. This module does not
 * import that library. `contextFromScale` fills the same shape from the scale helper.
 */

import { DRUM_PADS } from './drums'
import { nameChord, pitchClass, scaleById, voiceChord, type ScaleId } from './scale'
import type { TrackInstrument } from './types'

export const GRID = 0.25

export const GENERATOR_STYLES = [
  { id: 'pop', name: 'Pop' },
  { id: 'trap', name: 'Trap' },
  { id: 'rnb', name: 'R&B' },
  { id: 'lofi', name: 'Lo-fi' },
  { id: 'house', name: 'House' },
  { id: 'jazz', name: 'Jazz' },
  { id: 'gospel', name: 'Gospel' },
  { id: 'drill', name: 'Drill' },
  { id: 'afrobeats', name: 'Afrobeats' },
  { id: 'cinematic', name: 'Cinematic' },
] as const

export const GENERATOR_KINDS = [
  { id: 'chords', name: 'Chords', track: 'Chords', color: '#e0b15a' },
  { id: 'bass', name: 'Bass', track: 'Bass', color: '#79b8d4' },
  { id: 'melody', name: 'Melody', track: 'Melody', color: '#73c48f' },
  { id: 'arp', name: 'Arp', track: 'Arp', color: '#f09a6a' },
  { id: 'rhythm', name: 'Strum', track: 'Strum', color: '#ef6b6b' },
  { id: 'drums', name: 'Drums', track: 'Drums', color: '#c58be0' },
] as const

export type GeneratorStyle = (typeof GENERATOR_STYLES)[number]['id']
export type GeneratorKind = (typeof GENERATOR_KINDS)[number]['id']

export interface GeneratorChord {
  label: string
  /** Pitch class of the chord root. */
  root: number
  /** Semitone intervals from the chord root. */
  intervals: readonly number[]
  /** Scale degree when the chord was built from the scale. */
  degree?: number
}

/** What a chord/scale library hands a generator. */
export interface GeneratorScale {
  /** Pitch class, 0 = C. */
  key: number
  /** Semitones from the key, within one octave. Include 0. */
  intervals: readonly number[]
  /** Chords to draw from. Empty derives diatonic triads from `intervals`. */
  chords: readonly GeneratorChord[]
}

export interface GeneratedNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
}

export interface GeneratedClip {
  kind: GeneratorKind
  style: GeneratorStyle
  name: string
  track: string
  color: string
  instrument: TrackInstrument
  bars: number
  beatsPerBar: number
  notes: GeneratedNote[]
  summary: string
}

export interface GenerateRequest {
  scale: GeneratorScale
  style: GeneratorStyle
  kind: GeneratorKind
  tempo: number
  /** Quarter notes in a bar. 4/4 is 4, 6/8 is 3. */
  beatsPerBar: number
  seed: number
}

type Strings = 'all' | 'low' | 'high'
type Direction = 'up' | 'down' | 'updown' | 'broken'

interface Hit {
  step: number
  hold: number
  strings?: Strings
  semi?: number
}

interface Placed {
  start16: number
  hold: number
  strings: Strings
  semi: number
}

interface DrumRow {
  pitch: number
  steps: number[]
  velocity: number
  bars?: 'all' | 'even' | 'first'
}

interface Plan {
  scale: GeneratorScale
  style: GeneratorStyle
  tempo: number
  beatsPerBar: number
  bars: number
  bar16: number
  total16: number
  rng: () => number
  chords: GeneratorChord[]
}

const STYLE_NAME: Record<GeneratorStyle, string> = {
  pop: 'Pop',
  trap: 'Trap',
  rnb: 'R&B',
  lofi: 'Lo-fi',
  house: 'House',
  jazz: 'Jazz',
  gospel: 'Gospel',
  drill: 'Drill',
  afrobeats: 'Afrobeats',
  cinematic: 'Cinematic',
}

const MAJOR: Record<GeneratorStyle, number[][]> = {
  pop: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [0, 3, 4, 0]],
  trap: [[0, 5, 3, 4], [5, 3, 0, 4], [0, 6, 5, 3]],
  rnb: [[1, 4, 0, 5], [0, 5, 1, 4], [3, 4, 0, 1]],
  lofi: [[0, 5, 1, 4], [1, 4, 0, 3], [0, 3, 4, 5]],
  house: [[0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 4, 0]],
  jazz: [[1, 4, 0, 5], [0, 5, 1, 4], [2, 5, 1, 4]],
  gospel: [[0, 3, 4, 0], [0, 4, 5, 3], [3, 0, 4, 5]],
  drill: [[0, 5, 6, 0], [0, 6, 5, 3], [0, 3, 6, 5]],
  afrobeats: [[0, 4, 5, 3], [0, 3, 4, 0], [5, 3, 0, 4]],
  cinematic: [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 0]],
}

const MINOR: Record<GeneratorStyle, number[][]> = {
  pop: [[0, 5, 2, 6], [0, 3, 4, 5], [5, 2, 0, 6]],
  trap: [[0, 5, 6, 3], [0, 5, 3, 6], [0, 6, 5, 0]],
  rnb: [[0, 3, 4, 5], [1, 4, 0, 6], [0, 6, 3, 4]],
  lofi: [[0, 5, 3, 4], [0, 3, 1, 4], [5, 0, 3, 4]],
  house: [[0, 5, 2, 6], [0, 3, 6, 5], [0, 6, 3, 4]],
  jazz: [[1, 4, 0, 5], [0, 5, 1, 4], [0, 3, 1, 4]],
  gospel: [[0, 3, 4, 0], [0, 5, 3, 4], [0, 6, 3, 0]],
  drill: [[0, 5, 6, 0], [0, 6, 5, 6], [0, 3, 6, 5]],
  afrobeats: [[0, 5, 2, 6], [0, 3, 4, 0], [0, 6, 5, 3]],
  cinematic: [[0, 5, 2, 4], [0, 3, 5, 6], [0, 6, 5, 4]],
}

const REGISTER: Record<GeneratorStyle, { low: number; high: number; extend: boolean }> = {
  pop: { low: 60, high: 76, extend: false },
  trap: { low: 48, high: 67, extend: false },
  rnb: { low: 52, high: 74, extend: true },
  lofi: { low: 53, high: 76, extend: true },
  house: { low: 60, high: 79, extend: false },
  jazz: { low: 52, high: 76, extend: true },
  gospel: { low: 48, high: 74, extend: true },
  drill: { low: 48, high: 67, extend: false },
  afrobeats: { low: 60, high: 76, extend: false },
  cinematic: { low: 48, high: 81, extend: false },
}

const CHORD_RHYTHM: Record<GeneratorStyle, Hit[][]> = {
  pop: [[{ step: 0, hold: 16 }], [{ step: 0, hold: 8 }, { step: 8, hold: 8 }]],
  trap: [[{ step: 0, hold: 14 }, { step: 14, hold: 2 }], [{ step: 0, hold: 16 }]],
  rnb: [[{ step: 0, hold: 6 }, { step: 6, hold: 4 }, { step: 10, hold: 6 }], [{ step: 0, hold: 4 }, { step: 7, hold: 3 }, { step: 12, hold: 4 }]],
  lofi: [[{ step: 0, hold: 16 }], [{ step: 0, hold: 12 }, { step: 12, hold: 4 }]],
  house: [[{ step: 2, hold: 2 }, { step: 6, hold: 2 }, { step: 10, hold: 2 }, { step: 14, hold: 2 }], [{ step: 0, hold: 2 }, { step: 4, hold: 2 }, { step: 8, hold: 2 }, { step: 12, hold: 2 }]],
  jazz: [[{ step: 4, hold: 3 }, { step: 12, hold: 3 }], [{ step: 0, hold: 2 }, { step: 6, hold: 2 }, { step: 8, hold: 2 }, { step: 14, hold: 2 }]],
  gospel: [[{ step: 0, hold: 4 }, { step: 6, hold: 2 }, { step: 8, hold: 4 }, { step: 12, hold: 4 }], [{ step: 0, hold: 6 }, { step: 8, hold: 4 }, { step: 12, hold: 4 }]],
  drill: [[{ step: 0, hold: 16 }], [{ step: 0, hold: 10 }, { step: 12, hold: 4 }]],
  afrobeats: [[{ step: 2, hold: 2 }, { step: 6, hold: 2 }, { step: 10, hold: 2 }, { step: 14, hold: 2 }], [{ step: 0, hold: 2 }, { step: 6, hold: 2 }, { step: 8, hold: 2 }, { step: 14, hold: 2 }]],
  cinematic: [[{ step: 0, hold: 16 }], [{ step: 0, hold: 8 }, { step: 8, hold: 8 }]],
}

const BASS: Record<GeneratorStyle, Hit[][]> = {
  pop: [[{ step: 0, hold: 6, semi: 0 }, { step: 8, hold: 6, semi: 7 }], [{ step: 0, hold: 4, semi: 0 }, { step: 8, hold: 4, semi: 0 }, { step: 12, hold: 4, semi: 7 }]],
  trap: [[{ step: 0, hold: 10, semi: 0 }, { step: 10, hold: 2, semi: 12 }, { step: 14, hold: 2, semi: 0 }], [{ step: 0, hold: 6, semi: 0 }, { step: 8, hold: 4, semi: 0 }, { step: 12, hold: 2, semi: 12 }]],
  rnb: [[{ step: 0, hold: 3, semi: 0 }, { step: 6, hold: 2, semi: 7 }, { step: 10, hold: 4, semi: 0 }], [{ step: 0, hold: 4, semi: 0 }, { step: 7, hold: 2, semi: 3 }, { step: 10, hold: 4, semi: 7 }]],
  lofi: [[{ step: 0, hold: 8, semi: 0 }, { step: 8, hold: 6, semi: 7 }], [{ step: 0, hold: 14, semi: 0 }]],
  house: [[{ step: 0, hold: 2, semi: 0 }, { step: 4, hold: 2, semi: 0 }, { step: 8, hold: 2, semi: 0 }, { step: 12, hold: 2, semi: 7 }], [{ step: 0, hold: 2, semi: 0 }, { step: 6, hold: 2, semi: 0 }, { step: 8, hold: 2, semi: 0 }, { step: 14, hold: 2, semi: 7 }]],
  jazz: [[{ step: 0, hold: 3, semi: 0 }]],
  gospel: [[{ step: 0, hold: 4, semi: 0 }, { step: 6, hold: 2, semi: 7 }, { step: 8, hold: 4, semi: 12 }, { step: 12, hold: 4, semi: 0 }], [{ step: 0, hold: 2, semi: 0 }, { step: 4, hold: 2, semi: 7 }, { step: 8, hold: 2, semi: 0 }, { step: 12, hold: 2, semi: 5 }]],
  drill: [[{ step: 0, hold: 12, semi: 0 }, { step: 12, hold: 2, semi: 12 }], [{ step: 0, hold: 8, semi: 0 }, { step: 10, hold: 2, semi: 0 }, { step: 14, hold: 2, semi: 12 }]],
  afrobeats: [[{ step: 0, hold: 2, semi: 0 }, { step: 6, hold: 2, semi: 0 }, { step: 10, hold: 2, semi: 7 }, { step: 14, hold: 2, semi: 0 }], [{ step: 0, hold: 2, semi: 0 }, { step: 4, hold: 2, semi: 0 }, { step: 10, hold: 2, semi: 12 }, { step: 14, hold: 2, semi: 0 }]],
  cinematic: [[{ step: 0, hold: 16, semi: 0 }], [{ step: 0, hold: 8, semi: 0 }, { step: 8, hold: 8, semi: 7 }]],
}

const MELODY: Record<GeneratorStyle, number[][]> = {
  pop: [[0, 4, 8, 12], [0, 6, 8, 14], [0, 4, 7, 12, 14]],
  trap: [[0, 6, 10], [0, 3, 8, 14], [0, 10, 12]],
  rnb: [[0, 3, 6, 10, 12], [2, 6, 8, 14], [0, 6, 10, 14]],
  lofi: [[0, 8, 12], [0, 6, 10], [0, 12]],
  house: [[0, 4, 8, 12], [0, 2, 4, 6, 8, 10, 12, 14], [2, 6, 10, 14]],
  jazz: [[0, 3, 6, 8, 12], [0, 4, 7, 10, 12], [0, 6, 8, 14]],
  gospel: [[0, 4, 6, 8, 12], [0, 6, 8, 12, 14], [0, 4, 8, 12]],
  drill: [[0, 7, 12], [0, 3, 10], [0, 6, 14]],
  afrobeats: [[2, 6, 10, 14], [0, 6, 8, 14], [0, 4, 10, 14]],
  cinematic: [[0, 8], [0, 4, 12], [0]],
}

const MELODY_OCTAVE: Record<GeneratorStyle, number> = {
  pop: 5, trap: 4, rnb: 4, lofi: 4, house: 5, jazz: 4, gospel: 4, drill: 4, afrobeats: 5, cinematic: 5,
}

const ARP: Record<GeneratorStyle, { direction: Direction; rate: number; octaves: number }[]> = {
  pop: [{ direction: 'up', rate: 2, octaves: 1 }, { direction: 'updown', rate: 2, octaves: 2 }],
  trap: [{ direction: 'broken', rate: 4, octaves: 2 }, { direction: 'down', rate: 2, octaves: 1 }],
  rnb: [{ direction: 'updown', rate: 2, octaves: 1 }, { direction: 'up', rate: 2, octaves: 1 }],
  lofi: [{ direction: 'up', rate: 4, octaves: 1 }, { direction: 'updown', rate: 4, octaves: 1 }],
  house: [{ direction: 'up', rate: 1, octaves: 2 }, { direction: 'broken', rate: 1, octaves: 1 }],
  jazz: [{ direction: 'updown', rate: 2, octaves: 1 }, { direction: 'up', rate: 2, octaves: 2 }],
  gospel: [{ direction: 'up', rate: 2, octaves: 1 }, { direction: 'updown', rate: 2, octaves: 1 }],
  drill: [{ direction: 'broken', rate: 2, octaves: 2 }, { direction: 'down', rate: 4, octaves: 1 }],
  afrobeats: [{ direction: 'up', rate: 2, octaves: 1 }, { direction: 'broken', rate: 2, octaves: 1 }],
  cinematic: [{ direction: 'up', rate: 4, octaves: 2 }, { direction: 'updown', rate: 4, octaves: 2 }],
}

const STRUM: Record<GeneratorStyle, Hit[][]> = {
  pop: [[
    { step: 0, hold: 4, strings: 'all' }, { step: 4, hold: 2, strings: 'all' }, { step: 6, hold: 2, strings: 'high' },
    { step: 8, hold: 4, strings: 'all' }, { step: 12, hold: 2, strings: 'all' }, { step: 14, hold: 2, strings: 'high' },
  ]],
  trap: [[{ step: 0, hold: 10, strings: 'all' }, { step: 12, hold: 4, strings: 'low' }]],
  rnb: [[
    { step: 0, hold: 3, strings: 'all' }, { step: 3, hold: 3, strings: 'high' }, { step: 6, hold: 4, strings: 'all' }, { step: 10, hold: 4, strings: 'high' },
  ]],
  lofi: [[{ step: 0, hold: 8, strings: 'all' }, { step: 8, hold: 6, strings: 'high' }]],
  house: [[{ step: 2, hold: 2, strings: 'all' }, { step: 6, hold: 2, strings: 'high' }, { step: 10, hold: 2, strings: 'all' }, { step: 14, hold: 2, strings: 'high' }]],
  jazz: [[{ step: 4, hold: 3, strings: 'all' }, { step: 12, hold: 3, strings: 'high' }], [{ step: 0, hold: 2, strings: 'low' }, { step: 4, hold: 2, strings: 'all' }, { step: 12, hold: 2, strings: 'all' }]],
  gospel: [[
    { step: 0, hold: 4, strings: 'all' }, { step: 6, hold: 2, strings: 'high' }, { step: 8, hold: 4, strings: 'all' }, { step: 12, hold: 4, strings: 'low' },
  ]],
  drill: [[{ step: 0, hold: 12, strings: 'low' }, { step: 12, hold: 4, strings: 'all' }]],
  afrobeats: [[
    { step: 2, hold: 2, strings: 'all' }, { step: 6, hold: 2, strings: 'high' }, { step: 10, hold: 2, strings: 'all' }, { step: 14, hold: 2, strings: 'high' },
  ]],
  cinematic: [[{ step: 0, hold: 16, strings: 'all' }], [{ step: 0, hold: 8, strings: 'low' }, { step: 8, hold: 8, strings: 'all' }]],
}

const DRUM_PITCH = {
  kick: 36, snare: 38, rim: 37, clap: 39, hat: 42, open: 46, crash: 49, ride: 51, tamb: 54, cow: 56, conga: 62, clave: 75,
} as const

const KIND_OF = new Map(GENERATOR_KINDS.map((kind) => [kind.id, kind]))

export function contextFromScale(root: number, scaleId: ScaleId, chords?: readonly GeneratorChord[]): GeneratorScale {
  return normalizeScaleContext({
    key: pitchClass(root),
    intervals: scaleById(scaleId).intervals,
    chords: chords ?? [],
  })
}

export function normalizeScaleContext(input: Partial<GeneratorScale> | null | undefined): GeneratorScale {
  const key = mod(Math.round(input?.key ?? 0), 12)
  const raw = (input?.intervals ?? [0, 2, 4, 5, 7, 9, 11]).map((interval) => mod(Math.round(interval), 12))
  const intervals = [...new Set(raw.includes(0) ? raw : [0, ...raw])].sort((a, b) => a - b)
  const given = (input?.chords ?? []).map(normalizeChord).filter((chord) => chord.intervals.length > 0)
  return { key, intervals, chords: given.length ? given : diatonicChords(key, intervals) }
}

export function generate(request: GenerateRequest): GeneratedClip {
  const scale = normalizeScaleContext(request.scale)
  const style = STYLE_NAME[request.style] ? request.style : 'pop'
  const kind = KIND_OF.has(request.kind) ? request.kind : 'chords'
  const meta = KIND_OF.get(kind)!
  const tempo = clamp(request.tempo, 40, 300)
  const beatsIn = clamp(request.beatsPerBar, 1, 12)
  const bar16 = Math.max(4, Math.round(beatsIn * 4))
  const bars = 4
  const plan = makePlan(scale, style, tempo, bar16 / 4, bar16, bars, request.seed)
  const built = kind === 'drums' ? buildDrums(plan) : BUILD[kind](plan)
  const notes = built.notes.length ? built.notes : fallback(plan, kind)
  notes.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  return {
    kind,
    style,
    name: `${STYLE_NAME[style]} ${meta.name.toLowerCase()}`,
    track: meta.track,
    color: meta.color,
    instrument: kind === 'drums' ? 'drum-machine' : kind === 'bass' && (style === 'trap' || style === 'drill') ? '808' : 'synth',
    bars,
    beatsPerBar: bar16 / 4,
    notes,
    summary: built.summary || meta.name,
  }
}

function makePlan(scale: GeneratorScale, style: GeneratorStyle, tempo: number, beatsPerBar: number, bar16: number, bars: number, seed: number): Plan {
  const rng = mulberry32(Math.floor(seed) || 1)
  const book = minorScale(scale) ? MINOR[style] : MAJOR[style]
  const degrees = pick(rng, book)
  const chords = Array.from({ length: bars }, (_, index) => chordForDegree(scale, degrees[index % degrees.length]))
  return { scale, style, tempo, beatsPerBar, bars, bar16, total16: bars * bar16, rng, chords }
}

const BUILD: Record<Exclude<GeneratorKind, 'drums'>, (plan: Plan) => { notes: GeneratedNote[]; summary: string }> = {
  chords: buildChords,
  bass: buildBass,
  melody: buildMelody,
  arp: buildArp,
  rhythm: buildStrum,
}

function buildChords(plan: Plan) {
  const rhythm = pick(plan.rng, CHORD_RHYTHM[plan.style])
  const reg = REGISTER[plan.style]
  const bag = collector(plan.total16)
  const labels: string[] = []
  let previous: number[] = []
  const hits = mapHits(rhythm, plan.bar16, plan.bars)
  for (let bar = 0; bar < plan.bars; bar++) {
    const chord = reg.extend ? extended(plan.scale, plan.chords[bar]) : plan.chords[bar]
    const pitches = realize(plan.scale, chord, reg.low, reg.high, previous, plan.style)
    previous = pitches
    labels.push(nameChord(pitches) || chord.label)
    for (const hit of hits) {
      if (Math.floor(hit.start16 / plan.bar16) !== bar) continue
      const velocity = hit.start16 % plan.bar16 === 0 ? 0.86 : 0.74
      for (const pitch of pitches) bag.push(pitch, hit.start16, hit.hold, velocity)
    }
  }
  return { notes: bag.notes, summary: labels.join(' – ') }
}

function buildBass(plan: Plan) {
  const bag = collector(plan.total16)
  if (plan.style === 'jazz') walkBass(plan, bag)
  else {
    const pattern = pick(plan.rng, BASS[plan.style])
    for (const hit of mapHits(pattern, plan.bar16, plan.bars)) {
      const bar = Math.floor(hit.start16 / plan.bar16)
      const root = plan.chords[bar]?.root ?? plan.scale.key
      const pitch = fitPitch(36 + mod(root, 12) + hit.semi, plan.scale, 28, 60)
      bag.push(pitch, hit.start16, hit.hold, hit.start16 % plan.bar16 === 0 ? 0.9 : 0.74)
    }
  }
  return { notes: bag.notes, summary: chordLine(plan) }
}

function walkBass(plan: Plan, bag: ReturnType<typeof collector>) {
  const steps = Math.max(1, Math.round(plan.beatsPerBar))
  const len = Math.max(1, plan.scale.intervals.length)
  for (let bar = 0; bar < plan.bars; bar++) {
    const from = degreeOf(plan.scale, plan.chords[bar].root)
    let dest = degreeOf(plan.scale, plan.chords[(bar + 1) % plan.bars].root)
    if (dest <= from) dest += len
    for (let index = 0; index < steps; index++) {
      const degree = index === steps - 1 && steps > 1 ? dest - 1 : Math.round(from + ((dest - from) * index) / steps)
      const fitted = fitDegree(plan.scale, degree, 2, 28, 55)
      const start = bar * plan.bar16 + Math.round((index * plan.bar16) / steps)
      const next = bar * plan.bar16 + Math.round(((index + 1) * plan.bar16) / steps)
      const gap = next - start > 1 ? 1 : 0
      bag.push(fitted.pitch, start, Math.max(1, next - start - gap), index === 0 ? 0.86 : 0.7)
    }
  }
}

function buildMelody(plan: Plan) {
  let steps = [...pick(plan.rng, MELODY[plan.style])]
  if (plan.tempo >= 146) {
    const thinned = steps.filter((step, index) => step % 4 === 0 || index % 2 === 0)
    if (thinned.length) steps = thinned
  }
  const bag = collector(plan.total16)
  const len = Math.max(1, plan.scale.intervals.length)
  const octave = MELODY_OCTAVE[plan.style]
  const maxHold = plan.style === 'cinematic' ? 16 : plan.style === 'lofi' ? 8 : 4
  let degree = degreeOf(plan.scale, plan.chords[0].root)
  for (let bar = 0; bar < plan.bars; bar++) {
    const targets = chordDegrees(plan.scale, plan.chords[bar])
    const barSteps = mapSteps(steps, plan.bar16).sort((a, b) => a - b)
    barSteps.forEach((step, index) => {
      const strong = step % 4 === 0
      if (strong) degree = nearestDegree(degree, targets, len)
      else {
        const leap = Math.floor(plan.rng() * 5) - 2
        degree += leap === 0 ? (plan.rng() < 0.5 ? -1 : 1) : leap
      }
      const fitted = fitDegree(plan.scale, degree, octave, octave >= 5 ? 64 : 55, 86)
      degree = fitted.degree
      const next = barSteps[index + 1] ?? plan.bar16
      bag.push(fitted.pitch, bar * plan.bar16 + step, Math.max(1, Math.min(maxHold, next - step)), strong ? 0.84 : 0.68)
    })
  }
  return { notes: bag.notes, summary: chordLine(plan) }
}

function buildArp(plan: Plan) {
  const spec = pick(plan.rng, ARP[plan.style])
  const reg = REGISTER[plan.style]
  const low = plan.style === 'trap' || plan.style === 'drill' ? 48 : Math.max(52, reg.low)
  const high = Math.max(reg.high, 84)
  const bag = collector(plan.total16)
  let previous: number[] = []
  for (let bar = 0; bar < plan.bars; bar++) {
    const chord = reg.extend ? extended(plan.scale, plan.chords[bar]) : plan.chords[bar]
    let pitches = realize(plan.scale, chord, low, high, previous, plan.style)
    pitches = spreadOctaves(pitches, spec.octaves, plan.scale, low, high)
    previous = pitches
    const line = arpLine(pitches, spec.direction)
    const rate = Math.max(1, spec.rate)
    let index = 0
    for (let step = 0; step < plan.bar16; step += rate) {
      const pitch = line[index % line.length]
      bag.push(pitch, bar * plan.bar16 + step, Math.min(rate, plan.bar16 - step), step === 0 ? 0.84 : 0.7)
      index += 1
    }
  }
  return { notes: bag.notes, summary: chordLine(plan) }
}

function buildStrum(plan: Plan) {
  const pattern = pick(plan.rng, STRUM[plan.style])
  const reg = REGISTER[plan.style]
  const bag = collector(plan.total16)
  let previous: number[] = []
  const hits = mapHits(pattern, plan.bar16, plan.bars)
  for (let bar = 0; bar < plan.bars; bar++) {
    const chord = reg.extend ? extended(plan.scale, plan.chords[bar]) : plan.chords[bar]
    const pitches = realize(plan.scale, chord, reg.low, reg.high, previous, plan.style)
    previous = pitches
    for (const hit of hits) {
      if (Math.floor(hit.start16 / plan.bar16) !== bar) continue
      const velocity = hit.strings === 'low' ? 0.8 : hit.start16 % plan.bar16 === 0 ? 0.86 : 0.7
      for (const pitch of voiced(pitches, hit.strings)) bag.push(pitch, hit.start16, hit.hold, velocity)
    }
  }
  return { notes: bag.notes, summary: chordLine(plan) }
}

function buildDrums(plan: Plan) {
  const variant = Math.floor(plan.rng() * 3)
  const bag = collector(plan.total16)
  for (const row of drumRows(plan.style, variant, plan.tempo)) {
    for (let bar = 0; bar < plan.bars; bar++) {
      if (row.bars === 'first' && bar !== 0) continue
      if (row.bars === 'even' && bar % 2 !== 0) continue
      for (const step of mapSteps(row.steps, plan.bar16)) {
        bag.push(row.pitch, bar * plan.bar16 + step, 1, row.velocity)
      }
    }
  }
  return { notes: bag.notes, summary: `${STYLE_NAME[plan.style]} drums` }
}

function drumRows(style: GeneratorStyle, variant: number, tempo: number): DrumRow[] {
  const hats = tempo < 100 ? [0, 2, 4, 6, 8, 10, 12, 14] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
  const hatVel = (steps: number[], velocity = 0.42): DrumRow => ({ pitch: DRUM_PITCH.hat, steps, velocity })
  if (style === 'trap') {
    const kicks = [[0, 6, 10], [0, 7, 12], [0, 3, 8, 14]]
    return [
      { pitch: DRUM_PITCH.kick, steps: kicks[variant % 3], velocity: 0.92 },
      { pitch: DRUM_PITCH.snare, steps: [8], velocity: 0.88 },
      hatVel(hats, 0.4),
      { pitch: DRUM_PITCH.open, steps: tempo >= 100 ? [14] : [], velocity: 0.5 },
    ]
  }
  if (style === 'drill') {
    const kicks = [[0, 3, 6, 10], [0, 6, 8, 13], [0, 4, 10, 14]]
    const snares = [[8], [8, 14], [8, 15]]
    return [
      { pitch: DRUM_PITCH.kick, steps: kicks[variant % 3], velocity: 0.93 },
      { pitch: DRUM_PITCH.snare, steps: snares[variant % 3], velocity: 0.9 },
      hatVel(hats, 0.38),
    ]
  }
  if (style === 'house') {
    return [
      { pitch: DRUM_PITCH.kick, steps: [0, 4, 8, 12], velocity: 0.94 },
      { pitch: DRUM_PITCH.clap, steps: [4, 12], velocity: 0.78 },
      { pitch: DRUM_PITCH.open, steps: tempo >= 150 ? [6, 14] : [2, 6, 10, 14], velocity: 0.55 },
      { pitch: DRUM_PITCH.crash, steps: [0], velocity: 0.6, bars: 'first' },
    ]
  }
  if (style === 'jazz') {
    return [
      { pitch: DRUM_PITCH.ride, steps: [0, 3, 4, 7, 8, 11, 12, 15], velocity: 0.48 },
      { pitch: DRUM_PITCH.rim, steps: [4, 12], velocity: 0.36 },
      { pitch: DRUM_PITCH.kick, steps: variant === 1 ? [0, 8] : [0, 10], velocity: 0.55 },
    ]
  }
  if (style === 'gospel') {
    return [
      { pitch: DRUM_PITCH.kick, steps: variant === 2 ? [0, 8] : [0, 6, 8], velocity: 0.88 },
      { pitch: DRUM_PITCH.snare, steps: [4, 12], velocity: 0.8 },
      hatVel([0, 2, 4, 6, 8, 10, 12, 14], 0.4),
      { pitch: DRUM_PITCH.crash, steps: [0], velocity: 0.62, bars: 'first' },
    ]
  }
  if (style === 'lofi') {
    return [
      { pitch: DRUM_PITCH.kick, steps: [0, 10], velocity: 0.7 },
      { pitch: DRUM_PITCH.snare, steps: [4, 12], velocity: 0.5 },
      hatVel([0, 3, 4, 7, 8, 11, 12, 15], 0.32),
    ]
  }
  if (style === 'rnb') {
    const kicks = [[0, 7, 10], [0, 6, 11], [0, 3, 10]]
    return [
      { pitch: DRUM_PITCH.kick, steps: kicks[variant % 3], velocity: 0.84 },
      { pitch: DRUM_PITCH.snare, steps: [4, 12], velocity: 0.72 },
      hatVel([0, 2, 4, 6, 8, 10, 12, 14], 0.36),
      { pitch: DRUM_PITCH.rim, steps: [3, 11], velocity: 0.28 },
    ]
  }
  if (style === 'afrobeats') {
    return [
      { pitch: DRUM_PITCH.kick, steps: variant === 1 ? [0, 6, 8, 14] : [0, 6, 10], velocity: 0.86 },
      { pitch: DRUM_PITCH.snare, steps: [4, 12], velocity: 0.7 },
      hatVel([2, 6, 10, 14], 0.45),
      { pitch: DRUM_PITCH.conga, steps: [0, 3, 8, 11], velocity: 0.5 },
      { pitch: DRUM_PITCH.cow, steps: [0, 6, 10], velocity: 0.4 },
    ]
  }
  if (style === 'cinematic') {
    return [
      { pitch: DRUM_PITCH.kick, steps: [0], velocity: 0.9, bars: 'even' },
      { pitch: DRUM_PITCH.snare, steps: [8], velocity: 0.4, bars: 'even' },
      { pitch: DRUM_PITCH.crash, steps: [0], velocity: 0.55, bars: 'first' },
      { pitch: DRUM_PITCH.tamb, steps: [0, 8], velocity: 0.28 },
    ]
  }
  const kicks = [[0, 8], [0, 8, 10], [0, 4, 8]]
  return [
    { pitch: DRUM_PITCH.kick, steps: kicks[variant % 3], velocity: 0.88 },
    { pitch: DRUM_PITCH.snare, steps: [4, 12], velocity: 0.8 },
    hatVel([0, 2, 4, 6, 8, 10, 12, 14], 0.4),
    { pitch: DRUM_PITCH.crash, steps: [0], velocity: 0.58, bars: 'first' },
  ]
}

function fallback(plan: Plan, kind: GeneratorKind): GeneratedNote[] {
  const bag = collector(plan.total16)
  if (kind === 'drums') bag.push(DRUM_PITCH.kick, 0, 1, 0.8)
  else bag.push(snapToScale(60 + plan.scale.key, plan.scale), 0, Math.min(plan.bar16, plan.total16), 0.8)
  return bag.notes
}

function chordLine(plan: Plan) {
  return plan.chords.map((chord) => chord.label).join(' – ')
}

function minorScale(scale: GeneratorScale) {
  const has = (interval: number) => scale.intervals.some((item) => item === interval)
  if (has(3) && !has(4)) return true
  if (has(4) && !has(3)) return false
  return has(3) || has(8)
}

function diatonicChords(key: number, intervals: readonly number[]): GeneratorChord[] {
  const len = intervals.length
  if (!len) return [{ label: 'C', root: key, intervals: [0], degree: 0 }]
  const count = len >= 7 ? 7 : len
  const chords: GeneratorChord[] = []
  for (let degree = 0; degree < count; degree++) {
    const root = intervals[degree % len]
    const steps = len >= 3 ? [0, 2, 4] : [0]
    const stacked = steps.map((step) => {
      const index = degree + step
      const wrapped = mod(index, len)
      const octaves = Math.floor(index / len)
      let interval = intervals[wrapped] + octaves * 12 - root
      if (interval < 0) interval += 12
      return interval
    })
    const unique = [...new Set(stacked)].sort((a, b) => a - b)
    const midi = unique.map((interval) => 60 + key + root + interval)
    chords.push({
      label: nameChord(midi) || 'Chord',
      root: mod(key + root, 12),
      intervals: unique,
      degree,
    })
  }
  return chords
}

function normalizeChord(chord: GeneratorChord): GeneratorChord {
  const intervals = [...new Set((chord.intervals ?? []).map((interval) => Math.round(interval)).filter((interval) => Number.isFinite(interval)))].sort((a, b) => a - b)
  return {
    label: chord.label || 'Chord',
    root: mod(Math.round(chord.root ?? 0), 12),
    intervals,
    degree: Number.isFinite(chord.degree) ? Math.round(chord.degree as number) : undefined,
  }
}

function chordForDegree(scale: GeneratorScale, degree: number): GeneratorChord {
  const chords = scale.chords
  const exact = chords.find((chord) => chord.degree === degree)
  if (exact) return exact
  const ranked = chords.filter((chord) => chord.degree != null)
  if (ranked.length) {
    return ranked.reduce((best, chord) => Math.abs((chord.degree ?? 0) - degree) < Math.abs((best.degree ?? 0) - degree) ? chord : best)
  }
  return chords[mod(degree, Math.max(1, chords.length))] ?? { label: 'Chord', root: scale.key, intervals: [0, 4, 7], degree: 0 }
}

function extended(scale: GeneratorScale, chord: GeneratorChord): GeneratorChord {
  const len = scale.intervals.length
  if (len < 5) return chord
  const ext = degreeOf(scale, chord.root) + 6
  const wrapped = mod(ext, len)
  const octaves = Math.floor(ext / len)
  const rootRel = mod(chord.root - scale.key, 12)
  let interval = scale.intervals[wrapped] + octaves * 12 - rootRel
  while (interval < 0) interval += 12
  while (interval > 14) interval -= 12
  if (chord.intervals.some((item) => mod(item, 12) === mod(interval, 12))) return chord
  return { ...chord, intervals: [...chord.intervals, interval].sort((a, b) => a - b) }
}

function realize(scale: GeneratorScale, chord: GeneratorChord, low: number, high: number, previous: number[], style: GeneratorStyle) {
  const root = mod(chord.root, 12)
  let base = low - mod(low, 12) + root
  if (base < low) base += 12
  const raw = chord.intervals.map((interval) => fitPitch(base + interval, scale, low, high))
  let pitches = unique(raw)
  if (!pitches.length) pitches = [fitPitch(base, scale, low, high)]
  const led = voiceChord(pitches, {
    voiceLead: previous.length > 0,
    previous,
    spread: style === 'cinematic',
    octave: style === 'cinematic' || style === 'gospel',
  }).map((pitch) => fitPitch(pitch, scale, low, high))
  pitches = unique(led)
  return pitches.length ? pitches : [snapToScale(base, scale)]
}

function spreadOctaves(pitches: number[], octaves: number, scale: GeneratorScale, low: number, high: number) {
  const out: number[] = []
  const count = Math.max(1, Math.min(3, octaves))
  for (let octave = 0; octave < count; octave++) {
    for (const pitch of pitches) out.push(fitPitch(pitch + octave * 12, scale, low, high))
  }
  return unique(out)
}

function voiced(pitches: number[], strings: Strings) {
  if (!pitches.length) return []
  if (strings === 'low') return [pitches[0]]
  if (strings === 'high') return pitches.slice(Math.max(0, pitches.length - 2))
  return pitches
}

function arpLine(pitches: number[], direction: Direction) {
  const sorted = [...pitches].sort((a, b) => a - b)
  if (!sorted.length) return [60]
  if (direction === 'down') return [...sorted].reverse()
  if (direction === 'updown') {
    if (sorted.length === 1) return sorted
    return [...sorted, ...[...sorted].reverse().slice(1, -1)]
  }
  if (direction === 'broken') return [0, 2, 1, 2].map((index) => sorted[index % sorted.length])
  return sorted
}

function chordDegrees(scale: GeneratorScale, chord: GeneratorChord) {
  const degrees = chord.intervals.map((interval) => degreeOf(scale, mod(chord.root + interval, 12)))
  return degrees.length ? degrees : [degreeOf(scale, chord.root)]
}

function nearestDegree(current: number, targets: number[], len: number) {
  const span = Math.max(1, len)
  let best = current
  let dist = 99
  for (const target of targets) {
    const base = target + Math.round((current - target) / span) * span
    for (const cand of [base - span, base, base + span]) {
      const delta = Math.abs(cand - current)
      if (delta < dist) {
        dist = delta
        best = cand
      }
    }
  }
  return best
}

function degreeOf(scale: GeneratorScale, pc: number) {
  const rel = mod(pc - scale.key, 12)
  const exact = scale.intervals.indexOf(rel)
  if (exact >= 0) return exact
  let best = 0
  let bestDist = 99
  scale.intervals.forEach((interval, index) => {
    const dist = Math.min(mod(rel - interval, 12), mod(interval - rel, 12))
    if (dist < bestDist) {
      bestDist = dist
      best = index
    }
  })
  return best
}

function pitchAtDegree(scale: GeneratorScale, degree: number, octave: number) {
  const intervals = scale.intervals.length ? scale.intervals : [0]
  const len = intervals.length
  const wrapped = mod(degree, len)
  const shift = Math.floor(degree / len)
  return snapToScale((octave + shift + 1) * 12 + scale.key + intervals[wrapped], scale)
}

function fitDegree(scale: GeneratorScale, degree: number, octave: number, low: number, high: number) {
  const len = Math.max(1, scale.intervals.length)
  let next = degree
  let pitch = pitchAtDegree(scale, next, octave)
  let guard = 0
  while (pitch > high && guard++ < 8) {
    next -= len
    pitch = pitchAtDegree(scale, next, octave)
  }
  guard = 0
  while (pitch < low && guard++ < 8) {
    next += len
    pitch = pitchAtDegree(scale, next, octave)
  }
  return { pitch, degree: next }
}

export function snapToScale(pitch: number, scale: GeneratorScale) {
  const intervals = scale.intervals.length ? scale.intervals : [0]
  const rounded = Math.round(pitch)
  let best = rounded
  let bestDist = 99
  for (let candidate = rounded - 6; candidate <= rounded + 6; candidate++) {
    if (!intervals.some((interval) => interval === mod(candidate - scale.key, 12))) continue
    const dist = Math.abs(candidate - rounded)
    if (dist < bestDist || (dist === bestDist && candidate < best)) {
      best = candidate
      bestDist = dist
    }
  }
  return Math.max(0, Math.min(127, best))
}

function fitPitch(pitch: number, scale: GeneratorScale, low: number, high: number) {
  let next = snapToScale(pitch, scale)
  let guard = 0
  while (next < low && guard++ < 8) next = snapToScale(next + 12, scale)
  guard = 0
  while (next > high && guard++ < 8) next = snapToScale(next - 12, scale)
  return Math.max(0, Math.min(127, next))
}

function mapHits(pattern: Hit[], bar16: number, bars: number): Placed[] {
  const out: Placed[] = []
  for (let bar = 0; bar < bars; bar++) {
    for (const step of place(pattern, bar16)) {
      out.push({ start16: bar * bar16 + step.start, hold: step.hold, strings: step.strings, semi: step.semi })
    }
  }
  return out
}

function place(pattern: Hit[], bar16: number) {
  const out: { start: number; hold: number; strings: Strings; semi: number }[] = []
  const seen = new Set<number>()
  const cycles = Math.max(1, Math.ceil(bar16 / 16))
  for (let cycle = 0; cycle < cycles; cycle++) {
    const origin = cycle * 16
    const room = bar16 - origin
    if (room <= 0) break
    const window = Math.min(16, room)
    for (const hit of pattern) {
      const start = origin + Math.round((hit.step * window) / 16)
      if (start < origin || start >= bar16 || seen.has(start)) continue
      seen.add(start)
      const hold = Math.max(1, Math.min(Math.round((hit.hold * window) / 16), bar16 - start))
      out.push({ start, hold, strings: hit.strings ?? 'all', semi: hit.semi ?? 0 })
    }
  }
  return out
}

function mapSteps(steps: number[], bar16: number) {
  return place(steps.map((step) => ({ step, hold: 1 })), bar16).map((hit) => hit.start)
}

function collector(total16: number) {
  const notes: GeneratedNote[] = []
  const seen = new Set<string>()
  return {
    notes,
    push(pitch: number, start16: number, hold: number, velocity: number) {
      const start = Math.max(0, Math.round(start16))
      if (start >= total16) return
      const dur = Math.max(1, Math.min(Math.round(hold), total16 - start))
      const key = `${Math.round(pitch)}:${start}`
      if (seen.has(key)) return
      seen.add(key)
      notes.push({
        pitch: Math.max(0, Math.min(127, Math.round(pitch))),
        startBeat: start / 4,
        durationBeats: dur / 4,
        velocity: Math.min(0.95, Math.max(0.15, velocity)),
      })
    },
  }
}

function unique(pitches: number[]) {
  return [...new Set(pitches.map((pitch) => Math.round(pitch)))].sort((a, b) => a - b)
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length))
  return items[Math.max(0, index)]
}

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let next = Math.imul(state ^ (state >>> 15), 1 | state)
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function mod(value: number, span: number) {
  if (span <= 0) return 0
  return ((Math.trunc(value) % span) + span) % span
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export const DRUM_PITCHES = DRUM_PADS.map((pad) => pad.pitch)
