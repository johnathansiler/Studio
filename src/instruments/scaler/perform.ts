import type { KeysLock, ScalerNote, VoiceGroup } from './types'
import { expressNotes } from './face'
import { lockedTone, pitchRole } from '../../theory/lock'
import { renderStyled, type PlayStyle, type VariationContext } from './vary'
import type { GenrePack } from './catalog/library'

export const KEYS_LOCKS = ['off', 'scale-snap', 'scale-hide', 'chord', 'chord-notes', 'one-finger'] as const
export type { KeysLock, VoiceGroup } from './types'

export const KEYS_LOCK_LABELS: Record<KeysLock, string> = {
  off: 'Off',
  'scale-snap': 'Scale snap',
  'scale-hide': 'Scale hide',
  chord: 'Chord lock',
  'chord-notes': 'Chord notes',
  'one-finger': 'One finger',
}

export interface ExpressionPreset {
  id: string
  name: string
  hint: string
}

export const EXPRESSIONS: ExpressionPreset[] = [
  { id: 'still', name: 'Still', hint: 'Even velocity, no push.' },
  { id: 'animando', name: 'Animando', hint: 'Notes bloom one after another.' },
  { id: 'push', name: 'Push', hint: 'Louder and shorter, leaning forward.' },
  { id: 'laid', name: 'Laid back', hint: 'Notes sit a little behind the beat.' },
  { id: 'swing', name: 'Swing', hint: 'Offbeats land late.' },
  { id: 'human', name: 'Human', hint: 'Small timing and velocity differences.' },
  { id: 'strum', name: 'Strum', hint: 'A slow spread, low note to high note.' },
  { id: 'tight', name: 'Tight', hint: 'Shorter notes, a bit louder.' },
]

export interface PatternSpec {
  id: string
  name: string
  category: 'Arpeggio' | 'Strum' | 'Rhythm' | 'Bassline' | 'Melody' | 'Comping'
  kind: 'arp' | 'strum' | 'chord' | 'bass' | 'melody' | 'comp'
  /** Arpeggio and melody: chord-tone indexes. Chord and comp: hit times in beats. Strum: direction per pass. */
  steps: number[]
  rate: number
}

export interface PerformanceSpec {
  id: string
  name: string
  category: PatternSpec['category']
  style: string
  patternId: string
  rate: number
  swing: number
}

