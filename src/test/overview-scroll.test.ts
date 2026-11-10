import { describe, expect, it } from 'vitest'
import {
  LANE_ZOOM_MAX,
  TIMELINE_PX_MAX,
  TIMELINE_PX_SOFT_MIN,
  clampTimelinePx,
  laneZoomBounds,
  overviewPart,
  panOverview,
  thumbBox,
  timelinePxBounds,
  zoomLaneByEdge,
  zoomTimeByEdge,
  contentOfPixel,
} from '../ui/overviewScroll'

describe('timeline overview thumb', () => {
  it('sizes the thumb to the visible fraction and maps scroll through the travel', () => {
    const full = thumbBox(0, 800, 800, 400)
    expect(full.size).toBe(400)
    expect(full.origin).toBe(0)
    const zoomed = thumbBox(0, 200, 800, 400)
    expect(zoomed.size).toBeCloseTo(100)
    expect(zoomed.origin).toBe(0)
    const mid = thumbBox(300, 200, 800, 400)
    expect(mid.origin + mid.size).toBeCloseTo(((300 + 200) / 800) * 400)
    const panned = panOverview({ offset: 0, view: 200, span: 800, track: 400, thumb: mid.size, deltaPx: 100 })
    expect(panned).toBeCloseTo(200)
    expect(panOverview({ offset: 500, view: 200, span: 800, track: 400, thumb: 100, deltaPx: 400 })).toBeCloseTo(600)
    expect(panOverview({ offset: 0, view: 200, span: 800, track: 400, thumb: 100, deltaPx: -40 })).toBe(0)
  })

  it('gives each end a 40px zoom grip and the middle a pan', () => {
    expect(overviewPart(25, 40, 200)).toBe('start')
    expect(overviewPart(10, 40, 200)).toBe(null)
    expect(overviewPart(40, 40, 200)).toBe('start')
    expect(overviewPart(70, 40, 200)).toBe('start')
    expect(overviewPart(140, 40, 200)).toBe('pan')
    expect(overviewPart(220, 40, 200)).toBe('end')
    expect(overviewPart(250, 40, 200)).toBe('end')
    expect(overviewPart(300, 40, 200)).toBe(null)
    const tiny = overviewPart(8, 0, 36)
    expect(tiny === 'start' || tiny === 'end').toBe(true)
    expect(overviewPart(34, 0, 36)).toBe('end')
  })
})

describe('time zoom from the overview', () => {
  const view = 800
  const total = 32
  const bounds = timelinePxBounds(view, total)

  it('zooms out until the whole project fits, and in to the existing limit', () => {
    expect(bounds.min).toBeCloseTo(view / total)
    expect(bounds.min).toBeLessThan(TIMELINE_PX_SOFT_MIN)
    expect(bounds.max).toBe(TIMELINE_PX_MAX)
    expect(timelinePxBounds(900, 10).min).toBe(TIMELINE_PX_SOFT_MIN)
    expect(clampTimelinePx(10, view, total)).toBeCloseTo(bounds.min)
    expect(clampTimelinePx(999, view, total)).toBe(TIMELINE_PX_MAX)
    const fitted = zoomTimeByEdge({
      edge: 'end',
      startSec: 0,
      endSec: view / 90,
      totalSec: total,
      deltaFrac: 1,
      viewPx: view,
      bounds,
    })
    expect(fitted.px).toBeCloseTo(bounds.min)
    expect(fitted.scrollLeft).toBeCloseTo(0)
    expect(fitted.endSec).toBeCloseTo(total, 5)
    const tight = zoomTimeByEdge({
      edge: 'end',
      startSec: 4,
      endSec: 12,
      totalSec: total,
      deltaFrac: -1,
      viewPx: view,
      bounds,
    })
    expect(tight.px).toBeCloseTo(TIMELINE_PX_MAX)
    expect(tight.startSec).toBeCloseTo(4)
  })

  it('keeps the opposite edge fixed while a grip is dragged', () => {
    const startSec = 4
    const endSec = 12
    const zoomed = zoomTimeByEdge({
      edge: 'end',
      startSec,
      endSec,
      totalSec: total,
      deltaFrac: 0.1,
      viewPx: view,
      bounds,
    })
    expect(zoomed.startSec).toBeCloseTo(startSec)
    expect(zoomed.endSec).toBeGreaterThan(endSec)
    expect(zoomed.px).toBeLessThan(view / (endSec - startSec))
    const fromStart = zoomTimeByEdge({
      edge: 'start',
      startSec,
      endSec,
      totalSec: total,
      deltaFrac: 0.05,
      viewPx: view,
      bounds,
    })
    expect(fromStart.endSec).toBeCloseTo(endSec)
    expect(fromStart.startSec).toBeGreaterThan(startSec)
    expect(fromStart.scrollLeft).toBeCloseTo(fromStart.startSec * fromStart.px)
    const still = zoomTimeByEdge({
      edge: 'end',
      startSec,
      endSec,
      totalSec: total,
      deltaFrac: 0,
      viewPx: view,
      bounds,
    })
    expect(still.px).toBeCloseTo(view / (endSec - startSec))
    expect(still.scrollLeft).toBeCloseTo(startSec * still.px)
  })
})

describe('track-height zoom from the overview', () => {
  const fixed = 80
  const flex = 600
  const view = 320
  const bounds = laneZoomBounds(view, fixed, flex)

  it('fits every lane when fully out and stops at the tall lane limit', () => {
    expect(bounds.min).toBeLessThan(1)
    expect(bounds.min).toBeCloseTo((view - fixed) / flex)
    expect(bounds.max).toBe(LANE_ZOOM_MAX)
    expect(laneZoomBounds(800, 80, 200).min).toBe(1)
    const fitted = zoomLaneByEdge({
      edge: 'end',
      y0: 0,
      y1: view,
      total: fixed + flex,
      deltaFrac: 1,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(fitted.zoom).toBeCloseTo(bounds.min)
    expect(fitted.scrollTop).toBeCloseTo(0)
  })

  it('zooms in around the top anchor and restores the same window at zero drag', () => {
    const y0 = contentOfPixel(100, 1, fixed)
    const y1 = contentOfPixel(100 + view, 1, fixed)
    const still = zoomLaneByEdge({
      edge: 'end',
      y0,
      y1,
      total: fixed + flex,
      deltaFrac: 0,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(still.zoom).toBeCloseTo(1)
    expect(still.scrollTop).toBeCloseTo(100)
    const closer = zoomLaneByEdge({
      edge: 'end',
      y0,
      y1,
      total: fixed + flex,
      deltaFrac: -0.08,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(closer.zoom).toBeGreaterThan(1)
    expect(contentOfPixel(closer.scrollTop, closer.zoom, fixed)).toBeCloseTo(y0)
  })
})
