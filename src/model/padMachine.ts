/** Pad banks, swing, chops, and step logic for the drum deck. */

import { DRUM_PADS } from './drums'
import { quantizeBeat } from './midiClock'
import { scaleById, pitchClass, type ScaleId } from './scale'

export const BANKS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
export type BankId = (typeof BANKS)[number]
export type LevelSpread = 'velocity' | 'tune' | 'filter' | 'decay' | 'attack'
export type LayerMode = 'velocity' | 'robin' | 'random'
export type StepCondition = 'always' | '1:2' | '1:4' | 'fill'
export type GridLayout = 'fourths' | 'sequential'
export type RecordTakeMode = 'overdub' | 'replace'
export type ChopMode = 'transient' | 'regions' | 'bpm'
export type PadPoly = 'poly' | 'mono'

export const PAD_MACROS = ['tune', 'filter', 'attack', 'decay', 'sustain', 'release', 'pan', 'level'] as const

export interface LevelParams {
  velocity: number
  tune: number
  filter: number
  decay: number
  attack: number
}

export interface PadLayer {
  velocityLo: number
  velocityHi: number
  tune: number
  bufferId?: string
}

export interface PadVoice {
  pitch: number
  name: string
  /** Full library name. The pad face keeps the short role name. */
  sampleName?: string
  level: number
  pan: number
  send: number
  choke: number
  poly: PadPoly
  tune: number
  filter: number
  filterEnv: number
  attack: number
  decay: number
  sustain: number
  release: number
  layerMode: LayerMode
  layers: PadLayer[]
  busId?: string
  /** Pad mute. Recorded notes stay; the voice does not sound. */
  muted?: boolean
}

export interface SequenceNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  probability?: number
  condition?: StepCondition
  nudge?: number
  locks?: Record<string, number>
  velocityLo?: number
  velocityHi?: number
}

export interface PadSequence {
  id: string
  name: string
  lengthBeats: number
  notes: SequenceNote[]
}

export interface SongSlot {
  sequenceId: string
  repeats: number
}

export interface PadProgram {
  banks: PadVoice[][]
  swing: number
  trackSwing: number
  activeBank: number
  seed: number
  fill: boolean
  timing: boolean
  timingStrength: number
  timingGrid: number
  sequences: PadSequence[]
  song: SongSlot[]
  name?: string
}

const FREE_PITCHES: number[] = []
{
  const used = new Set(DRUM_PADS.map((pad) => pad.pitch))
  for (let pitch = 0; pitch < 128; pitch++) if (!used.has(pitch)) FREE_PITCHES.push(pitch)
}

export function bankPitch(bank: number, index: number): number {
  const b = clamp(Math.round(bank), 0, 7)
  const i = clamp(Math.round(index), 0, 15)
  if (b === 0) return DRUM_PADS[i].pitch
  return FREE_PITCHES[(b - 1) * 16 + i] ?? 0
}

/** Sixteen pads of a 128-pad drum rack. */
export function rackPitch(page: number, index: number): number {
  return clamp(page * 16 + index, 0, 127)
}

export function sixteenLevels(index: number, spread: LevelSpread): LevelParams {
  const i = clamp(Math.round(index), 0, 15)
  const across = i / 15
  const neutral: LevelParams = { velocity: 1, tune: 0, filter: 1, decay: 1, attack: 0 }
  if (spread === 'velocity') return { ...neutral, velocity: (i + 1) / 16 }
  if (spread === 'tune') return { ...neutral, tune: -12 + across * 24 }
  if (spread === 'filter') return { ...neutral, filter: across }
  if (spread === 'decay') return { ...neutral, decay: (i + 1) / 16 }
  return { ...neutral, attack: across }
}

/** Odd repeats slide later. 50% is straight. 75% parks the offbeat three quarters of the way through the pair. */
export function swungRepeats(startBeat: number, endBeat: number, intervalBeats: number, swingPercent: number): number[] {
  if (!(intervalBeats > 0)) return [startBeat]
  const delay = intervalBeats * swingDelay(swingPercent)
  const straight: number[] = []
  const limit = endBeat - intervalBeats * 1e-6
  for (let beat = startBeat; beat <= limit; beat += intervalBeats) straight.push(beat)
  if (!straight.length) return [startBeat]
  const marks: number[] = []
  for (let i = 0; i < straight.length; i++) {
    const beat = i % 2 === 1 ? straight[i] + delay : straight[i]
    if (beat < endBeat - 1e-9) marks.push(beat)
  }
  return marks.length ? marks : [startBeat]
}

