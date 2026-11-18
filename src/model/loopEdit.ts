import { activeGridBeats } from './snapGrid'
import type { Project } from './types'
import { quartersPerBar } from './time'
import { musicalAt, projectBeatSample, projectSampleBeat, type MusicalPlace } from './tempoMap'
import { transportSample, type LoopClock } from './transportSync'

export type LoopDragMode = 'start' | 'end' | 'move' | 'draw'

export interface LoopDrag {
  mode: LoopDragMode
  /** Unsnapped sample under the pointer when the drag started. */
  anchor: number
  originStart: number
  originEnd: number
}

export interface LoopReadout {
  /** "4 bars" when the length is whole bars, otherwise "2.2.0" as bars.beats.ticks. */
  length: string
  /** "1 → 5" on bar lines, otherwise "1.1.0 → 3.3.0". */
  span: string
  text: string
}

/** Grid in quarter notes. 0 means free. An explicit view grid wins; otherwise the shared Snap grid. */
export function loopGridBeats(project: Pick<Project, 'snap' | 'timeSignature'> & { snapDivision?: string }, viewGrid?: number): number {
  if (!project.snap) return 0
  if (viewGrid != null) return viewGrid > 0 ? viewGrid : 0
  return activeGridBeats(project)
}

/**
 * Share of a bar (or beat) on each side of a grid line that grabs the pointer.
 * About a third of the cell, so landing on 1, 2, 3, or 4 bars does not need a pixel-perfect finger.
 */
export const LOOP_SNAP_CAPTURE = 0.36
/** Capture zone in pixels. Below this a snap line is finer than a finger can hold. */
export const LOOP_CAPTURE_MIN_PX = 28
/** Keep a gap between neighbors so a line can stay sticky instead of flickering at the midpoint. */
export const LOOP_CAPTURE_MAX_FRACTION = 0.45

export type LoopSnapUnit = 'bar' | 'beat' | 'free'

export interface LoopSnapSpec {
  unit: LoopSnapUnit
  /** Quarter notes between snap lines. 0 is free movement. */
  gridBeats: number
  /** How close, in quarter notes, the pointer must be before a line takes it. */
  captureBeats: number
}

/** A meter beat is comfortable to aim at once its capture zone is a practical finger width. */
export function loopBeatComfortPx() {
  return LOOP_CAPTURE_MIN_PX / LOOP_SNAP_CAPTURE
}

/**
 * Snap resolution for a loop drag.
 * Snap off is free. Snap on uses bars until a beat is wide enough to grab, then beats.
 * The capture zone is ~36% of that cell at a normal phone zoom, and never a sliver of pixels
 * unless the cell itself is already that narrow.
 */
export function loopSnapSpec(input: {
  snap: boolean
  /** Quarter notes in one bar. */
  barBeats: number
  /** Quarter notes in one meter beat. */
  beatBeats: number
  /** Screen pixels per quarter note at the current zoom. */
  pxPerQuarter: number
}): LoopSnapSpec {
  if (!input.snap) return { unit: 'free', gridBeats: 0, captureBeats: 0 }
  const bar = Math.max(1e-6, input.barBeats)
  const beat = Math.max(1e-6, input.beatBeats)
  const px = Number.isFinite(input.pxPerQuarter) && input.pxPerQuarter > 0 ? input.pxPerQuarter : 45
  const beatPx = px * beat
  const unit: LoopSnapUnit = beatPx >= loopBeatComfortPx() - 1e-6 ? 'beat' : 'bar'
  const gridBeats = unit === 'beat' ? beat : bar
  return { unit, gridBeats, captureBeats: loopCaptureBeats(gridBeats, px) }
}

