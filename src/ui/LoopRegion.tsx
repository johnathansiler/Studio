import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { formatLoopReadout, loopDragLabel, loopGridBeats, loopLabelCenter, loopSnapMinSamples, loopSnapSpec, resolveStickyLoopDrag, type LoopDragMode, type LoopSnapUnit } from '../model/loopEdit'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { quartersPerBar } from '../model/time'
import type { Project } from '../model/types'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from './form'
import { LOOP_DRAG_THRESHOLD, LOOP_GRIP_VISUAL, LOOP_TOUCH_THRESHOLD, layoutLoopGrips, loopEdgeAt, loopGripHit, resolveGripParks, type GripPark, type LoopGripBox } from './loopGrips'
import './loopRegion.css'

/** Arrange caps sit on the loop edges. Park a cap only after it has left the visible slice. */
export function arrangeGripParks(start: number, end: number, viewLeft: number, viewRight: number, visual = LOOP_GRIP_VISUAL) {
  return resolveGripParks({
    startFace: Math.min(start, end),
    startFaceEnd: Math.min(start, end) + visual,
    endFace: Math.max(start, end) - visual,
    endFaceEnd: Math.max(start, end),
    viewLeft,
    viewRight,
  })
}

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
  heldBeat: number
  snapUnit: LoopSnapUnit
  snapX: number | null
  moved: boolean
  changed: boolean
  onBody: boolean
  fine: boolean
  finger: number | null
  read: { text: string } | null
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
   * Arrange timeline. The host is as wide as the ruler, so the caps stay on
   * their beats while the timeline scrolls and zooms. They are not pinned to
   * the viewport.
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
  const boxRef = useRef(box)
  const edgesRef = useRef({ start: 0, end: 0 })
  const readout = formatLoopReadout(project, project.loopStartSample, project.loopEndSample)
  const sampleAtRef = useRef(sampleAt)
  sampleAtRef.current = sampleAt
  const gridRef = useRef(gridBeats)
  gridRef.current = gridBeats
  const onSeekRef = useRef(onSeek)
  onSeekRef.current = onSeek
  const xAtRef = useRef(xAt)
  xAtRef.current = xAt

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    let frame = 0
    const measure = () => {
      // A sticky ruler resolves `inset: 0` against the visible slice, so the
      // host stays on screen while the bars scroll. Size it to the ruler's
      // layout width and pin only the left edge so on-screen caps stay on the beat.
      const width = followScroll ? (host.parentElement?.offsetWidth || host.offsetWidth) : host.clientWidth
      const scroller = scrollParent(host)
      const hostRect = host.getBoundingClientRect()
      const viewRect = scroller.getBoundingClientRect()
      const padLeft = viewRect.left + scroller.clientLeft
      const padRight = padLeft + scroller.clientWidth
      const rawLeft = padLeft - hostRect.left
      const rawRight = padRight - hostRect.left
      const viewLeft = Math.max(0, rawLeft)
      const viewRight = Math.min(width || rawRight, Math.max(viewLeft, rawRight))
      const viewWidth = Math.max(0, viewRight - viewLeft) || (followScroll ? 0 : width)
      if (followScroll) {
        const edges = edgesRef.current
        const prev = boxRef.current
        const prevParks = arrangeGripParks(edges.start, edges.end, prev.viewLeft, prev.viewLeft + prev.viewWidth)
        const nextParks = arrangeGripParks(edges.start, edges.end, viewLeft, viewLeft + viewWidth)
        const next = { width, viewLeft, viewWidth }
        boxRef.current = next
        const samePark = prevParks.start === nextParks.start && prevParks.end === nextParks.end
        const sameWidth = near(prev.width, width)
        if (prev.width > 0 && samePark && sameWidth) return
        setBox(next)
        return
      }
      const next = { width, viewLeft, viewWidth: viewWidth || width }
      setBox((prev) => (
        near(prev.width, next.width) &&
        near(prev.viewLeft, next.viewLeft) &&
        near(prev.viewWidth, next.viewWidth)
          ? prev
          : next
      ))
    }
    const onScroll = () => {
      if (!followScroll) {
        measure()
        return
      }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    measure()
    const scroller = scrollParent(host)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(host)
    if (followScroll && host.parentElement) observer.observe(host.parentElement)
    window.addEventListener('resize', measure)
    const blockTouch = (event: TouchEvent) => {
      if (!drag.current) return
      event.preventDefault()
    }
    host.addEventListener('touchmove', blockTouch, { passive: false })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
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
    // Shift or Alt leaves the grid. Snap on stays on bars (or beats, when zoomed in) for the whole drag.
    const fine = point.shift || point.alt || state.fine
    const snapping = !fine && gridRef.current > 0
    const spec = loopSnapSpec({
      snap: snapping,
      barBeats: quartersPerBar(projectNow.timeSignature),
      beatBeats: 4 / Math.max(1, projectNow.timeSignature.denominator),
      pxPerQuarter: quarterPxAt(projectNow, rect, sampleAtRef.current),
    })
    // Beats can be the snap grid once a beat is wide enough. The loop still cannot shrink under one bar.
    const minSamples = snapping
      ? loopSnapMinSamples(projectNow, state.mode === 'start' ? state.originEnd : state.originStart, quartersPerBar(projectNow.timeSignature))
      : (fine ? state.minSamples : 1)
    const next = resolveStickyLoopDrag(
      {
        mode,
        anchor: state.anchor,
        originStart: state.originStart,
        originEnd: state.originEnd,
        heldBeat: state.heldBeat,
      },
      sampleAtRef.current(point.x, rect),
      projectNow,
      spec,
      minSamples,
    )
    state.heldBeat = next.heldBeat
    state.snapUnit = spec.unit
    const target = state.mode === 'end' ? next.end : next.start
    state.snapX = spec.unit === 'free' ? null : xAtRef.current(target, host.clientWidth)
    state.finger = spec.unit === 'free' ? point.x - rect.left : null
    state.read = { text: loopDragLabel(projectNow, next.start, next.end).text }
    const same = next.start === projectNow.loopStartSample && next.end === projectNow.loopEndSample && projectNow.loopEnabled
    if (!same) {
      const stepped = next.start !== projectNow.loopStartSample || next.end !== projectNow.loopEndSample
      // One tick per grid landing. Free drags stay quiet, and a repeat of the same bar does not buzz.
      if (spec.unit !== 'free' && stepped) pulseSnap()
      // Drafted, so playback extends the queued window instead of cutting the buffer on every pixel.
      store.setLoop(true, next.start, next.end, true)
      state.changed = true
    }
    setPaint((n) => n + 1)
  }

  endRef.current = (clientX: number) => {
    const state = drag.current
    if (!state) return
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
  edgesRef.current = { start: Math.min(rawLeft, rawRight), end: Math.max(rawLeft, rawRight) }
  const left = Math.min(rawLeft, rawRight)
  const barWidth = Math.max(0, Math.abs(rawRight - rawLeft))
  const visible = boxRef.current
  const viewLeft = followScroll ? 0 : (box.viewWidth > 0 ? box.viewLeft : 0)
  const viewWidth = followScroll ? width : (box.viewWidth > 0 ? box.viewWidth : width)
  const parks: { start: GripPark; end: GripPark } = followScroll
    ? arrangeGripParks(edgesRef.current.start, edgesRef.current.end, visible.viewLeft, visible.viewLeft + visible.viewWidth)
    : { start: 'track', end: 'track' }
  const grips = layoutLoopGrips({
    start: rawLeft,
    end: rawRight,
    hostWidth: width,
    hostHeight: (() => {
      const measured = hostRef.current?.clientHeight || 0
      if (confineHits) return measured || 22
      return Math.max(44, measured)
    })(),
    viewLeft,
    viewWidth,
    hit: loopGripHit(coarse),
    confineHeight: confineHits,
  })
  const body = { left, right: left + barWidth, top: 0, bottom: hostRef.current?.clientHeight || 44, mode: grips.mode }
  const live = drag.current
  const finger = live?.moved ? live.finger : null
  const liveRead = live?.moved ? live.read : null
  const snapX = live?.moved ? live.snapX : null
  const labelViewLeft = followScroll ? visible.viewLeft : viewLeft
  const labelViewWidth = followScroll ? visible.viewWidth : viewWidth
  const labelLeft = liveRead
    ? loopLabelCenter(left, barWidth, 96, labelViewLeft, labelViewWidth || viewWidth)
    : 0

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
    const snapping = !fine && gridRef.current > 0
    const downSpec = loopSnapSpec({
      snap: snapping,
      barBeats: quartersPerBar(projectNow.timeSignature),
      beatBeats: 4 / Math.max(1, projectNow.timeSignature.denominator),
      pxPerQuarter: quarterPxAt(projectNow, rect, sampleAtRef.current),
    })
    const heldSample = edge === 'end' ? projectNow.loopEndSample : projectNow.loopStartSample
    drag.current = {
      pointerId,
      pointerType: event.pointerType,
      mode: edge,
      anchor: sampleAtRef.current(event.clientX, rect),
      originStart: projectNow.loopStartSample,
      originEnd: projectNow.loopEndSample,
      originX: event.clientX,
      originY: event.clientY,
      minSamples: snapping ? loopSnapMinSamples(projectNow, projectNow.loopStartSample, downSpec.gridBeats) : 1,
      heldBeat: projectSampleBeat(projectNow, heldSample),
      snapUnit: downSpec.unit,
      snapX: null,
      moved: false,
      changed: false,
      onBody,
      fine,
      finger: null,
      read: null,
    }
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

  return (
    <div
      ref={hostRef}
      className={`loop-host${project.loopEnabled ? '' : ' off'}${followScroll ? ' follow-scroll' : ''}`}
      data-loop={project.loopEnabled ? 'on' : 'off'}
      data-loop-hit={grips.mode}
      data-loop-region={view}
      data-loop-length={readout.length}
      data-loop-span={readout.span}
      data-park-start={followScroll ? parks.start : undefined}
      data-park-end={followScroll ? parks.end : undefined}
      data-loop-snap={live?.moved ? live.snapUnit : undefined}
      role="group"
      aria-label={`Loop, ${readout.text}. Drag the edges to resize. Drag the middle to move it. Double-click to turn it ${project.loopEnabled ? 'off' : 'on'}.`}
      style={followScroll ? {
        touchAction: 'none',
        left: 0,
        right: 'auto',
        width: width > 0 ? width : undefined,
      } : { touchAction: 'none' }}
      onPointerDown={onPointerDown}
    >
      <div
        className="song-loop"
        data-loop-body="1"
        data-loop-edge="move"
        style={{ left, width: barWidth, touchAction: 'none' }}
        title={`${readout.text}. Drag to move the loop. Double-click to turn it ${project.loopEnabled ? 'off' : 'on'}.`}
      />
      <ParkDock side="left" parks={parks}>
        {parks.start === 'left' && <LoopGrip edge="start" box={grips.start} dragging={activeEdge === 'start'} parked="left" />}
        {parks.end === 'left' && <LoopGrip edge="end" box={grips.end} dragging={activeEdge === 'end'} parked="left" />}
      </ParkDock>
      {parks.start === 'track' && <LoopGrip edge="start" box={grips.start} dragging={activeEdge === 'start'} />}
      {parks.end === 'track' && <LoopGrip edge="end" box={grips.end} dragging={activeEdge === 'end'} />}
      <ParkDock side="right" parks={parks}>
        {parks.start === 'right' && <LoopGrip edge="start" box={grips.start} dragging={activeEdge === 'start'} parked="right" />}
        {parks.end === 'right' && <LoopGrip edge="end" box={grips.end} dragging={activeEdge === 'end'} parked="right" />}
      </ParkDock>
      {snapX != null && <i className="snap-line loop-snap-target" data-loop-snap-target="1" style={{ left: snapX }} />}
      {finger != null && <i className="snap-line loop-finger" style={{ left: finger }} />}
      {liveRead && <em className="loop-drag-read" data-loop-drag-read="1" data-loop-drag-label={liveRead.text} style={{ left: labelLeft }}>{liveRead.text}</em>}
    </div>
  )
}

