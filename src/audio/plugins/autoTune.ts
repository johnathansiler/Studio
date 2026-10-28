/** Auto-Tune insert helpers. The saved plugin id stays `tune`. */

import { NOTE_NAMES, SCALES, pitchClass } from '../../model/scale'
import { findScale, getScale } from '../../theory/scales'

export const TUNE_ID = 'tune'
export const TUNE_NAME = 'Auto-Tune'

/** Applied when a track insert is created without an explicit preset. */
export const TUNE_INSERT_PRESET = 'Hard tune/T-Pain'

export const TUNE_PRESET_NAMES = [
  'Hard tune/T-Pain',
  'Natural',
  'Soprano',
  'Alto/Tenor',
  'Low male',
  'Instrument',
] as const

export const TUNE_PRESET_META: { name: (typeof TUNE_PRESET_NAMES)[number]; short: string; hint: string }[] = [
  { name: 'Hard tune/T-Pain', short: 'Hard', hint: 'Fast snap. Follows the project key.' },
  { name: 'Natural', short: 'Natural', hint: 'Slow correction. Keeps some of the original pitch.' },
  { name: 'Soprano', short: 'Soprano', hint: 'Higher voice range. Follows the project key.' },
  { name: 'Alto/Tenor', short: 'Alto', hint: 'Mid voice range. Follows the project key.' },
  { name: 'Low male', short: 'Low', hint: 'Low voice range. Follows the project key.' },
  { name: 'Instrument', short: 'Inst', hint: 'Chromatic snap for instruments.' },
]

/** Pairs of detected Hz, corrected Hz. Index 2k is detected, 2k+1 is the correction target. */
export const TUNE_TRACE_FRAMES = 64

export function tuneLiveHop(sampleRate: number) {
  return Math.max(128, Math.round(256 * (sampleRate / 48000)))
}

/** Output delay of the monitoring path: two hops, not the HQ analysis window. */
export function tuneLiveLatency(sampleRate: number) {
  return tuneLiveHop(sampleRate) * 2
}

/** Auto-Tune leads every insert list. */
export function orderedInserts<T extends { id: string }>(entries: readonly T[]): T[] {
  const index = entries.findIndex((item) => item.id === TUNE_ID)
  if (index <= 0) return [...entries]
  const next = [...entries]
  const [tune] = next.splice(index, 1)
  next.unshift(tune)
  return next
}

export interface TuneScaleFrame {
  root: number
  note: string
  scaleName: string
  cents: number[]
  intervals: number[]
}

let cachedScaleKey = ''
let cachedScaleFrame: TuneScaleFrame = {
  root: 0,
  note: 'C',
  scaleName: 'Major',
  cents: [0, 200, 400, 500, 700, 900, 1100],
  intervals: [0, 2, 4, 5, 7, 9, 11],
}
let cachedBlockFrame: TuneScaleFrame | null = null
let cachedBlock = { scaleRoot: 0, scaleIntervals: cachedScaleFrame.intervals, scaleCents: cachedScaleFrame.cents }

/** The scale Auto-Tune follows when its key and scale are set to Project. */
export function tuneScaleOf(scale: { root?: number; scale?: string; library?: string } | null | undefined): TuneScaleFrame {
  const libraryId = scale?.library ?? ''
  const known = libraryId && findScale(libraryId) ? libraryId : ''
  const key = `${scale?.root ?? 0}|${scale?.scale ?? ''}|${known}`
  if (key === cachedScaleKey) return cachedScaleFrame
  const root = ((Math.round(scale?.root ?? 0) % 12) + 12) % 12
  const spec = getScale(known || scale?.scale)
  const cents = spec.cents.slice()
  const twelve = cents.every((value) => Math.abs(value - Math.round(value / 100) * 100) < 0.6)
  const intervals = (twelve ? cents.map((value) => Math.round(value / 100)) : cents.map((value) => Math.round(value / 100) % 12)).filter(
    (interval, index, all) => all.indexOf(interval) === index,
  )
  cachedScaleKey = key
  cachedScaleFrame = {
    root,
    note: NOTE_NAMES[root] ?? 'C',
    scaleName: spec.name,
    cents,
    intervals: intervals.length ? intervals : [0, 2, 4, 5, 7, 9, 11],
  }
  return cachedScaleFrame
}