/** Capture distance in quarter notes. Scales with zoom, floored to a finger width, capped so neighbors still have a gap. */
export function loopCaptureBeats(gridBeats: number, pxPerQuarter: number): number {
  const grid = Math.max(1e-6, gridBeats)
  const px = Math.max(1, pxPerQuarter)
  const fraction = LOOP_SNAP_CAPTURE * grid
  const fromPx = LOOP_CAPTURE_MIN_PX / px
  const cap = LOOP_CAPTURE_MAX_FRACTION * grid
  return Math.min(cap, Math.max(fraction, fromPx))
}

/**
 * Stick to `heldBeat` until the pointer enters another line's capture zone.
 * A null hold lands on the nearest line. An off-grid hold stays put until a line captures it,
 * so the edge does not jump on the first pixel.
 */
export function magneticSnapBeat(rawBeat: number, gridBeats: number, captureBeats: number, heldBeat: number | null): number {
  const raw = Math.max(0, rawBeat)
  if (!(gridBeats > 0)) return raw
  const grid = gridBeats
  const capture = Math.min(grid * (LOOP_CAPTURE_MAX_FRACTION + 0.04), Math.max(0, captureBeats))
  const nearest = Math.max(0, Math.round(raw / grid) * grid)
  if (heldBeat == null || !Number.isFinite(heldBeat)) return nearest
  const held = Math.max(0, heldBeat)
  const heldLine = Math.max(0, Math.round(held / grid) * grid)
  const heldOnGrid = Math.abs(held - heldLine) <= Math.max(1e-4, grid * 1e-4)
  if (!heldOnGrid) {
    if (Math.abs(raw - nearest) <= capture + 1e-6) return nearest
    return held
  }
  const sticky = grid - capture
  if (Math.abs(raw - heldLine) <= sticky + 1e-6) return heldLine
  return nearest
}

/** One snap unit, in samples. Free movement (no grid) keeps a single sample so the ends cannot cross. */
export function loopSnapMinSamples(
  project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate' | 'timeSignature'>,
  atSample = 0,
  gridBeats = 0,
): number {
  if (!(gridBeats > 0)) return 1
  const beat = projectSampleBeat(project, Math.max(0, atSample))
  const samples = projectBeatSample(project, beat + gridBeats) - projectBeatSample(project, beat)
  return Math.max(1, Math.round(Math.abs(samples)))
}

/** One meter beat, in samples, measured at `atSample` so a tempo map stays honest. */
export function loopMinSamples(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate' | 'timeSignature'>, atSample = 0): number {
  const beat = projectSampleBeat(project, Math.max(0, atSample))
  const unit = 4 / Math.max(1, project.timeSignature.denominator)
  const samples = projectBeatSample(project, beat + unit) - projectBeatSample(project, beat)
  return Math.max(1, Math.round(Math.abs(samples)))
}

export function snapLoopSample(
  sample: number,
  project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate'>,
  gridBeats: number,
  bypass: boolean,
  bias: 'round' | 'ceil' | 'floor' = 'round',
): number {
  const rounded = Math.max(0, Math.round(sample))
  if (bypass || !(gridBeats > 0)) return rounded
  const beat = projectSampleBeat(project, rounded)
  const steps = beat / gridBeats
  const snappedSteps = bias === 'ceil' ? Math.ceil(steps - 1e-6) : bias === 'floor' ? Math.floor(steps + 1e-6) : Math.round(steps)
  const snappedBeat = Math.max(0, snappedSteps * gridBeats)
  return Math.max(0, Math.round(projectBeatSample(project, snappedBeat)))
}

function finish(start: number, end: number, min: number) {
  const safe = Math.max(0, Math.round(start))
  return { start: safe, end: Math.max(safe + min, Math.round(end)) }
}

/**
 * Apply a pointer sample to the shared transport loop.
 * End changes only the end, start only the start, move keeps the length, draw sets both.
 * The result is never shorter than `minSamples`.
 */
