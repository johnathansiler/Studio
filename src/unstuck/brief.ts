/**
 * Steering for Unstuck. The same brief and seed always describe the same idea.
 * A part action writes one role. Full song is a separate action that opts in.
 */

import { NOTE_NAMES, SCALES, type ScaleId } from '../model/scale'
import type { SectionKind } from '../model/types'
import { registerScales, findScale } from '../theory/scales'
import { clamp, hashSeed, mulberry32 } from '../generators/rng'

export const ROLES = [
  { id: 'drums', name: 'Drums', track: 'Drums', color: '#c58be0', instrument: 'pads', plugin: 'pads', mix: 'compressor', volume: 0.82, pan: 0 },
  { id: 'bass', name: 'Bass', track: 'Bass', color: '#79b8d4', instrument: 'synth', plugin: 'synth', mix: 'eq', volume: 0.78, pan: 0 },
  { id: 'chords', name: 'Chords', track: 'Chords', color: '#e0b15a', instrument: 'scaler', plugin: 'scaler', mix: 'eq', volume: 0.7, pan: 0 },
  { id: 'melody', name: 'Melody', track: 'Melody', color: '#73c48f', instrument: 'synth', plugin: 'synth', mix: 'delay', volume: 0.74, pan: 0.08 },
  { id: 'arp', name: 'Arpeggio', track: 'Arpeggio', color: '#f09a6a', instrument: 'synth', plugin: 'synth', mix: 'delay', volume: 0.58, pan: -0.12 },
  { id: 'pad', name: 'Pad', track: 'Pad', color: '#8fd0c4', instrument: 'synth', plugin: 'synth', mix: 'reverb', volume: 0.5, pan: 0 },
] as const

export type RoleId = (typeof ROLES)[number]['id']

export type FeelId = 'straight' | 'swing' | 'shuffle' | 'half-time' | 'double-time'
export type MoodId = 'calm' | 'warm' | 'bright' | 'dark' | 'tense' | 'lifted'
export type AmountId = 'subtle' | 'medium' | 'wild'
export type LengthId = 'short' | 'medium' | 'long'
export type StructureId = 'loop' | 'verse-chorus' | 'pop' | 'ballad' | 'club'

export interface UnstuckBrief {
  seed: number
  genre: string
  feel: FeelId
  mood: MoodId
  /** 0 is spare, 1 is as loud as the section allows. */
  energy: number
  tempoMin: number
  tempoMax: number
  /** Pitch class, 0–11. */
  key: number
  /** Built-in scale id, or a maqam id from the scale library. */
  scale: string
  /** 0 is triads and a plain groove. 1 adds extensions, ghosts, and motion. */
  complexity: number
  /** 0 keeps accents. 1 keeps every hit the style wrote. */
  density: number
  /** 0 is on the grid. 1 nudges time and velocity. */
  humanize: number
  /** Parts a multi-part action includes. A single part button ignores this. */
  parts: RoleId[]
  /** Skipped when a multi-part action is shuffled or rewritten. */
  locks: RoleId[]
  length: LengthId
  structure: StructureId
  amount: AmountId
}

export interface GenreSpec {
  id: string
  name: string
  style: string
  tempo: [number, number]
  feel: FeelId
  minor: boolean
}

export const GENRES: GenreSpec[] = [
  { id: 'hip-hop', name: 'Hip-hop', style: 'boom-bap', tempo: [82, 98], feel: 'swing', minor: true },
  { id: 'trap', name: 'Trap', style: 'trap', tempo: [130, 150], feel: 'half-time', minor: true },
  { id: 'rnb', name: 'R&B', style: 'rnb', tempo: [70, 96], feel: 'swing', minor: false },
  { id: 'pop', name: 'Pop', style: 'pop', tempo: [100, 126], feel: 'straight', minor: false },
  { id: 'gospel', name: 'Gospel', style: 'gospel', tempo: [72, 104], feel: 'swing', minor: false },
  { id: 'afrobeats', name: 'Afrobeats', style: 'afrobeats', tempo: [100, 118], feel: 'straight', minor: false },
  { id: 'reggaeton', name: 'Reggaeton', style: 'reggaeton', tempo: [88, 100], feel: 'straight', minor: true },
  { id: 'house', name: 'House', style: 'house', tempo: [120, 128], feel: 'straight', minor: false },
  { id: 'drill', name: 'Drill', style: 'drill', tempo: [138, 148], feel: 'half-time', minor: true },
  { id: 'lofi', name: 'Lo-fi', style: 'lofi', tempo: [72, 90], feel: 'swing', minor: true },
  { id: 'rock', name: 'Rock', style: 'rock', tempo: [110, 140], feel: 'straight', minor: false },
  { id: 'country', name: 'Country', style: 'blues', tempo: [96, 124], feel: 'shuffle', minor: false },
  { id: 'jazz', name: 'Jazz', style: 'jazz', tempo: [100, 160], feel: 'swing', minor: false },
  { id: 'cinematic', name: 'Cinematic', style: 'lofi', tempo: [60, 90], feel: 'straight', minor: true },
  { id: 'funk', name: 'Funk', style: 'funk', tempo: [96, 116], feel: 'straight', minor: false },
  { id: 'latin', name: 'Latin', style: 'latin', tempo: [96, 120], feel: 'straight', minor: false },
  { id: 'reggae', name: 'Reggae', style: 'reggae', tempo: [70, 90], feel: 'straight', minor: false },
  { id: 'amapiano', name: 'Amapiano', style: 'amapiano', tempo: [110, 116], feel: 'swing', minor: false },
  { id: 'maqam', name: 'Maqam', style: 'maqam', tempo: [80, 110], feel: 'straight', minor: true },
]

