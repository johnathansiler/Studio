/**
 * Shared zoomable waveform for clip, sampler, loop, and chop editors.
 * The Beat Machine pad screen can pass the same channel and markers.
 * Drawing and hit testing stay on the UI thread.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { buildPeakPyramid } from '../audio/peakPyramid'
import { snapFraction } from '../audio/zeroCross'
import { WAVE_DPR_CAP, paintWaveCanvas, type WaveOutline } from './waveformDraw'
import { fitSpan, panSpan, sampleAtX, zoomSpan, type WaveSpan } from './waveZoom'
import './waveform.css'

export interface WaveMarker {
  id: string
  /** Fraction of the buffer, from 0 to 1. */
  at: number
  className: string
  label: string
  title: string
  name: string
  marker?: string
  grip?: boolean
}

export interface WaveViewApi {
  percent: (fraction: number) => number
  span: WaveSpan
}

export function WaveformView({
  channel,
  outline,
  bounds,
  home,
  ariaLabel = 'Waveform',
  className,
  color = '',
  markers = [],
  onMarker,
  onPlace,
  snap: snapProp,
  onSnap,
  chrome = 'above',
  toolbarExtra,
  statusClass,
  children,
  listenRef,
  onPinch,
  onSpan,
  dataWaveform,
}: {
  channel?: ArrayLike<number> | null
  outline?: WaveOutline[] | null
  /** Samples the user can scroll to. Defaults to the whole buffer. */
  bounds?: WaveSpan
  /** Samples shown before the user zooms. Defaults to `bounds`. */
  home?: WaveSpan
  ariaLabel?: string
  className?: string
  color?: string
  markers?: WaveMarker[]
  onMarker?: (id: string, fraction: number, phase: 'move' | 'commit', locked: boolean) => void
  onPlace?: (fraction: number, locked: boolean) => void
  snap?: boolean
  onSnap?: (snap: boolean) => void
  chrome?: 'above' | 'below' | 'inside' | 'none' | 'auto'
  toolbarExtra?: ReactNode
  statusClass?: string
  children?: ReactNode | ((api: WaveViewApi) => ReactNode)
  listenRef?: RefObject<HTMLElement | null>
  onPinch?: (active: boolean) => void
  onSpan?: (span: WaveSpan) => void
  dataWaveform?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const length = channel?.length || outline?.length || 1
  const limit = fitSpan(bounds ?? { start: 0, end: length })
  const homeSpan = fitSpan(home ?? limit)
  const [inner, setInner] = useState<WaveSpan | null>(null)
  const [localSnap, setLocalSnap] = useState(true)
  const [drag, setDrag] = useState<{ id: string; raw: number; snapped: number; locked: boolean } | null>(null)
  const open = inner ?? homeSpan
  const span = fitSpan({
    start: Math.min(limit.end - 1, Math.max(limit.start, open.start)),
    end: Math.min(limit.end, Math.max(limit.start + 1, open.end)),
  })
  const snap = snapProp ?? localSnap
  const zoomed = inner != null && (inner.start > limit.start + 0.5 || inner.end < limit.end - 0.5)
  const showChrome = chrome === 'auto' ? zoomed : chrome !== 'none'

  const pyramidCache = useRef<{ channel: ArrayLike<number>; pyramid: ReturnType<typeof buildPeakPyramid> } | null>(null)
  const spanRef = useRef(span)
  const limitRef = useRef(limit)
  const snapRef = useRef(snap)
  const channelRef = useRef(channel)
  const onMarkerRef = useRef(onMarker)
  const onPlaceRef = useRef(onPlace)
  const onPinchRef = useRef(onPinch)
  const onSpanRef = useRef(onSpan)
  const dragRef = useRef(drag)
  spanRef.current = span
  limitRef.current = limit
  snapRef.current = snap
  channelRef.current = channel
  onMarkerRef.current = onMarker
  onPlaceRef.current = onPlace
  onPinchRef.current = onPinch
  onSpanRef.current = onSpan
  dragRef.current = drag

  const commitSpan = (next: WaveSpan) => {
    const homeNow = fitSpan(homeSpan)
    const coversHome = Math.abs(next.start - homeNow.start) < 0.5 && Math.abs(next.end - homeNow.end) < 0.5
    setInner(coversHome ? null : { start: next.start, end: next.end })
    onSpanRef.current?.(coversHome ? homeNow : next)
  }
  const commitRef = useRef(commitSpan)
  commitRef.current = commitSpan

  useEffect(() => {
    onSpanRef.current?.(spanRef.current)
  }, [span.start, span.end])

  useEffect(() => {
    const node = canvas.current
    const host = root.current
    if (!node || !host) return
    const paint = () => {
      const cssW = Math.max(1, host.clientWidth || node.clientWidth || 320)
      const cssH = Math.max(1, host.clientHeight || node.clientHeight || 96)
      const dpr = Math.min(WAVE_DPR_CAP, window.devicePixelRatio || 1)
      const tone = color || readColor(node)
      let pyramid = null
      if (channel && channel.length > 1) {
        if (pyramidCache.current?.channel !== channel) pyramidCache.current = { channel, pyramid: buildPeakPyramid(channel) }
        pyramid = pyramidCache.current.pyramid
      }
      paintWaveCanvas(node, cssW, cssH, channel, tone, spanRef.current, { outline, pyramid, dpr })
    }
    paint()
    const watch = new ResizeObserver(paint)
    watch.observe(host)
    return () => watch.disconnect()
  }, [channel, outline, color, span.start, span.end])

  useEffect(() => {
    const el = listenRef?.current ?? root.current
    const host = root.current
    if (!el || !host) return
    const pointers = new Map<number, { x: number; y: number }>()
    let gesture: { span: WaveSpan; dist: number; midX: number; anchor: number } | null = null
    let pinching = false
    let tap: { x: number; y: number; moved: boolean } | null = null

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      const rect = host.getBoundingClientRect()
      const anchor = sampleAtX(spanRef.current, event.clientX - rect.left, rect.width)
      commitRef.current(zoomSpan(spanRef.current, limitRef.current, Math.exp(-event.deltaY * 0.0018), anchor))
    }
    const onDown = (event: PointerEvent) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size >= 2) {
        pinching = true
        tap = null
        onPinchRef.current?.(true)
        el.dataset.wavePinch = '1'
        const pts = [...pointers.values()]
        const rect = host.getBoundingClientRect()
        const midX = (pts[0].x + pts[1].x) / 2
        gesture = {
          span: spanRef.current,
          dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
          midX,
          anchor: sampleAtX(spanRef.current, midX - rect.left, rect.width),
        }
      }
    }
    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 6) tap.moved = true
      if (!gesture || pointers.size < 2) return
      event.preventDefault()
      const pts = [...pointers.values()]
      const dist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y))
      const midX = (pts[0].x + pts[1].x) / 2
      const rect = host.getBoundingClientRect()
      let next = zoomSpan(gesture.span, limitRef.current, dist / gesture.dist, gesture.anchor)
      const samplesPerPx = (next.end - next.start) / Math.max(1, rect.width)
      next = panSpan(next, limitRef.current, (gesture.midX - midX) * samplesPerPx)
      commitRef.current(next)
    }
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId)
      if (pointers.size < 2 && pinching) {
        pinching = false
        gesture = null
        onPinchRef.current?.(false)
        delete el.dataset.wavePinch
      }
      if (tap && !tap.moved && !pinching && onPlaceRef.current) {
        const rect = host.getBoundingClientRect()
        const fraction = fractionInView(spanRef.current, event.clientX - rect.left, rect.width, channelRef.current?.length || length)
        const hit = snapFraction(channelRef.current, fraction, snapRef.current)
        onPlaceRef.current(hit.fraction, hit.locked)
      }
      tap = null
    }
    const onHostDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('button, .wave-zoom, .edge')) return
      if (pointers.size > 1) return
      tap = { x: event.clientX, y: event.clientY, moved: false }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown, { capture: true })
    host.addEventListener('pointerdown', onHostDown)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown, { capture: true })
      host.removeEventListener('pointerdown', onHostDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      delete el.dataset.wavePinch
    }
  }, [listenRef, length])

  const percent = (fraction: number) => {
    const sample = fraction * Math.max(1, channel?.length || length)
    return ((sample - span.start) / Math.max(1e-6, span.end - span.start)) * 100
  }
  const api: WaveViewApi = { percent, span }
  const setSnap = (value: boolean) => {
    if (onSnap) onSnap(value)
    else setLocalSnap(value)
  }
  const zoomBy = (factor: number) => {
    const anchor = (span.start + span.end) / 2
    commitSpan(zoomSpan(span, limit, factor, anchor))
  }

  const onHandleDown = (marker: WaveMarker) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const pointer = event.pointerId
    const host = root.current
    if (!host) return
    const originX = event.clientX
    const originY = event.clientY
    let moved = false
    const apply = (clientX: number) => {
      if (host.dataset.wavePinch === '1' || listenRef?.current?.dataset.wavePinch === '1') return
      const rect = host.getBoundingClientRect()
      const fraction = fractionInView(spanRef.current, clientX - rect.left, rect.width, channelRef.current?.length || length)
      const hit = snapFraction(channelRef.current, fraction, snapRef.current)
      const next = { id: marker.id, raw: fraction, snapped: hit.fraction, locked: hit.locked }
      dragRef.current = next
      setDrag(next)
      onMarkerRef.current?.(marker.id, hit.fraction, 'move', hit.locked)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer || !Number.isFinite(ev.clientX)) return
      if (Math.hypot(ev.clientX - originX, ev.clientY - originY) > 3) moved = true
      if (moved) apply(ev.clientX)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (moved && Number.isFinite(ev.clientX)) apply(ev.clientX)
      const final = dragRef.current
      dragRef.current = null
      setDrag(null)
      onMarkerRef.current?.(marker.id, moved ? (final?.snapped ?? marker.at) : marker.at, 'commit', moved && !!final?.locked)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const bar = showChrome ? (
    <div className="wave-zoom" role="group" aria-label="Waveform zoom">
      <button type="button" className="wave-zoom-btn" title="Zoom out. See more of the waveform." onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomBy(0.5)}>Zoom out</button>
      <button type="button" className="wave-zoom-btn" title="Zoom in. See fewer samples, down to a single cycle." onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomBy(2)}>Zoom in</button>
      <button type="button" className={`wave-zoom-btn${snap ? ' on' : ''}`} aria-pressed={snap} title="Snap to zero. Edits land on the nearest zero crossing. Turn this off for free placement." onPointerDown={(event) => event.stopPropagation()} onClick={() => setSnap(!snap)}>Snap to zero</button>
      {toolbarExtra}
    </div>
  ) : null
  const active = drag ? markers.find((marker) => marker.id === drag.id) : null
  const body = (
    <div ref={root} className={className} data-waveform={dataWaveform} data-snap-zero={snap ? '1' : '0'}>
      <canvas ref={canvas} aria-label={ariaLabel} />
      {typeof children === 'function' ? children(api) : children}
      {markers.map((marker) => {
        const at = drag?.id === marker.id ? drag.snapped : marker.at
        const left = percent(at)
        if (left < -12 || left > 112) return null
        const locked = drag?.id === marker.id && drag.locked
        return (
          <button
            key={marker.id}
            type="button"
            className={`${marker.className}${drag?.id === marker.id ? ' on' : ''}`}
            style={{ left: `${left}%` }}
            aria-label={marker.label}
            title={marker.title}
            data-marker={marker.marker}
            data-zero-lock={locked ? '1' : '0'}
            onPointerDown={onHandleDown(marker)}
          >
            {marker.grip !== false && <i />}
            {locked && <em className="wave-lock">Locked</em>}
          </button>
        )
      })}
      {drag && <i className="wave-finger" style={{ left: `${percent(drag.raw)}%` }} />}
      {drag && drag.locked && Math.abs(drag.raw - drag.snapped) > 0.0005 && (
        <i className="wave-ghost" data-zero-lock="1" style={{ left: `${percent(drag.snapped)}%` }} />
      )}
      {active && statusClass && <p className={statusClass}>{active.name}</p>}
      {chrome === 'inside' || chrome === 'auto' ? bar : null}
    </div>
  )
  if (chrome === 'above' || chrome === 'below') {
    return (
      <div className="wave-editor">
        {chrome === 'above' && bar}
        {body}
        {chrome === 'below' && bar}
      </div>
    )
  }
  return body
}

