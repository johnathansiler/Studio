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
  'Classic',
  'Harmony',
  'MIDI target',
] as const

export const TUNE_PRESET_META: { name: (typeof TUNE_PRESET_NAMES)[number]; short: string; hint: string }[] = [
  { name: 'Hard tune/T-Pain', short: 'Hard', hint: 'Fast snap. Follows the project key.' },
  { name: 'Natural', short: 'Natural', hint: 'Slow correction. Keeps some of the original pitch.' },
  { name: 'Soprano', short: 'Soprano', hint: 'Higher voice range. Follows the project key.' },
  { name: 'Alto/Tenor', short: 'Alto', hint: 'Mid voice range. Follows the project key.' },
  { name: 'Low male', short: 'Low', hint: 'Low voice range. Follows the project key.' },
  { name: 'Instrument', short: 'Inst', hint: 'Chromatic snap for instruments.' },
  { name: 'Classic', short: 'Classic', hint: 'Harder snap, with tracking and a slower note transition.' },
  { name: 'Harmony', short: 'Harmony', hint: 'Lead plus third, fifth, and both octaves.' },
  { name: 'MIDI target', short: 'MIDI', hint: 'Correct only while a MIDI note is held.' },
]

/** Pairs of detected Hz, corrected Hz. Index 2k is detected, 2k+1 is the correction target. */
export const TUNE_TRACE_FRAMES = 64

export function tuneLiveHop(sampleRate: number) {
  return Math.max(128, Math.round(256 * (sampleRate / 48000)))
}

/**
 * Output delay of the monitoring path.
 * The hop stays short. The lookahead is long enough for a two-period grain at the
 * bottom of the detector range, so low notes are not stitched from silence.
 */