export const FEELS: { id: FeelId; name: string }[] = [
  { id: 'straight', name: 'Straight' },
  { id: 'swing', name: 'Swing' },
  { id: 'shuffle', name: 'Shuffle' },
  { id: 'half-time', name: 'Half-time' },
  { id: 'double-time', name: 'Double-time' },
]

export const MOODS: { id: MoodId; name: string }[] = [
  { id: 'calm', name: 'Calm' },
  { id: 'warm', name: 'Warm' },
  { id: 'bright', name: 'Bright' },
  { id: 'dark', name: 'Dark' },
  { id: 'tense', name: 'Tense' },
  { id: 'lifted', name: 'Lifted' },
]

export const AMOUNTS: { id: AmountId; name: string }[] = [
  { id: 'subtle', name: 'Subtle' },
  { id: 'medium', name: 'Medium' },
  { id: 'wild', name: 'Wild' },
]

export const LENGTHS: { id: LengthId; name: string }[] = [
  { id: 'short', name: 'Short' },
  { id: 'medium', name: 'Medium' },
  { id: 'long', name: 'Long' },
]

export const STRUCTURES: { id: StructureId; name: string }[] = [
  { id: 'loop', name: 'Loop' },
  { id: 'verse-chorus', name: 'Verse chorus' },
  { id: 'pop', name: 'Pop' },
  { id: 'ballad', name: 'Ballad' },
  { id: 'club', name: 'Club' },
]

/** Maqamat offered beside the modes. Cents match the scale library. */
export const MAQAMS: { id: string; name: string; cents: number[] }[] = [
  { id: 'maqam-rast', name: 'Rast', cents: [0, 200, 350, 500, 700, 900, 1050] },
  { id: 'maqam-bayati', name: 'Bayati', cents: [0, 150, 300, 500, 700, 900, 1050] },
  { id: 'maqam-hijaz', name: 'Hijaz', cents: [0, 100, 400, 500, 700, 800, 1000] },
  { id: 'maqam-nahawand', name: 'Nahawand', cents: [0, 200, 300, 500, 700, 800, 1100] },
  { id: 'maqam-kurd', name: 'Kurd', cents: [0, 100, 300, 500, 700, 800, 1000] },
  { id: 'maqam-ajam', name: 'Ajam', cents: [0, 200, 400, 500, 700, 900, 1100] },
  { id: 'maqam-sikah', name: 'Sikah', cents: [0, 150, 350, 500, 650, 850, 1050] },
  { id: 'maqam-saba', name: 'Saba', cents: [0, 150, 300, 400, 650, 700, 1000] },
]

export const SCALE_CHOICES: { id: string; name: string }[] = [
  ...SCALES.map((scale) => ({ id: scale.id, name: scale.name })),
  ...MAQAMS.map((scale) => ({ id: scale.id, name: scale.name })),
]

export interface FormSection {
  kind: SectionKind
  name: string
  bars: number
  energy: number
}

/** Every full song keeps these. Structure only changes their order. */
const REQUIRED_SLOTS = new Set(['verse', 'chorus'])

type FormSlot = 'intro' | 'verse' | 'pre' | 'chorus' | 'post' | 'breakdown' | 'bridge' | 'instrumental' | 'outro'

const SLOT: Record<FormSlot, { kind: SectionKind; name: string; bars: number; energy: number }> = {
  intro: { kind: 'intro', name: 'Intro', bars: 4, energy: 0.38 },
  verse: { kind: 'verse', name: 'Verse', bars: 8, energy: 0.64 },
  pre: { kind: 'pre', name: 'Pre-Chorus', bars: 4, energy: 0.8 },
  chorus: { kind: 'chorus', name: 'Chorus', bars: 8, energy: 1 },
  post: { kind: 'custom', name: 'Post-Chorus', bars: 4, energy: 0.86 },
  breakdown: { kind: 'breakdown', name: 'Breakdown', bars: 8, energy: 0.32 },
  bridge: { kind: 'bridge', name: 'Bridge', bars: 8, energy: 0.48 },
  instrumental: { kind: 'solo', name: 'Instrumental', bars: 8, energy: 0.58 },
  outro: { kind: 'outro', name: 'Outro', bars: 4, energy: 0.36 },
}

