import { renderClipChannels } from '../audio/stretch/engine'
import { isMicrotonal } from '../theory'
import { placePitch, type ScaleId } from './scale'
import { STEP_BEAT, emptyCell, type StepCell, type StepChannel } from './steps'
import { beatsToSamples, samplesToBeats } from './time'
import type { AudioClip, ClipStretch, MidiNote, Project, WarpMarker } from './types'

export const DIVISIONS = [1, 2, 4, 8, 16, 32, 64, 128] as const
export type Division = (typeof DIVISIONS)[number]
export type Feel = 'straight' | 'triplet' | 'dotted' | 'quintuplet' | 'septuplet' | 'custom'
export type SwingUnit = '8' | '16'
export type VelocityMode = 'off' | 'fixed' | 'compress'
export type RecordQuantize = 'off' | 'live' | 'after'
export type QuantizeScope = 'selection' | 'clip' | 'track' | 'pattern'

export interface Groove {
  name: string
  offsets: number[]
}

export interface WarpPoint {
  source: number
  target: number
}

export interface QuantizeSettings {
  division: Division
  feel: Feel
  tupletN: number
  tupletM: number
  /** 0–1. Each apply moves this fraction of the remaining distance. */
  strength: number
  /** 0–1. 0 is straight. 0.5 is an MPC 75% 16th. */
  swing: number
  swingUnit: SwingUnit
  groove: Groove | null
  /** 0–100. Notes farther than this share of the grid stay put. */
  window: number
  /** MIDI velocity floor, and the audio onset gate. */
  threshold: number
  starts: boolean
  ends: boolean
  keepLength: boolean
  lengthQuantize: boolean
  fixOverlaps: boolean
  legato: boolean
  humanizeMs: number
  humanizeVel: number
  seed: number | null
  velocity: VelocityMode
  velocityCompress: number
  scaleSnap: boolean
  record: RecordQuantize
  scope: QuantizeScope
}

export interface QuantizePreset {
  id: string
  name: string
  settings: QuantizeSettings
}

export interface QuantizeContext {
  tempo?: number
  root?: number
  scale?: ScaleId
  only?: string[]
  rng?: () => number
}

export const MPC_SWING = [50, 54, 58, 62, 66, 71, 75] as const

export function defaultQuantize(): QuantizeSettings {
  return {
    division: 16,
    feel: 'straight',
    tupletN: 3,
    tupletM: 2,
    strength: 1,
    swing: 0,
    swingUnit: '16',
    groove: null,
    window: 100,
    threshold: 0,
    starts: true,
    ends: false,
    keepLength: true,
    lengthQuantize: false,
    fixOverlaps: false,
    legato: false,
    humanizeMs: 0,
    humanizeVel: 0,
    seed: null,
    velocity: 'off',
    velocityCompress: 0,
    scaleSnap: false,
    record: 'off',
    scope: 'selection',
  }
}

export function normalizeQuantize(value: Partial<QuantizeSettings> | undefined): QuantizeSettings {
  const base = defaultQuantize()
  const next = { ...base, ...value }
  const division = DIVISIONS.includes(next.division) ? next.division : 16
  return {
    ...next,
    division,
    tupletN: clampInt(next.tupletN, 2, 16, 3),
    tupletM: clampInt(next.tupletM, 1, 16, 2),
    strength: clamp01(next.strength),
    swing: clamp01(next.swing),
    window: Math.max(0, Math.min(100, Number.isFinite(next.window) ? next.window : 100)),
    threshold: clamp01(next.threshold),
    humanizeMs: Math.max(0, Math.min(80, Number.isFinite(next.humanizeMs) ? next.humanizeMs : 0)),
    humanizeVel: Math.max(0, Math.min(100, Number.isFinite(next.humanizeVel) ? next.humanizeVel : 0)),
    seed: next.seed == null || !Number.isFinite(next.seed) ? null : Math.round(next.seed),
    velocityCompress: clamp01(next.velocityCompress),
    groove: next.groove?.offsets?.length ? { name: next.groove.name || 'Clip', offsets: next.groove.offsets.map((offset) => Number(offset) || 0) } : null,
  }
}

/** Straight value is a fraction of a whole note (4 quarter beats). */
export function gridBeats(settings: QuantizeSettings): number {
  const straight = 4 / settings.division
  if (settings.feel === 'triplet') return straight * (2 / 3)
  if (settings.feel === 'dotted') return straight * 1.5
  if (settings.feel === 'quintuplet') return straight * (4 / 5)
  if (settings.feel === 'septuplet') return straight * (4 / 7)
  if (settings.feel === 'custom') return straight * (settings.tupletM / settings.tupletN)
  return straight
}