export function resolveLoopDrag(
  drag: LoopDrag,
  sample: number,
  project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate'>,
  gridBeats: number,
  bypass: boolean,
  minSamples: number,
): { start: number; end: number } {
  const min = Math.max(1, Math.round(minSamples))
  const at = Math.max(0, sample)
  const free = bypass || !(gridBeats > 0)
  if (drag.mode === 'end') {
    // Delta from the pointer, so a handle pinned to the screen edge does not jump.
    let end = snapLoopSample(Math.max(0, drag.originEnd + (at - drag.anchor)), project, gridBeats, bypass)
    if (end < drag.originStart + min) {
      end = free ? drag.originStart + min : snapLoopSample(drag.originStart + min, project, gridBeats, false, 'ceil')
      if (end < drag.originStart + min) end = drag.originStart + min
    }
    return finish(drag.originStart, end, min)
  }
  if (drag.mode === 'start') {
    let start = snapLoopSample(Math.max(0, drag.originStart + (at - drag.anchor)), project, gridBeats, bypass)
    const limit = Math.max(0, drag.originEnd - min)
    if (start > limit) {
      start = free ? limit : snapLoopSample(limit, project, gridBeats, false, 'floor')
      if (start > limit) start = limit
    }
    start = Math.max(0, start)
    if (drag.originEnd - start < min) start = Math.max(0, drag.originEnd - min)
    return finish(start, drag.originEnd, min)
  }
  if (drag.mode === 'move') {
    const len = Math.max(min, Math.round(drag.originEnd - drag.originStart))
    const raw = drag.originStart + (at - drag.anchor)
    const start = snapLoopSample(Math.max(0, raw), project, gridBeats, bypass)
    return finish(start, start + len, min)
  }
  const a = snapLoopSample(Math.max(0, drag.anchor), project, gridBeats, bypass)
  const b = snapLoopSample(at, project, gridBeats, bypass)
  let start = Math.min(a, b)
  let end = Math.max(a, b)
  if (end - start < min) {
    if (b >= a) {
      end = free ? start + min : snapLoopSample(start + min, project, gridBeats, false, 'ceil')
      if (end < start + min) end = start + min
    } else {
      start = free ? Math.max(0, end - min) : snapLoopSample(Math.max(0, end - min), project, gridBeats, false, 'floor')
      if (end - start < min) start = Math.max(0, end - min)
      if (end - start < min) end = start + min
    }
  }
  return finish(start, end, min)
}

export interface StickyLoopDrag extends LoopDrag {
  /** Beat the active edge is sticking to. Pass the origin beat so a grab does not jump. */
  heldBeat: number | null
}

/**
 * Loop drag with magnetic bar or beat snap.
 * The pointer delta is applied first, so a parked handle follows the finger instead of jumping under it.
 * Snap off (`spec.unit === 'free'`) keeps that delta. Handles cannot cross, and a bar grid cannot shrink below one bar.
 */