const GRIDS: PatternSpec[] = [
  { id: 'arp-up', name: 'Up', category: 'Arpeggio', kind: 'arp', steps: [0, 1, 2, 3], rate: 0.5 },
  { id: 'arp-down', name: 'Down', category: 'Arpeggio', kind: 'arp', steps: [3, 2, 1, 0], rate: 0.5 },
  { id: 'arp-updown', name: 'Up down', category: 'Arpeggio', kind: 'arp', steps: [0, 1, 2, 3, 2, 1], rate: 0.5 },
  { id: 'arp-broken', name: 'Broken', category: 'Arpeggio', kind: 'arp', steps: [0, 2, 1, 3], rate: 0.5 },
  { id: 'arp-octave', name: 'Octave', category: 'Arpeggio', kind: 'arp', steps: [0, 1, 2, 0], rate: 0.25 },
  { id: 'strum-down', name: 'Down strum', category: 'Strum', kind: 'strum', steps: [1], rate: 1 },
  { id: 'strum-up', name: 'Up strum', category: 'Strum', kind: 'strum', steps: [-1], rate: 1 },
  { id: 'strum-folk', name: 'Folk strum', category: 'Strum', kind: 'strum', steps: [1, -1, 1, -1], rate: 1 },
  { id: 'strum-reggae', name: 'Reggae chop', category: 'Strum', kind: 'chord', steps: [0.5, 1.5, 2.5, 3.5], rate: 1 },
  { id: 'rhythm-block', name: 'Block', category: 'Rhythm', kind: 'chord', steps: [0], rate: 1 },
  { id: 'rhythm-pulse', name: 'Pulse', category: 'Rhythm', kind: 'chord', steps: [0, 1, 2, 3], rate: 1 },
  { id: 'rhythm-sync', name: 'Syncopation', category: 'Rhythm', kind: 'chord', steps: [0, 1.5, 2.5], rate: 1 },
  { id: 'rhythm-off', name: 'Offbeat', category: 'Rhythm', kind: 'chord', steps: [0.5, 1.5, 2.5, 3.5], rate: 1 },
  { id: 'bass-root', name: 'Roots', category: 'Bassline', kind: 'bass', steps: [0, 2], rate: 1 },
  { id: 'bass-five', name: 'Root five', category: 'Bassline', kind: 'bass', steps: [0, 1, 2, 3], rate: 1 },
  { id: 'bass-octave', name: 'Octave bass', category: 'Bassline', kind: 'bass', steps: [0, 1, 2, 3], rate: 0.5 },
  { id: 'bass-walk', name: 'Walking', category: 'Bassline', kind: 'bass', steps: [0, 1, 2, 3], rate: 1 },
  { id: 'melody-chord', name: 'Chord tones', category: 'Melody', kind: 'melody', steps: [0, 1, 2, 1], rate: 1 },
  { id: 'melody-leap', name: 'Leap', category: 'Melody', kind: 'melody', steps: [0, 2, 1, 3], rate: 1 },
  { id: 'melody-neighbor', name: 'Neighbor', category: 'Melody', kind: 'melody', steps: [1, 0, 1, 2], rate: 0.5 },
  { id: 'melody-sustain', name: 'Sustain', category: 'Melody', kind: 'melody', steps: [2], rate: 4 },
  { id: 'comp-shell', name: 'Shells', category: 'Comping', kind: 'comp', steps: [0, 2], rate: 1 },
  { id: 'comp-stab', name: 'Stabs', category: 'Comping', kind: 'comp', steps: [0, 1.5, 3], rate: 1 },
  { id: 'comp-push', name: 'Push', category: 'Comping', kind: 'comp', steps: [0, 0.75, 2, 2.75], rate: 1 },
  { id: 'comp-back', name: 'Backbeat', category: 'Comping', kind: 'comp', steps: [1, 3], rate: 1 },
]

const BASS_TONE: Record<string, number[]> = {
  'bass-root': [0, 0],
  'bass-five': [0, 2, 0, 2],
  'bass-octave': [0, 0, 0, 0],
  'bass-walk': [0, 1, 2, 1],
}

const BASS_OCTAVE: Record<string, number[]> = {
  'bass-root': [0, 0],
  'bass-five': [0, 0, 0, 0],
  'bass-octave': [0, 1, 0, 1],
  'bass-walk': [0, 0, 0, 0],
}

const STYLES: { id: string; name: string; swing: number; rate: number }[] = [
  { id: 'pop', name: 'Pop', swing: 0, rate: 1 },
  { id: 'jazz', name: 'Jazz', swing: 0.22, rate: 1 },
  { id: 'latin', name: 'Latin', swing: 0.08, rate: 1 },
  { id: 'gospel', name: 'Gospel', swing: 0.1, rate: 0.85 },
  { id: 'trap', name: 'Trap', swing: 0, rate: 0.5 },
  { id: 'afrobeats', name: 'Afrobeats', swing: 0.05, rate: 0.75 },
  { id: 'rock', name: 'Rock', swing: 0, rate: 1 },
  { id: 'lofi', name: 'Lo-fi', swing: 0.14, rate: 1.1 },
  { id: 'edm', name: 'EDM', swing: 0, rate: 0.5 },
  { id: 'film', name: 'Film', swing: 0, rate: 1.4 },
]

const GRID_BY_ID = new Map(GRIDS.map((grid) => [grid.id, grid]))

let performances: PerformanceSpec[] | null = null

export function patternCatalog() {
  return GRIDS
}

export function performanceCatalog(): PerformanceSpec[] {
  if (!performances) {
    performances = STYLES.flatMap((style) => GRIDS.map((grid) => ({
      id: `${style.id}-${grid.id}`,
      name: `${style.name} ${grid.name}`,
      category: grid.category,
      style: style.name,
      patternId: grid.id,
      rate: Math.max(0.125, grid.rate * style.rate),
      swing: style.swing,
    })))
  }
  return performances
}

export function performanceById(id: string) {
  return performanceCatalog().find((item) => item.id === id) ?? null
}