/** Small waveform for rows and overviews. Peaks are built only after the canvas is on screen. */
export function MiniWave({
  channel,
  outline,
  color = '#73c48f',
  className,
  label = 'Waveform',
}: {
  channel?: ArrayLike<number> | null
  outline?: WaveOutline[] | null
  color?: string
  className?: string
  label?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const host = canvas?.parentElement
    if (!canvas || !host) return
    let pyramid: ReturnType<typeof buildPeakPyramid> | null = null
    let seen = false
    const paint = () => {
      if (!seen) return
      const cssW = Math.max(1, host.clientWidth || canvas.clientWidth || 72)
      const cssH = Math.max(1, host.clientHeight || canvas.clientHeight || 28)
      const dpr = Math.min(WAVE_DPR_CAP, window.devicePixelRatio || 1)
      if (channel && channel.length > 1 && !pyramid) pyramid = buildPeakPyramid(channel)
      paintWaveCanvas(canvas, cssW, cssH, channel, color, { start: 0, end: channel?.length || outline?.length || 1 }, {
        outline,
        pyramid,
        dpr,
      })
    }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      seen = true
      paint()
    })
    io.observe(host)
    const ro = new ResizeObserver(() => paint())
    ro.observe(host)
    return () => {
      io.disconnect()
      ro.disconnect()
    }
  }, [channel, outline, color])
  return <canvas ref={ref} className={className} aria-hidden={label ? undefined : true} aria-label={label} />
}

function fractionInView(span: WaveSpan, x: number, width: number, length: number) {
  const sample = sampleAtX(span, x, width)
  return Math.min(1, Math.max(0, sample / Math.max(1, length)))
}

function readColor(node: HTMLElement) {
  const tone = getComputedStyle(node).getPropertyValue('--accent').trim()
  return tone || '#8ee0ae'
}