export function tuneLiveLatency(sampleRate: number) {
  const hop = tuneLiveHop(sampleRate)
  const span = Math.max(1024, Math.round(1536 * (sampleRate / 48000)))
  const ahead = Math.max(hop, Math.floor((span - 1) / 2))
  return ahead + hop
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

export function dragNudge(startMidi: number, nextMidi: number, startCents: number, pc = Math.round(startMidi)) {
  const pitch = ((Math.round(pc) % 12) + 12) % 12
  const cents = Math.max(-200, Math.min(200, Math.round(startCents + (nextMidi - startMidi) * 100)))
  return { id: tuneNudgeId(pitch), cents }
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
export function graphNotes(trace: Float32Array | null, a4 = 440): GraphNote[] {
  if (!trace) return []
  const ref = a4 > 0 ? a4 : 440
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
    const next = Math.round(69 + 12 * Math.log2(hz / ref))
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

/** Fractional MIDI of a blob. The nudge is already in the corrected frequency. */
export function blobMidi(note: GraphNote, a4 = 440) {
  const hz = note.corrected > 0 ? note.corrected : note.detected
  const ref = a4 > 0 ? a4 : 440
  if (hz <= 0) return note.midi
  return 69 + 12 * Math.log2(hz / ref)
}

/** Pitch class the correction offset belongs to, after that offset has moved the blob. */
export function nudgeKey(correctedMidi: number, values: Record<string, number>) {
  let bestPc = ((Math.round(correctedMidi) % 12) + 12) % 12
  let bestErr = Infinity
  for (let pc = 0; pc < 12; pc++) {
    const nudge = (values[tuneNudgeId(pc)] ?? 0) / 100
    const source = correctedMidi - nudge
    const rounded = Math.round(source)
    const err = Math.abs(source - rounded)
    if ((((rounded % 12) + 12) % 12) === pc && err < bestErr) {
      bestErr = err
      bestPc = pc
    }
  }
  return tuneNudgeId(bestPc)
}

export function heardPitchClass(trace: Float32Array | null, a4 = 440) {
  if (!trace) return null
  const ref = a4 > 0 ? a4 : 440
  const counts = new Array(12).fill(0)
  for (let i = 0; i + 1 < trace.length; i += 2) {
    const hz = trace[i] || trace[i + 1] || 0
    if (hz <= 0) continue
    const midi = Math.round(69 + 12 * Math.log2(hz / ref))
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

/**
 * Appended after n11. Do not insert anything earlier: the Rust layout and the
 * TypeScript catalog share these indexes.
 */
export const TUNE_APPENDED_IDS = [
  'tracking', 'transition', 'throat', 'vibeRate', 'vibeDepth', 'vibeOnset',
  'autoKey', 'midi', 'harmony', 'h1', 'h2', 'h3', 'h4', 'vocal',
  'r0lo', 'r0hi', 'r0ct', 'r0amt',
  'r1lo', 'r1hi', 'r1ct', 'r1amt',
  'r2lo', 'r2hi', 'r2ct', 'r2amt',
  'r3lo', 'r3hi', 'r3ct', 'r3amt',
] as const

export const TUNE_ORIGINAL_IDS = [
  'retune', 'humanize', 'flex', 'amount', 'transpose', 'formant', 'mode', 'root', 'scaleIndex', 'minHz', 'maxHz', 'mask', 'custom', 'bypassMask', 'a4', 'hq', 'color', 'vibrato', 'holdMidi', 'n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11',
] as const

/** Major then minor weights. The same literals live in `core/dsp/src/tune.rs`. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export interface DetectedKey {
  root: number
  scaleIndex: number
  name: string
}

/** Best major or minor key. Null until a few notes have been counted. */
export function keyFromHist(hist: readonly number[]): DetectedKey | null {
  let total = 0
  for (let i = 0; i < 12; i++) total += hist[i] || 0
  if (total < 4) return null
  let bestScore = -Infinity
  let bestRoot = 0
  let bestMinor = false
  for (let root = 0; root < 12; root++) {
    let major = 0
    let minor = 0
    for (let degree = 0; degree < 12; degree++) {
      const weight = hist[(root + degree) % 12] || 0
      major += weight * MAJOR_PROFILE[degree]
      minor += weight * MINOR_PROFILE[degree]
    }
    if (major > bestScore) {
      bestScore = major
      bestRoot = root
      bestMinor = false
    }
    if (minor > bestScore) {
      bestScore = minor
      bestRoot = root
      bestMinor = true
    }
  }
  const scaleIndex = bestMinor ? 5 : 0
  const scaleName = bestMinor ? 'Minor' : 'Major'
  return { root: bestRoot, scaleIndex, name: `${NOTE_NAMES[bestRoot]} ${scaleName}` }
}

/** Key of the notes in a pitch trace. Uses the sung pitch, not the corrected one. */
export function detectKey(trace: Float32Array | null, a4 = 440): DetectedKey | null {
  if (!trace) return null
  const hist = new Array(12).fill(0)
  const ref = a4 > 0 ? a4 : 440
  for (let i = 0; i + 1 < trace.length; i += 2) {
    const hz = trace[i] || 0
    if (hz <= 0) continue
    const midi = Math.round(69 + 12 * Math.log2(hz / ref))
    hist[((midi % 12) + 12) % 12] += 1
  }
  return keyFromHist(hist)
}

/** Confidence floor. The default tracking of 0.5 keeps the original 0.7 gate. */
export function trackingGate(tracking: number) {
  if (Math.abs(tracking - 0.5) <= 1e-12) return 0.7
  const amount = Math.max(0, Math.min(1, tracking))
  return 0.95 - amount * 0.5
}

/** Retune speed. Note transition slows only the hop where the target note changes. */
export function correctionRate(speed: number, classic: boolean, transition: number, changed: boolean) {
  const clipped = Math.max(0.02, Math.min(1, speed))
  let rate = classic ? Math.min(1, 0.35 + clipped * 0.65) : clipped
  if (changed && transition < 0.999) rate = Math.max(0.02, rate * Math.max(0, Math.min(1, transition)))
  return rate
}

export function throatCoeff(sampleRate: number) {
  const rate = sampleRate > 0 ? sampleRate : 48000
  return 1 - Math.exp((-2 * Math.PI * 1400) / rate)
}

export const HARMONY_STEPS = [0, -12, -7, -5, -4, -3, 3, 4, 5, 7, 12] as const

const HARMONY_NAMES: Record<number, string> = {
  0: 'Off',
  [-12]: 'Octave down',
  [-7]: 'Fifth down',
  [-5]: 'Fourth down',
  [-4]: 'Major third down',
  [-3]: 'Minor third down',
  3: 'Minor third',
  4: 'Major third',
  5: 'Fourth',
  7: 'Fifth',
  12: 'Octave',
}

export function harmonyName(semis: number) {
  const rounded = Math.round(semis)
  return HARMONY_NAMES[rounded] ?? `${rounded > 0 ? '+' : ''}${rounded} semitones`
}

export function stepHarmony(semis: number, dir: number) {
  const rounded = Math.round(semis)
  let at = HARMONY_STEPS.indexOf(rounded as (typeof HARMONY_STEPS)[number])
  if (at < 0) {
    let best = 99
    HARMONY_STEPS.forEach((item, index) => {
      const dist = Math.abs(item - rounded)
      if (dist < best) {
        best = dist
        at = index
      }
    })
  }
  return HARMONY_STEPS[(at + dir + HARMONY_STEPS.length) % HARMONY_STEPS.length]
}

export interface TuneRegion {
  lo: number
  hi: number
  ct: number
  amt: number
}

export function readRegions(params: Record<string, number>): TuneRegion[] {
  const regions: TuneRegion[] = []
  for (let i = 0; i < 4; i++) {
    regions.push({
      lo: Math.round(params[`r${i}lo`] ?? 0),
      hi: Math.round(params[`r${i}hi`] ?? 0),
      ct: params[`r${i}ct`] ?? 0,
      amt: params[`r${i}amt`] ?? 1,
    })
  }
  return regions
}

export function regionActive(region: TuneRegion) {
  return region.hi >= region.lo && (region.lo > 0 || region.hi > 0)
}

/** Cents and amount for a snapped MIDI note, when a correction region covers it. */
export function matchRegion(params: Record<string, number>, midi: number) {
  const note = Math.round(midi)
  if (!Number.isFinite(note)) return null
  const regions = readRegions(params)
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]
    if (!regionActive(region)) continue
    if (note >= region.lo && note <= region.hi) return { ct: region.ct, amt: region.amt, slot: i }
  }
  return null
}

/** Which single-note region a graph blob is showing, after its cents offset. */
export function regionForBlob(params: Record<string, number>, visualMidi: number) {
  const regions = readRegions(params)
  let best = -1
  let bestDist = 0.75
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]
    if (!regionActive(region) || region.hi !== region.lo) continue
    const dist = Math.abs(region.lo + region.ct / 100 - visualMidi)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}

export function regionPatch(params: Record<string, number>, midi: number, cents: number, amount?: number) {
  const note = Math.max(1, Math.min(127, Math.round(midi)))
  const regions = readRegions(params)
  let slot = regions.findIndex((region) => regionActive(region) && region.lo === note && region.hi === note)
  if (slot < 0) slot = regions.findIndex((region) => !regionActive(region))
  if (slot < 0) slot = 0
  const prev = regions[slot]
  const ct = Math.max(-200, Math.min(200, Math.round(cents)))
  const amt = amount == null ? (regionActive(prev) ? prev.amt : 1) : Math.max(0, Math.min(1, amount))
  return {
    slot,
    patch: {
      [`r${slot}lo`]: note,
      [`r${slot}hi`]: note,
      [`r${slot}ct`]: ct,
      [`r${slot}amt`]: amt,
    },
  }
}

export function dragRegionCents(startMidi: number, nextMidi: number, startCents: number) {
  return Math.max(-200, Math.min(200, Math.round(startCents + (nextMidi - startMidi) * 100)))
}

export interface VocalMidiNote {
  midi: number
  start: number
  end: number
  name: string
}

/** Notes a singer produced, for the vocal-to-MIDI readout. */
export function vocalNotes(trace: Float32Array | null, a4 = 440): VocalMidiNote[] {
  if (!trace) return []
  const ref = a4 > 0 ? a4 : 440
  const notes: VocalMidiNote[] = []
  let start = -1
  let midi = 0
  const flush = (end: number) => {
    if (start < 0 || end - start < 2) {
      start = -1
      return
    }
    const name = NOTE_NAMES[((midi % 12) + 12) % 12] ?? 'C'
    notes.push({ midi, start, end, name: `${name}${Math.floor(midi / 12) - 1}` })
    start = -1
  }
  const frames = Math.floor(trace.length / 2)
  for (let i = 0; i < frames; i++) {
    const hz = trace[i * 2] || 0
    if (hz <= 0) {
      flush(i)
      continue
    }
    const next = Math.round(69 + 12 * Math.log2(hz / ref))
    if (start < 0 || next !== midi) {
      flush(i)
      start = i
      midi = next
      continue
    }
  }
  flush(frames)
  return notes
}