/** MPC percent 50 is straight. 75 delays the offbeat 16th to 75% of the eighth. */
export function mpcGroove(percent: number): Groove {
  const amount = clamp01((percent - 50) / 50)
  const offset = amount * 0.25
  return {
    name: `MPC ${percent}`,
    offsets: Array.from({ length: 16 }, (_, index) => (index % 2 ? offset : 0)),
  }
}

export function extractGroove(beats: number[], steps = 16, barBeats = 4): Groove {
  const count = Math.max(2, Math.round(steps))
  const step = barBeats / count
  const buckets = Array.from({ length: count }, () => [] as number[])
  for (const beat of beats) {
    if (!Number.isFinite(beat)) continue
    const local = ((beat % barBeats) + barBeats) % barBeats
    const index = mod(Math.round(local / step), count)
    buckets[index].push(local - Math.round(local / step) * step)
  }
  return {
    name: 'Clip',
    offsets: buckets.map((list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0)),
  }
}

export function snapBeatToGrid(beat: number, settings: QuantizeSettings): { target: number; distance: number; grid: number } {
  const grid = Math.max(1 / 128, gridBeats(settings))
  const sub = settings.swingUnit === '8' ? 0.5 : 0.25
  const delay = clamp01(settings.swing) * sub
  const groove = settings.groove
  const safe = Math.max(0, beat)
  const origin = Math.floor(safe / grid)
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  for (let k = origin - 2; k <= origin + 3; k++) {
    if (k < 0) continue
    const raw = k * grid
    let target = raw
    if (groove && groove.offsets.length) {
      const grooveStep = 4 / groove.offsets.length
      const index = mod(Math.round(raw / grooveStep), groove.offsets.length)
      target = raw + (groove.offsets[index] || 0)
    } else if (Math.round(raw / sub) % 2 === 1) target = raw + delay
    target = Math.max(0, target)
    const dist = Math.abs(target - safe)
    if (dist < bestDist - 1e-9) {
      bestDist = dist
      best = target
    }
  }
  return { target: best, distance: bestDist, grid }
}

export function divisionForGrid(grid: number): Division {
  const raw = Math.round(4 / grid)
  return (DIVISIONS as readonly number[]).includes(raw) ? (raw as Division) : 16
}

export function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function moveToward(value: number, settings: QuantizeSettings): number {
  const { target, distance, grid } = snapBeatToGrid(value, settings)
  const limit = (settings.window / 100) * (grid / 2)
  if (distance > limit + 1e-9) return value
  return value + (target - value) * clamp01(settings.strength)
}

export function quantizeMidi(notes: MidiNote[], raw: QuantizeSettings, ctx: QuantizeContext = {}): MidiNote[] {
  const settings = normalizeQuantize(raw)
  const chosen = ctx.only?.length ? new Set(ctx.only) : null
  const tempo = ctx.tempo && ctx.tempo > 0 ? ctx.tempo : 120
  const rng = ctx.rng ?? (settings.seed == null ? Math.random : mulberry32(settings.seed))
  const working = notes.map((note) => ({ ...note }))
  const active = working.filter((note) => !chosen || chosen.has(note.id))
  for (const note of active) {
    if (note.velocity < settings.threshold) continue
    const start0 = note.startBeat
    const end0 = note.startBeat + note.durationBeats
    let start = start0
    let end = end0
    if (settings.starts) start = Math.max(0, moveToward(start0, settings))
    if (settings.keepLength) end = start + (end0 - start0)
    else if (settings.ends) {
      let snapped = moveToward(end0, settings)
      if (snapped <= start + 1e-6) {
        const grid = gridBeats(settings)
        snapped = start + grid
      }
      end = snapped
    }
    if (settings.lengthQuantize) {
      const grid = gridBeats(settings)
      const length = Math.max(grid, Math.round((end - start) / grid) * grid)
      end = start + length
    }
    note.startBeat = Math.max(0, start)
    note.durationBeats = Math.max(0.01, end - note.startBeat)
    if (settings.scaleSnap && ctx.scale) {
      const placed = placePitch(note.pitch + (note.fine || 0) / 100, ctx.root ?? 0, ctx.scale)
      note.pitch = placed.pitch
      if (placed.cents) note.fine = placed.cents
      else if (isMicrotonal(ctx.scale)) note.fine = undefined
    }
  }
  if (settings.velocity === 'fixed') {
    for (const note of active) note.velocity = nearestEighth(note.velocity)
  } else if (settings.velocity === 'compress' && active.length) {
    const center = active.reduce((sum, note) => sum + note.velocity, 0) / active.length
    const keep = 1 - clamp01(settings.velocityCompress)
    for (const note of active) note.velocity = clamp(center + (note.velocity - center) * keep, 0.05, 1)
  }
  const time = (Math.max(0, settings.humanizeMs) / 1000) * (tempo / 60)
  const vel = Math.max(0, settings.humanizeVel) / 100
  if (time > 0 || vel > 0) {
    for (const note of active) {
      if (time > 0) note.startBeat = Math.max(0, note.startBeat + (rng() - 0.5) * 2 * time)
      if (vel > 0) note.velocity = clamp(note.velocity * (1 + (rng() - 0.5) * 2 * vel), 0.05, 1)
    }
  }
  if (settings.fixOverlaps) fixOverlaps(working, chosen)
  if (settings.legato) applyLegato(working, chosen)
  return working
}

