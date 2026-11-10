import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import {
  contentOfPixel,
  laneZoomBounds,
  overviewPart,
  panOverview,
  thumbBox,
  timeWindow,
  timelinePxBounds,
  zoomLaneByEdge,
  zoomTimeByEdge,
} from './overviewScroll'
import './overviewScroll.css'

type Axis = 'x' | 'y'

export function TimelineOverview({
  scrollerRef,
  seconds,
  px,
  onTimeWindow,
  laneZoom,
  onLaneWindow,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>
  seconds: number
  px: number
  onTimeWindow: (px: number, scrollLeft: number) => void
  laneZoom: number
  onLaneWindow: (zoom: number, scrollTop: number) => void
}) {
  return (
    <>
      <OverviewBar
        axis="x"
        label="Timeline overview. Drag to scroll. Drag either end to zoom time."
        scrollerRef={scrollerRef}
        seconds={seconds}
        px={px}
        laneZoom={laneZoom}
        onTimeWindow={onTimeWindow}
        onLaneWindow={onLaneWindow}
      />
      <OverviewBar
        axis="y"
        label="Track overview. Drag to scroll. Drag either end to zoom track height."
        scrollerRef={scrollerRef}
        seconds={seconds}
        px={px}
        laneZoom={laneZoom}
        onTimeWindow={onTimeWindow}
        onLaneWindow={onLaneWindow}
      />
      <div className="overview-corner" aria-hidden="true" />
    </>
  )
}

