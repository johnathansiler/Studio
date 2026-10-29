import { activeGridBeats, divisionBeats, normalizeSnapDivision, SNAP_DIVISIONS, type SnapDivisionId, type SnapProject } from './snapGrid'
import { quartersPerBar } from './time'

/** Closer than this and the line is dropped for a coarser one. Snapping does not change. */
export const MIN_LINE_PX = 6

const COARSE: SnapDivisionId[] = ['1/32', '1/16T', '1/16', '1/8T', '1/8', '1/4T', '1/4', '1/2', 'bar']

export type GridRole = 'bar' | 'beat' | 'snap'

export interface GridLine {
  beats: number
  role: GridRole
}

export interface GridPaint {
  /** 0 when Snap is off. */
  snapBeats: number
  /** Finest line actually drawn. */
  drawBeats: number
  barBeats: number
  beatBeats: number
  thinned: boolean
  hint: string
  lines: GridLine[]
}

function divisionLabel(id: SnapDivisionId) {
  return SNAP_DIVISIONS.find((item) => item.id === id)?.label ?? id
}

function beatUnit(project: SnapProject) {
  return 4 / Math.max(1, project.timeSignature.denominator)
}

/** Next readable spacing at or above `target`, in quarter notes. */
export function readableBeats(target: number, pxPerQuarter: number, barBeats: number): number {
  const ordered = COARSE
    .map((id) => divisionBeats(id, { numerator: barBeats, denominator: 4 }))
    .filter((beats, index, all) => all.indexOf(beats) === index)
    .sort((a, b) => a - b)
  if (!(pxPerQuarter > 0)) return Math.max(target, 1e-6)
  const fit = ordered.find((beats) => beats + 1e-9 >= target && beats * pxPerQuarter >= MIN_LINE_PX - 1e-6)
  if (fit) return fit
  return barBeats
}

/**
 * Lines for the current zoom. Snap off draws bars and beats.
 * A grid tighter than MIN_LINE_PX is drawn coarser, and `hint` says so.
 * `snapBeats` stays the real snap value.
 */
export function gridPaint(project: SnapProject, pxPerQuarter: number): GridPaint {
  const barBeats = Math.max(1e-6, quartersPerBar(project.timeSignature))
  const beatBeats = beatUnit(project)
  const snapBeats = activeGridBeats(project)
  const target = snapBeats > 0 ? snapBeats : beatBeats
  const drawBeats = readableBeats(target, pxPerQuarter, barBeats)
  const thinned = snapBeats > 0 && drawBeats > snapBeats + 1e-6
  const lines: GridLine[] = [{ beats: barBeats, role: 'bar' }]
  if (drawBeats + 1e-4 < beatBeats && beatBeats * Math.max(0, pxPerQuarter) >= MIN_LINE_PX - 1e-6 && beatBeats + 1e-4 < barBeats) {
    lines.push({ beats: beatBeats, role: 'beat' })
  }
  if (Math.abs(drawBeats - barBeats) > 1e-4) {
    lines.push({ beats: drawBeats, role: Math.abs(drawBeats - beatBeats) < 1e-4 ? 'beat' : 'snap' })
  }
  const selected = snapBeats > 0 ? normalizeSnapDivision(project.snapDivision) : null
  const hint = thinned && selected
    ? `${divisionLabel(selected)} is tighter than the view. Snapping still uses ${divisionLabel(selected)}.`
    : ''
  return { snapBeats, drawBeats, barBeats, beatBeats, thinned, hint, lines }
}

const LINE_COLOR: Record<GridRole, string> = {
  bar: 'rgba(115, 196, 143, 0.72)',
  beat: 'rgba(255, 255, 255, 0.28)',
  snap: 'rgba(255, 255, 255, 0.1)',
}

/** Layered repeating gradients. Bar lines sit on top of beats, beats on top of subdivisions. */
export function gridBackground(paint: GridPaint, pxPerQuarter: number, rowPx?: number): { backgroundImage: string; backgroundSize: string } {
  const images: string[] = []
  const sizes: string[] = []
  const ordered = [...paint.lines].sort((a, b) => b.beats - a.beats)
  for (const line of ordered) {
    const span = line.beats * pxPerQuarter
    if (!(span >= 1)) continue
    images.push(`linear-gradient(to right, ${LINE_COLOR[line.role]} 1px, transparent 1px)`)
    sizes.push(rowPx ? `${span}px ${rowPx}px` : `${span}px 100%`)
  }
  return {
    backgroundImage: images.join(', ') || 'none',
    backgroundSize: sizes.join(', '),
  }
}
