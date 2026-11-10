import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatLoopReadout, loopGridBeats, loopSnapMinSamples, resolveLoopDrag, type LoopDragMode } from '../model/loopEdit'
import { positionReadout } from '../model/snapGrid'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { quartersPerBar } from '../model/time'
import type { Project } from '../model/types'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from './form'
import { armFinePress } from './integerTick'
import { LOOP_DRAG_THRESHOLD, LOOP_TOUCH_THRESHOLD, layoutLoopGrips, loopEdgeAt, loopGripHit, resolveGripParks, type GripPark, type LoopGripBox } from './loopGrips'
import './loopRegion.css'

type DragPoint = { x: number; y: number; shift: boolean; alt: boolean }

type DragState = {
  pointerId: number
  pointerType: string
  mode: LoopDragMode | 'seek'
  anchor: number
  originStart: number
  originEnd: number
  originX: number
  originY: number
  minSamples: number
  moved: boolean
  changed: boolean
  onBody: boolean
  fine: boolean
  finger: number | null
  read: { x: number; text: string } | null
  cancelFine: () => void
}

export function LoopRegion({
  store,
  project,
  view,
  gridBeats,
  sampleAt,
  xAt,
  onSeek,
  yieldEmpty = false,
  followScroll = false,
}: {
  store: ProjectStore
  project: Project
  view: string
  /** Quarter-note grid. 0 is free. Alt and Fine bypass it. */
  gridBeats: number
  sampleAt: (clientX: number, rect: DOMRect) => number
  /** Pixel position inside the host. `hostWidth` is 0 until the ruler is measured. */
  xAt: (sample: number, hostWidth: number) => number
  onSeek?: (sample: number) => void
  /** Empty-ruler presses pass through, so pan and zoom still work. */
  yieldEmpty?: boolean
  /**
   * Arrange timeline. Caps stay in content coordinates while they are on screen,
   * and park on a viewport edge only after they leave. Positions are not rewritten
   * on each scroll event, so momentum scroll cannot leave them a frame behind.
   */
  followScroll?: boolean
}) {
  const form = useFormFactor()
  const coarse = form !== 'desk'
  const confineHits = form === 'phone' && view === 'arrange'
  const hostRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const pendingMove = useRef<DragPoint | null>(null)
  const frame = useRef(0)
  const applyRef = useRef<() => void>(() => {})
  const endRef = useRef<(x: number) => void>(() => {})
  const stopListeners = useRef<(() => void) | null>(null)
  const [activeEdge, setActiveEdge] = useState<'start' | 'end' | 'move' | null>(null)
  const [, setPaint] = useState(0)
  const lastTap = useRef(0)
  const [box, setBox] = useState({ width: 0, viewLeft: 0, viewWidth: 0 })
  const [park, setPark] = useState<{ start: GripPark; end: GripPark }>({ start: 'track', end: 'track' })
  const faceRef = useRef({ start: 0, startEnd: 0, end: 0, endEnd: 0 })
  const viewRef = useRef({ origin: 0, width: 0 })
  const readout = formatLoopReadout(project, project.loopStartSample, project.loopEndSample)
  const sampleAtRef = useRef(sampleAt)
  sampleAtRef.current = sampleAt
  const gridRef = useRef(gridBeats)
  gridRef.current = gridBeats
  const onSeekRef = useRef(onSeek)
  onSeekRef.current = onSeek

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => {
      const width = host.clientWidth
      if (followScroll) {
        const next = { width, viewLeft: 0, viewWidth: width }
        setBox((prev) => (near(prev.width, next.width) && near(prev.viewLeft, 0) && near(prev.viewWidth, next.viewWidth) ? prev : next))
        return
      }
      const scroller = scrollParent(host)
      const hostRect = host.getBoundingClientRect()
      const viewRect = scroller.getBoundingClientRect()
      const padLeft = viewRect.left + scroller.clientLeft
      const padRight = padLeft + scroller.clientWidth
      const rawLeft = padLeft - hostRect.left
      const rawRight = padRight - hostRect.left
      const viewLeft = Math.max(0, rawLeft)
      const viewRight = Math.min(width, Math.max(viewLeft, rawRight))
      const viewWidth = Math.max(0, viewRight - viewLeft) || width
      const next = { width, viewLeft, viewWidth }
      setBox((prev) => (
        near(prev.width, next.width) &&
        near(prev.viewLeft, next.viewLeft) &&
        near(prev.viewWidth, next.viewWidth)
          ? prev
          : next
      ))
    }
    measure()
    const scroller = scrollParent(host)
    if (!followScroll) scroller.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(host)
    window.addEventListener('resize', measure)
    const blockTouch = (event: TouchEvent) => {
      if (!drag.current) return
      event.preventDefault()
    }
    host.addEventListener('touchmove', blockTouch, { passive: false })
    return () => {
      if (!followScroll) scroller.removeEventListener('scroll', measure)
      observer.disconnect()
      window.removeEventListener('resize', measure)
      host.removeEventListener('touchmove', blockTouch)
    }
  }, [followScroll])

  applyRef.current = () => {
    const point = pendingMove.current
    const state = drag.current
    const host = hostRef.current
    if (!point || !state || !host) return
    const threshold = state.pointerType === 'touch' ? LOOP_TOUCH_THRESHOLD : LOOP_DRAG_THRESHOLD
    if (Math.hypot(point.x - state.originX, point.y - state.originY) <= threshold) return
    state.moved = true
    const mode: LoopDragMode = state.mode === 'seek' ? 'draw' : state.mode
    state.mode = mode
    const rect = host.getBoundingClientRect()
    const projectNow = store.project
    const fine = point.shift || point.alt || state.fine
    const next = resolveLoopDrag(
      { mode, anchor: state.anchor, originStart: state.originStart, originEnd: state.originEnd },
      sampleAtRef.current(point.x, rect),
      projectNow,
      fine ? 0 : gridRef.current,
      fine,
      state.minSamples,
    )
    const shown = state.mode === 'end' ? next.end : next.start
    const beat = projectSampleBeat(projectNow, shown)
    state.finger = point.x - rect.left
    state.read = { x: point.x - rect.left, text: positionReadout(beat, quartersPerBar(projectNow.timeSignature)) }
    const same = next.start === projectNow.loopStartSample && next.end === projectNow.loopEndSample && projectNow.loopEnabled
    if (!same) {
      store.setLoop(true, next.start, next.end, true)
      state.changed = true
    }
    setPaint((n) => n + 1)
  }

  endRef.current = (clientX: number) => {
    const state = drag.current
    if (!state) return
    state.cancelFine()
    drag.current = null
    pendingMove.current = null
    setActiveEdge(null)
    setPaint((n) => n + 1)
    if (state.changed) store.endDraft()
    if (!state.moved && state.mode === 'seek') {
      const host = hostRef.current
      if (!host) return
      onSeekRef.current?.(Math.max(0, sampleAtRef.current(clientX, host.getBoundingClientRect())))
      return
    }
    if (!state.moved && state.onBody) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0
      if (now - lastTap.current < 400) {
        lastTap.current = 0
        store.toggle('loopEnabled')
      } else lastTap.current = now
    }
  }

  useEffect(() => () => {
    stopListeners.current?.()
    if (frame.current) cancelAnimationFrame(frame.current)
  }, [])

  const width = box.width
  const rawLeft = xAt(project.loopStartSample, width)
  const rawRight = xAt(project.loopEndSample, width)
  const left = Math.min(rawLeft, rawRight)
  const barWidth = Math.max(0, Math.abs(rawRight - rawLeft))
  const viewLeft = followScroll ? 0 : (box.viewWidth > 0 ? box.viewLeft : 0)
  const viewWidth = followScroll ? width : (box.viewWidth > 0 ? box.viewWidth : width)
  const grips = layoutLoopGrips({
    start: rawLeft,
    end: rawRight,
    hostWidth: width,
    hostHeight: hostRef.current?.clientHeight || (confineHits ? 22 : 44),
    viewLeft,
    viewWidth,
    hit: loopGripHit(coarse),
    confineHeight: confineHits,
  })
  faceRef.current = {
    start: grips.start.faceLeft,
    startEnd: grips.start.faceLeft + grips.start.faceWidth,
    end: grips.end.faceLeft,
    endEnd: grips.end.faceLeft + grips.end.faceWidth,
  }
  const body = { left, right: left + barWidth, top: 0, bottom: hostRef.current?.clientHeight || 44, mode: grips.mode }
  const finger = drag.current?.finger ?? null
  const liveRead = drag.current?.read ?? null

  useLayoutEffect(() => {
    if (!followScroll) return
    const host = hostRef.current
    if (!host) return
    const scroller = scrollParent(host)
    const measureView = () => {
      const hostRect = host.getBoundingClientRect()
      const scrollRect = scroller.getBoundingClientRect()
      viewRef.current = {
        origin: hostRect.left - scrollRect.left - scroller.clientLeft + scroller.scrollLeft,
        width: scroller.clientWidth,
      }
    }
    const apply = () => {
      const widthNow = viewRef.current.width
      if (!(widthNow > 1)) return
      const left = scroller.scrollLeft - viewRef.current.origin
      const right = left + widthNow
      const faces = faceRef.current
      const next = resolveGripParks({
        startFace: faces.start,
        startFaceEnd: faces.startEnd,
        endFace: faces.end,
        endFaceEnd: faces.endEnd,
        viewLeft: left,
        viewRight: right,
        hit: 44,
      })
      setPark((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
    }
    measureView()
    apply()
    const onScroll = () => apply()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(() => {
      measureView()
      apply()
    })
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [followScroll, rawLeft, rawRight, box.width])

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return
    if (event.button !== 0 && event.pointerType !== 'touch') return
    const rect = event.currentTarget.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const localY = event.clientY - rect.top
    const exact = visualGrip(event.currentTarget, event.clientX, event.clientY, 0)
    const layoutEdge = loopEdgeAt(localX, grips, body, localY)
    const sloppy = exact || layoutEdge === 'move' ? null : visualGrip(event.currentTarget, event.clientX, event.clientY, 12)
    const edge = exact ?? sloppy ?? layoutEdge
    const onBody = edge !== 'seek'
    if (yieldEmpty && !onBody) return
    event.stopPropagation()
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* The pointer can already be gone. */
    }
    const projectNow = store.project
    const fine = event.shiftKey || event.altKey
    const pointerId = event.pointerId
    drag.current = {
      pointerId,
      pointerType: event.pointerType,
      mode: edge,
      anchor: sampleAtRef.current(event.clientX, rect),
      originStart: projectNow.loopStartSample,
      originEnd: projectNow.loopEndSample,
      originX: event.clientX,
      originY: event.clientY,
      minSamples: loopSnapMinSamples(projectNow, projectNow.loopStartSample, gridRef.current),
      moved: false,
      changed: false,
      onBody,
      fine,
      finger: null,
      read: null,
      cancelFine: () => undefined,
    }
    drag.current.cancelFine = armFinePress(event.pointerType, () => {
      const state = drag.current
      if (state) state.fine = true
    })
    if (edge === 'start' || edge === 'end' || edge === 'move') setActiveEdge(edge)
    const move = (ev: PointerEvent) => {
      const state = drag.current
      if (!state || ev.pointerId !== state.pointerId) return
      if (ev.cancelable) ev.preventDefault()
      pendingMove.current = { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey, alt: ev.altKey }
      if (frame.current) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        applyRef.current()
      })
    }
    const up = (ev: PointerEvent) => {
      const state = drag.current
      if (!state || ev.pointerId !== state.pointerId) return
      stopListeners.current?.()
      stopListeners.current = null
      pendingMove.current = { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey, alt: ev.altKey }
      if (frame.current) {
        cancelAnimationFrame(frame.current)
        frame.current = 0
      }
      applyRef.current()
      endRef.current(ev.clientX)
    }
    stopListeners.current?.()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    stopListeners.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }

  const startPark = followScroll ? park.start : 'track'
  const endPark = followScroll ? park.end : 'track'

  return (
    <div
      ref={hostRef}
      className={`loop-host${project.loopEnabled ? '' : ' off'}${followScroll ? ' follow-scroll' : ''}`}
      data-loop={project.loopEnabled ? 'on' : 'off'}
      data-loop-hit={grips.mode}
      data-loop-region={view}
      data-loop-length={readout.length}
      data-loop-span={readout.span}
      data-park-start={followScroll ? startPark : undefined}
      data-park-end={followScroll ? endPark : undefined}
      role="group"
      aria-label={`Loop, ${readout.text}. Drag the edges to resize. Drag the middle to move it. Double-click to turn it ${project.loopEnabled ? 'off' : 'on'}.`}
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
    >
      <div
        className="song-loop"
        data-loop-body="1"
        data-loop-edge="move"
        style={{ left, width: barWidth, touchAction: 'none' }}
        title={`${readout.text}. Drag to move the loop. Double-click to turn it ${project.loopEnabled ? 'off' : 'on'}.`}
      />
      {startPark === 'track' && <LoopGrip edge="start" box={grips.start} dragging={activeEdge === 'start'} />}
      {endPark === 'track' && <LoopGrip edge="end" box={grips.end} dragging={activeEdge === 'end'} />}
      {(startPark === 'left' || endPark === 'left') && (
        <div className="park-dock left">
          {startPark === 'left' && <LoopGrip edge="start" box={grips.start} dragging={activeEdge === 'start'} parked="left" />}
          {endPark === 'left' && <LoopGrip edge="end" box={grips.end} dragging={activeEdge === 'end'} parked="left" />}
        </div>
      )}
      {(startPark === 'right' || endPark === 'right') && (
        <div className="park-dock right">
          {startPark === 'right' && <LoopGrip edge="start" box={grips.start} dragging={activeEdge === 'start'} parked="right" />}
          {endPark === 'right' && <LoopGrip edge="end" box={grips.end} dragging={activeEdge === 'end'} parked="right" />}
        </div>
      )}
      {finger != null && <i className="snap-line loop-finger" style={{ left: finger }} />}
      {liveRead && <em className="loop-drag-read" data-loop-drag-read="1" style={{ left: liveRead.x }}>{liveRead.text}</em>}
    </div>
  )
}

