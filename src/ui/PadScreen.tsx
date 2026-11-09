/** Beat Machine LCD. The waveform redraws when the picture changes, not on a timer. */

import { useEffect, useRef, useState } from 'react'
import { swingDelay } from '../model/padMachine'
import { buildPeakPyramid, type PeakPyramid } from '../audio/peakPyramid'
import {
  dragFraction,
  fractionOf,
  markerLeft,
  panView,
  resolveTrimIndex,
  sampleIndex,
  secondsLabel,
  showsSamples,
  snapRadius,
  viewFraction,
  zoomAround,
  type WaveView,
} from '../model/padTrim'
import { paintWaveCanvas } from './waveformDraw'
import { bindSwipeDismiss } from './swipeDismiss'

const HINT_KEY = 'cueharbor-pad-zoom-hint'
const FULL: WaveView = { start: 0, end: 1 }
let hintMemory = false

function hintSeen() {
  if (hintMemory) return true
  try { return localStorage.getItem(HINT_KEY) === '1' } catch { return false }
}

function rememberHint() {
  hintMemory = true
  try { localStorage.setItem(HINT_KEY, '1') } catch { /* private mode keeps the in-memory flag */ }
}

export function PadScreen({
  name,
  samples,
  sampleRate,
  start,
  end,
  reverse,
  tune,
  tuneCents,
  pitchMode,
  filter,
  highpass,
  vintage,
  level,
  swing,
  tempo,
  hitToken,
  snap,
  onTrim,
  onTrimEnd,
}: {
  name: string
  samples: Float32Array | null
  sampleRate: number
  start: number
  end: number
  reverse: boolean
  tune: number
  tuneCents: number
  pitchMode: 'vinyl' | 'stretch'
  filter: number
  highpass: number
  vintage: number
  level: number
  gate: 'shot' | 'hold'
  swing: number
  tempo: number
  hitToken: number
  /** Snap dragged markers to a zero crossing. The switch lives on the Sound tab. */
  snap: boolean
  onTrim: (start: number, end: number) => void
  onTrimEnd: () => void
}) {
  const waveRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<WaveView>(FULL)
  const [hint, setHint] = useState(false)
  const [lock, setLock] = useState<{ edge: 'start' | 'end'; text: string } | null>(null)
  const viewRef = useRef(view)
  const regionRef = useRef({ start, end, reverse })
  const samplesRef = useRef(samples)
  const snapRef = useRef(snap)
  const lookRef = useRef({ start, end, reverse, filter, highpass, vintage, level })
  const trimRef = useRef({ onTrim, onTrimEnd })
  const drag = useRef<{ edge: 'start' | 'end'; origin: number; x: number; y: number; last: number } | null>(null)
  viewRef.current = view
  regionRef.current = { start, end, reverse }
  samplesRef.current = samples
  snapRef.current = snap
  lookRef.current = { start, end, reverse, filter, highpass, vintage, level }
  trimRef.current = { onTrim, onTrimEnd }
  const length = samples?.length ?? 0
  const rate = sampleRate > 0 ? sampleRate : 48000

  useEffect(() => {
    const canvas = canvasRef.current
    const wave = waveRef.current
    if (!canvas || !wave) return
    const draw = () => {
      const shown = viewRef.current
      paint(canvas, wave.clientWidth, wave.clientHeight, samplesRef.current, shown, lookRef.current)
      wave.dataset.viewStart = String(shown.start)
      wave.dataset.viewEnd = String(shown.end)
      placeMarkers(wave, shown, regionRef.current)
    }
    draw()
    const watch = new ResizeObserver(draw)
    watch.observe(wave)
    return () => watch.disconnect()
  }, [samples, view, start, end, reverse, filter, highpass, vintage, level])

  useEffect(() => {
    const head = headRef.current
    if (!head || hitToken === 0) return
    const span = Math.max(0.002, regionRef.current.end - regionRef.current.start)
    const seconds = (span * Math.max(1, length)) / rate
    const semis = tune + tuneCents / 100
    const pitched = pitchMode === 'stretch' ? seconds : seconds / 2 ** (semis / 12)
    const delay = swing > 50 ? swingDelay(swing) * (60 / Math.max(1, tempo)) * 0.25 * 1000 : 0
    const ms = Math.max(40, pitched * 1000)
    const began = performance.now()
    let frame = 0
    const tick = () => {
      const node = headRef.current
      if (!node) return
      const elapsed = performance.now() - began - delay
      if (elapsed >= ms) {
        node.style.opacity = '0'
        return
      }
      if (elapsed < 0) {
        node.style.opacity = '0'
        frame = requestAnimationFrame(tick)
        return
      }
      const now = regionRef.current
      const place = now.start + (elapsed / ms) * (now.end - now.start)
      const left = markerLeft(place, viewRef.current, now.reverse)
      node.style.opacity = left >= 0 && left <= 1 ? '1' : '0'
      node.style.left = `${Math.min(1, Math.max(0, left)) * 100}%`
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [hitToken, length, rate, tune, tuneCents, pitchMode, swing, tempo])

  useEffect(() => {
    if (hintSeen()) return
    setHint(true)
  }, [])

  useEffect(() => {
    if (!hint) return
    const el = hintRef.current
    const dismiss = () => {
      rememberHint()
      setHint(false)
    }
    const timer = window.setTimeout(dismiss, 3200)
    const unbind = el ? bindSwipeDismiss(el, dismiss) : () => {}
    return () => {
      window.clearTimeout(timer)
      unbind()
    }
  }, [hint])

  useEffect(() => {
    const wave = waveRef.current
    if (!wave) return
    const pointers = new Map<number, { x: number; y: number }>()
    let pinch: { dist: number; view: WaveView; focus: number; mid: number } | null = null
    let pan: { x: number; y: number; active: boolean } | null = null
    let lastTap = { t: 0, x: 0, y: 0 }
    let frame = 0

    const lengthOf = () => Math.max(8, samplesRef.current?.length ?? 0)
    const show = (next: WaveView) => {
      viewRef.current = next
      const canvas = canvasRef.current
      const host = waveRef.current
      if (!canvas || !host) return
      paint(canvas, host.clientWidth, host.clientHeight, samplesRef.current, next, lookRef.current)
      host.dataset.viewStart = String(next.start)
      host.dataset.viewEnd = String(next.end)
      placeMarkers(host, next, regionRef.current)
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setView(viewRef.current)
      })
    }
    const resetView = () => show(FULL)

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const width = wave.clientWidth || 1
      const current = viewRef.current
      const rect = wave.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        const focus = viewFraction(event.clientX - rect.left, width, current, regionRef.current.reverse)
        show(zoomAround(current, focus, Math.exp(-event.deltaY * 0.0022), lengthOf()))
        return
      }
      const pixels = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const span = current.end - current.start
      show(panView(current, (pixels / width) * span))
    }

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      try { wave.setPointerCapture?.(event.pointerId) } catch { /* a synthetic pointer has nothing to capture */ }
      if (pointers.size >= 2) {
        const pts = [...pointers.values()]
        const width = wave.clientWidth || 1
        const rect = wave.getBoundingClientRect()
        const mid = (pts[0].x + pts[1].x) / 2 - rect.left
        pinch = {
          dist: Math.max(8, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
          view: viewRef.current,
          focus: viewFraction(mid, width, viewRef.current, regionRef.current.reverse),
          mid,
        }
        drag.current = null
        pan = null
        return
      }
      const marker = (event.target as HTMLElement | null)?.closest?.('[data-trim]') as HTMLElement | null
      const edge = marker?.dataset.trim === 'end' ? 'end' : marker?.dataset.trim === 'start' ? 'start' : null
      if (edge) {
        if (event.cancelable) event.preventDefault()
        const now = regionRef.current
        drag.current = { edge, origin: edge === 'start' ? now.start : now.end, x: event.clientX, y: event.clientY, last: -1 }
        pan = null
        return
      }
      drag.current = null
      pan = { x: event.clientX, y: event.clientY, active: false }
    }

    const onMove = (event: PointerEvent) => {
      const previous = pointers.get(event.pointerId)
      if (!previous) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size >= 2 && pinch) {
        if (event.cancelable) event.preventDefault()
        const pts = [...pointers.values()]
        const width = wave.clientWidth || 1
        const rect = wave.getBoundingClientRect()
        const dist = Math.max(8, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y))
        const mid = (pts[0].x + pts[1].x) / 2 - rect.left
        const zoomed = zoomAround(pinch.view, pinch.focus, dist / pinch.dist, lengthOf())
        const delta = -((mid - pinch.mid) / width) * (zoomed.end - zoomed.start)
        show(panView(zoomed, delta))
        return
      }
      const held = drag.current
      if (held) {
        moveMarker(held, event.clientX, event.clientY)
        return
      }
      if (!pan || pointers.size !== 1) return
      const dx = event.clientX - pan.x
      const dy = event.clientY - pan.y
      const span = viewRef.current.end - viewRef.current.start
      if (span >= 0.999) return
      if (!pan.active) {
        if (Math.hypot(dx, dy) < 5) return
        if (Math.abs(dx) <= Math.abs(dy)) return
        pan.active = true
      }
      if (event.cancelable) event.preventDefault()
      const width = wave.clientWidth || 1
      const delta = -((event.clientX - previous.x) / width) * span
      if (event.clientX !== previous.x) show(panView(viewRef.current, delta))
    }

    const moveMarker = (held: NonNullable<typeof drag.current>, clientX: number, clientY: number) => {
      const data = samplesRef.current
      if (!data?.length) return
      const width = wave.clientWidth || 1
      const now = regionRef.current
      const dx = clientX - held.x
      const pulled = Math.abs(clientY - held.y) > 28
      const shown = dragFraction(markerLeft(held.origin, viewRef.current, now.reverse), dx, width, pulled)
      const fraction = viewFraction(shown * width, width, viewRef.current, now.reverse)
      const raw = sampleIndex(fraction, data.length)
      const zoomed = showsSamples(viewRef.current, data.length, width)
      const hit = resolveTrimIndex(data, raw, snapRef.current, snapRadius(rate, zoomed))
      const next = fractionOf(hit.index, data.length)
      const minGap = 2 / data.length
      const region = held.edge === 'start'
        ? { start: Math.min(next, now.end - minGap), end: now.end }
        : { start: now.start, end: Math.max(next, now.start + minGap) }
      if (hit.crossing && hit.index !== held.last) {
        setLock({ edge: held.edge, text: hit.crossing.rising ? 'Rising zero' : 'Falling zero' })
        const haptic = navigator as Navigator & { vibrate?: (pattern: number) => boolean }
        try { haptic.vibrate?.(10) } catch { /* this device has no haptic */ }
      }
      held.last = hit.index
      trimRef.current.onTrim(region.start, region.end)
    }

    const onUp = (event: PointerEvent) => {
      const wasDrag = drag.current != null
      const wasPinch = pinch != null
      const gesture = pan
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinch = null
      if (wasDrag && pointers.size === 0) {
        drag.current = null
        trimRef.current.onTrimEnd()
      }
      if (pointers.size === 0 && gesture && !gesture.active && !wasDrag && !wasPinch) {
        const now = performance.now()
        const near = Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30
        const still = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 8
        if (still && near && now - lastTap.t <= 320) {
          lastTap = { t: 0, x: 0, y: 0 }
          resetView()
        } else if (still) {
          lastTap = { t: now, x: event.clientX, y: event.clientY }
        }
      }
      if (pointers.size === 0) pan = null
    }

    const onDouble = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.('[data-trim]')) return
      resetView()
    }

    wave.addEventListener('wheel', onWheel, { passive: false })
    wave.addEventListener('pointerdown', onDown)
    wave.addEventListener('pointermove', onMove)
    wave.addEventListener('pointerup', onUp)
    wave.addEventListener('pointercancel', onUp)
    wave.addEventListener('dblclick', onDouble)
    return () => {
      cancelAnimationFrame(frame)
      wave.removeEventListener('wheel', onWheel)
      wave.removeEventListener('pointerdown', onDown)
      wave.removeEventListener('pointermove', onMove)
      wave.removeEventListener('pointerup', onUp)
      wave.removeEventListener('pointercancel', onUp)
      wave.removeEventListener('dblclick', onDouble)
    }
  }, [rate])

  const startLabel = secondsLabel(start, length, rate)
  const endLabel = secondsLabel(end, length, rate)
  const startLeft = markerLeft(start, view, reverse)
  const endLeft = markerLeft(end, view, reverse)

  return (
    <div className="pad-screen-stack">
      <section className="pad-screen hw-screen" aria-label={`Pad screen. ${name}`} data-pad-screen="lcd">
        <div
          className="pad-screen-wave"
          ref={waveRef}
          data-snap-zero={snap ? '1' : '0'}
          data-view-start={view.start}
          data-view-end={view.end}
        >
          <canvas ref={canvasRef} aria-hidden />
          <i className="pad-screen-zero" aria-hidden />
          <i className="pad-screen-playhead" ref={headRef} aria-hidden />
          {samples && (
            <button
              type="button"
              className={`pad-marker${lock?.edge === 'start' ? ' is-locked' : ''}`}
              data-trim="start"
              style={{ left: `${Math.min(1, Math.max(0, startLeft)) * 100}%`, visibility: startLeft >= -0.02 && startLeft <= 1.02 ? 'visible' : 'hidden' }}
              aria-label={`Start marker. ${startLabel}${lock?.edge === 'start' ? `. ${lock.text}` : ''}`}
              title="Drag the start. Pull up or down for a finer move."
            />
          )}
          {samples && (
            <button
              type="button"
              className={`pad-marker pad-marker-end${lock?.edge === 'end' ? ' is-locked' : ''}`}
              data-trim="end"
              style={{ left: `${Math.min(1, Math.max(0, endLeft)) * 100}%`, visibility: endLeft >= -0.02 && endLeft <= 1.02 ? 'visible' : 'hidden' }}
              aria-label={`End marker. ${endLabel}${lock?.edge === 'end' ? `. ${lock.text}` : ''}`}
              title="Drag the end. Pull up or down for a finer move."
            />
          )}
        </div>
      </section>
      {hint && (
        <div ref={hintRef} className="pad-zoom-hint" role="status">Pinch to zoom · double-tap to reset</div>
      )}
    </div>
  )
}

