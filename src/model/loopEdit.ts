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

/** Grid in quarter notes. 0 means free. A view grid wins; otherwise the meter beat when snap is on. */
export function loopGridBeats(project: Pick<Project, 'snap' | 'timeSignature'>, viewGrid?: number): number {
  if (!project.snap) return 0
  if (viewGrid != null) return viewGrid > 0 ? viewGrid : 0
  return 4 / Math.max(1, project.timeSignature.denominator)
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

/**
 * Where to park the length label so it stays inside the visible ruler.
 * Coordinates are host pixels. The return value is the label center.
 */
export function loopLabelCenter(regionLeft: number, regionWidth: number, labelWidth: number, viewLeft: number, viewWidth: number): number {
  const center = regionLeft + Math.max(0, regionWidth) / 2
  const half = Math.max(0, labelWidth) / 2
  const min = viewLeft + half
  const max = viewLeft + Math.max(0, viewWidth) - half
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