/**
 * Optional slots sit in structure order. The seed keeps or drops each one.
 * Verse and chorus slots always stay, and every order has two of each.
 */
const ORDERS: Record<StructureId, FormSlot[]> = {
  loop: ['intro', 'verse', 'chorus', 'post', 'verse', 'chorus', 'outro'],
  'verse-chorus': ['intro', 'verse', 'pre', 'chorus', 'post', 'verse', 'pre', 'chorus', 'bridge', 'outro'],
  pop: ['intro', 'verse', 'pre', 'chorus', 'post', 'breakdown', 'verse', 'chorus', 'bridge', 'instrumental', 'outro'],
  ballad: ['intro', 'verse', 'verse', 'pre', 'chorus', 'bridge', 'instrumental', 'chorus', 'outro'],
  club: ['intro', 'breakdown', 'chorus', 'verse', 'post', 'instrumental', 'chorus', 'verse', 'outro'],
}

const NEXT_KIND: Partial<Record<SectionKind, SectionKind>> = {
  intro: 'verse',
  verse: 'pre',
  pre: 'chorus',
  chorus: 'bridge',
  bridge: 'chorus',
  breakdown: 'chorus',
  solo: 'chorus',
  outro: 'outro',
  custom: 'chorus',
  marker: 'verse',
}

const ROLE_IDS = new Set<string>(ROLES.map((role) => role.id))
const FEEL_IDS = new Set<string>(FEELS.map((item) => item.id))
const MOOD_IDS = new Set<string>(MOODS.map((item) => item.id))
const AMOUNT_IDS = new Set<string>(AMOUNTS.map((item) => item.id))
const LENGTH_IDS = new Set<string>(LENGTHS.map((item) => item.id))
const STRUCTURE_IDS = new Set<string>(STRUCTURES.map((item) => item.id))

export function genreById(id: string | undefined): GenreSpec {
  return GENRES.find((genre) => genre.id === id) ?? GENRES.find((genre) => genre.id === 'pop')!
}

export function roleById(id: RoleId) {
  return ROLES.find((role) => role.id === id) ?? ROLES[0]
}

export function roleLabel(id: RoleId) {
  return roleById(id).name
}

export function defaultBrief(): UnstuckBrief {
  const pop = genreById('pop')
  return {
    seed: 1,
    genre: pop.id,
    feel: pop.feel,
    mood: 'warm',
    energy: 0.72,
    tempoMin: pop.tempo[0],
    tempoMax: pop.tempo[1],
    key: 0,
    scale: 'ionian',
    complexity: 0.45,
    density: 0.8,
    humanize: 0.2,
    parts: ['drums', 'bass', 'chords', 'melody', 'arp', 'pad'],
    locks: [],
    length: 'medium',
    structure: 'pop',
    amount: 'medium',
  }
}

export function normalizeBrief(value?: Partial<UnstuckBrief> | null): UnstuckBrief {
  const base = defaultBrief()
  const genre = genreById(value?.genre ?? base.genre)
  const scale = SCALE_CHOICES.some((item) => item.id === value?.scale) ? (value!.scale as string) : base.scale
  let tempoMin = clamp(Math.round(value?.tempoMin ?? genre.tempo[0]), 40, 240)
  let tempoMax = clamp(Math.round(value?.tempoMax ?? genre.tempo[1]), 40, 240)
  if (tempoMax < tempoMin) {
    const swap = tempoMin
    tempoMin = tempoMax
    tempoMax = swap
  }
  return {
    seed: Number.isFinite(value?.seed) ? (value!.seed as number) >>> 0 : base.seed,
    genre: genre.id,
    feel: FEEL_IDS.has(value?.feel ?? '') ? (value!.feel as FeelId) : genre.feel,
    mood: MOOD_IDS.has(value?.mood ?? '') ? (value!.mood as MoodId) : base.mood,
    energy: clamp(value?.energy ?? base.energy, 0, 1),
    tempoMin,
    tempoMax,
    key: ((Math.round(value?.key ?? base.key) % 12) + 12) % 12,
    scale,
    complexity: clamp(value?.complexity ?? base.complexity, 0, 1),
    density: clamp(value?.density ?? base.density, 0, 1),
    humanize: clamp(value?.humanize ?? base.humanize, 0, 1),
    parts: cleanRoles(value?.parts, base.parts),
    locks: cleanRoles(value?.locks, []),
    length: LENGTH_IDS.has(value?.length ?? '') ? (value!.length as LengthId) : base.length,
    structure: STRUCTURE_IDS.has(value?.structure ?? '') ? (value!.structure as StructureId) : base.structure,
    amount: AMOUNT_IDS.has(value?.amount ?? '') ? (value!.amount as AmountId) : base.amount,
  }
}