function LoopGrip({ edge, box, dragging, parked = null }: { edge: 'start' | 'end'; box: LoopGripBox; dragging: boolean; parked?: 'left' | 'right' | null }) {
  return (
    <button
      type="button"
      className={`loop-grip ${edge}${dragging ? ' dragging' : ''}${parked ? ' parked' : ''}`}
      data-loop-edge={edge}
      style={parked ? {
        position: 'relative',
        left: 'auto',
        right: 'auto',
        top: 0,
        width: Math.max(44, box.hitWidth),
        minWidth: 44,
        height: box.hitHeight,
        minHeight: 0,
        bottom: 'auto',
        touchAction: 'none',
      } : {
        position: 'absolute',
        left: box.hitLeft,
        top: box.hitTop,
        width: box.hitWidth,
        height: box.hitHeight,
        bottom: 'auto',
        touchAction: 'none',
      }}
      aria-label={edge === 'start' ? 'Loop start. Drag to move the start of the loop.' : 'Loop end. Drag to stretch the loop.'}
      title={edge === 'start' ? 'Loop start. Drag to move the start of the loop.' : 'Loop end. Drag to stretch the loop.'}
    >
      <span
        className={`loop-grip-face ${edge}`}
        style={parked === 'right'
          ? { left: 'auto', right: 0, width: box.faceWidth }
          : parked === 'left'
            ? { left: 0, right: 'auto', width: box.faceWidth }
            : { left: box.faceLeft - box.hitLeft, width: box.faceWidth }}
        aria-hidden="true"
      />
    </button>
  )
}