export function renderPerformance(
  tones: { midi: number; cents: number }[],
  performanceId: string,
  spanBeats: number,
  rate = 0.5,
  swingAdd = 0,
  context?: Partial<VariationContext>,
): ScalerNote[] {
  const styled = styleById(performanceId)
  if (styled) return renderStyled(styled, tones, spanBeats, rate, swingAdd, context)
  const spec = performanceById(performanceId)
  const grid = spec ? GRID_BY_ID.get(spec.patternId) : undefined
  if (!spec || !grid || !tones.length) return []
  const span = Math.max(0.25, spanBeats)
  const speed = Math.max(0.25, rate / 0.5)
  const swing = clamp(spec.swing + swingAdd, 0, 0.7)
  if (grid.kind === 'strum') return strum(tones, grid.steps, span)
  if (grid.kind === 'chord') return hits(tones, grid.steps, span, swing, (tone) => tone)
  if (grid.kind === 'comp') return comp(tones, grid.steps, span, swing, grid.id === 'comp-shell')
  if (grid.kind === 'bass') return line(tones, grid, span, swing, true)
  if (grid.kind === 'melody') return line(tones, grid, span, swing, false)
  return arp(tones, grid.steps, span, Math.max(0.125, spec.rate * speed), swing)
}

/** Still, Animando, and Push keep the original amounts. The rest add feel. */
export function applyExpression(notes: ScalerNote[], id: string): ScalerNote[] {
  if (id === 'animando') return expressNotes(notes, 1)
  if (id === 'push') return expressNotes(notes, 2)
  if (id === 'laid') {
    return notes.map((note, index) => ({
      ...note,
      startBeat: note.startBeat + 0.04 + (index % 2) * 0.02,
      velocity: clamp(note.velocity * 0.9, 0.05, 1),
    }))
  }
  if (id === 'swing') {
    return notes.map((note) => {
      const late = Math.round(note.startBeat * 2) % 2 === 1
      return { ...note, startBeat: note.startBeat + (late ? 0.06 : 0), velocity: clamp(note.velocity * (late ? 0.86 : 1), 0.05, 1) }
    })
  }
  if (id === 'human') {
    return notes.map((note, index) => ({
      ...note,
      startBeat: Math.max(0, note.startBeat + ((note.pitch + index) % 5 - 2) * 0.012),
      velocity: clamp(note.velocity * (0.86 + (note.pitch % 7) * 0.03), 0.05, 1),
    }))
  }
  if (id === 'strum') {
    return notes.map((note, index) => ({
      ...note,
      startBeat: note.startBeat + index * 0.045,
      velocity: clamp(note.velocity * (0.82 + Math.min(0.2, index * 0.04)), 0.05, 1),
    }))
  }
  if (id === 'tight') {
    return notes.map((note) => ({
      ...note,
      durationBeats: Math.max(0.05, note.durationBeats * 0.55),
      velocity: clamp(note.velocity * 1.06, 0.05, 1),
    }))
  }
  return expressNotes(notes, 0)
}

/** Timing and velocity. Amount 0 leaves the chord locked together. */
export function humanizeNotes(notes: ScalerNote[], amount: number): ScalerNote[] {
  if (amount <= 0) return notes.map((note) => ({ ...note }))
  const depth = amount === 1 ? 0.015 : 0.04
  return notes.map((note, index) => {
    const sway = amount === 1 ? 0.92 + (note.pitch % 5) * 0.02 : 0.78 + (note.pitch % 7) * 0.04
    return {
      ...note,
      startBeat: Math.max(0, note.startBeat + ((note.pitch + index * 3) % 5 - 2) * depth),
      velocity: clamp(note.velocity * sway, 0.05, 1),
    }
  })
}

export function applyVoiceGroup<T extends { midi: number }>(tones: T[], group: VoiceGroup): T[] {
  if (!tones.length || group === 'all' || group === 'dynamic') return tones
  const ordered = tones.slice().sort((a, b) => a.midi - b.midi)
  if (group === 'bass') return ordered.slice(0, 1)
  return ordered.slice(1)
}

export interface LockRequest {
  mode: KeysLock
  midi: number
  root: number
  scale: string
  library: string
  chordPcs: number[]
  /** Diatonic chords, root position, for chord lock. White keys pick these in order from C. */
  chords: { midi: number; cents: number }[][]
  /** Current chord, for one-finger and chord-notes. */
  current: { midi: number; cents: number }[]
}

