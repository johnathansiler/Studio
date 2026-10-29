import { useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { formatLoopReadout, loopGridBeats, loopLabelCenter, loopMinSamples, resolveLoopDrag, type LoopDragMode } from '../model/loopEdit'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import type { Project } from '../model/types'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from './form'
import { loopFineSnap, subscribeLoopFine } from './loopFine'
import './loopRegion.css'

const GRIP = 36

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
  const fine = useSyncExternalStore(subscribeLoopFine, loopFineSnap, loopFineSnap)
  const phone = useFormFactor() === 'phone'
  const hostRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    pointerId: number
    mode: LoopDragMode | 'seek'
    anchor: number
    originStart: number
    originEnd: number
    originX: number
    minSamples: number
    moved: boolean
    changed: boolean
    onBody: boolean
  } | null>(null)
  const lastTap = useRef(0)
  const [box, setBox] = useState({ width: 0, label: 0, viewLeft: 0, viewWidth: 0 })
  const readout = formatLoopReadout(project, project.loopStartSample, project.loopEndSample)
  const xAtRef = useRef(xAt)
  xAtRef.current = xAt

  useLayoutEffect(() => {
    const host = hostRef.current
    const label = labelRef.current
    if (!host || !label) return
    const measure = () => {
      const width = host.clientWidth
      const scroller = scrollParent(host)
      const hostRect = host.getBoundingClientRect()
      const viewRect = scroller.getBoundingClientRect()
      const rawLeft = viewRect.left - hostRect.left
      const rawRight = viewRect.right - hostRect.left
      const viewLeft = Math.max(0, rawLeft)
      const viewRight = Math.min(width, rawRight)
      const viewWidth = Math.max(0, viewRight - viewLeft) || width
      const regionLeft = xAtRef.current(project.loopStartSample, width)
      const regionRight = xAtRef.current(project.loopEndSample, width)
      const center = loopLabelCenter(Math.min(regionLeft, regionRight), Math.abs(regionRight - regionLeft), label.offsetWidth, viewLeft, viewWidth)
      const next = { width, label: center, viewLeft, viewWidth }
      setBox((prev) => (near(prev.width, next.width) && near(prev.label, next.label) && near(prev.viewLeft, next.viewLeft) && near(prev.viewWidth, next.viewWidth) ? prev : next))
    }
    measure()
    const scroller = scrollParent(host)
    scroller.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      scroller.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [project.loopStartSample, project.loopEndSample, readout.text, gridBeats])

  const width = box.width
  const rawLeft = xAt(project.loopStartSample, width)
  const rawRight = xAt(project.loopEndSample, width)
  const left = Math.min(rawLeft, rawRight)
  const barWidth = Math.max(0, Math.abs(rawRight - rawLeft))
  const baseGrip = phone ? 44 : GRIP
  const grip = width > 0 && width < baseGrip * 2 ? Math.max(32, width / 2) : baseGrip
  const viewLeft = box.viewWidth > 0 ? box.viewLeft : 0
  const viewWidth = box.viewWidth > 0 ? box.viewWidth : width
  const startX = pinGrip(rawLeft, viewLeft, viewWidth, grip)
  const endX = pinGrip(rawRight, viewLeft, viewWidth, grip)
  const labelX = box.label || left + barWidth / 2

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return
    if (event.button !== 0 && event.pointerType !== 'touch') return
    const target = event.target as HTMLElement
    const edge = target.closest('[data-loop-edge]')?.getAttribute('data-loop-edge')
    const onBody = !!target.closest('[data-loop-body], [data-loop-edge]')
    if (yieldEmpty && !onBody) return
    const rect = event.currentTarget.getBoundingClientRect()
    const mode: LoopDragMode | 'seek' = edge === 'start' || edge === 'end' || edge === 'move' ? edge : 'seek'
    event.stopPropagation()
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* The pointer can already be gone. */
    }
    drag.current = {
      pointerId: event.pointerId,
      mode,
      anchor: sampleAt(event.clientX, rect),
      originStart: project.loopStartSample,
      originEnd: project.loopEndSample,
      originX: event.clientX,
      minSamples: loopMinSamples(project, project.loopStartSample),
      moved: false,
      changed: false,
      onBody,
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || event.pointerId !== state.pointerId) return
    if (Math.abs(event.clientX - state.originX) <= 5) return
    state.moved = true
    const mode: LoopDragMode = state.mode === 'seek' ? 'draw' : state.mode
    state.mode = mode
    const rect = event.currentTarget.getBoundingClientRect()
    const next = resolveLoopDrag(
      { ...state, mode },
      sampleAt(event.clientX, rect),
      project,
      gridBeats,
      event.altKey || fine || loopFineSnap(),
      state.minSamples,
    )
    if (next.start === store.project.loopStartSample && next.end === store.project.loopEndSample && store.project.loopEnabled) return
    store.setLoop(true, next.start, next.end, true)
    state.changed = true
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current
    if (!state || event.pointerId !== state.pointerId) return
    drag.current = null
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
      className={`loop-host${project.loopEnabled ? '' : ' off'}`}
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
        style={{ left, width: Math.max(barWidth, grip) }}
        title={`${readout.text}. Drag to move the loop. Double-click to turn it ${project.loopEnabled ? 'off' : 'on'}.`}
      />
      <button
        type="button"
        className="loop-grip"
        data-loop-edge="start"
        style={{ left: startX, width: grip }}
        aria-label="Loop start. Drag to move the start of the loop."
        title="Loop start. Drag to move the start of the loop."
      />
      <button
        type="button"
        className="loop-grip end"
        data-loop-edge="end"
        style={{ left: endX, width: grip }}
        aria-label="Loop end. Drag to stretch the loop."
        title="Loop end. Drag to stretch the loop."
      />
      <div ref={labelRef} className="loop-read" style={{ left: width ? labelX : '50%' }}>
        <span className="loop-len">{readout.length}</span>
        <span className="loop-span">{readout.span}</span>
      </div>
    </div>
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

/** Keep a grip inside the visible ruler, centered on its edge when that edge is on screen. */
function pinGrip(edge: number, viewLeft: number, viewWidth: number, grip: number) {
  if (!(viewWidth > 0)) return Math.max(0, edge - grip / 2)
  const pad = 8
  const min = viewLeft + pad
  const max = viewLeft + viewWidth - grip - pad
  if (max <= min) return viewLeft
  return Math.min(max, Math.max(min, edge - grip / 2))
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
