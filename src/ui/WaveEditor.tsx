import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import {
  bodyLength,
  copyRange,
  deleteRange,
  displayLength,
  displayOf,
  documentFromClip,
  fadeCurve,
  normalizeGain,
  pasteRegions,
  reverseRange,
  setCrossfade,
  setFades,
  setGainDb,
  silenceRange,
  sourceLen,
  timelineOf,
  trimDocument,
  type FadeShape,
  type WaveEdit,
  type WaveRegion,
} from '../audio/wave/edit'
import { displayColumns, displaySamples } from '../audio/wave/render'
import { activeGridBeats, positionReadout, snapBeatToGrid } from '../model/snapGrid'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { quartersPerBar } from '../model/time'
import type { AudioClip, Project } from '../model/types'
import { typingTarget } from '../state/history'
import type { ProjectStore } from '../state/store'
import { panSpan, zoomSpan, type WaveSpan } from './waveZoom'
import { useScreenOverlay } from './screenOverlay'
import './waveEditor.css'

const SHAPES: { id: FadeShape; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'equal', label: 'Equal' },
  { id: 's', label: 'S-curve' },
  { id: 'log', label: 'Log' },
]

function paintEditor(
  canvas: HTMLCanvasElement,
  channels: ArrayLike<number>[],
  edit: WaveEdit,
  span: WaveSpan,
) {
  const cssW = Math.max(1, canvas.clientWidth)
  const cssH = Math.max(1, canvas.clientHeight)
  const dpr = Math.min(3, window.devicePixelRatio || 1)
  const pixelW = Math.max(1, Math.floor(cssW * dpr))
  const pixelH = Math.max(1, Math.floor(cssH * dpr))
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW
    canvas.height = pixelH
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.fillStyle = '#101614'
  ctx.fillRect(0, 0, cssW, cssH)
  const lanes = Math.max(1, channels.length)
  const laneH = cssH / lanes
  const view = Math.max(1e-6, span.end - span.start)
  const raw = view <= Math.max(64, cssW * 48)
  const exact = raw ? displaySamples(channels, edit, span.start, span.end) : null
  const peaks = raw ? null : displayColumns(channels, edit, span.start, span.end, Math.max(1, Math.floor(cssW * dpr)))
  for (let lane = 0; lane < lanes; lane++) {
    const top = lane * laneH
    const mid = top + laneH / 2
    const amp = Math.max(1, laneH / 2 - 4)
    if (lane > 0) {
      ctx.strokeStyle = 'rgba(49, 68, 58, 0.9)'
      ctx.beginPath()
      ctx.moveTo(0, top + 0.5)
      ctx.lineTo(cssW, top + 0.5)
      ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(244, 255, 248, 0.28)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, mid + 0.5)
    ctx.lineTo(cssW, mid + 0.5)
    ctx.stroke()
    ctx.fillStyle = '#d7efe0'
    ctx.strokeStyle = '#d7efe0'
    if (exact) {
      const data = exact[Math.min(lane, exact.length - 1)] ?? new Float32Array(0)
      const origin = Math.floor(span.start)
      ctx.beginPath()
      let moved = false
      for (let index = 0; index < data.length; index++) {
        const x = ((origin + index - span.start) / view) * cssW
        const y = mid - (data[index] || 0) * amp
        if (!moved) {
          ctx.moveTo(x, y)
          moved = true
        } else ctx.lineTo(x, y)
      }
      ctx.lineWidth = 1.25
      ctx.stroke()
      if (cssW / view >= 4) {
        const origin = Math.floor(span.start)
        ctx.fillStyle = '#f4fff8'
        const radius = Math.min(3.5, Math.max(1.6, (cssW / view) * 0.16))
        for (let index = 0; index < data.length; index++) {
          const x = ((origin + index - span.start) / view) * cssW
          const y = mid - (data[index] || 0) * amp
          ctx.beginPath()
          ctx.arc(x, y, radius, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    } else if (peaks) {
      const bars = peaks[Math.min(lane, peaks.length - 1)] ?? []
      if (!bars.length) continue
      ctx.beginPath()
      bars.forEach((bar, index) => {
        const x = ((index + 0.5) / bars.length) * cssW
        const y = mid - bar.max * amp
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      for (let index = bars.length - 1; index >= 0; index--) {
        const x = ((index + 0.5) / bars.length) * cssW
        ctx.lineTo(x, mid - bars[index].min * amp)
      }
      ctx.closePath()
      ctx.fill()
    }
  }
  const body = bodyLength(edit)
  const shade = (from: number, to: number) => {
    const left = Math.max(0, Math.min(cssW, ((from - span.start) / view) * cssW))
    const right = Math.max(0, Math.min(cssW, ((to - span.start) / view) * cssW))
    if (right - left < 0.5) return
    ctx.fillStyle = 'rgba(8, 12, 10, 0.62)'
    ctx.fillRect(left, 0, right - left, cssH)
  }
  shade(span.start, Math.min(span.end, edit.head))
  shade(Math.max(span.start, edit.head + body), span.end)
  const xOf = (sample: number) => ((sample - span.start) / view) * cssW
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(224, 177, 90, 0.95)'
  const strokeFade = (from: number, to: number, shape: FadeShape, fadeOut: boolean) => {
    if (to - from < 2) return
    ctx.beginPath()
    const steps = 28
    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      const curve = fadeCurve(fadeOut ? 1 - t : t, shape)
      const x = xOf(from + (to - from) * t)
      const y = 2 + (1 - curve) * (cssH / 2 - 2)
      if (step === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  if (edit.fadeIn > 1) strokeFade(edit.head, edit.head + edit.fadeIn, edit.fadeInShape, false)
  if (edit.fadeOut > 1) strokeFade(edit.head + body - edit.fadeOut, edit.head + body, edit.fadeOutShape, true)
}

function paintRuler(
  canvas: HTMLCanvasElement,
  project: Project,
  clip: AudioClip,
  edit: WaveEdit,
  span: WaveSpan,
) {
  const cssW = Math.max(1, canvas.clientWidth)
  const cssH = Math.max(1, canvas.clientHeight)
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const pixelW = Math.max(1, Math.floor(cssW * dpr))
  const pixelH = Math.max(1, Math.floor(cssH * dpr))
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW
    canvas.height = pixelH
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.fillStyle = '#141c18'
  ctx.fillRect(0, 0, cssW, cssH)
  const view = Math.max(1e-6, span.end - span.start)
  const beat0 = projectSampleBeat(project, timelineOf(clip, edit, span.start))
  const beat1 = projectSampleBeat(project, timelineOf(clip, edit, span.end))
  const spanBeats = Math.max(1e-4, beat1 - beat0)
  const bar = quartersPerBar(project.timeSignature)
  const step = spanBeats > 48 ? bar : spanBeats > 16 ? 1 : spanBeats > 6 ? 0.5 : 0.25
  const first = Math.floor(beat0 / step) * step
  ctx.font = '11px Outfit, "Avenir Next", "Segoe UI", sans-serif'
  ctx.lineWidth = 1
  for (let beat = first; beat <= beat1 + step * 0.5; beat += step) {
    const display = displayOf(clip, edit, projectBeatSample(project, beat))
    const x = ((display - span.start) / view) * cssW
    if (x < -40 || x > cssW + 40) continue
    const downbeat = Math.abs(beat / bar - Math.round(beat / bar)) < 1e-2
    ctx.strokeStyle = downbeat ? 'rgba(244, 255, 248, 0.45)' : 'rgba(244, 255, 248, 0.16)'
    ctx.beginPath()
    ctx.moveTo(x + 0.5, downbeat ? 2 : 16)
    ctx.lineTo(x + 0.5, cssH)
    ctx.stroke()
    if (downbeat || step >= 1) {
      ctx.fillStyle = '#b7c4b8'
      ctx.fillText(positionReadout(Math.max(0, beat), bar), Math.min(cssW - 28, x + 4), 12)
    }
  }
}

export function WaveEditor({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const trackId = store.waveTrackId
  const clipId = store.waveClipId
  const track = trackId ? store.track(trackId) : undefined
  const clip = track?.clips.find((item) => item.id === clipId) ?? null
  const asset = clip ? store.buffers.get(clip.bufferId) : undefined
  const project = store.project
  const file = asset?.channels[0]?.length ?? (clip ? clip.offsetSamples + sourceLen(clip) : 1)
  const base = clip ? documentFromClip(clip, file) : null
  const [draft, setDraft] = useState<WaveEdit | null>(null)
  const [view, setView] = useState<WaveSpan | null>(null)
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [loopOn, setLoopOn] = useState(false)
  const [bypass, setBypass] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [canPaste, setCanPaste] = useState(false)
  const clipboard = useRef<WaveRegion[]>([])
  const dragging = useRef(false)
  const pinching = useRef(false)
  const preview = useRef<{ start: number; end: number } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rulerRef = useRef<HTMLCanvasElement>(null)
  const edit = draft ?? base
  const full = edit ? displayLength(edit) : 1
  const span = view ?? { start: 0, end: full }
  const editRef = useRef(edit)
  const spanRef = useRef(span)
  const playRef = useRef(playhead)
  const selectionRef = useRef(selection)
  editRef.current = edit
  spanRef.current = span
  playRef.current = playhead
  selectionRef.current = selection
  const clipToken = clip
    ? `${clip.id}:${clip.startSample}:${clip.durationSamples}:${clip.offsetSamples}:${clip.gain}:${clip.fadeInSamples}:${clip.fadeOutSamples}:${JSON.stringify(clip.wave ?? null)}`
    : ''

  useScreenOverlay(() => {
    engine.stopPreview()
    store.closeWaveEditor()
  }, !!clip)

  useEffect(() => () => engine.stopPreview(), [engine])

  useEffect(() => {
    if (!clip || !base) return
    setDraft(null)
    setView(null)
    setSelection(null)
    setPlayhead(base.head)
    setPlaying(false)
    preview.current = null
    engine.stopPreview()
  }, [clip?.id])

  useEffect(() => {
    if (!dragging.current) setDraft(null)
  }, [clipToken])

  useEffect(() => {
    let frame = 0
    const tick = () => {
      const head = engine.previewHead()
      const range = preview.current
      const current = editRef.current
      if (head && range && current && !dragging.current) {
        setPlayhead(current.head + range.start + head.ratio * Math.max(1, range.end - range.start))
        if (head.done) {
          preview.current = null
          setPlaying(false)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [engine])

  useEffect(() => {
    const canvas = canvasRef.current
    const ruler = rulerRef.current
    const stage = stageRef.current
    if (!canvas || !ruler || !stage || !clip || !edit || !asset?.channels.length) return
    const draw = () => {
      paintEditor(canvas, asset.channels, edit, span)
      paintRuler(ruler, project, clip, edit, span)
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [asset, clip, edit, project, span.start, span.end])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const pointers = new Map<number, { x: number; y: number }>()
    let gesture: { span: WaveSpan; dist: number; mid: number; anchor: number } | null = null
    const limit = () => {
      const current = editRef.current
      return { start: 0, end: current ? displayLength(current) : 1 }
    }
    const onDown = (event: PointerEvent) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size < 2) return
      pinching.current = true
      setSelection(null)
      const pts = [...pointers.values()]
      const rect = stage.getBoundingClientRect()
      const mid = (pts[0].x + pts[1].x) / 2
      const width = Math.max(1, rect.width)
      const current = spanRef.current
      gesture = {
        span: current,
        dist: Math.max(8, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
        mid,
        anchor: current.start + ((mid - rect.left) / width) * (current.end - current.start),
      }
    }
    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (!gesture || pointers.size < 2) return
      event.preventDefault()
      const pts = [...pointers.values()]
      const dist = Math.max(8, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y))
      const mid = (pts[0].x + pts[1].x) / 2
      const rect = stage.getBoundingClientRect()
      let next = zoomSpan(gesture.span, limit(), dist / gesture.dist, gesture.anchor)
      const perPx = (next.end - next.start) / Math.max(1, rect.width)
      next = panSpan(next, limit(), (gesture.mid - mid) * perPx)
      setView(next)
    }
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId)
      if (pointers.size < 2) {
        gesture = null
        pinching.current = false
      }
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const current = spanRef.current
      const bounds = limit()
      if (event.ctrlKey || event.metaKey) {
        const anchor = current.start + ((event.clientX - rect.left) / Math.max(1, rect.width)) * (current.end - current.start)
        setView(zoomSpan(current, bounds, Math.exp(-event.deltaY * 0.0016), anchor))
        return
      }
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const perPx = (current.end - current.start) / Math.max(1, rect.width)
      setView(panSpan(current, bounds, delta * perPx))
    }
    stage.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      stage.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      stage.removeEventListener('wheel', onWheel)
    }
  }, [clip?.id])

  function sampleAt(clientX: number) {
    const wrap = canvasRef.current?.parentElement
    if (!wrap) return spanRef.current.start
    const rect = wrap.getBoundingClientRect()
    const current = spanRef.current
    const ratio = (clientX - rect.left) / Math.max(1, rect.width)
    return current.start + ratio * (current.end - current.start)
  }

  function snapSample(sample: number) {
    const current = editRef.current
    const live = clip
    if (!current || !live || !project.snap || bypass) return sample
    const beat = projectSampleBeat(project, Math.max(0, timelineOf(live, current, sample)))
    const grid = activeGridBeats(project)
    if (!(grid > 0)) return sample
    return displayOf(live, current, projectBeatSample(project, snapBeatToGrid(Math.max(0, beat), grid)))
  }

  function commit(next: WaveEdit, label: string) {
    if (!trackId || !clip) return
    engine.stopPreview()
    preview.current = null
    setPlaying(false)
    dragging.current = false
    store.applyWave(trackId, clip.id, next, label)
    setDraft(null)
  }

  function bodySelection(editNow: WaveEdit, sel = selectionRef.current) {
    if (!sel) return null
    const body = bodyLength(editNow)
    const from = Math.max(0, Math.min(sel.start, sel.end) - editNow.head)
    const to = Math.min(body, Math.max(sel.start, sel.end) - editNow.head)
    if (to - from < 1) return null
    return { start: from, end: to }
  }

  function play() {
    const current = editRef.current
    if (!current || !asset?.channels.length) return
    const body = bodyLength(current)
    const selected = bodySelection(current)
    let range = selected
    if (!range) {
      const at = Math.max(0, Math.min(body - 1, playRef.current - current.head))
      range = loopOn || at >= body - 1 ? { start: 0, end: body } : { start: at, end: body }
    }
    preview.current = range
    setPlaying(true)
    engine.previewWave(asset.channels, current, range.start, range.end, asset.sampleRate, loopOn)
  }

  function stop() {
    preview.current = null
    setPlaying(false)
    engine.stopPreview()
  }

  function dragHandle(event: ReactPointerEvent, apply: (sample: number) => WaveEdit, label: string) {
    if (!edit) return
    event.preventDefault()
    event.stopPropagation()
    dragging.current = true
    const pointer = event.pointerId
    const origin = edit
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer || pinching.current) return
      setDraft(apply(snapSample(sampleAt(ev.clientX))))
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const next = apply(snapSample(sampleAt(ev.clientX)))
      if (next === origin) {
        dragging.current = false
        setDraft(null)
        return
      }
      commit(next, label)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typingTarget(event.target as HTMLElement | null)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        engine.stopPreview()
        store.closeWaveEditor()
        return
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const current = editRef.current
      const range = current ? bodySelection(current) : null
      if (!current || !range || !trackId || !clip) return
      event.preventDefault()
      event.stopPropagation()
      setSelection(null)
      commit(deleteRange(current, range.start, range.end), 'Delete')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [clip, engine, store, trackId])

  if (!clip || !edit || !trackId) return null
  const body = bodyLength(edit)
  const audibleEnd = edit.head + body
  const selected = bodySelection(edit, selection)
  const bar = quartersPerBar(project.timeSignature)
  const playBeat = projectSampleBeat(project, Math.max(0, timelineOf(clip, edit, playhead)))
  const readout = selected
    ? `${positionReadout(Math.max(0, projectSampleBeat(project, timelineOf(clip, edit, edit.head + selected.start))), bar)} – ${positionReadout(Math.max(0, projectSampleBeat(project, timelineOf(clip, edit, edit.head + selected.end))), bar)}`
    : positionReadout(playBeat, bar)
  const gainDb = Math.round(edit.gainDb * 10) / 10
  const snapping = project.snap && !bypass
  const zoomed = view != null && (view.start > 0.5 || view.end < full - 0.5)
  const pct = (sample: number) => ((sample - span.start) / Math.max(1e-6, span.end - span.start)) * 100
  const shown = (sample: number) => sample >= span.start - 2 && sample <= span.end + 2

  function onWaveDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || pinching.current) return
    const originX = event.clientX
    const origin = sampleAt(event.clientX)
    let moved = false
    const move = (ev: PointerEvent) => {
      if (pinching.current) return
      if (Math.abs(ev.clientX - originX) > 4) moved = true
      const next = snapSample(sampleAt(ev.clientX))
      setSelection({ start: Math.min(origin, next), end: Math.max(origin, next) })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (pinching.current) return
      if (!moved) {
        setSelection(null)
        setPlayhead(snapSample(sampleAt(ev.clientX)))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function onRulerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const place = (clientX: number) => setPlayhead(snapSample(sampleAt(clientX)))
    place(event.clientX)
    const pointer = event.pointerId
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === pointer) place(ev.clientX)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const rate = asset?.sampleRate || project.sampleRate
  const joinsOn = edit.crossfade >= Math.round(rate * 0.008)

  return (
    <div className="wave-editor" data-editor="wave" data-wave-editor="open" data-screen-overlay="" role="dialog" aria-label="Wave editor">
      <header>
        <div className="wave-title">
          <strong>{clip.name}</strong>
          <span className="wave-readout">{readout} · {gainDb.toFixed(1)} dB{asset && asset.channels.length > 1 ? ' · Stereo' : ''}</span>
        </div>
        <button
          type="button"
          className="text-btn"
          title="Pitch, stretch, and tempo for this clip."
          onClick={() => {
            engine.stopPreview()
            store.closeWaveEditor()
            store.selectClip(trackId, clip.id, false, true)
          }}
        >
          Timing
        </button>
        <button
          type="button"
          className="overlay-close wave-done"
          onClick={() => {
            engine.stopPreview()
            store.closeWaveEditor()
          }}
        >
          Done
        </button>
      </header>
      {asset?.channels.length ? (
        <div className="wave-stage" ref={stageRef}>
          <canvas ref={rulerRef} className="wave-ruler" aria-label="Time ruler" onPointerDown={onRulerDown} />
          <div className="wave-canvas-wrap">
            <canvas ref={canvasRef} className="wave-canvas" aria-label="Clip waveform" onPointerDown={onWaveDown} />
            {selection && (
              <div className="wave-select" style={{ left: `${pct(Math.min(selection.start, selection.end))}%`, width: `${Math.max(0, pct(Math.max(selection.start, selection.end)) - pct(Math.min(selection.start, selection.end)))}%` }} />
            )}
            <div className="wave-playhead" style={{ left: `${pct(playhead)}%` }} />
            {shown(edit.head) && (
              <button
                type="button"
                className="wave-trim"
                aria-label="Trim start"
                title="Trim the start. Audio outside the clip stays dimmed."
                style={{ left: `${pct(edit.head)}%` }}
                onPointerDown={(event) => dragHandle(event, (sample) => trimDocument(edit, 'start', sample - edit.head), 'Trim')}
              />
            )}
            {shown(audibleEnd) && (
              <button
                type="button"
                className="wave-trim"
                aria-label="Trim end"
                title="Trim the end. Audio outside the clip stays dimmed."
                style={{ left: `${pct(audibleEnd)}%` }}
                onPointerDown={(event) => dragHandle(event, (sample) => trimDocument(edit, 'end', audibleEnd - sample), 'Trim')}
              />
            )}
            {edit.fadeIn > 1 && shown(edit.head + edit.fadeIn) && (
              <button
                type="button"
                className="wave-fade"
                aria-label="Fade in"
                title="Drag to change the fade in."
                style={{ left: `${pct(edit.head + edit.fadeIn)}%` }}
                onPointerDown={(event) => dragHandle(event, (sample) => setFades(edit, { fadeIn: sample - edit.head }), 'Fade')}
              />
            )}
            {edit.fadeOut > 1 && shown(audibleEnd - edit.fadeOut) && (
              <button
                type="button"
                className="wave-fade"
                aria-label="Fade out"
                title="Drag to change the fade out."
                style={{ left: `${pct(audibleEnd - edit.fadeOut)}%` }}
                onPointerDown={(event) => dragHandle(event, (sample) => setFades(edit, { fadeOut: audibleEnd - sample }), 'Fade')}
              />
            )}
            {selection && shown(Math.min(selection.start, selection.end)) && (
              <button
                type="button"
                className="wave-sel"
                aria-label="Selection start"
                style={{ left: `${pct(Math.min(selection.start, selection.end))}%` }}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  const end = Math.max(selection.start, selection.end)
                  const pointer = event.pointerId
                  const move = (ev: PointerEvent) => {
                    if (ev.pointerId !== pointer) return
                    const next = Math.min(end - 1, snapSample(sampleAt(ev.clientX)))
                    setSelection({ start: next, end })
                  }
                  const up = () => {
                    window.removeEventListener('pointermove', move)
                    window.removeEventListener('pointerup', up)
                  }
                  window.addEventListener('pointermove', move)
                  window.addEventListener('pointerup', up)
                }}
              />
            )}
            {selection && shown(Math.max(selection.start, selection.end)) && (
              <button
                type="button"
                className="wave-sel"
                aria-label="Selection end"
                style={{ left: `${pct(Math.max(selection.start, selection.end))}%` }}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  const start = Math.min(selection.start, selection.end)
                  const pointer = event.pointerId
                  const move = (ev: PointerEvent) => {
                    if (ev.pointerId !== pointer) return
                    const next = Math.max(start + 1, snapSample(sampleAt(ev.clientX)))
                    setSelection({ start, end: next })
                  }
                  const up = () => {
                    window.removeEventListener('pointermove', move)
                    window.removeEventListener('pointerup', up)
                  }
                  window.addEventListener('pointermove', move)
                  window.addEventListener('pointerup', up)
                }}
              />
            )}
          </div>
          {zoomed && (
            <input
              className="wave-scroll"
              type="range"
              aria-label="Scroll the waveform"
              min={0}
              max={Math.max(1, full - (span.end - span.start))}
              step={1}
              value={Math.max(0, Math.min(full, span.start))}
              onChange={(event) => {
                const width = span.end - span.start
                const start = Number(event.target.value)
                setView({ start, end: Math.min(full, start + width) })
              }}
            />
          )}
        </div>
      ) : (
        <p className="wave-empty">This clip has no audio loaded.</p>
      )}
      <div className="btn-tray wave-tools">
        <button type="button" aria-pressed={playing} title="Play the selection, or from the playhead." onClick={() => (playing ? stop() : play())}>{playing ? 'Stop' : 'Play'}</button>
        <button type="button" title="Stop the preview." onClick={stop}>Stop</button>
        <button type="button" aria-pressed={loopOn} title="Loop the selection, or the whole clip." onClick={() => setLoopOn((value) => !value)}>Loop</button>
        <button type="button" aria-pressed={snapping} title={project.snap ? 'Snap to the song grid. Turn off to place freely.' : 'Snap is off for the song.'} onClick={() => project.snap && setBypass((value) => !value)}>Snap</button>
        <button type="button" aria-label="Zoom out" title="Zoom out." onClick={() => setView(zoomSpan(span, { start: 0, end: full }, 1 / 1.6, playhead))}>−</button>
        <button type="button" aria-label="Zoom in" title="Zoom in." onClick={() => setView(zoomSpan(span, { start: 0, end: full }, 1.6, playhead))}>+</button>
        <button type="button" title="Fit the whole clip." onClick={() => setView(null)}>Fit</button>
      </div>
      <div className="btn-tray wave-tools">
        <button
          type="button"
          title="Split the clip at the playhead."
          disabled={playhead <= edit.head + 1 || playhead >= audibleEnd - 1}
          onClick={() => store.splitWaveClip(trackId, clip.id, timelineOf(clip, edit, playhead))}
        >
          Split
        </button>
        <button
          type="button"
          disabled={!selected}
          title="Copy the selection and remove it."
          onClick={() => {
            if (!selected) return
            clipboard.current = copyRange(edit, selected.start, selected.end)
            setCanPaste(clipboard.current.length > 0)
            setSelection(null)
            commit(deleteRange(edit, selected.start, selected.end), 'Cut')
          }}
        >
          Cut
        </button>
        <button
          type="button"
          disabled={!selected}
          title="Copy the selection."
          onClick={() => {
            if (!selected) return
            clipboard.current = copyRange(edit, selected.start, selected.end)
            setCanPaste(clipboard.current.length > 0)
          }}
        >
          Copy
        </button>
        <button
          type="button"
          disabled={!canPaste}
          title="Paste at the playhead, or replace the selection."
          onClick={() => {
            const at = selected ? selected.start : Math.max(0, Math.min(body, playhead - edit.head))
            commit(pasteRegions(edit, at, clipboard.current, selected ? selected.end : undefined), 'Paste')
            setSelection(null)
          }}
        >
          Paste
        </button>
        <button
          type="button"
          disabled={!selected}
          title="Delete the selection and close the gap."
          onClick={() => {
            if (!selected) return
            setSelection(null)
            commit(deleteRange(edit, selected.start, selected.end), 'Delete')
          }}
        >
          Delete
        </button>
        <button
          type="button"
          disabled={!selected}
          title="Replace the selection with silence."
          onClick={() => {
            if (!selected) return
            commit(silenceRange(edit, selected.start, selected.end), 'Silence')
          }}
        >
          Silence
        </button>
      </div>
      <div className="btn-tray wave-tools">
        <button
          type="button"
          title="Reverse the selection, or the whole clip."
          onClick={() => {
            const range = selected ?? { start: 0, end: body }
            commit(reverseRange(edit, range.start, range.end), 'Reverse')
          }}
        >
          Reverse
        </button>
        <button
          type="button"
          title="Raise the clip so the loudest sample reaches full scale."
          disabled={!asset?.channels.length}
          onClick={() => asset && commit(normalizeGain(edit, asset.channels), 'Normalize')}
        >
          Normalize
        </button>
        <button
          type="button"
          aria-pressed={joinsOn}
          title="Crossfade each edit so cuts do not click."
          onClick={() => commit(setCrossfade(edit, joinsOn ? 0 : Math.round(rate * 0.01)), 'Crossfade')}
        >
          Joins
        </button>
        <select
          aria-label="Fade curve"
          title="Shape of the fade in and fade out."
          value={edit.fadeInShape}
          onChange={(event) => {
            const shape = event.target.value as FadeShape
            const fadeIn = edit.fadeIn > 0 ? edit.fadeIn : Math.round(rate * 0.01)
            const fadeOut = edit.fadeOut > 0 ? edit.fadeOut : Math.round(rate * 0.02)
            commit(setFades(edit, { fadeInShape: shape, fadeOutShape: shape, fadeIn, fadeOut }), 'Fade')
          }}
        >
          {SHAPES.map((shape) => (
            <option key={shape.id} value={shape.id}>{shape.label}</option>
          ))}
        </select>
      </div>
      <label className="wave-gain">
        <span>{gainDb.toFixed(1)} dB</span>
        <input
          type="range"
          aria-label="Clip gain"
          min={-48}
          max={24}
          step={0.1}
          value={Math.max(-48, Math.min(24, edit.gainDb))}
          onPointerDown={() => { dragging.current = true }}
          onChange={(event) => setDraft(setGainDb(base ?? edit, Number(event.target.value)))}
          onKeyUp={(event) => {
            if (dragging.current) return
            const next = setGainDb(base ?? edit, Number(event.currentTarget.value))
            if (base && Math.abs(next.gainDb - base.gainDb) < 0.05) return
            commit(next, 'Gain')
          }}
          onPointerUp={(event) => {
            const next = setGainDb(base ?? edit, Number(event.currentTarget.value))
            if (Math.abs(next.gainDb - (base?.gainDb ?? edit.gainDb)) < 0.05) {
              dragging.current = false
              setDraft(null)
              return
            }
            commit(next, 'Gain')
          }}
          onBlur={(event) => {
            if (!dragging.current) return
            const next = setGainDb(base ?? edit, Number(event.currentTarget.value))
            if (Math.abs(next.gainDb - (base?.gainDb ?? edit.gainDb)) < 0.05) {
              dragging.current = false
              setDraft(null)
              return
            }
            commit(next, 'Gain')
          }}
        />
      </label>
    </div>
  )
}