export function resolveStickyLoopDrag(
  drag: StickyLoopDrag,
  sample: number,
  project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate'>,
  spec: LoopSnapSpec,
  minSamples: number,
): { start: number; end: number; heldBeat: number } {
  const min = Math.max(1, Math.round(minSamples))
  const at = Math.max(0, sample)
  const free = spec.unit === 'free' || !(spec.gridBeats > 0)
  const toBeat = (value: number) => projectSampleBeat(project, Math.max(0, value))
  const toSample = (beat: number) => Math.max(0, Math.round(projectBeatSample(project, Math.max(0, beat))))
  const hard = (beat: number, bias: 'ceil' | 'floor') => {
    if (free) return Math.max(0, beat)
    const steps = Math.max(0, beat) / spec.gridBeats
    const snapped = bias === 'ceil' ? Math.ceil(steps - 1e-6) : Math.floor(steps + 1e-6)
    return Math.max(0, snapped * spec.gridBeats)
  }
  const stick = (rawSample: number, held: number | null) => {
    const beat = toBeat(rawSample)
    if (free) return { beat, sample: Math.max(0, Math.round(rawSample)) }
    const next = magneticSnapBeat(beat, spec.gridBeats, spec.captureBeats, held)
    return { beat: next, sample: toSample(next) }
  }

  if (drag.mode === 'end') {
    const raw = Math.max(0, drag.originEnd + (at - drag.anchor))
    let landed = stick(raw, drag.heldBeat)
    if (landed.sample < drag.originStart + min) {
      const liftedBeat = free ? toBeat(drag.originStart + min) : hard(toBeat(drag.originStart + min), 'ceil')
      const lifted = free ? drag.originStart + min : toSample(liftedBeat)
      const end = lifted < drag.originStart + min ? drag.originStart + min : lifted
      landed = { beat: end === lifted ? liftedBeat : toBeat(end), sample: end }
    }
    const done = finish(drag.originStart, landed.sample, min)
    return { ...done, heldBeat: Math.abs(done.end - landed.sample) < 1 ? landed.beat : toBeat(done.end) }
  }
  if (drag.mode === 'start') {
    const raw = Math.max(0, drag.originStart + (at - drag.anchor))
    let landed = stick(raw, drag.heldBeat)
    const limit = Math.max(0, drag.originEnd - min)
    if (landed.sample > limit) {
      const droppedBeat = free ? toBeat(limit) : hard(toBeat(limit), 'floor')
      const dropped = free ? limit : toSample(droppedBeat)
      const start = dropped > limit ? limit : dropped
      landed = { beat: start === dropped ? droppedBeat : toBeat(start), sample: Math.max(0, start) }
    }
    if (drag.originEnd - landed.sample < min) {
      const start = Math.max(0, drag.originEnd - min)
      landed = { beat: toBeat(start), sample: start }
    }
    const done = finish(landed.sample, drag.originEnd, min)
    return { ...done, heldBeat: Math.abs(done.start - landed.sample) < 1 ? landed.beat : toBeat(done.start) }
  }
  if (drag.mode === 'move') {
    const len = Math.max(min, Math.round(drag.originEnd - drag.originStart))
    const raw = Math.max(0, drag.originStart + (at - drag.anchor))
    const landed = stick(raw, drag.heldBeat)
    const done = finish(landed.sample, landed.sample + len, min)
    return { ...done, heldBeat: Math.abs(done.start - landed.sample) < 1 ? landed.beat : toBeat(done.start) }
  }
  const anchor = stick(Math.max(0, drag.anchor), null)
  const pointer = stick(at, drag.heldBeat)
  let start = Math.min(anchor.sample, pointer.sample)
  let end = Math.max(anchor.sample, pointer.sample)
  if (end - start < min) {
    if (pointer.sample >= anchor.sample) {
      end = free ? start + min : toSample(hard(toBeat(start + min), 'ceil'))
      if (end < start + min) end = start + min
    } else {
      start = free ? Math.max(0, end - min) : toSample(hard(toBeat(Math.max(0, end - min)), 'floor'))
      if (end - start < min) start = Math.max(0, end - min)
      if (end - start < min) end = start + min
    }
  }
  const done = finish(start, end, min)
  return { ...done, heldBeat: toBeat(pointer.sample >= anchor.sample ? done.end : done.start) }
}

function compactPlace(place: MusicalPlace) {
  return `${place.bar}.${place.beat}.${place.tick === 0 ? 0 : place.tick}`
}

function downbeat(place: MusicalPlace) {
  return place.beat === 1 && place.tick === 0
}

