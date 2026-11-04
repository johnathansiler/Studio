/** Chop, key, tempo fit, and the Vintage macro. No audio engine and no Rust. */

import { NOTE_NAMES } from './scale'

export type ChopMode = 'tempo' | 'even' | 'transient' | 'manual'
export type TempoGrid = 'bar' | 'half' | 'quarter' | 'eighth' | 'sixteenth'
export type SliceStart = 'start' | 'transient'
export type PitchMode = 'vinyl' | 'stretch'
export type VintageCurve = 'linear' | 'ease' | 'late'

export interface Slice {
  start: number
  end: number
}

export interface ChopSetup {
  bufferId: string
  name: string
  mode: ChopMode
  even: 4 | 8 | 16
  /** 0 hears only the loudest hits. 1 hears the quiet ones too. */
  sensitivity: number
  grid: TempoGrid
  tempoSource: 'project' | 'sample'
  sampleBpm: number
  sliceStart: SliceStart
  /** Manual markers as fractions of the sample, not including the ends. */
  markers: number[]
  root: number
  modeName: 'minor' | 'major'
  /** Whole-sample pitch, in semitones. Vinyl also changes the tempo. */
  semitones: number
  cents: number
  pitchMode: PitchMode
  /** 0 is open. 1 cuts the most bass. */
  highpass: number
}

export interface VintageDepth {
  /** How strong this effect is when the macro is fully up. 0 to 1. */
  amount: number
  curve: VintageCurve
}

export interface VintageTable {
  wow: VintageDepth
  crackle: VintageDepth
  lowpass: VintageDepth
  bits: VintageDepth
  rate: VintageDepth
}

export interface VintageState {
  /** 0 is clean. 1 is the full custom blend. */
  macro: number
  table: VintageTable
  presetName: string
}

/** Values after the macro, ready for pad.setVintage. */
export interface ScaledVintage {
  wow: number
  crackle: number
  lowpass: number
  bits: number
  rate: number
}

export interface SampleKey {
  root: number
  name: string
  mode: 'minor' | 'major'
  label: string
  hz: number
}

const GRIDS: TempoGrid[] = ['bar', 'half', 'quarter', 'eighth', 'sixteenth']

export function gridBeats(grid: TempoGrid, beatsPerBar = 4): number {
  const bar = beatsPerBar > 0 ? beatsPerBar : 4
  if (grid === 'bar') return bar
  if (grid === 'half') return bar / 2
  if (grid === 'quarter') return 1
  if (grid === 'eighth') return 0.5
  return 0.25
}

export function evenSlices(length: number, count: number): Slice[] {
  const total = Math.floor(length)
  const slices = Math.max(1, Math.round(count))
  if (total < 2) return []
  const out: Slice[] = []
  for (let index = 0; index < slices; index++) {
    const start = Math.round((index * total) / slices)
    const end = index === slices - 1 ? total : Math.round(((index + 1) * total) / slices)
    if (end > start) out.push({ start, end })
  }
  return out
}

/** Energy jumps. A higher sensitivity keeps quieter hits. */
export function transientPoints(samples: Float32Array, sampleRate: number, sensitivity: number): number[] {
  const length = samples.length
  if (length < 8) return []
  const sense = clamp(sensitivity, 0, 1)
  const threshold = 1.15 - sense * 0.9
  const floor = 0.08 - sense * 0.07
  const win = Math.max(1, Math.round(sampleRate * 0.008))
  const gap = Math.max(win, Math.round(sampleRate * (0.08 - sense * 0.06)))
  const points: number[] = []
  let last = -gap
  for (let i = win; i + win < length; i += win) {
    let energy = 0
    let prev = 0
    for (let j = 0; j < win; j++) {
      energy += Math.abs(samples[i + j] || 0)
      prev += Math.abs(samples[i - win + j] || 0)
    }
    if (i - last < gap) continue
    if (energy > prev * threshold && energy / win > floor) {
      points.push(i)
      last = i
    }
  }
  return points
}

export function tempoSlices(opts: {
  length: number
  sampleRate: number
  bpm: number
  grid: TempoGrid
  beatsPerBar?: number
  startSample?: number
}): Slice[] {
  const total = Math.floor(opts.length)
  const rate = opts.sampleRate
  const bpm = opts.bpm
  if (total < 2 || !(rate > 0) || !(bpm > 0)) return []
  const step = Math.max(1, Math.round((rate * 60 / bpm) * gridBeats(opts.grid, opts.beatsPerBar ?? 4)))
  let cursor = Math.max(0, Math.min(total - 1, Math.round(opts.startSample ?? 0)))
  const out: Slice[] = []
  while (cursor < total) {
    const end = Math.min(total, cursor + step)
    if (end <= cursor) break
    out.push({ start: cursor, end })
    if (end >= total) break
    cursor = end
  }
  return out
}

