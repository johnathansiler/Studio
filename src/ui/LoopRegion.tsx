import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatLoopReadout, loopGridBeats, loopSnapMinSamples, resolveLoopDrag, type LoopDragMode } from '../model/loopEdit'
import { positionReadout } from '../model/snapGrid'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { quartersPerBar } from '../model/time'
import type { Project } from '../model/types'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from './form'
import { armFinePress } from './integerTick'
import { LOOP_DRAG_THRESHOLD, layoutLoopGrips, loopEdgeAt, loopGripHit, type LoopGripBox } from './loopGrips'
import './loopRegion.css'

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
  const [finger, setFinger] = useState<number | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    pointerId: number
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
    cancelFine: () => void
  } | null>(null)
  const [activeEdge, setActiveEdge] = useState<'start' | 'end' | 'move' | null>(null)
  const [liveRead, setLiveRead] = useState<{ x: number; text: string } | null>(null)
  const lastTap = useRef(0)
  const [box, setBox] = useState({ width: 0, viewLeft: 0, viewWidth: 0 })
  const readout = formatLoopReadout(project, project.loopStartSample, project.loopEndSample)
  const xAtRef = useRef(xAt)
  xAtRef.current = xAt

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
    return () => {
      scroller.removeEventListener('scroll', measure)
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [project.loopStartSample, project.loopEndSample, gridBeats])

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

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return
    if (event.button !== 0 && event.pointerType !== 'touch') return
    const rect = event.currentTarget.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const localY = event.clientY - rect.top
    const edge = loopEdgeAt(localX, grips, body, localY)
    const onBody = edge !== 'seek'
    if (yieldEmpty && !onBody) return
    const mode: LoopDragMode | 'seek' = edge
    event.stopPropagation()
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* The pointer can already be gone. */
    }
    const fine = event.shiftKey || event.altKey
    drag.current = {
      pointerId: event.pointerId,
      mode,
      anchor: sampleAt(event.clientX, rect),
      originStart: project.loopStartSample,
      originEnd: project.loopEndSample,
      originX: event.clientX,
      originY: event.clientY,
      minSamples: loopSnapMinSamples(project, project.loopStartSample, gridBeats),
      moved: false,
      changed: false,
      onBody,
      fine,
      cancelFine: () => undefined,
    }
    drag.current.cancelFine = armFinePress(event.pointerType, () => {
      const state = drag.current
      if (!state) return
      state.fine = true
    })
    if (edge === 'start' || edge === 'end' || edge === 'move') setActiveEdge(edge)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || event.pointerId !== state.pointerId) return
    const host = event.currentTarget.getBoundingClientRect()
    setFinger(event.clientX - host.left)
    if (Math.hypot(event.clientX - state.originX, event.clientY - state.originY) <= LOOP_DRAG_THRESHOLD) return
    state.moved = true
    const mode: LoopDragMode = state.mode === 'seek' ? 'draw' : state.mode
    state.mode = mode
    const fine = event.shiftKey || event.altKey || state.fine
    const rect = event.currentTarget.getBoundingClientRect()
    const next = resolveLoopDrag(
      { ...state, mode },
      sampleAt(event.clientX, rect),
      project,
      fine ? 0 : gridBeats,
      fine,
      state.minSamples,
    )
    const shown = mode === 'end' ? next.end : next.start
    const beat = projectSampleBeat(project, shown)
    setLiveRead({ x: event.clientX - rect.left, text: positionReadout(beat, quartersPerBar(project.timeSignature)) })
    if (next.start === store.project.loopStartSample && next.end === store.project.loopEndSample && store.project.loopEnabled) return
    store.setLoop(true, next.start, next.end, true)
    state.changed = true
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || event.pointerId !== state.pointerId) return
    state.cancelFine()
    drag.current = null
    setFinger(null)
    setActiveEdge(null)
    setLiveRead(null)
    if (state.changed) store.endDraft()
    if (!state.moved && state.mode === 'seek') {
      const rect = event.currentTarget.getBoundingClientRect()
      onSeek?.(Math.max(0, sampleAt(event.clientX, rect)))
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

  return (
    <div
      ref={hostRef}
      className={`loop-host${project.loopEnabled ? '' : ' off'}${grips.mode === 'offset' ? ' offset' : ''}`}
      data-loop={project.loopEnabled ? 'on' : 'off'}
      data-loop-hit={grips.mode}
      data-loop-region={view}
      data-loop-length={readout.length}
      data-loop-span={readout.span}
      role="group"
      aria-label={`Loop, ${readout.text}. Drag the edges to resize. Drag the middle to move it. Double-click to turn it ${project.loopEnabled ? 'off' : 'on'}.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="song-loop"
        data-loop-body="1"
        data-loop-edge="move"
        style={{ left, width: barWidth }}
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
  const offset = box.offset !== 'inline'
  return (
    <button
      type="button"
      className={`loop-grip ${edge}${offset ? ` offset offset-${box.offset}` : ''}${dragging ? ' dragging' : ''}`}
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
        className={`loop-grip-face ${edge}${offset ? ' tab' : ''}`}
        style={{ left: box.faceLeft - box.hitLeft, top: offset ? box.faceTop : undefined, width: box.faceWidth, height: offset ? box.faceHeight : undefined }}
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
