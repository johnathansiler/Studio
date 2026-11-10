import { describe, expect, it } from 'vitest'
import {
  LANE_ZOOM_COMPACT,
  LANE_ZOOM_MAX,
  TIMELINE_PX_MAX,
  TIMELINE_PX_SOFT_MIN,
  clampTimelinePx,
  laneSpan,
  laneZoomBounds,
  overviewPart,
  panOverview,
  thumbBox,
  timelinePxBounds,
  zoomLaneByEdge,
  zoomTimeByEdge,
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
    const fitted = zoomLaneByEdge({
      edge: 'end',
      zoom: 1,
      scrollTop: 0,
      deltaFrac: 1,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(fitted.zoom).toBeCloseTo(bounds.min)
    expect(fitted.scrollTop).toBeCloseTo(0)
    expect(laneSpan(fixed, flex, fitted.zoom)).toBeLessThanOrEqual(view + 0.5)
  })

  it('keeps the default height between a compact floor and the tall limit', () => {
    const roomy = laneZoomBounds(800, 80, 200)
    expect(roomy.min).toBeCloseTo(LANE_ZOOM_COMPACT)
    expect(roomy.min).toBeLessThan(1)
    expect(roomy.max).toBeGreaterThan(1)
    expect(roomy.max).toBe(LANE_ZOOM_MAX)
    const shrunk = zoomLaneByEdge({
      edge: 'end',
      zoom: 1,
      scrollTop: 0,
      deltaFrac: 0.2,
      view: 800,
      fixed: 80,
      flex: 200,
      bounds: roomy,
    })
    expect(shrunk.zoom).toBeLessThan(1)
    expect(shrunk.zoom).toBeGreaterThanOrEqual(roomy.min - 1e-6)
  })

  it('zooms in and out symmetrically from either end', () => {
    const drag = 0.12
    const out = zoomLaneByEdge({
      edge: 'end',
      zoom: 1,
      scrollTop: 40,
      deltaFrac: drag,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(out.zoom).toBeLessThan(1)
    const back = zoomLaneByEdge({
      edge: 'end',
      zoom: out.zoom,
      scrollTop: out.scrollTop,
      deltaFrac: -drag,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(back.zoom).toBeCloseTo(1, 2)
    const inn = zoomLaneByEdge({
      edge: 'end',
      zoom: 1,
      scrollTop: 40,
      deltaFrac: -drag,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(inn.zoom).toBeGreaterThan(1)
    const undone = zoomLaneByEdge({
      edge: 'end',
      zoom: inn.zoom,
      scrollTop: inn.scrollTop,
      deltaFrac: drag,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(undone.zoom).toBeCloseTo(1, 2)
    const nudge = 0.04
    const fromStart = zoomLaneByEdge({
      edge: 'start',
      zoom: 1.4,
      scrollTop: 200,
      deltaFrac: -nudge,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(fromStart.zoom).toBeLessThan(1.4)
    const startBack = zoomLaneByEdge({
      edge: 'start',
      zoom: fromStart.zoom,
      scrollTop: fromStart.scrollTop,
      deltaFrac: nudge,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(startBack.zoom).toBeCloseTo(1.4, 2)
    const tighter = zoomLaneByEdge({
      edge: 'start',
      zoom: 1.4,
      scrollTop: 200,
      deltaFrac: drag,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(tighter.zoom).toBeGreaterThan(1.4)
  })

  it('grows a phone stack after it has been shrunk', () => {
    const view = 579
    const fixed = 22
    const flex = 300
    const bounds = laneZoomBounds(view, fixed, flex)
    const shrunk = zoomLaneByEdge({
      edge: 'end',
      zoom: 0.7026022304832714,
      scrollTop: 0,
      deltaFrac: -160 / 579,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(shrunk.zoom).toBeGreaterThan(0.75)
  })

  it('restores the same window at zero drag and can scroll a short thumb', () => {
    const still = zoomLaneByEdge({
      edge: 'end',
      zoom: 1,
      scrollTop: 100,
      deltaFrac: 0,
      view,
      fixed,
      flex,
      bounds,
    })
    expect(still.zoom).toBeCloseTo(1)
    expect(still.scrollTop).toBeCloseTo(100)
    const span = laneSpan(fixed, flex, 1.8)
    const box = thumbBox(40, view, span, 280)
    expect(box.size).toBeLessThan(280)
    const panned = panOverview({ offset: 40, view, span, track: 280, thumb: box.size, deltaPx: 30 })
    expect(panned).toBeGreaterThan(40)
  })
})