export interface LockedNote {
  midi: number
  cents: number
}

const WHITES = [0, 2, 4, 5, 7, 9, 11]

/** Keys lock for the on-screen piano, pads, the computer keyboard, and MIDI keyboards. */
export function applyKeysLock(input: LockRequest): { notes: LockedNote[] | null; hidden: boolean } {
  const mode = input.mode
  if (mode === 'off') return { notes: [{ midi: input.midi, cents: 0 }], hidden: false }
  const scaleId = input.library || input.scale
  if (mode === 'scale-snap') {
    const tone = lockedTone(input.midi, 0, { root: input.root, scale: input.scale, library: input.library })
    return { notes: [{ midi: tone.midi, cents: tone.cents }], hidden: false }
  }
  if (mode === 'scale-hide') {
    if (pitchRole(input.midi, 0, input.root, scaleId) === 'out') return { notes: null, hidden: true }
    const tone = lockedTone(input.midi, 0, { root: input.root, scale: input.scale, library: input.library })
    return { notes: [{ midi: tone.midi, cents: tone.cents }], hidden: false }
  }
  if (mode === 'chord-notes') {
    const pcs = input.chordPcs.length ? input.chordPcs : input.current.map((tone) => mod12(tone.midi))
    if (pcs.length && !pcs.includes(mod12(input.midi))) return { notes: null, hidden: true }
    return { notes: [{ midi: input.midi, cents: 0 }], hidden: false }
  }
  if (mode === 'chord') {
    const pc = mod12(input.midi)
    if (!WHITES.includes(pc)) return { notes: null, hidden: true }
    const list = input.chords.filter((chord) => chord.length).slice(0, 7)
    const chord = list[WHITES.indexOf(pc) % Math.max(1, list.length)]
    if (!chord?.length) return { notes: [{ midi: input.midi, cents: 0 }], hidden: false }
    return { notes: nearOctave(chord, input.midi), hidden: false }
  }
  const source = input.current.length ? input.current : [{ midi: 60, cents: 0 }, { midi: 64, cents: 0 }, { midi: 67, cents: 0 }]
  const target = lockedTone(input.midi, 0, { root: input.root, scale: input.scale, library: input.library })
  const origin = source[0]?.midi ?? target.midi
  const shift = target.midi - origin
  return {
    notes: source.map((tone) => ({ midi: clamp(tone.midi + shift, 0, 127), cents: tone.cents || 0 })),
    hidden: false,
  }
}

