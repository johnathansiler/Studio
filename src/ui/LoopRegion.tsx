import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatLoopReadout, loopGridBeats, loopSnapMinSamples, resolveLoopDrag, type LoopDragMode } from '../model/loopEdit'
import { positionReadout } from '../model/snapGrid'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { quartersPerBar } from '../model/time'
import type { Project } from '../model/types'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from './form'
import { armFinePress } from './integerTick'
import { LOOP_DRAG_THRESHOLD, LOOP_TOUCH_THRESHOLD, layoutLoopGrips, loopEdgeAt, loopGripHit, type LoopGripBox } from './loopGrips'
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
}) {
  const coarse = useFormFactor() !== 'desk'
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
    scroller.addEventListener('scroll', measure, { passive: true })
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
      scroller.removeEventListener('scroll', measure)
      observer.disconnect()
      window.removeEventListener('resize', measure)
      host.removeEventListener('touchmove', blockTouch)
    }
  }, [])

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
  const viewLeft = box.viewWidth > 0 ? box.viewLeft : 0
  const viewWidth = box.viewWidth > 0 ? box.viewWidth : width
  const grips = layoutLoopGrips({
    start: rawLeft,
    end: rawRight,
    hostWidth: width,
    hostHeight: hostRef.current?.clientHeight || 44,
    viewLeft,
    viewWidth,
    hit: loopGripHit(coarse),
  })
  const body = { left, right: left + barWidth, top: 0, bottom: hostRef.current?.clientHeight || 44, mode: grips.mode }
  const finger = drag.current?.finger ?? null
  const liveRead = drag.current?.read ?? null

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return
    if (event.button !== 0 && event.pointerType !== 'touch') return
    const rect = event.currentTarget.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const localY = event.clientY - rect.top
    const edge = loopEdgeAt(localX, grips, body, localY)
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

  return (
    <div
      ref={hostRef}
      className={`loop-host${project.loopEnabled ? '' : ' off'}`}
      data-loop={project.loopEnabled ? 'on' : 'off'}
      data-loop-hit={grips.mode}
      data-loop-region={view}
      data-loop-length={readout.length}
      data-loop-span={readout.span}
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
      <LoopGrip edge="start" box={grips.start} dragging={activeEdge === 'start'} />
      <LoopGrip edge="end" box={grips.end} dragging={activeEdge === 'end'} />
      {finger != null && <i className="snap-line loop-finger" style={{ left: finger }} />}
      {liveRead && <em className="loop-drag-read" data-loop-drag-read="1" style={{ left: liveRead.x }}>{liveRead.text}</em>}
    </div>
  )
}

function LoopGrip({ edge, box, dragging }: { edge: 'start' | 'end'; box: LoopGripBox; dragging: boolean }) {
  return (
    <button
      type="button"
      className={`loop-grip ${edge}${dragging ? ' dragging' : ''}`}
      data-loop-edge={edge}
      style={{
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
        style={{ left: box.faceLeft - box.hitLeft, width: box.faceWidth }}
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

function scrollParent(node: HTMLElement) {
  let el: HTMLElement | null = node.parentElement
  while (el) {
    const style = getComputedStyle(el)
    if (/(auto|scroll)/.test(style.overflowX) || /(auto|scroll)/.test(style.overflowY)) return el
    el = el.parentElement
  }
  return node
}