export function briefFromProject(project: { tempo: number; scale?: { root?: number; scale?: string; library?: string } }): UnstuckBrief {
  const scale = project.scale
  const tempo = clamp(Math.round(project.tempo || 120), 40, 240)
  return normalizeBrief({
    key: scale?.root ?? 0,
    scale: scale?.library || scale?.scale || 'ionian',
    tempoMin: clamp(tempo - 8, 40, 240),
    tempoMax: clamp(tempo + 8, 40, 240),
  })
}

/** Register a listed maqam so Scaler and the generators can spell it. */
export function ensureScale(id: string) {
  if (findScale(id)) return id
  const maqam = MAQAMS.find((item) => item.id === id)
  if (!maqam) return 'ionian'
  registerScales([{ id: maqam.id, name: maqam.name, family: 'maqam', cents: maqam.cents, description: maqam.name }])
  return maqam.id
}

export function scaleIsBuiltin(id: string): id is ScaleId {
  return SCALES.some((scale) => scale.id === id)
}

export function partBars(brief: UnstuckBrief) {
  if (brief.length === 'short') return 4
  if (brief.length === 'long') return 16
  return 8
}

export function scaleBars(bars: number, length: LengthId) {
  if (length === 'short') return bars >= 8 ? 4 : Math.max(4, bars)
  if (length === 'long') return bars >= 8 ? bars + 4 : bars
  return bars
}

/** Two verses and two choruses, plus the optional sections this seed keeps. */
export function formOf(brief: UnstuckBrief): FormSection[] {
  const order = ORDERS[brief.structure]
  const keep = keptSlots(brief.seed, brief.structure, order)
  const slots = order.filter((slot, index) => REQUIRED_SLOTS.has(slot) || keep[index])
  const verses = slots.filter((slot) => slot === 'verse').length
  const choruses = slots.filter((slot) => slot === 'chorus').length
  for (let extra = verses; extra < 2; extra++) slots.push('verse')
  for (let extra = choruses; extra < 2; extra++) slots.push('chorus')
  const seen = new Map<string, number>()
  return slots.map((slot) => {
    const spec = SLOT[slot]
    const count = (seen.get(spec.name) ?? 0) + 1
    seen.set(spec.name, count)
    return {
      kind: spec.kind,
      name: count === 1 ? spec.name : `${spec.name} ${count}`,
      bars: scaleBars(spec.bars, brief.length),
      energy: spec.energy,
    }
  })
}

function keptSlots(seed: number, structure: string, order: FormSlot[]) {
  const rng = mulberry32(hashSeed(seed >>> 0, structureSalt(structure), 41))
  const flags = order.map(() => false)
  const optional = order.map((slot, index) => REQUIRED_SLOTS.has(slot) ? -1 : index).filter((index) => index >= 0)
  if (!optional.length) return flags
  const roll = rng()
  let count = 0
  if (roll < 0.2) count = 0
  else if (roll < 0.42) count = 1
  else if (roll < 0.66) count = 2
  else if (roll < 0.84) count = 3
  else count = Math.min(optional.length, 4 + Math.floor(rng() * Math.max(1, optional.length - 3)))
  const bag = [...optional]
  for (let index = bag.length - 1; index > 0; index--) {
    const swap = Math.floor(rng() * (index + 1))
    const held = bag[index]
    bag[index] = bag[swap]
    bag[swap] = held
  }
  for (const index of bag.slice(0, count)) flags[index] = true
  return flags
}

function structureSalt(structure: string) {
  let hash = 0
  for (let index = 0; index < structure.length; index++) hash = (hash + structure.charCodeAt(index) * (index + 3)) >>> 0
  return hash || 1
}

export function nextKind(kind: SectionKind | undefined): SectionKind {
  if (!kind) return 'verse'
  return NEXT_KIND[kind] ?? 'chorus'
}

export function sectionEnergy(kind: SectionKind) {
  const found = Object.values(SLOT).find((section) => section.kind === kind)
  return found?.energy ?? 0.7
}

export function sectionBars(kind: SectionKind) {
  if (kind === 'intro' || kind === 'pre' || kind === 'outro') return 4
  if (kind === 'breakdown') return 8
  return 8
}

export function keyName(key: number) {
  return NOTE_NAMES[((key % 12) + 12) % 12]
}

function cleanRoles(value: RoleId[] | undefined, fallback: RoleId[]): RoleId[] {
  if (!value) return [...fallback]
  const out: RoleId[] = []
  for (const role of value) {
    if (!ROLE_IDS.has(role) || out.includes(role)) continue
    out.push(role)
  }
  return out
}
