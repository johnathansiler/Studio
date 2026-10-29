import { quartersPerBar, type TimeSignature } from './time'
import type { Project } from './types'

export const SNAP_DIVISIONS = [
  { id: 'bar', label: 'Bar' },
  { id: '1/2', label: '1/2' },
  { id: '1/4', label: '1/4' },
  { id: '1/8', label: '1/8' },
  { id: '1/16', label: '1/16' },
  { id: '1/32', label: '1/32' },
  { id: '1/4T', label: '1/4T' },
  { id: '1/8T', label: '1/8T' },
  { id: '1/16T', label: '1/16T' },
] as const

export type SnapDivisionId = (typeof SNAP_DIVISIONS)[number]['id']

const FIXED: Record<Exclude<SnapDivisionId, 'bar'>, number> = {
  '1/2': 2,
  '1/4': 1,
  '1/8': 0.5,
  '1/16': 0.25,
  '1/32': 0.125,
  '1/4T': 2 / 3,
  '1/8T': 1 / 3,
  '1/16T': 1 / 6,
}

export type SnapProject = Pick<Project, 'snap' | 'timeSignature'> & { snapDivision?: string }

export function normalizeSnapDivision(value: unknown): SnapDivisionId {
  return SNAP_DIVISIONS.some((item) => item.id === value) ? (value as SnapDivisionId) : '1/4'
}

export function divisionBeats(id: SnapDivisionId, signature: TimeSignature): number {
  if (id === 'bar') return Math.max(1e-6, quartersPerBar(signature))
  return FIXED[id]
}

/** Quarter-note grid while Snap is on. 0 means free movement. */
export function activeGridBeats(project: SnapProject): number {
  if (!project.snap) return 0
  return divisionBeats(normalizeSnapDivision(project.snapDivision), project.timeSignature)
}

/** Clip ends use the grid, or the bar when Snap is off. */
export function clipEndGrid(project: SnapProject): number {
  if (!project.snap) return Math.max(1e-6, quartersPerBar(project.timeSignature))
  return divisionBeats(normalizeSnapDivision(project.snapDivision), project.timeSignature)
}

export function snapBeatToGrid(beat: number, grid: number): number {
  const safe = Math.max(0, beat)
  if (!(grid > 0)) return safe
  return Math.max(0, Math.round(safe / grid) * grid)
}

export function snapEditBeat(beat: number, project: SnapProject): number {
  return snapBeatToGrid(beat, activeGridBeats(project))
}

/** Round up to the next grid line. A value already on a line stays there. */
export function ceilToGrid(beat: number, grid: number): number {
  const safe = Math.max(0, beat)
  if (!(grid > 0)) return safe
  const steps = safe / grid
  const nearest = Math.round(steps)
  if (Math.abs(steps - nearest) <= 1e-4) return Math.max(0, nearest * grid)
  return Math.max(0, Math.ceil(steps - 1e-9) * grid)
}

export function clipEndForContent(contentEnd: number, project: SnapProject): number {
  return ceilToGrid(Math.max(0, contentEnd), clipEndGrid(project))
}

/** Grow a clip to the snapped end. A longer clip the user set is left alone. */
export function grownClipEnd(current: number, contentEnd: number, project: SnapProject): number {
  return Math.max(Math.max(0, current), clipEndForContent(contentEnd, project))
}

/** Passed to snapSampleToMap. 1 is a quarter note. */
export function subdivisionFor(project: SnapProject): number {
  const grid = activeGridBeats(project)
  return grid > 0 ? 1 / grid : 1
}

const FINE_STEP = 1 / 64

/**
 * New edge from the pointer beat itself.
 * Snap on lands on the grid. Snap off keeps the pointer, in small steps.
 */
export function edgeFromPointer(
  start: number,
  end: number,
  pointer: number,
  edge: 'start' | 'end',
  grid: number,
): { start: number; end: number } {
  const min = grid > 0 ? grid : FINE_STEP
  const at = grid > 0 ? snapBeatToGrid(pointer, grid) : Math.max(0, Math.round(pointer / FINE_STEP) * FINE_STEP)
  if (edge === 'end') return { start, end: Math.max(start + min, at) }
  const next = Math.max(0, Math.min(at, end - min))
  return { start: next, end }
}

/** Move a clip so the grabbed beat stays under the pointer, then snap that start. */
export function moveFromPointer(originStart: number, grabBeat: number, pointerBeat: number, grid: number): number {
  const raw = originStart + (pointerBeat - grabBeat)
  if (!(grid > 0)) return Math.max(0, raw)
  return Math.max(0, snapBeatToGrid(raw, grid))
}

export function lengthReadout(start: number, end: number, barBeats: number): string {
  const len = Math.max(0, end - start)
  const bars = len / Math.max(1e-6, barBeats)
  if (Math.abs(bars - Math.round(bars)) < 0.03 && Math.round(bars) >= 1) {
    const count = Math.round(bars)
    return count === 1 ? '1 bar' : `${count} bars`
  }
  const quarters = Math.round(len * 100) / 100
  return `${quarters} beats`
}