export function formatLoopReadout(project: Project, startSample: number, endSample: number): LoopReadout {
  const startBeat = projectSampleBeat(project, Math.max(0, startSample))
  const endBeat = projectSampleBeat(project, Math.max(0, endSample))
  const lengthBeats = Math.max(0, endBeat - startBeat)
  const barLen = Math.max(1e-6, quartersPerBar(project.timeSignature))
  const bars = lengthBeats / barLen
  const whole = Math.abs(bars - Math.round(bars)) < 0.03 && Math.round(bars) >= 1
  let length: string
  if (whole) {
    const count = Math.round(bars)
    length = count === 1 ? '1 bar' : `${count} bars`
  } else {
    const fullBars = Math.floor(lengthBeats / barLen + 1e-6)
    const rem = Math.max(0, lengthBeats - fullBars * barLen)
    const beatUnit = 4 / Math.max(1, project.timeSignature.denominator)
    let beats = Math.floor(rem / beatUnit + 1e-6)
    let tick = Math.round((rem / beatUnit - beats) * 960)
    if (tick >= 960) {
      tick = 0
      beats += 1
    }
    length = `${fullBars}.${beats}.${tick === 0 ? 0 : tick}`
  }
  const from = musicalAt(project, Math.max(0, startSample))
  const to = musicalAt(project, Math.max(0, endSample))
  const span = downbeat(from) && downbeat(to) ? `${from.bar} → ${to.bar}` : `${compactPlace(from)} → ${compactPlace(to)}`
  return { length, span, text: `${length} · ${span}` }
}

/** Length plus the start bar, for the label shown while a loop handle is dragging. */
export function loopDragLabel(project: Project, startSample: number, endSample: number): { length: string; bar: string; text: string } {
  const read = formatLoopReadout(project, startSample, endSample)
  const bar = String(musicalAt(project, Math.max(0, startSample)).bar)
  return { length: read.length, bar, text: `${read.length} / ${bar}` }
}

/**
 * Where to park the length label so it stays inside the visible ruler.
 * Coordinates are host pixels. The return value is the label center.
 */
export function loopLabelCenter(regionLeft: number, regionWidth: number, labelWidth: number, viewLeft: number, viewWidth: number): number {
  const center = regionLeft + Math.max(0, regionWidth) / 2
  const half = Math.max(0, labelWidth) / 2
  // Matches the phone and fold grip pad so a handle pinned to the screen stays off the label.
  const clearance = 44
  const min = viewLeft + half + clearance
  const max = viewLeft + Math.max(0, viewWidth) - half - clearance
  if (!(max > min)) return viewLeft + Math.max(0, viewWidth) / 2
  return Math.min(max, Math.max(min, center))
}

export interface LoopScheduleState {
  /** Linear transport sample at the audio clock, before the loop fold. */
  nowLinear: number
  /** Timeline sample the queued window plays until. Null when nothing is queued. */
  scheduledUntil: number | null
  /** A wrap back to the loop start is already in the queue. */
  wrapQueued: boolean
}

export type LoopAudioPlan =
  | { action: 'keep' }
  | { action: 'extend'; from: number; to: number }
  | { action: 'restart'; from: number; to: number; reason: 'outside' | 'shrink' | 'wrap' }

/**
 * How arrangement audio should follow a new loop. Extend fills the gap without
 * stopping what is already sounding. A playhead past the new end restarts inside it.
 */
export function planLoopAudio(loop: LoopClock, state: LoopScheduleState): LoopAudioPlan {
  if (!loop.loopEnabled) return { action: 'keep' }
  const start = Math.max(0, Math.round(loop.loopStartSample))
  const end = Math.max(start + 1, Math.round(loop.loopEndSample))
  const now = Math.max(0, state.nowLinear)
  const heard = transportSample(now, { loopEnabled: true, loopStartSample: start, loopEndSample: end })
  const outside = Math.abs(heard - now) > 0.5
  if (outside) return { action: 'restart', from: heard, to: end, reason: 'outside' }
  if (state.wrapQueued) return { action: 'restart', from: heard, to: end, reason: 'wrap' }
  if (state.scheduledUntil == null) return { action: 'restart', from: heard, to: end, reason: 'shrink' }
  if (state.scheduledUntil > end + 1) return { action: 'restart', from: heard, to: end, reason: 'shrink' }
  if (end > state.scheduledUntil + 1) return { action: 'extend', from: state.scheduledUntil, to: end }
  return { action: 'keep' }
}