/** Pull a played beat toward the grid, then swing the odd grid point. Off leaves the beat alone. */
export function timingCorrect(beat: number, grid: number, strength: number, swingPercent: number, enabled: boolean): number {
  if (!enabled || !(grid > 0)) return beat
  const amount = clamp(strength, 0, 1)
  const target = quantizeBeat(beat, grid)
  const pulled = beat + (target - beat) * amount
  const index = Math.round(target / grid)
  if (index % 2 === 1) return pulled + grid * swingDelay(swingPercent) * amount
  return pulled
}

export function swingDelay(swingPercent: number): number {
  return 2 * (clampSwing(swingPercent) / 100) - 1
}

export function effectiveSwing(program: number, track: number): number {
  return clampSwing(Number.isFinite(track) ? track : program)
}

export function chokeTargets(pads: { pitch: number; choke: number }[], playedPitch: number): number[] {
  const mine = pads.find((pad) => pad.pitch === playedPitch)
  if (!mine || !mine.choke) return []
  return pads.filter((pad) => pad.choke === mine.choke && pad.pitch !== playedPitch).map((pad) => pad.pitch)
}

export function pickLayer(layers: PadLayer[], velocity: number, mode: LayerMode, robinIndex: number, seed: number): number {
  const count = Math.max(1, Math.min(4, layers.length))
  if (mode === 'robin') return ((robinIndex % count) + count) % count
  if (mode === 'random') return Math.floor(unitHash(seed, robinIndex, 0) * count)
  const found = layers.findIndex((layer, index) => index < count && velocity >= layer.velocityLo && velocity <= layer.velocityHi)
  return found >= 0 ? found : 0
}