export function manualSlices(length: number, markers: number[]): Slice[] {
  const total = Math.floor(length)
  if (total < 2) return []
  const points = [0, total]
  for (const marker of markers) {
    if (!Number.isFinite(marker)) continue
    const at = Math.round(marker * total)
    if (at > 0 && at < total) points.push(at)
  }
  const sorted = [...new Set(points)].sort((a, b) => a - b)
  const out: Slice[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1] > sorted[i]) out.push({ start: sorted[i], end: sorted[i + 1] })
  }
  return out
}

export function slicesFor(setup: ChopSetup, samples: Float32Array, sampleRate: number, projectBpm: number, beatsPerBar = 4): Slice[] {
  if (setup.mode === 'even') return evenSlices(samples.length, setup.even)
  if (setup.mode === 'manual') return manualSlices(samples.length, setup.markers)
  if (setup.mode === 'transient') {
    const points = [0, ...transientPoints(samples, sampleRate, setup.sensitivity), samples.length]
    return manualSlices(samples.length, points.filter((point) => point > 0 && point < samples.length).map((point) => point / samples.length))
  }
  const bpm = setup.tempoSource === 'sample' && setup.sampleBpm > 0 ? setup.sampleBpm : projectBpm
  const start = setup.sliceStart === 'transient' ? (transientPoints(samples, sampleRate, 0.55)[0] ?? 0) : 0
  return tempoSlices({ length: samples.length, sampleRate, bpm, grid: setup.grid, beatsPerBar, startSample: start })
}

export function assignPlan(sliceCount: number, slots = 16): { assigned: number; left: number } {
  const count = Math.max(0, Math.floor(sliceCount))
  const assigned = Math.min(slots, count)
  return { assigned, left: count - assigned }
}

/** Vinyl semitone that lands nearest the project tempo, and the BPM that shift produces. */
export function fitToTempo(sampleBpm: number, projectBpm: number): { semitones: number; bpm: number; difference: number } {
  if (!(sampleBpm > 0) || !(projectBpm > 0)) return { semitones: 0, bpm: sampleBpm || 0, difference: 0 }
  const semitones = Math.round(12 * Math.log2(projectBpm / sampleBpm))
  const bpm = sampleBpm * 2 ** (semitones / 12)
  return { semitones, bpm, difference: projectBpm - bpm }
}

export function shiftedKey(root: number, mode: 'minor' | 'major', semitones: number, cents: number): string {
  const steps = Math.trunc(semitones) + (Math.abs(cents) >= 50 ? Math.sign(cents) : 0)
  const pc = ((Math.round(root) + steps) % 12 + 12) % 12
  return `${NOTE_NAMES[pc]} ${mode}`
}

export function keyLabel(root: number, mode: 'minor' | 'major'): string {
  const pc = ((Math.round(root) % 12) + 12) % 12
  return `${NOTE_NAMES[pc]} ${mode}`
}

/** Pitch of a monophonic tone. A single tone is reported as minor, the soul default. */
export function detectToneKey(samples: Float32Array, sampleRate: number): SampleKey {
  const hz = estimateHz(samples, sampleRate)
  if (!(hz > 0)) return { root: 0, name: 'C', mode: 'minor', label: 'C minor', hz: 0 }
  const midi = 69 + 12 * Math.log2(hz / 440)
  const root = ((Math.round(midi) % 12) + 12) % 12
  const name = NOTE_NAMES[root]
  return { root, name, mode: 'minor', label: `${name} minor`, hz }
}

/** Median gap between hits, doubled or halved into 60–180. */
export function detectSampleBpm(samples: Float32Array, sampleRate: number): number | null {
  const hits = transientPoints(samples, sampleRate, 0.6)
  if (hits.length < 4) return null
  const gaps: number[] = []
  for (let i = 1; i < hits.length; i++) gaps.push(hits[i] - hits[i - 1])
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  if (!(median > 0)) return null
  let bpm = 60 / (median / sampleRate)
  while (bpm < 60) bpm *= 2
  while (bpm > 180) bpm /= 2
  return Math.round(bpm * 10) / 10
}

export function depth(amount = 0, curve: VintageCurve = 'linear'): VintageDepth {
  return { amount: clamp(amount, 0, 1), curve }
}

export function vintageTable(partial?: Partial<Record<keyof VintageTable, Partial<VintageDepth>>>): VintageTable {
  const read = (key: keyof VintageTable, fallback: number): VintageDepth => {
    const value = partial?.[key]
    return depth(value?.amount ?? fallback, value?.curve === 'ease' || value?.curve === 'late' ? value.curve : 'linear')
  }
  return {
    wow: read('wow', 0),
    crackle: read('crackle', 0),
    lowpass: read('lowpass', 0),
    bits: read('bits', 0),
    rate: read('rate', 0),
  }
}

export interface VintagePreset {
  name: string
  table: VintageTable
}