function ParkDock({ side, parks, children }: { side: 'left' | 'right'; parks: { start: GripPark; end: GripPark }; children: ReactNode }) {
  if (parks.start !== side && parks.end !== side) return null
  return <div className={`park-dock ${side}`}>{children}</div>
}

function LoopGrip({ edge, box, dragging, parked = null }: { edge: 'start' | 'end'; box: LoopGripBox; dragging: boolean; parked?: 'left' | 'right' | null }) {
  const tall = box.hitHeight >= 44
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
        height: tall ? Math.max(44, box.hitHeight) : box.hitHeight,
        minHeight: tall ? 44 : 0,
        maxHeight: '100%',
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

/** Pixels per quarter note, measured across the ruler so zoom decides bar vs beat snap. */
function quarterPxAt(project: Project, rect: DOMRect, sampleAt: (clientX: number, rect: DOMRect) => number) {
  const x0 = rect.left + 16
  const x1 = x0 + 64
  const beats = projectSampleBeat(project, sampleAt(x1, rect)) - projectSampleBeat(project, sampleAt(x0, rect))
  if (!(Math.abs(beats) > 1e-4)) return 45
  return 64 / Math.abs(beats)
}

/** One short tick when the loop lands on the next bar or beat. Missing haptics are ignored. */
function pulseSnap() {
  const nav = typeof navigator === 'undefined' ? null : navigator as Navigator & { vibrate?: (pattern: number) => boolean }
  if (!nav?.vibrate) return
  try {
    nav.vibrate(8)
  } catch {
    /* this device has no haptic */
  }
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
