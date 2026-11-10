/** Overview scrollbar geometry. The thumb is the visible slice of the project. */

export const OVERVIEW_HIT = 40
export const TIMELINE_PX_MAX = 280
/** Existing timeline floor. A long project may zoom out further so the whole song fits. */
export const TIMELINE_PX_SOFT_MIN = 30
/** Half the default lane height. A tall stack may zoom out further so every lane fits. */
export const LANE_ZOOM_SOFT_MIN = 0.5
export const LANE_ZOOM_MAX = 2.25
/** Below this the header folds onto one row so the 40px controls still fit. */
export const LANE_ZOOM_TIGHT = 0.9

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
 * Fully out fits every lane in the viewport, and can keep going to half height
 * when the stack is already shorter than the view. Fully in stops at a tall lane.
 * Default zoom is 1, between those ends. `flex` is the track stack at zoom 1.
 * `fixed` is the ruler and map, which do not scale.
 */
export function laneZoomBounds(view: number, fixed: number, flex: number): ZoomBounds {
  const room = Math.max(0, view - Math.max(0, Math.min(fixed, view)))
  const fit = flex > 1 ? room / flex : LANE_ZOOM_SOFT_MIN
  const min = Math.min(LANE_ZOOM_SOFT_MIN, Math.max(0.05, fit))
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
  const moved = slideZoomWindow({
    edge: input.edge,
    start: input.startSec,
    end: input.endSec,
    delta,
    minWindow: minView,
    maxWindow: maxView,
    limit: total,
  })
  const start = moved.start
  const viewSec = Math.max(minView, moved.span)
  const px = clamp(view / viewSec, input.bounds.min, input.bounds.max)
  return {
    px,
    scrollLeft: Math.max(0, start * px),
    startSec: start,
    endSec: start + view / px,
  }
}

/**
 * Same edge slide as time zoom. `limit` is the far end of the document.
 * Lane zoom passes a virtual limit so the window can grow past the stack
 * and the lanes can shrink below the fit-all scale.
 */
function slideZoomWindow(input: {
  edge: 'start' | 'end'
  start: number
  end: number
  delta: number
  minWindow: number
  maxWindow: number
  limit: number
}) {
  const minWindow = Math.max(1e-6, input.minWindow)
  const maxWindow = Math.max(minWindow, input.maxWindow)
  const limit = input.limit
  let start = input.start
  let end = input.end
  if (input.edge === 'end') {
    end = clamp(end + input.delta, start + minWindow, Math.min(limit, start + maxWindow))
  } else {
    start = clamp(start + input.delta, Math.max(0, end - maxWindow), Math.max(0, end - minWindow))
  }
  let span = clamp(end - start, minWindow, maxWindow)
  if (input.edge === 'end') {
    end = Math.min(limit, start + span)
    if (end - start < minWindow) start = Math.max(0, end - minWindow)
    span = Math.max(minWindow, end - start)
    end = start + span
  } else {
    start = Math.max(0, end - span)
    if (end - start < minWindow) end = Math.min(limit, start + minWindow)
    span = Math.max(minWindow, end - start)
    start = Math.max(0, end - span)
  }
  if (start + span > limit) start = Math.max(0, limit - span)
  return { start, end: start + span, span }
}

/** Flex-content window for the pixels on screen. The ruler does not scale. */
function laneFlexFrame(y0: number, y1: number, view: number, fixed: number) {
  const safeView = Math.max(1, view)
  const head = Math.max(0, fixed)
  const top = Number.isFinite(y0) ? y0 : 0
  const bottom = Number.isFinite(y1) ? Math.max(top, y1) : top
  if (top >= head - 1e-3) {
    const start = Math.max(0, top - head)
    const end = Math.max(start + 1e-3, bottom - head)
    return { start, end, room: safeView, header: 0 }
  }
  const header = Math.min(head, Math.max(0, head - top))
  const room = Math.max(1, safeView - header)
  const end = bottom <= head + 1e-3 ? room : Math.max(1e-3, bottom - head)
  return { start: 0, end, room, header }
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
  const view = Math.max(1, input.view)
  const fixed = Math.max(0, input.fixed)
  const flex = Math.max(0, input.flex)
  const frame = laneFlexFrame(input.y0, input.y1, view, fixed)
  const minZoom = Math.min(input.bounds.min, input.bounds.max)
  const maxZoom = Math.max(minZoom, input.bounds.max, minZoom + 1e-6)
  const minWindow = frame.room / maxZoom
  const maxWindow = frame.room / Math.max(1e-6, minZoom)
  // One track-length of drag covers the zoom range, same as time where the
  // project length is the largest window.
  const basis = Math.max(input.total, fixed + flex, maxWindow, frame.end - frame.start, 1e-6)
  const delta = (Number.isFinite(input.deltaFrac) ? input.deltaFrac : 0) * basis
  const limit = Math.max(flex, maxWindow, frame.end, minWindow)
  const moved = slideZoomWindow({
    edge: input.edge,
    start: frame.start,
    end: frame.end,
    delta,
    minWindow,
    maxWindow,
    limit,
  })
  const zoom = clamp(frame.room / Math.max(1e-6, moved.span), minZoom, maxZoom)
  const scrollable = Math.max(0, laneSpan(fixed, flex, zoom) - view)
  const anchor = input.edge === 'end'
    ? (frame.header > 0 ? input.y0 : fixed + moved.start)
    : fixed + moved.end
  const scrollTop = input.edge === 'end'
    ? clamp(pixelOfContent(anchor, zoom, fixed), 0, scrollable)
    : clamp(pixelOfContent(anchor, zoom, fixed) - view, 0, scrollable)
  return { zoom, scrollTop }
}
