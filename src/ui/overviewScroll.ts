/** Overview scrollbar geometry. The thumb is the visible slice of the project. */

export const OVERVIEW_HIT = 40
export const TIMELINE_PX_MAX = 280
/** Existing timeline floor. A long project may zoom out further so the whole song fits. */
export const TIMELINE_PX_SOFT_MIN = 30
export const LANE_ZOOM_MAX = 2.25

export interface ZoomBounds {
  min: number
  max: number
}

export interface ThumbBox {
  origin: number
  size: number
}

export type OverviewPart = 'start' | 'end' | 'pan'

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Fully out shows the whole project (px may drop below the old floor of 30).
 * Fully in stops at the existing 280px per second.
 */
export function timelinePxBounds(viewPx: number, totalSec: number): ZoomBounds {
  const fit = viewPx > 0 && totalSec > 0 ? viewPx / totalSec : TIMELINE_PX_SOFT_MIN
  const min = Math.min(TIMELINE_PX_SOFT_MIN, Math.max(0.05, fit))
  return { min, max: Math.max(min, TIMELINE_PX_MAX) }
}

export function clampTimelinePx(px: number, viewPx: number, totalSec: number) {
  const bounds = timelinePxBounds(viewPx, totalSec)
  const value = Number.isFinite(px) ? px : TIMELINE_PX_SOFT_MIN
  return clamp(value, bounds.min, bounds.max)
}

/**
 * Fully out fits every lane in the viewport. Fully in stops at a tall, still-readable lane.
 * `flex` is the track stack height at zoom 1. `fixed` is the ruler and map, which do not scale.
 */
export function laneZoomBounds(view: number, fixed: number, flex: number): ZoomBounds {
  const room = Math.max(0, view - Math.max(0, Math.min(fixed, view)))
  const fit = flex > 1 ? room / flex : 1
  const min = Math.min(1, Math.max(0.05, fit))
  return { min, max: Math.max(min, LANE_ZOOM_MAX) }
}

export function laneSpan(fixed: number, flex: number, zoom: number) {
  return Math.max(0, fixed) + Math.max(0, flex) * Math.max(0, zoom)
}

export function contentOfPixel(pixel: number, zoom: number, fixed: number) {
  if (pixel <= fixed) return pixel
  return fixed + (pixel - fixed) / Math.max(1e-6, zoom)
}

export function pixelOfContent(content: number, zoom: number, fixed: number) {
  if (content <= fixed) return content
  return fixed + (content - fixed) * zoom
}

/** Thumb length is the visible fraction. A minimum size keeps the end grips grabbable. */
export function thumbBox(offset: number, view: number, span: number, track: number, minThumb = 28): ThumbBox {
  const safeSpan = Math.max(view, span, 1)
  const safeView = Math.min(safeSpan, Math.max(0, view))
  const safeOffset = clamp(Number.isFinite(offset) ? offset : 0, 0, Math.max(0, safeSpan - safeView))
  const safeTrack = Math.max(0, track)
  if (safeTrack <= 0) return { origin: 0, size: 0 }
  const natural = safeTrack * (safeView / safeSpan)
  const size = Math.min(safeTrack, Math.max(Math.min(minThumb, safeTrack), natural))
  const travel = Math.max(0, safeTrack - size)
  const scrollable = safeSpan - safeView
  const origin = scrollable <= 1e-6 ? 0 : (safeOffset / scrollable) * travel
  return { origin, size }
}

/**
 * The outer 40px of each end zooms. The middle pans.
 * A short thumb gives the nearer end the point, so both zoom directions stay reachable.
 */
export function overviewPart(pointer: number, origin: number, size: number, hit = OVERVIEW_HIT): OverviewPart | null {
  if (!(size > 0) || !Number.isFinite(pointer)) return null
  const startEdge = origin
  const endEdge = origin + size
  const inStart = pointer >= startEdge - hit / 2 && pointer <= startEdge + hit
  const inEnd = pointer >= endEdge - hit && pointer <= endEdge + hit / 2
  if (inStart && inEnd) {
    const pad = Math.min(hit * 0.3, size * 0.34)
    if (pointer > startEdge + pad && pointer < endEdge - pad) return 'pan'
    const startDist = Math.abs(pointer - startEdge)
    const endDist = Math.abs(pointer - endEdge)
    return startDist <= endDist ? 'start' : 'end'
  }
  if (inStart) return 'start'
  if (inEnd) return 'end'
  if (pointer >= startEdge && pointer <= endEdge) return 'pan'
  return null
}