export function lockPadNotes(notes: ScalerNote[], mode: KeysLock, root: number, scale: string, library: string): ScalerNote[] {
  if (mode === 'off' || mode === 'chord' || mode === 'chord-notes' || mode === 'one-finger') return notes
  const scaleId = library || scale
  if (mode === 'scale-hide') return notes.filter((note) => pitchRole(note.pitch, note.fine ?? 0, root, scaleId) !== 'out')
  return notes.map((note) => {
    const tone = lockedTone(note.pitch, note.fine ?? 0, { root, scale, library })
    return { ...note, pitch: tone.midi, fine: tone.cents ? Math.round(tone.cents) : undefined }
  })
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items.slice()
  const next = items.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function arp(tones: { midi: number; cents: number }[], steps: number[], span: number, step: number, swing: number): ScalerNote[] {
  const count = Math.max(1, Math.floor(span / step))
  const notes: ScalerNote[] = []
  for (let i = 0; i < count; i++) {
    const tone = tones[steps[i % steps.length] % tones.length]
    let start = i * step
    if (i % 2 === 1) start += swing * step * 0.5
    if (start >= span - 0.02) break
    notes.push(toneNote(tone, start, Math.max(0.05, Math.min(step * 0.92, span - start)), i % 2 === 0 ? 0.86 : 0.74))
  }
  return notes
}

function strum(tones: { midi: number; cents: number }[], directions: number[], span: number): ScalerNote[] {
  const dirs = directions.length ? directions : [1]
  const gap = span / dirs.length
  const notes: ScalerNote[] = []
  dirs.forEach((dir, pass) => {
    const ordered = dir < 0 ? tones.slice().reverse() : tones
    ordered.forEach((tone, index) => {
      const start = pass * gap + index * 0.03
      if (start >= span) return
      notes.push(toneNote(tone, start, Math.max(0.2, span - start), clamp(0.72 + index * 0.04, 0.05, 1)))
    })
  })
  return notes
}

function hits(
  tones: { midi: number; cents: number }[],
  times: number[],
  span: number,
  swing: number,
  pick: (tone: { midi: number; cents: number }, index: number) => { midi: number; cents: number },
): ScalerNote[] {
  const notes: ScalerNote[] = []
  for (const hit of times) {
    if (hit >= span) continue
    const late = Math.round(hit * 2) % 2 === 1
    const start = hit + (late ? swing * 0.35 : 0)
    tones.forEach((tone, index) => {
      notes.push(toneNote(pick(tone, index), start, Math.max(0.08, Math.min(0.95, span - start)), late ? 0.74 : 0.86))
    })
  }
  return notes
}

function comp(tones: { midi: number; cents: number }[], times: number[], span: number, swing: number, shell: boolean): ScalerNote[] {
  const chosen = shell && tones.length > 2 ? [tones[0], tones[tones.length - 1]] : tones
  return hits(chosen, times, span, swing, (tone) => tone)
}

function line(tones: { midi: number; cents: number }[], grid: PatternSpec, span: number, swing: number, bass: boolean): ScalerNote[] {
  const beats = grid.steps
  const indexes = bass ? (BASS_TONE[grid.id] ?? beats.map((_, index) => index % tones.length)) : grid.steps
  const octaves = bass ? (BASS_OCTAVE[grid.id] ?? beats.map(() => 0)) : beats.map(() => 0)
  const notes: ScalerNote[] = []
  const step = span / Math.max(1, beats.length)
  beats.forEach((beat, index) => {
    const at = bass || grid.kind === 'melody' ? (grid.kind === 'melody' ? index * Math.max(0.25, grid.rate) : beat) : beat
    if (grid.kind === 'melody' && at >= span) return
    if (grid.kind === 'bass' && beat >= span) return
    const tone = tones[Math.abs(indexes[index] ?? 0) % tones.length]
    const late = index % 2 === 1
    const start = (grid.kind === 'bass' ? beat : at) + (late ? swing * 0.3 : 0)
    if (start >= span) return
    const midi = clamp(tone.midi + (octaves[index] ?? 0) * 12, 0, 127)
    const duration = grid.kind === 'melody' && grid.steps.length === 1 ? span : Math.max(0.08, Math.min(step * 0.95, span - start))
    notes.push({
      pitch: midi,
      fine: tone.cents ? Math.round(tone.cents) : undefined,
      startBeat: start,
      durationBeats: duration,
      velocity: late ? 0.72 : 0.84,
    })
  })
  return notes
}

function toneNote(tone: { midi: number; cents: number }, start: number, duration: number, velocity: number): ScalerNote {
  return {
    pitch: tone.midi,
    fine: tone.cents ? Math.round(tone.cents) : undefined,
    startBeat: start,
    durationBeats: duration,
    velocity,
  }
}

function nearOctave(tones: { midi: number; cents: number }[], anchor: number): LockedNote[] {
  const low = Math.min(...tones.map((tone) => tone.midi))
  const shift = Math.round((anchor - low) / 12) * 12
  return tones.map((tone) => ({ midi: clamp(tone.midi + shift, 0, 127), cents: tone.cents || 0 }))
}

function mod12(midi: number) {
  return ((midi % 12) + 12) % 12
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

let styles: PlayStyle[] | null = null
let packs: GenrePack[] | null = null
let loading: Promise<void> | null = null

/** Lazy catalog of play styles and genre packs. Safe to call more than once. */
export function loadPerformanceLibrary(): Promise<void> {
  if (!loading) {
    loading = import('./catalog/library').then((mod) => {
      styles = mod.PLAY_STYLES
      packs = mod.GENRE_PACKS
    })
  }
  return loading
}

export function styleCatalog(): PlayStyle[] {
  return styles ?? []
}

export function packCatalog(): GenrePack[] {
  return packs ?? []
}

export function styleById(id: string) {
  return styles?.find((item) => item.id === id) ?? null
}

void loadPerformanceLibrary()