function placeMarkers(wave: HTMLElement, next: WaveView, region: { start: number; end: number; reverse: boolean }) {
  for (const edge of ['start', 'end'] as const) {
    const marker = wave.querySelector<HTMLElement>(`[data-trim="${edge}"]`)
    if (!marker) continue
    const left = markerLeft(edge === 'start' ? region.start : region.end, next, region.reverse)
    marker.style.left = `${Math.min(1, Math.max(0, left)) * 100}%`
    marker.style.visibility = left >= -0.02 && left <= 1.02 ? 'visible' : 'hidden'
  }
}

const padPyramids = new WeakMap<Float32Array, PeakPyramid>()

function paint(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  samples: Float32Array | null,
  view: WaveView,
  look: { start: number; end: number; reverse: boolean; filter: number; highpass: number; vintage: number; level: number },
) {
  const cssWidth = Math.max(1, Math.floor(width))
  const cssHeight = Math.max(1, Math.floor(height))
  const dpr = Math.min(3, window.devicePixelRatio || 1)
  if (!samples || samples.length < 2 || cssWidth < 2) {
    paintWaveCanvas(canvas, cssWidth, cssHeight, null, '#d7f5c8', { start: 0, end: 1 }, { dpr, background: '#10160f' })
    return
  }
  let pyramid = padPyramids.get(samples)
  if (!pyramid) {
    pyramid = buildPeakPyramid(samples)
    padPyramids.set(samples, pyramid)
  }
  const gain = Math.max(0.05, Math.min(1, look.level || 0))
  const span = {
    start: Math.max(0, view.start * samples.length),
    end: Math.max(1, view.end * samples.length),
  }
  const shared = { pyramid, dpr, gain, flipX: look.reverse, background: '#10160f' as const }
  paintWaveCanvas(canvas, cssWidth, cssHeight, samples, 'rgba(120, 140, 112, 0.55)', span, shared)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const windowSpan = Math.max(1e-6, view.end - view.start)
  const xAt = (fraction: number) => {
    const shown = (fraction - view.start) / windowSpan
    return (look.reverse ? 1 - shown : shown) * cssWidth
  }
  const left = Math.min(xAt(look.start), xAt(look.end))
  const right = Math.max(xAt(look.start), xAt(look.end))
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.beginPath()
  ctx.rect(left, 0, Math.max(1, right - left), cssHeight)
  ctx.clip()
  paintWaveCanvas(canvas, cssWidth, cssHeight, samples, '#d7f5c8', span, { ...shared, clear: false, background: undefined })
  ctx.restore()
  const overlay = canvas.getContext('2d')
  if (!overlay) return
  overlay.setTransform(dpr, 0, 0, dpr, 0, 0)
  const mid = cssHeight / 2
  if (look.highpass > 0.02) {
    overlay.fillStyle = 'rgba(40, 70, 120, 0.28)'
    overlay.fillRect(0, mid, cssWidth, mid * Math.min(1, look.highpass))
  }
  if (look.filter < 0.98) {
    overlay.fillStyle = 'rgba(120, 80, 30, 0.28)'
    overlay.fillRect(0, 0, cssWidth, mid * (1 - Math.max(0, look.filter)))
  }
  if (look.vintage > 0.01) {
    overlay.fillStyle = `rgba(196, 140, 60, ${0.08 + look.vintage * 0.22})`
    overlay.fillRect(0, 0, cssWidth, cssHeight)
  }
}