export function quantizeChannel(channel: StepChannel, raw: QuantizeSettings, ctx: QuantizeContext = {}): StepCell[] {
  const count = Math.max(1, Math.min(64, Math.round(channel.steps || 16)))
  const notes: MidiNote[] = []
  for (let index = 0; index < count; index++) {
    const cell = channel.cells[index]
    if (!cell?.on) continue
    notes.push({
      id: String(index),
      pitch: channel.note + (cell.pitch || 0),
      startBeat: index * STEP_BEAT + (cell.nudge || 0),
      durationBeats: Math.max(0.02, (cell.gate || 0.8) * STEP_BEAT),
      velocity: cell.velocity || 0.8,
    })
  }
  const moved = quantizeMidi(notes, { ...normalizeQuantize(raw), legato: false, fixOverlaps: false }, ctx)
  const cells = channel.cells.map((cell) => ({ ...emptyCell(), ...cell, on: false }))
  const claimed = new Set<number>()
  for (const note of moved) {
    let index = Math.round(note.startBeat / STEP_BEAT)
    index = Math.max(0, Math.min(count - 1, index))
    if (claimed.has(index) && (cells[index].velocity || 0) >= note.velocity) continue
    claimed.add(index)
    const source = channel.cells[Number(note.id)] ?? emptyCell()
    cells[index] = {
      ...source,
      on: true,
      velocity: note.velocity,
      pitch: note.pitch - channel.note,
      nudge: note.startBeat - index * STEP_BEAT,
      gate: Math.max(0.05, Math.min(1, note.durationBeats / STEP_BEAT)),
    }
  }
  return cells
}

export function detectTransients(channel: Float32Array, sampleRate: number, threshold: number): number[] {
  let peak = 0
  for (let index = 0; index < channel.length; index++) peak = Math.max(peak, Math.abs(channel[index] || 0))
  if (peak < 1e-6) return []
  const gate = Math.max(0.02, Math.min(0.95, threshold || 0)) * peak
  const minGap = Math.max(1, Math.round(sampleRate * 0.03))
  const hits: number[] = []
  let last = -minGap
  for (let index = 1; index < channel.length - 1; index++) {
    const mag = Math.abs(channel[index] || 0)
    if (mag < gate || mag < Math.abs(channel[index - 1] || 0) || mag <= Math.abs(channel[index + 1] || 0)) continue
    if (index - last < minGap) continue
    hits.push(index)
    last = index
  }
  return hits
}

export function quantizeAudioStart(clip: AudioClip, channel: Float32Array, sampleRate: number, tempo: number, raw: QuantizeSettings): AudioClip {
  const settings = normalizeQuantize(raw)
  const slice = channel.subarray(clip.offsetSamples, clip.offsetSamples + clip.durationSamples)
  const hits = detectTransients(slice, sampleRate, settings.threshold)
  const timeline = clip.startSample + (hits[0] ?? 0)
  const beat = samplesToBeats(timeline, sampleRate, tempo)
  const next = moveToward(beat, settings)
  const delta = beatsToSamples(next - beat, sampleRate, tempo)
  return { ...clip, startSample: Math.max(0, Math.round(clip.startSample + delta)) }
}