/** A song-time ruler for the session clip editor. */
export function SongLoopStrip({ store, onSeek }: { store: ProjectStore; onSeek?: (sample: number) => void }) {
  const project = store.project
  const endBeat = projectSampleBeat(project, project.loopEndSample)
  const span = Math.max(16, Math.ceil(endBeat + 4))
  const px = 36
  return (
    <div className="loop-scroll" aria-label="Song loop">
      <div className="loop-scroll-inner" style={{ width: span * px }}>
        <LoopRegion
          store={store}
          project={project}
          view="session"
          gridBeats={loopGridBeats(project)}
          sampleAt={(clientX, rect) => projectBeatSample(project, Math.max(0, (clientX - rect.left) / px))}
          xAt={(sample) => projectSampleBeat(project, sample) * px}
          onSeek={onSeek}
        />
      </div>
    </div>
  )
}

function near(a: number, b: number) {
  return Math.abs(a - b) < 0.5
}

function visualGrip(host: HTMLElement, clientX: number, clientY: number, slop = 0): 'start' | 'end' | null {
  let best: { edge: 'start' | 'end'; dist: number } | null = null
  for (const edge of ['start', 'end'] as const) {
    const node = host.querySelector<HTMLElement>(`[data-loop-edge="${edge}"]`)
    if (!node) continue
    const rect = node.getBoundingClientRect()
    if (clientX < rect.left - slop || clientX > rect.right + slop || clientY < rect.top - slop || clientY > rect.bottom + slop) continue
    const dist = (clientX - (rect.left + rect.width / 2)) ** 2 + (clientY - (rect.top + rect.height / 2)) ** 2
    if (!best || dist < best.dist) best = { edge, dist }
  }
  return best?.edge ?? null
}

function scrollParent(node: HTMLElement) {
  let el: HTMLElement | null = node.parentElement
  while (el) {
    const style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowX) || /(auto|scroll)/.test(style.overflowY)) return el
    el = el.parentElement
  }
  return node
}
