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
  const chromatic = (params.mode ?? 1) < 0.5 && mask <= 0
  const root = (params.root ?? -1) >= 0 ? Math.round(params.root) : ctx.scaleRoot
  const scaleIndex = Math.round(params.scaleIndex ?? -1)
  if (!chromatic && mask <= 0 && scaleIndex < 0) {
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
    const allowed = mask > 0 ? (mask & (1 << pc)) !== 0 : chromatic ? true : intervals.some((interval) => interval === rel)
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