/** Stable object while the project scale is unchanged, so the live callback does not allocate. */
export function tuneBlockScale(scale: { root?: number; scale?: string; library?: string } | null | undefined) {
  const frame = tuneScaleOf(scale)
  if (cachedBlockFrame === frame) return cachedBlock
  cachedBlockFrame = frame
  cachedBlock = { scaleRoot: frame.root, scaleIntervals: frame.intervals, scaleCents: frame.cents }
  return cachedBlock
}

/** Factory or saved preset whose stored values match. The first match wins. */
export function activeTunePreset(params: Record<string, number>, presets: readonly { name: string; params: Record<string, number> }[]) {
  for (const preset of presets) {
    const keys = Object.keys(preset.params)
    if (!keys.length) continue
    const match = keys.every((key) => Math.abs((params[key] ?? 0) - preset.params[key]) < 0.001)
    if (match) return preset.name
  }
  return null
}

/**
 * Nearest allowed MIDI pitch. A fractional result is cents above the integer note.
 * Project scale (scale index -1) uses `scaleCents` so quarter tones stay in key.
 */
export function tuneSnapMidi(
  midi: number,
  params: Record<string, number>,
  ctx: { scaleRoot: number; scaleIntervals: readonly number[]; scaleCents?: readonly number[] },
) {
  const mask = Math.round(params.mask || 0)
  const maskOn = (params.custom ?? 0) >= 0.5 || mask > 0
  const chromatic = (params.mode ?? 1) < 0.5 && !maskOn
  const root = (params.root ?? -1) >= 0 ? Math.round(params.root) : ctx.scaleRoot
  const scaleIndex = Math.round(params.scaleIndex ?? -1)
  if (!chromatic && !maskOn && scaleIndex < 0) {
    const degrees = ctx.scaleCents?.length
      ? ctx.scaleCents
      : (ctx.scaleIntervals?.length ? ctx.scaleIntervals : [0, 2, 4, 5, 7, 9, 11]).map((interval) => interval * 100)
    return nearestCents(midi, root, degrees)
  }
  const intervals: readonly number[] = scaleIndex >= 0 && SCALES[scaleIndex] ? SCALES[scaleIndex].intervals : ctx.scaleIntervals
  let best = Math.round(midi)
  let bestDist = 99
  for (let note = Math.floor(midi) - 3; note <= Math.ceil(midi) + 3; note++) {
    const pc = pitchClass(note)
    const rel = ((pc - root) % 12 + 12) % 12
    const allowed = maskOn ? (mask & (1 << pc)) !== 0 : chromatic ? true : intervals.some((interval) => interval === rel)
    if (!allowed) continue
    const dist = Math.abs(note - midi)
    if (dist < bestDist || (dist === bestDist && note < best)) {
      best = note
      bestDist = dist
    }
  }
  return best
}

function nearestCents(midi: number, root: number, degrees: readonly number[]) {
  const target = midi * 100
  const rootPc = ((Math.round(root) % 12) + 12) % 12
  const center = Math.round(midi / 12) * 12 + rootPc
  let best = target
  let bestDist = Infinity
  for (let oct = -2; oct <= 2; oct++) {
    const tonic = (center + oct * 12) * 100
    for (const degree of degrees) {
      const abs = tonic + degree
      const dist = Math.abs(abs - target)
      if (dist < bestDist - 0.01 || (Math.abs(dist - bestDist) <= 0.01 && abs < best)) {
        bestDist = dist
        best = abs
      }
    }
  }
  return best / 100
}

export function tuneOnTrack(plugins: readonly { id: string; pluginId: string; enabled: boolean }[]) {
  return plugins.find((plugin) => plugin.pluginId === TUNE_ID) ?? null
}

export const TUNE_RANGES = [
  { id: 'wide', name: 'Wide', minHz: 80, maxHz: 1000 },
  { id: 'soprano', name: 'Soprano', minHz: 200, maxHz: 1200 },
  { id: 'alto', name: 'Alto', minHz: 120, maxHz: 700 },
  { id: 'low', name: 'Low', minHz: 70, maxHz: 420 },
] as const

const BLACK = new Set([1, 3, 6, 8, 10])

export function tuneNudgeId(pc: number) {
  return `n${((pc % 12) + 12) % 12}`
}

export function scaleAllowMask(root: number, intervals: readonly number[]) {
  let mask = 0
  for (const interval of intervals) {
    const pc = ((Math.round(root) + Math.round(interval)) % 12 + 12) % 12
    mask |= 1 << pc
  }
  return mask
}

export function bitOn(mask: number, pc: number) {
  return (Math.round(mask) & (1 << (((pc % 12) + 12) % 12))) !== 0
}