/** Deterministic 0–1 value. The same seed, step, and bar always match. */
export function unitHash(seed: number, step: number, bar: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(step | 0, 668265263) + Math.imul(bar | 0, 1274126177)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

export function stepFires(probability: number, condition: StepCondition, seed: number, step: number, bar: number, fill: boolean): boolean {
  if (condition === '1:2' && bar % 2 !== 0) return false
  if (condition === '1:4' && bar % 4 !== 0) return false
  if (condition === 'fill' && !fill) return false
  const chance = clamp(probability, 0, 1)
  if (chance >= 1) return true
  if (chance <= 0) return false
  return unitHash(seed, step, bar) < chance
}

export function velocityInRange(lo: number, hi: number, unit: number): number {
  const span = hi - lo
  return lo + clamp(unit, 0, 1) * span
}

export interface StepLock {
  step: number
  nudge?: number
  swing?: number
  locks: Record<string, number>
}

/** A lock applies only on its own step, within a millionth of a beat. */
export function locksAtBeat(events: StepLock[], beat: number, stepBeats: number): Record<string, number> | null {
  for (const event of events) {
    const moment = event.step * stepBeats + (event.nudge || 0) + (event.swing || 0)
    if (Math.abs(beat - moment) <= 1e-6) return event.locks
  }
  return null
}

export interface PlaybackNote {
  startBeat: number
  velocity: number
  probability?: number
  condition?: StepCondition
  nudge?: number
  locks?: Record<string, number>
  velocityLo?: number
  velocityHi?: number
}

export function noteForPlayback<T extends PlaybackNote>(note: T, opts: { stepBeats: number; seed: number; bar: number; fill: boolean }): T | null {
  const step = Math.round((note.startBeat - (note.nudge || 0)) / opts.stepBeats)
  if (!stepFires(note.probability ?? 1, note.condition ?? 'always', opts.seed, step, opts.bar, opts.fill)) return null
  const ranged = note.velocityLo != null && note.velocityHi != null
    ? velocityInRange(note.velocityLo, note.velocityHi, unitHash(opts.seed, step, opts.bar))
    : note.velocity
  if (!note.locks || !Object.keys(note.locks).length) return ranged === note.velocity ? note : { ...note, velocity: ranged }
  const locks = locksAtBeat([{ step, nudge: note.nudge || 0, locks: note.locks }], note.startBeat, opts.stepBeats)
  if (!locks) {
    const cleared = { ...note, velocity: ranged, locks: undefined }
    return cleared
  }
  return { ...note, velocity: locks.velocity ?? ranged, locks }
}

export function eraseWhilePlaying<T extends { pitch: number; startBeat: number }>(notes: T[], pitch: number, fromBeat: number, toBeat: number): T[] {
  const from = Math.min(fromBeat, toBeat)
  const to = Math.max(fromBeat, toBeat)
  return notes.filter((note) => !(note.pitch === pitch && note.startBeat >= from && note.startBeat < to))
}

export function chainSong(slots: { sequenceId: string; repeats: number }[], sequences: { id: string; lengthBeats: number }[]): { id: string; start: number; end: number }[] {
  const spans: { id: string; start: number; end: number }[] = []
  let cursor = 0
  for (const slot of slots) {
    const sequence = sequences.find((item) => item.id === slot.sequenceId)
    if (!sequence) continue
    const repeats = Math.max(1, Math.round(slot.repeats || 1))
    for (let i = 0; i < repeats; i++) {
      spans.push({ id: sequence.id, start: cursor, end: cursor + sequence.lengthBeats })
      cursor += sequence.lengthBeats
    }
  }
  return spans
}

export function gridPitch(rowFromBottom: number, column: number, root: number, scaleId: ScaleId, layout: GridLayout, inKey: boolean): { pitch: number; isRoot: boolean } {
  const base = root > 11 ? clamp(Math.round(root), 0, 127) : 60 + ((Math.round(root) % 12) + 12) % 12
  const intervals = scaleById(scaleId).intervals
  let pitch = base
  if (layout === 'fourths') {
    if (inKey) pitch = degreePitch(base, column + rowFromBottom * 3, intervals)
    else pitch = base + column + rowFromBottom * 5
  } else {
    const index = rowFromBottom * 8 + column
    pitch = inKey ? degreePitch(base, index, intervals) : base + index
  }
  pitch = clamp(pitch, 0, 127)
  return { pitch, isRoot: pitchClass(pitch) === pitchClass(base) }
}

function degreePitch(base: number, degree: number, intervals: readonly number[]): number {
  const span = intervals.length || 1
  const octave = Math.floor(degree / span)
  const step = ((degree % span) + span) % span
  return base + octave * 12 + intervals[step]
}

export function ratchetBeats(stepBeat: number, stepLength: number, count: number): number[] {
  const hits = count >= 4 ? 4 : count >= 2 ? 2 : 1
  const span = stepLength / hits
  return Array.from({ length: hits }, (_, index) => stepBeat + index * span)
}

export function doubleLength<T extends { startBeat: number }>(notes: T[], lengthBeats: number): { notes: T[]; lengthBeats: number } {
  const copies = notes.map((note) => ({ ...note, startBeat: note.startBeat + lengthBeats }))
  return { notes: [...notes, ...copies], lengthBeats: lengthBeats * 2 }
}

export function recordTake<T extends { startBeat: number }>(existing: T[], incoming: T[], mode: RecordTakeMode, loopStart: number, loopEnd: number): T[] {
  if (mode !== 'replace') return [...existing, ...incoming]
  const kept = existing.filter((note) => note.startBeat < loopStart || note.startBeat >= loopEnd)
  return [...kept, ...incoming]
}

export function chopSample(samples: Float32Array, sampleRate: number, mode: ChopMode, opts?: { regions?: number; bpm?: number; threshold?: number }): { start: number; end: number }[] {
  const length = samples.length
  if (!length) return []
  if (mode === 'regions') {
    const count = clamp(Math.round(opts?.regions || 4), 1, 64)
    const span = Math.floor(length / count) || 1
    return Array.from({ length: count }, (_, index) => ({
      start: index * span,
      end: index === count - 1 ? length : Math.min(length, (index + 1) * span),
    }))
  }
  if (mode === 'bpm') {
    const bpm = Math.max(20, opts?.bpm || 120)
    const slice = Math.max(1, Math.round((sampleRate * 60) / bpm / 4))
    const regions: { start: number; end: number }[] = []
    for (let start = 0; start < length; start += slice) regions.push({ start, end: Math.min(length, start + slice) })
    return regions
  }
  const threshold = opts?.threshold ?? 0.35
  const win = Math.max(1, Math.round(sampleRate * 0.01))
  const gap = Math.round(sampleRate * 0.05)
  const onsets = [0]
  let last = 0
  for (let i = win; i + win < length; i += win) {
    let energy = 0
    let prev = 0
    for (let j = 0; j < win; j++) {
      energy += Math.abs(samples[i + j])
      prev += Math.abs(samples[i - win + j])
    }
    if (i - last < gap) continue
    if (energy > prev * (1 + threshold) && energy / win > 0.02) {
      onsets.push(i)
      last = i
    }
  }
  return onsets.map((start, index) => ({ start, end: onsets[index + 1] ?? length }))
}

export function chopsToPads(chops: { start: number; end: number }[], name: string): { pad: number; name: string; start: number; end: number }[] {
  return chops.slice(0, 16).map((chop, pad) => ({ pad, name: `${name} ${pad + 1}`, start: chop.start, end: chop.end }))
}

export function padVelocity(played: number, fullLevel: boolean, accent: boolean): number {
  if (fullLevel) return 1
  const base = clamp(played, 0, 1)
  return accent ? Math.min(1, base + 0.25) : base
}

export function latchRepeat(latched: boolean, pressed: boolean): boolean {
  return pressed ? !latched : latched
}

export function kitPreset(id: 'room' | 'tight'): { name: string; tune: number; decay: number; attack: number } {
  if (id === 'tight') return { name: 'Tight kit', tune: 2, decay: 0.45, attack: 0 }
  return { name: 'Room kit', tune: -2, decay: 1, attack: 0.02 }
}

export function createKit(): PadProgram {
  return {
    banks: BANKS.map((_, bank) => Array.from({ length: 16 }, (_, index) => makePad(bank, index))),
    swing: 50,
    trackSwing: 50,
    activeBank: 0,
    seed: 1,
    fill: false,
    timing: false,
    timingStrength: 1,
    timingGrid: 0.25,
    sequences: [],
    song: [],
  }
}

export function normalizePadKit(value: Partial<PadProgram> | undefined | null): PadProgram {
  const base = createKit()
  if (!value) return base
  const banks = base.banks.map((row, bank) => row.map((pad, index) => {
    const incoming = value.banks?.[bank]?.[index]
    if (!incoming) return pad
    return {
      ...pad,
      ...incoming,
      pitch: Number.isFinite(incoming.pitch) ? clamp(Math.round(incoming.pitch), 0, 127) : pad.pitch,
      name: incoming.name || pad.name,
      level: clamp(incoming.level ?? pad.level, 0, 1),
      pan: clamp(incoming.pan ?? 0, -1, 1),
      send: clamp(incoming.send ?? 0, 0, 1),
      choke: Math.max(0, Math.round(incoming.choke || 0)),
      poly: incoming.poly === 'mono' ? 'mono' : 'poly',
      tune: clamp(incoming.tune ?? 0, -24, 24),
      filter: clamp(incoming.filter ?? 1, 0, 1),
      filterEnv: clamp(incoming.filterEnv ?? 0, 0, 1),
      attack: clamp(incoming.attack ?? 0, 0, 1),
      decay: clamp(incoming.decay ?? 1, 0.05, 1),
      sustain: clamp(incoming.sustain ?? 1, 0, 1),
      release: clamp(incoming.release ?? 0.1, 0, 2),
      layerMode: incoming.layerMode === 'robin' || incoming.layerMode === 'random' ? incoming.layerMode : 'velocity',
      layers: normalizeLayers(incoming.layers),
      busId: incoming.busId || undefined,
      muted: Boolean(incoming.muted),
    } as PadVoice
  }))
  return {
    ...base,
    swing: clampSwing(value.swing ?? 50),
    trackSwing: clampSwing(value.trackSwing ?? 50),
    activeBank: clamp(Math.round(value.activeBank ?? 0), 0, 7),
    seed: Number.isFinite(value.seed) ? (value.seed as number) : 1,
    fill: Boolean(value.fill),
    timing: Boolean(value.timing),
    timingStrength: clamp(value.timingStrength ?? 1, 0, 1),
    timingGrid: value.timingGrid && value.timingGrid > 0 ? value.timingGrid : 0.25,
    sequences: Array.isArray(value.sequences) ? value.sequences : [],
    song: Array.isArray(value.song) ? value.song : [],
    name: value.name,
    banks,
  }
}

export function padFingerprint(kit: PadProgram): string {
  return JSON.stringify({
    swing: kit.swing,
    trackSwing: kit.trackSwing,
    song: kit.song,
    fill: kit.fill,
    timing: kit.timing,
    timingStrength: kit.timingStrength,
    name: kit.name || '',
    banks: kit.banks.map((row) => row.map((pad) => [pad.choke, pad.level, pad.pan, pad.send, pad.tune, pad.decay, pad.busId || '', pad.layers[0]?.bufferId || ''])),
  })
}

function makePad(bank: number, index: number): PadVoice {
  const pitch = bankPitch(bank, index)
  const known = DRUM_PADS.find((pad) => pad.pitch === pitch)
  return {
    pitch,
    name: known?.name ?? `${BANKS[bank]}${index + 1}`,
    level: 0.8,
    pan: 0,
    send: 0,
    choke: pitch === 42 || pitch === 46 ? 1 : 0,
    poly: 'poly',
    tune: 0,
    filter: 1,
    filterEnv: 0,
    attack: 0,
    decay: 1,
    sustain: 1,
    release: 0.1,
    layerMode: 'velocity',
    layers: [{ velocityLo: 0, velocityHi: 1, tune: 0 }],
  }
}

function normalizeLayers(layers: PadLayer[] | undefined): PadLayer[] {
  const source = Array.isArray(layers) && layers.length ? layers.slice(0, 4) : [{ velocityLo: 0, velocityHi: 1, tune: 0 }]
  return source.map((layer) => ({
    velocityLo: clamp(layer.velocityLo ?? 0, 0, 1),
    velocityHi: clamp(layer.velocityHi ?? 1, 0, 1),
    tune: clamp(layer.tune ?? 0, -24, 24),
    bufferId: layer.bufferId,
  }))
}

function clampSwing(value: number): number {
  return clamp(value, 50, 75)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