export function panOverview(input: {
  offset: number
  view: number
  span: number
  track: number
  thumb: number
  deltaPx: number
}) {
  const span = Math.max(input.view, input.span, 1)
  const view = Math.min(span, Math.max(0, input.view))
  const travel = Math.max(1, input.track - Math.min(input.thumb, input.track))
  const scrollable = Math.max(0, span - view)
  const delta = Number.isFinite(input.deltaPx) ? input.deltaPx : 0
  return clamp(input.offset + (delta / travel) * scrollable, 0, scrollable)
}

export function timeWindow(scrollLeft: number, viewPx: number, px: number) {
  const scale = px > 0 ? px : 1
  const startSec = Math.max(0, scrollLeft) / scale
  const viewSec = Math.max(0, viewPx) / scale
  return { startSec, endSec: startSec + viewSec }
}

export function zoomTimeByEdge(input: {
  edge: 'start' | 'end'
  startSec: number
  endSec: number
  totalSec: number
  deltaFrac: number
  viewPx: number
  bounds: ZoomBounds
}) {
  const total = Math.max(1e-6, input.totalSec)
  const view = Math.max(1, input.viewPx)
  const minView = view / input.bounds.max
  const maxView = Math.min(total, view / Math.max(1e-6, input.bounds.min))
  const delta = (Number.isFinite(input.deltaFrac) ? input.deltaFrac : 0) * total
  let start = input.startSec
  let end = input.endSec
  if (input.edge === 'end') {
    end = clamp(end + delta, start + minView, Math.min(total, start + maxView))
  } else {
    start = clamp(start + delta, Math.max(0, end - maxView), Math.max(0, end - minView))
  }
  let viewSec = clamp(end - start, minView, maxView)
  if (input.edge === 'end') {
    end = Math.min(total, start + viewSec)
    if (end - start < minView) start = Math.max(0, end - minView)
    viewSec = Math.max(minView, end - start)
    end = start + viewSec
  } else {
    start = Math.max(0, end - viewSec)
    if (end - start < minView) end = Math.min(total, start + minView)
    viewSec = Math.max(minView, end - start)
    start = Math.max(0, end - viewSec)
  }
  if (start + viewSec > total) start = Math.max(0, total - viewSec)
  const px = clamp(view / viewSec, input.bounds.min, input.bounds.max)
  return {
    px,
    scrollLeft: Math.max(0, start * px),
    startSec: start,
    endSec: start + view / px,
  }
}

function unclampedLaneZoom(y0: number, y1: number, view: number, fixed: number) {
  if (y1 <= y0 + 1e-3) return LANE_ZOOM_MAX
  if (y1 <= fixed + 1e-3) return 1
  if (y0 >= fixed - 1e-3) return view / (y1 - y0)
  const headerShown = Math.max(0, fixed - y0)
  const flexSpan = y1 - fixed
  if (flexSpan < 1e-3) return 1
  return (view - headerShown) / flexSpan
}

export function zoomLaneByEdge(input: {
  edge: 'start' | 'end'
  y0: number
  y1: number
  total: number
  deltaFrac: number
  view: number
  fixed: number
  flex: number
  bounds: ZoomBounds
}) {
  const total = Math.max(input.fixed + input.flex, input.total, 1e-6)
  const delta = (Number.isFinite(input.deltaFrac) ? input.deltaFrac : 0) * total
  let y0 = input.y0
  let y1 = input.y1
  if (input.edge === 'end') y1 = clamp(y1 + delta, Math.min(total, y0 + 0.5), total)
  else y0 = clamp(y0 + delta, 0, Math.max(0, y1 - 0.5))
  const raw = unclampedLaneZoom(y0, y1, Math.max(1, input.view), input.fixed)
  const zoom = clamp(raw, input.bounds.min, input.bounds.max)
  const span = laneSpan(input.fixed, input.flex, zoom)
  const view = Math.max(1, input.view)
  const scrollable = Math.max(0, span - view)
  const scrollTop = input.edge === 'start'
    ? clamp(pixelOfContent(y1, zoom, input.fixed) - view, 0, scrollable)
    : clamp(pixelOfContent(y0, zoom, input.fixed), 0, scrollable)
  return { zoom, scrollTop }
}