export const FACTORY_VINTAGE: VintagePreset[] = [
  { name: 'SP-1200', table: vintageTable({ bits: { amount: 0.85 }, rate: { amount: 0.8 }, lowpass: { amount: 0.55 }, wow: { amount: 0.05 }, crackle: { amount: 0.08 } }) },
  { name: 'Dusty Vinyl', table: vintageTable({ crackle: { amount: 0.9 }, wow: { amount: 0.35 }, lowpass: { amount: 0.4 }, bits: { amount: 0.15 }, rate: { amount: 0.1 } }) },
  { name: 'Tape', table: vintageTable({ wow: { amount: 0.8, curve: 'ease' }, lowpass: { amount: 0.45 }, crackle: { amount: 0.12 }, bits: { amount: 0.1 }, rate: { amount: 0.05 } }) },
]

/** User presets stored beside the factory ones. Bad JSON yields an empty list. */
export function parseVintagePresets(raw: string | null | undefined): VintagePreset[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; table?: VintageTable }[]
    if (!Array.isArray(parsed)) return []
    const out: VintagePreset[] = []
    for (const item of parsed) {
      if (!item || typeof item.name !== 'string' || !item.table) continue
      const name = item.name.trim()
      if (!name) continue
      out.push({ name, table: vintageTable(item.table) })
    }
    return out
  } catch {
    return []
  }
}

/** Replace a preset of the same name, or add it. The table is the blend at 100%. */
export function upsertVintagePreset(presets: VintagePreset[], name: string, table: VintageTable): VintagePreset[] {
  const clean = name.trim() || 'My vintage'
  return presets.filter((item) => item.name !== clean).concat({ name: clean, table: vintageTable(table) })
}

/** The macro scales every depth from clean (0) to that depth's own amount (1). */
export function scaleVintage(macro: number, table: VintageTable): ScaledVintage {
  const scale = (item: VintageDepth) => clamp(item.amount, 0, 1) * curveOf(clamp(macro, 0, 1), item.curve)
  return {
    wow: scale(table.wow),
    crackle: scale(table.crackle),
    lowpass: scale(table.lowpass),
    bits: scale(table.bits),
    rate: scale(table.rate),
  }
}

export function normalizeVintage(value: Partial<VintageState> | undefined | null): VintageState | undefined {
  if (!value || !value.table) return undefined
  return {
    macro: clamp(value.macro ?? 0, 0, 1),
    table: vintageTable(value.table),
    presetName: typeof value.presetName === 'string' ? value.presetName : '',
  }
}

export function normalizeChop(value: Partial<ChopSetup> | undefined | null): ChopSetup | undefined {
  if (!value || typeof value.bufferId !== 'string' || !value.bufferId) return undefined
  const mode: ChopMode = value.mode === 'even' || value.mode === 'transient' || value.mode === 'manual' || value.mode === 'tempo' ? value.mode : 'tempo'
  const grid: TempoGrid = GRIDS.includes(value.grid as TempoGrid) ? value.grid as TempoGrid : 'quarter'
  return {
    bufferId: value.bufferId,
    name: value.name?.trim() || 'Sample',
    mode,
    even: value.even === 4 || value.even === 16 ? value.even : 8,
    sensitivity: clamp(value.sensitivity ?? 0.5, 0, 1),
    grid,
    tempoSource: value.tempoSource === 'sample' ? 'sample' : 'project',
    sampleBpm: clamp(value.sampleBpm ?? 120, 40, 300),
    sliceStart: value.sliceStart === 'transient' ? 'transient' : 'start',
    markers: Array.isArray(value.markers) ? value.markers.filter((item) => Number.isFinite(item) && item > 0 && item < 1) : [],
    root: ((Math.round(value.root ?? 0) % 12) + 12) % 12,
    modeName: value.modeName === 'major' ? 'major' : 'minor',
    semitones: clamp(Math.round(value.semitones ?? 0), -24, 24),
    cents: clamp(value.cents ?? 0, -100, 100),
    pitchMode: value.pitchMode === 'stretch' ? 'stretch' : 'vinyl',
    highpass: clamp(value.highpass ?? 0, 0, 1),
  }
}

export function emptyChop(bufferId: string, name: string, projectBpm: number): ChopSetup {
  return normalizeChop({
    bufferId,
    name,
    mode: 'tempo',
    grid: 'quarter',
    tempoSource: 'project',
    sampleBpm: projectBpm,
    sliceStart: 'start',
  })!
}

function curveOf(macro: number, curve: VintageCurve): number {
  if (curve === 'ease') return macro * macro * (3 - 2 * macro)
  if (curve === 'late') return macro * macro
  return macro
}

function estimateHz(samples: Float32Array, sampleRate: number): number {
  const length = Math.min(samples.length, 8192)
  if (length < 64 || !(sampleRate > 0)) return 0
  const minLag = Math.max(2, Math.floor(sampleRate / 1000))
  const maxLag = Math.min(length - 2, Math.floor(sampleRate / 50))
  let best = 0
  let bestLag = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0
    const span = length - lag
    for (let i = 0; i < span; i += 2) score += (samples[i] || 0) * (samples[i + lag] || 0)
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  return bestLag > 0 ? sampleRate / bestLag : 0
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
