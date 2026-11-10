import { describe, expect, it } from 'vitest'
import {
  LANE_ZOOM_MAX,
  LANE_ZOOM_SOFT_MIN,
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
    const roomy = laneZoomBounds(800, 80, 200)
    expect(roomy.min).toBeCloseTo(LANE_ZOOM_SOFT_MIN)
    expect(roomy.min).toBeLessThan(1)
    expect(roomy.max).toBeGreaterThan(1)
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

  it('zooms in and out by the same amount from either end', () => {
    const y0 = contentOfPixel(160, 1, fixed)
    const y1 = contentOfPixel(160 + view, 1, fixed)
    const base = { y0, y1, total: fixed + flex, view, fixed, flex, bounds }
    const into = zoomLaneByEdge({ ...base, edge: 'end', deltaFrac: -0.08 })
    const intoStart = zoomLaneByEdge({ ...base, edge: 'start', deltaFrac: 0.08 })
    expect(into.zoom).toBeGreaterThan(1)
    expect(into.zoom).toBeCloseTo(intoStart.zoom, 5)
    expect(contentOfPixel(into.scrollTop, into.zoom, fixed)).toBeCloseTo(y0, 4)
    const backIn = zoomLaneByEdge({
      ...base,
      edge: 'end',
      deltaFrac: 0.08,
      y0: contentOfPixel(into.scrollTop, into.zoom, fixed),
      y1: contentOfPixel(into.scrollTop + view, into.zoom, fixed),
    })
    expect(backIn.zoom).toBeCloseTo(1, 4)
    expect(backIn.scrollTop).toBeCloseTo(160, 3)

    const out = zoomLaneByEdge({ ...base, edge: 'end', deltaFrac: 0.08 })
    const outStart = zoomLaneByEdge({ ...base, edge: 'start', deltaFrac: -0.08 })
    expect(out.zoom).toBeLessThan(1)
    expect(out.zoom).toBeCloseTo(outStart.zoom, 5)
    expect(contentOfPixel(out.scrollTop, out.zoom, fixed)).toBeCloseTo(y0, 4)
    const backOut = zoomLaneByEdge({
      ...base,
      edge: 'end',
      deltaFrac: -0.08,
      y0: contentOfPixel(out.scrollTop, out.zoom, fixed),
      y1: contentOfPixel(out.scrollTop + view, out.zoom, fixed),
    })
    expect(backOut.zoom).toBeCloseTo(1, 4)
    expect(backOut.scrollTop).toBeCloseTo(160, 3)
  })

  it('shrinks below the default when every lane already fits, then grows back', () => {
    const wide = 800
    const shortFlex = 200
    const shortBounds = laneZoomBounds(wide, fixed, shortFlex)
    expect(shortBounds.min).toBeCloseTo(0.5)
    expect(shortBounds.max).toBeGreaterThanOrEqual(2.25)
    expect(shortBounds.min).toBeLessThan(1)
    expect(shortBounds.max).toBeGreaterThan(1)
    const y0 = 0
    const y1 = contentOfPixel(wide, 1, fixed)
    const base = { y0, y1, total: fixed + shortFlex, view: wide, fixed, flex: shortFlex, bounds: shortBounds }
    const still = zoomLaneByEdge({ ...base, edge: 'end', deltaFrac: 0 })
    expect(still.zoom).toBeCloseTo(1)
    const shrunk = zoomLaneByEdge({ ...base, edge: 'end', deltaFrac: 0.25 })
    expect(shrunk.zoom).toBeLessThan(0.9)
    expect(shrunk.zoom).toBeGreaterThanOrEqual(shortBounds.min - 1e-9)
    const restored = zoomLaneByEdge({
      ...base,
      edge: 'end',
      deltaFrac: -0.25,
      y0: contentOfPixel(shrunk.scrollTop, shrunk.zoom, fixed),
      y1: contentOfPixel(shrunk.scrollTop + wide, shrunk.zoom, fixed),
    })
    expect(restored.zoom).toBeCloseTo(1, 4)
    const grown = zoomLaneByEdge({ ...base, edge: 'end', deltaFrac: -0.25 })
    expect(grown.zoom).toBeGreaterThan(1)
    expect(grown.zoom).toBeLessThanOrEqual(shortBounds.max + 1e-9)
    const back = zoomLaneByEdge({
      ...base,
      edge: 'end',
      deltaFrac: 0.25,
      y0: contentOfPixel(grown.scrollTop, grown.zoom, fixed),
      y1: contentOfPixel(grown.scrollTop + wide, grown.zoom, fixed),
    })
    expect(back.zoom).toBeCloseTo(1, 4)
    const floor = zoomLaneByEdge({ ...base, edge: 'end', deltaFrac: 1 })
    expect(floor.zoom).toBeCloseTo(shortBounds.min)
    expect(floor.scrollTop).toBeCloseTo(0)
    const ceiling = zoomLaneByEdge({ ...base, edge: 'start', deltaFrac: 1 })
    expect(ceiling.zoom).toBeCloseTo(shortBounds.max)
  })
})
