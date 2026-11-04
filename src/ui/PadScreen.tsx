/** Beat Machine LCD. The waveform redraws when the picture changes, not on a timer. */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { swingDelay } from '../model/padMachine'
import {
  closeUp,
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
  viewPeaks,
  zeroCrossings,
  zoomAround,
  type WaveView,
} from '../model/padTrim'

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
  gate,
  swing,
  tempo,
  hitToken,
  onTrim,
  onTrimEnd,
  onReset,
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
  onTrim: (start: number, end: number) => void
  onTrimEnd: () => void
  onReset: () => void
}) {
  const waveRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<WaveView>({ start: 0, end: 1 })
  const [snap, setSnap] = useState(true)
  const [fine, setFine] = useState(false)
  const [lock, setLock] = useState<{ edge: 'start' | 'end'; text: string } | null>(null)
  const viewRef = useRef(view)
  const regionRef = useRef({ start, end, reverse })
  const drag = useRef<{ edge: 'start' | 'end'; origin: number; x: number; y: number; last: number } | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; view: WaveView; focus: number; mid: number } | null>(null)
  viewRef.current = view
  regionRef.current = { start, end, reverse }
  const length = samples?.length ?? 0
  const rate = sampleRate > 0 ? sampleRate : 48000

  useEffect(() => {
    const canvas = canvasRef.current
    const wave = waveRef.current
    if (!canvas || !wave) return
    const draw = () => paint(canvas, wave.clientWidth, wave.clientHeight, samples, view, { start, end, reverse, filter, highpass, vintage, level })
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

  function zoom(factor: number) {
    const focus = (view.start + view.end) / 2
    setView(zoomAround(view, focus, factor, Math.max(8, length)))
  }

  function place(edge: 'start' | 'end', clientX: number, clientY: number, origin: number, originX: number, originY: number) {
    const wave = waveRef.current
    const data = samples
    if (!wave || !data?.length) return
    const width = wave.clientWidth || 1
    const dx = clientX - originX
    const pulled = Math.abs(clientY - originY) > 28
    setFine(pulled)
    const shown = dragFraction(markerLeft(origin, view, reverse), dx, width, pulled)
    const fraction = viewFraction(shown * width, width, view, reverse)
    const raw = sampleIndex(fraction, data.length)
    const zoomed = showsSamples(view, data.length, width)
    const hit = resolveTrimIndex(data, raw, snap, snapRadius(rate, zoomed))
    const next = fractionOf(hit.index, data.length)
    const minGap = 2 / data.length
    const region = edge === 'start'
      ? { start: Math.min(next, end - minGap), end }
      : { start, end: Math.max(next, start + minGap) }
    if (hit.crossing && hit.index !== drag.current?.last) {
      setLock({ edge, text: hit.crossing.rising ? 'Rising zero' : 'Falling zero' })
      const haptic = navigator as Navigator & { vibrate?: (pattern: number) => boolean }
      try { haptic.vibrate?.(10) } catch { /* this device has no haptic */ }
    }
    if (drag.current) drag.current.last = hit.index
    onTrim(region.start, region.end)
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    event.currentTarget.setPointerCapture(event.pointerId)
    if (pointers.current.size >= 2) {
      const pts = [...pointers.current.values()]
      const wave = waveRef.current
      const width = wave?.clientWidth || 1
      const rect = wave?.getBoundingClientRect()
      const mid = ((pts[0].x + pts[1].x) / 2) - (rect?.left ?? 0)
      pinch.current = {
        dist: Math.max(8, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
        view,
        focus: viewFraction(mid, width, view, reverse),
        mid,
      }
      drag.current = null
      return
    }
    const marker = (event.target as HTMLElement).closest?.('[data-trim]') as HTMLElement | null
    const edge = marker?.dataset.trim === 'end' ? 'end' : marker?.dataset.trim === 'start' ? 'start' : null
    if (!edge) {
      drag.current = null
      return
    }
    event.preventDefault()
    drag.current = { edge, origin: edge === 'start' ? start : end, x: event.clientX, y: event.clientY, last: -1 }
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size >= 2 && pinch.current) {
      const pts = [...pointers.current.values()]
      const wave = waveRef.current
      const width = wave?.clientWidth || 1
      const rect = wave?.getBoundingClientRect()
      const dist = Math.max(8, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y))
      const mid = ((pts[0].x + pts[1].x) / 2) - (rect?.left ?? 0)
      const zoomed = zoomAround(pinch.current.view, pinch.current.focus, dist / pinch.current.dist, Math.max(8, length))
      const delta = -((mid - pinch.current.mid) / width) * (zoomed.end - zoomed.start)
      setView(panView(zoomed, delta))
      return
    }
    const held = drag.current
    if (!held) {
      if (view.end - view.start < 0.999 && pointers.current.size === 1) {
        const wave = waveRef.current
        const width = wave?.clientWidth || 1
        const delta = -((event.clientX - previous.x) / width) * (view.end - view.start)
        if (event.clientX !== previous.x) setView(panView(view, delta))
      }
      return
    }
    place(held.edge, event.clientX, event.clientY, held.origin, held.x, held.y)
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const wasDrag = drag.current != null
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (wasDrag && pointers.current.size === 0) {
      drag.current = null
      setFine(false)
      onTrimEnd()
    }
  }

  const startLabel = secondsLabel(start, length, rate)
  const endLabel = secondsLabel(end, length, rate)
  const tuneLabel = `${pitchMode === 'stretch' ? 'Stretch' : 'Vinyl'} ${tune >= 0 ? '+' : ''}${tune.toFixed(1)}`
  const startLeft = markerLeft(start, view, reverse)
  const endLeft = markerLeft(end, view, reverse)

  return (
    <div className="pad-screen-stack">
    <section className="pad-screen hw-screen" aria-label="Pad screen" data-pad-screen="lcd">
      <div className="pad-screen-wave" ref={waveRef} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
        <canvas ref={canvasRef} aria-hidden />
        <i className="pad-screen-zero" aria-hidden />
        <i className="pad-screen-playhead" ref={headRef} aria-hidden />
        {samples && startLeft >= -0.02 && startLeft <= 1.02 && (
          <button
            type="button"
            className={`pad-marker${lock?.edge === 'start' ? ' is-locked' : ''}`}
            data-trim="start"
            style={{ left: `${Math.min(1, Math.max(0, startLeft)) * 100}%` }}
            aria-label={`Start marker. ${startLabel}${lock?.edge === 'start' ? `. ${lock.text}` : ''}`}
            title="Drag the start. Pull up or down for a finer move. It snaps to a zero crossing."
          />
        )}
        {samples && endLeft >= -0.02 && endLeft <= 1.02 && (
          <button
            type="button"
            className={`pad-marker pad-marker-end${lock?.edge === 'end' ? ' is-locked' : ''}`}
            data-trim="end"
            style={{ left: `${Math.min(1, Math.max(0, endLeft)) * 100}%` }}
            aria-label={`End marker. ${endLabel}${lock?.edge === 'end' ? `. ${lock.text}` : ''}`}
            title="Drag the end. Pull up or down for a finer move. It snaps to a zero crossing."
          />
        )}
        <div className="pad-screen-readout">
          <strong>{name}</strong>
          <span>Start {startLabel}</span>
          <span>End {endLabel}</span>
          <span>{tuneLabel}</span>
          <span>{gate === 'hold' ? 'Hold' : 'One shot'}</span>
          <span>Swing {Math.round(swing)}</span>
          <span>Level {Math.round(level * 100)}</span>
          <span>Vintage {Math.round(vintage * 100)}</span>
          {fine && <span>Fine</span>}
          {lock && <span className="pad-lock">{lock.text}</span>}
          {!samples && <span>No sample</span>}
        </div>
      </div>
    </section>
      <div className="pad-screen-tools" role="group" aria-label="Waveform zoom">
        <button type="button" className="hw-key mpc-pill" onClick={() => zoom(1 / 1.6)}>Zoom out</button>
        <button type="button" className="hw-key mpc-pill" onClick={() => zoom(1.6)}>Zoom in</button>
        <button type="button" className={`hw-key mpc-pill${snap ? ' on' : ''}`} aria-pressed={snap} title="Snap a dragged marker to the nearest zero crossing. Off places it freely." onClick={() => setSnap((value) => !value)}>Snap to zero</button>
        <button type="button" className="hw-key mpc-pill" onClick={() => setView(closeUp(start, Math.max(8, length)))}>Zoom to Start</button>
        <button type="button" className="hw-key mpc-pill" onClick={() => setView(closeUp(end, Math.max(8, length)))}>Zoom to End</button>
        <button type="button" className="hw-key mpc-pill" title="Reset start and end for this pad." onClick={() => { setView({ start: 0, end: 1 }); onReset() }}>Reset</button>
      </div>
    </div>
  )
}

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
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  if (canvas.width !== Math.floor(cssWidth * ratio) || canvas.height !== Math.floor(cssHeight * ratio)) {
    canvas.width = Math.floor(cssWidth * ratio)
    canvas.height = Math.floor(cssHeight * ratio)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  ctx.fillStyle = '#10160f'
  ctx.fillRect(0, 0, cssWidth, cssHeight)
  const mid = cssHeight / 2
  ctx.strokeStyle = 'rgba(186, 214, 170, 0.45)'
  ctx.beginPath()
  ctx.moveTo(0, mid)
  ctx.lineTo(cssWidth, mid)
  ctx.stroke()
  if (!samples || samples.length < 2 || cssWidth < 2) return
  const gain = Math.max(0.05, Math.min(1, look.level || 0))
  const span = Math.max(1e-6, view.end - view.start)
  const inside = (pixel: number) => {
    const shown = look.reverse ? 1 - pixel / cssWidth : pixel / cssWidth
    const fraction = view.start + shown * span
    return fraction >= look.start && fraction <= look.end
  }
  if (showsSamples(view, samples.length, cssWidth)) {
    const first = Math.max(0, Math.floor(view.start * (samples.length - 1)))
    const last = Math.min(samples.length - 1, Math.ceil(view.end * (samples.length - 1)))
    ctx.beginPath()
    for (let index = first; index <= last; index++) {
      const x = markerLeft(index / (samples.length - 1), view, look.reverse) * cssWidth
      const y = mid - (samples[index] || 0) * gain * (cssHeight * 0.42)
      if (index === first) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = '#d7f5c8'
    ctx.lineWidth = 1.4
    ctx.stroke()
    const roomy = last - first < cssWidth
    if (roomy) {
      ctx.fillStyle = '#f4ffe8'
      for (let index = first; index <= last; index++) {
        const x = markerLeft(index / (samples.length - 1), view, look.reverse) * cssWidth
        const y = mid - (samples[index] || 0) * gain * (cssHeight * 0.42)
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
      }
    }
    ctx.fillStyle = '#f0d78a'
    for (const hit of zeroCrossings(samples, first, last)) {
      const x = markerLeft(hit.index / (samples.length - 1), view, look.reverse) * cssWidth
      ctx.fillRect(x, mid - 7, 1.5, 14)
    }
  } else {
    const peaks = viewPeaks(samples, view, cssWidth, false)
    for (let x = 0; x < cssWidth; x++) {
      const shown = look.reverse ? cssWidth - 1 - x : x
      const lo = peaks[shown * 2] || 0
      const hi = peaks[shown * 2 + 1] || 0
      const y1 = mid - hi * gain * (cssHeight * 0.42)
      const y2 = mid - lo * gain * (cssHeight * 0.42)
      ctx.fillStyle = inside(x) ? '#d7f5c8' : 'rgba(120, 140, 112, 0.35)'
      ctx.fillRect(x, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)))
    }
  }
  if (look.highpass > 0.02) {
    ctx.fillStyle = 'rgba(40, 70, 120, 0.28)'
    ctx.fillRect(0, mid, cssWidth, mid * Math.min(1, look.highpass))
  }
  if (look.filter < 0.98) {
    ctx.fillStyle = 'rgba(120, 80, 30, 0.28)'
    ctx.fillRect(0, 0, cssWidth, mid * (1 - Math.max(0, look.filter)))
  }
  if (look.vintage > 0.01) {
    ctx.fillStyle = `rgba(196, 140, 60, ${0.08 + look.vintage * 0.22})`
    ctx.fillRect(0, 0, cssWidth, cssHeight)
  }
}