function OverviewBar({
  axis,
  label,
  scrollerRef,
  seconds,
  px,
  laneZoom,
  onTimeWindow,
  onLaneWindow,
}: {
  axis: Axis
  label: string
  scrollerRef: RefObject<HTMLDivElement | null>
  seconds: number
  px: number
  laneZoom: number
  onTimeWindow: (px: number, scrollLeft: number) => void
  onLaneWindow: (zoom: number, scrollTop: number) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const onTimeRef = useRef(onTimeWindow)
  const onLaneRef = useRef(onLaneWindow)
  onTimeRef.current = onTimeWindow
  onLaneRef.current = onLaneWindow
  const pxRef = useRef(px)
  const secondsRef = useRef(seconds)
  const laneRef = useRef(laneZoom)
  pxRef.current = px
  secondsRef.current = seconds
  laneRef.current = laneZoom

  useEffect(() => {
    const el = scrollerRef.current
    const thumb = thumbRef.current
    const track = trackRef.current
    const root = rootRef.current
    if (!el || !thumb || !track || !root) return
    const paint = () => {
      const metrics = readMetrics(el, axis, pxRef.current, secondsRef.current, laneRef.current)
      const length = axis === 'x' ? track.clientWidth : track.clientHeight
      const box = thumbBox(metrics.offset, metrics.view, metrics.span, length)
      const across = axis === 'x' ? 'translateX' : 'translateY'
      thumb.style.transform = `${across}(${box.origin}px)`
      if (axis === 'x') {
        thumb.style.width = `${box.size}px`
        thumb.style.height = '100%'
      } else {
        thumb.style.height = `${box.size}px`
        thumb.style.width = '100%'
      }
      root.setAttribute('aria-valuemin', '0')
      root.setAttribute('aria-valuemax', String(Math.round(metrics.span)))
      root.setAttribute('aria-valuenow', String(Math.round(metrics.offset)))
      root.dataset.thumb = String(Math.round(box.size))
    }
    paint()
    el.addEventListener('scroll', paint, { passive: true })
    const observer = new ResizeObserver(paint)
    observer.observe(el)
    observer.observe(track)
    return () => {
      el.removeEventListener('scroll', paint)
      observer.disconnect()
    }
  }, [axis, scrollerRef, px, seconds, laneZoom])

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return
    if (event.button !== 0 && event.pointerType !== 'touch') return
    const el = scrollerRef.current
    const track = trackRef.current
    if (!el || !track) return
    const rect = track.getBoundingClientRect()
    const pointer = axis === 'x' ? event.clientX - rect.left : event.clientY - rect.top
    const length = axis === 'x' ? rect.width : rect.height
    const metrics = readMetrics(el, axis, pxRef.current, secondsRef.current, laneRef.current)
    const box = thumbBox(metrics.offset, metrics.view, metrics.span, length)
    const part = overviewPart(pointer, box.origin, box.size)
    if (!part) return
    event.stopPropagation()
    event.preventDefault()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* already gone */ }
    const time = timeWindow(el.scrollLeft, el.clientWidth, pxRef.current)
    const lanes = measureLanes(el, laneRef.current)
    const y0 = contentOfPixel(el.scrollTop, laneRef.current, lanes.fixed)
    const y1 = contentOfPixel(el.scrollTop + el.clientHeight, laneRef.current, lanes.fixed)
    const drag = {
      pointerId: event.pointerId,
      part,
      down: pointer,
      length,
      offset: metrics.offset,
      view: metrics.view,
      span: metrics.span,
      thumb: box.size,
      startSec: time.startSec,
      endSec: time.endSec,
      y0,
      y1,
      total: Math.max(lanes.fixed + lanes.flex, 1),
      fixed: lanes.fixed,
      flex: lanes.flex,
    }
    let frame = 0
    let latest = pointer
    const apply = () => {
      frame = 0
      const node = scrollerRef.current
      if (!node) return
      const deltaPx = latest - drag.down
      if (drag.part === 'pan') {
        const next = panOverview({
          offset: drag.offset,
          view: drag.view,
          span: drag.span,
          track: drag.length,
          thumb: drag.thumb,
          deltaPx,
        })
        if (axis === 'x') node.scrollLeft = next
        else node.scrollTop = next
        return
      }
      const deltaFrac = drag.length > 0 ? deltaPx / drag.length : 0
      if (axis === 'x') {
        const bounds = timelinePxBounds(node.clientWidth, secondsRef.current)
        const next = zoomTimeByEdge({
          edge: drag.part,
          startSec: drag.startSec,
          endSec: drag.endSec,
          totalSec: secondsRef.current,
          deltaFrac,
          viewPx: node.clientWidth,
          bounds,
        })
        onTimeRef.current(next.px, next.scrollLeft)
      } else {
        const bounds = laneZoomBounds(node.clientHeight, drag.fixed, drag.flex)
        const next = zoomLaneByEdge({
          edge: drag.part,
          y0: drag.y0,
          y1: drag.y1,
          total: drag.total,
          deltaFrac,
          view: node.clientHeight,
          fixed: drag.fixed,
          flex: drag.flex,
          bounds,
        })
        onLaneRef.current(next.zoom, next.scrollTop)
      }
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return
      if (ev.cancelable) ev.preventDefault()
      const boxNow = track.getBoundingClientRect()
      latest = axis === 'x' ? ev.clientX - boxNow.left : ev.clientY - boxNow.top
      if (frame) return
      frame = window.requestAnimationFrame(apply)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (frame) cancelAnimationFrame(frame)
      const boxNow = track.getBoundingClientRect()
      latest = axis === 'x' ? ev.clientX - boxNow.left : ev.clientY - boxNow.top
      apply()
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div
      ref={rootRef}
      className="overview-scroll"
      data-overview={axis}
      data-axis={axis}
      role="scrollbar"
      aria-orientation={axis === 'x' ? 'horizontal' : 'vertical'}
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
    >
      <div className="overview-track" ref={trackRef}>
        <div className="overview-thumb" ref={thumbRef} data-overview-thumb={axis}>
          <i className="overview-grip start" aria-hidden="true" />
          <i className="overview-grip end" aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}

function readMetrics(el: HTMLElement, axis: Axis, px: number, seconds: number, laneZoom: number) {
  if (axis === 'x') {
    const span = Math.max(el.scrollWidth, seconds * Math.max(px, 0.05), el.clientWidth, 1)
    return { offset: el.scrollLeft, view: el.clientWidth, span }
  }
  const lanes = measureLanes(el, laneZoom)
  return {
    offset: el.scrollTop,
    view: el.clientHeight,
    span: Math.max(el.scrollHeight, lanes.fixed + lanes.flex * Math.max(laneZoom, 0.05), el.clientHeight, 1),
  }
}

function measureLanes(el: HTMLElement, zoom: number) {
  const map = el.querySelector('.song-map') as HTMLElement | null
  const ruler = el.querySelector('.ruler') as HTMLElement | null
  const mapHeight = map && getComputedStyle(map).display !== 'none' ? map.offsetHeight : 0
  const fixed = mapHeight + (ruler?.offsetHeight ?? 0)
  const lanes = [...el.querySelectorAll(':scope .timeline-inner > .lane')] as HTMLElement[]
  const height = lanes.reduce((sum, lane) => sum + lane.offsetHeight, 0)
  const flex = height > 0 ? height / Math.max(0.05, zoom) : 1
  return { fixed, flex }
}