export function toggleBit(mask: number, pc: number) {
  return (Math.round(mask) ^ (1 << (((pc % 12) + 12) % 12))) & 4095
}

/** Scale notes the keyboard should light. A custom mask replaces the scale. */
export function activeNoteMask(params: Record<string, number>, projectRoot: number, projectIntervals: readonly number[]) {
  const custom = (params.custom ?? 0) >= 0.5 || Math.round(params.mask || 0) > 0
  if (custom) return Math.round(params.mask || 0) & 4095
  if ((params.mode ?? 1) < 0.5) return 4095
  const root = (params.root ?? -1) >= 0 ? Math.round(params.root) : projectRoot
  const scaleIndex = Math.round(params.scaleIndex ?? -1)
  const intervals = scaleIndex >= 0 && SCALES[scaleIndex] ? SCALES[scaleIndex].intervals : projectIntervals
  return scaleAllowMask(root, intervals)
}

/** Remove toggles a scale note. The first edit copies the current scale into the mask. */
export function nextScaleMask(stored: number, custom: boolean, derived: number, pc: number) {
  const base = custom || stored > 0 ? stored & 4095 : derived & 4095
  return toggleBit(base, pc)
}

export function dragNudge(startMidi: number, nextMidi: number, startCents: number) {
  const pc = ((Math.round(startMidi) % 12) + 12) % 12
  const cents = Math.max(-200, Math.min(200, Math.round(startCents + (nextMidi - startMidi) * 100)))
  return { id: tuneNudgeId(pc), cents }
}

export interface MeterRead {
  name: string
  octave: number
  cents: number
  hz: number
}

export function readMeter(trace: Float32Array | null, a4 = 440): MeterRead | null {
  if (!trace) return null
  for (let i = trace.length - 2; i >= 0; i -= 2) {
    const detected = trace[i] || 0
    const corrected = trace[i + 1] || 0
    const hz = detected > 0 ? detected : corrected
    if (hz <= 0) continue
    const ref = a4 > 0 ? a4 : 440
    const midi = 69 + 12 * Math.log2(hz / ref)
    const target = corrected > 0 ? 69 + 12 * Math.log2(corrected / ref) : Math.round(midi)
    const cents = Math.max(-100, Math.min(100, Math.round((midi - target) * 100)))
    const shown = corrected > 0 ? target : midi
    const rounded = Math.round(shown)
    const name = NOTE_NAMES[((rounded % 12) + 12) % 12] ?? 'C'
    return { name, octave: Math.floor(rounded / 12) - 1, cents, hz }
  }
  return null
}

export interface GraphNote {
  start: number
  end: number
  midi: number
  detected: number
  corrected: number
}

/** Stable runs of corrected pitch, for the graph blobs. */
export function graphNotes(trace: Float32Array | null): GraphNote[] {
  if (!trace) return []
  const notes: GraphNote[] = []
  let start = -1
  let midi = 0
  let detected = 0
  let corrected = 0
  const flush = (end: number) => {
    if (start < 0) return
    notes.push({ start, end, midi, detected, corrected })
    start = -1
  }
  const frames = Math.floor(trace.length / 2)
  for (let i = 0; i < frames; i++) {
    const heard = trace[i * 2] || 0
    const tuned = trace[i * 2 + 1] || 0
    const hz = tuned > 0 ? tuned : heard
    if (hz <= 0) {
      flush(i)
      continue
    }
    const next = Math.round(69 + 12 * Math.log2(hz / 440))
    if (start < 0 || next !== midi) {
      flush(i)
      start = i
      midi = next
      detected = heard
      corrected = tuned || heard
      continue
    }
    if (heard > 0) detected = heard
    if (tuned > 0) corrected = tuned
  }
  flush(frames)
  return notes.filter((note) => note.end - note.start >= 2)
}

export function heardPitchClass(trace: Float32Array | null) {
  if (!trace) return null
  const counts = new Array(12).fill(0)
  for (let i = 0; i + 1 < trace.length; i += 2) {
    const hz = trace[i] || trace[i + 1] || 0
    if (hz <= 0) continue
    const midi = Math.round(69 + 12 * Math.log2(hz / 440))
    counts[((midi % 12) + 12) % 12] += 1
  }
  let best = -1
  let n = 0
  counts.forEach((count, pc) => {
    if (count > n) {
      n = count
      best = pc
    }
  })
  return best < 0 ? null : best
}

export function isBlackKey(pc: number) {
  return BLACK.has(((pc % 12) + 12) % 12)
}

export const KEYBOARD_START = 48
export const KEYBOARD_END = 84