export function quantizeAudioWarp(clip: AudioClip, channel: Float32Array, sampleRate: number, tempo: number, raw: QuantizeSettings): AudioClip {
  const settings = normalizeQuantize({ ...raw, ends: false, keepLength: true, legato: false, fixOverlaps: false, lengthQuantize: false })
  const from = Math.max(0, clip.offsetSamples)
  const to = Math.min(channel.length, from + clip.durationSamples)
  const slice = channel.subarray(from, to)
  const hits = detectTransients(slice, sampleRate, settings.threshold).map((sample) => sample + from)
  const secondsPerBeat = 60 / Math.max(1, tempo)
  const notes: MidiNote[] = hits.map((sample, index) => ({
    id: String(index),
    pitch: 60,
    startBeat: (sample - from) / sampleRate / secondsPerBeat,
    durationBeats: 0.01,
    velocity: 1,
  }))
  const moved = quantizeMidi(notes, settings, { tempo })
  const endBeat = Math.max(0.01, (to - from) / sampleRate / secondsPerBeat)
  const points: WarpPoint[] = [{ source: from, target: 0 }]
  for (let index = 0; index < hits.length; index++) {
    const target = Math.max(0, moved[index]?.startBeat ?? 0)
    const prev = points[points.length - 1]
    if (hits[index] <= prev.source + 1 || target <= prev.target + 1e-4) continue
    points.push({ source: hits[index], target })
  }
  const tail = Math.max(endBeat, points[points.length - 1].target + 0.01)
  points.push({ source: to, target: tail })
  const durationSamples = Math.max(1, Math.round(beatsToSamples(tail, sampleRate, tempo)))
  return { ...clip, warpPoints: points, durationSamples }
}

export interface WarpSpan {
  at: number
  offset: number
  sourceSeconds: number
  seconds: number
  rate: number
}

export function warpSpans(clip: AudioClip, sampleRate: number, tempo: number): WarpSpan[] | null {
  const points = clip.warpPoints
  if (!points || points.length < 2) return null
  const spans: WarpSpan[] = []
  for (let index = 0; index < points.length - 1; index++) {
    const left = points[index]
    const right = points[index + 1]
    const sourceSamples = right.source - left.source
    const targetBeats = right.target - left.target
    if (sourceSamples < 1 || targetBeats <= 0.0001) continue
    const seconds = targetBeats * (60 / Math.max(1, tempo))
    const sourceSeconds = sourceSamples / sampleRate
    spans.push({
      at: Math.max(0, Math.round(beatsToSamples(left.target, sampleRate, tempo))),
      offset: left.source / sampleRate,
      sourceSeconds,
      seconds,
      rate: sourceSeconds / seconds,
    })
  }
  return spans.length ? spans : null
}

/** Render warp markers with the shared stretch engine. Output length is the clip; pitch stays. */
export function renderQuantizedClip(channels: Float32Array[], clip: AudioClip, sampleRate: number, tempo: number): Float32Array[] {
  const points = clip.warpPoints
  if (!points || points.length < 2) {
    const from = Math.max(0, clip.offsetSamples)
    const to = from + Math.max(1, clip.durationSamples)
    return channels.map((channel) => Float32Array.from(channel.subarray(from, Math.min(channel.length, to))))
  }
  const ordered = [...points].sort((a, b) => a.source - b.source)
  const offset = ordered[0].source
  const sourceSamples = Math.max(1, ordered[ordered.length - 1].source - offset)
  const markers: WarpMarker[] = ordered.map((point, index) => ({
    id: `w${index}`,
    source: point.source - offset,
    target: point.target,
  }))
  const stretch: ClipStretch = {
    sourceSamples,
    semitones: 0,
    cents: 0,
    mode: markers.length > 2 ? 'beats' : 'tonal',
    followTempo: false,
    sourceBpm: null,
    markers,
  }
  const project = { sampleRate, tempo, automation: [] } as unknown as Project
  return renderClipChannels(channels, { ...clip, offsetSamples: offset, stretch }, project)
}

function fixOverlaps(notes: MidiNote[], active: Set<string> | null) {
  const byPitch = new Map<number, MidiNote[]>()
  for (const note of notes) {
    const list = byPitch.get(note.pitch) ?? []
    list.push(note)
    byPitch.set(note.pitch, list)
  }
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.startBeat - b.startBeat)
    for (let index = 0; index < list.length - 1; index++) {
      const note = list[index]
      const next = list[index + 1]
      if (active && !active.has(note.id)) continue
      const end = note.startBeat + note.durationBeats
      if (end > next.startBeat) note.durationBeats = Math.max(0.01, next.startBeat - note.startBeat)
    }
  }
}

function applyLegato(notes: MidiNote[], active: Set<string> | null) {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  for (let index = 0; index < sorted.length - 1; index++) {
    const note = sorted[index]
    if (active && !active.has(note.id)) continue
    const next = sorted[index + 1]
    if (next.startBeat > note.startBeat) note.durationBeats = Math.max(0.01, next.startBeat - note.startBeat)
  }
}

function nearestEighth(velocity: number) {
  const step = Math.round(clamp(velocity, 0.125, 1) * 8) / 8
  return clamp(step, 0.125, 1)
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function clampInt(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function mod(value: number, length: number) {
  return ((value % length) + length) % length
}
