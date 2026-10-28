import { useEffect, useRef, useState } from 'react'
import { paintSpectrogram, panView, yForHz, hzAt, zoomView, type SpectrogramView } from '../audio/spectral/display'
import { spectralKey } from '../audio/spectral/edit'
import { retrySpectral, spectralBlocked } from '../audio/spectral/job'
import type { SpectralAction, SpectralPoint, SpectralRegion, SpectralTool } from '../audio/spectral/types'
import { selectSpectral } from '../state/select'
import type { ProjectStore } from '../state/store'
import { TipButton } from './Hint'
import './spectral.css'

const TOOLS: { id: SpectralTool | 'pan'; label: string; hint: string }[] = [
  { id: 'box', label: 'Box', hint: 'Drag a rectangle around a time and frequency.' },
  { id: 'lasso', label: 'Lasso', hint: 'Draw around the sound you want to edit.' },
  { id: 'harmonic', label: 'Harmonic', hint: 'Drag across a tone to select it and its overtones.' },
  { id: 'pan', label: 'Pan', hint: 'Drag to move. Pinch or scroll to zoom.' },
]

const ACTIONS: { id: SpectralAction | 'learn'; label: string; hint: string }[] = [
  { id: 'attenuate', label: 'Attenuate', hint: 'Turn the selected frequencies down.' },
  { id: 'heal', label: 'Heal', hint: 'Fill the selection from the sound around it.' },
  { id: 'declick', label: 'De-click', hint: 'Take out short clicks and pops in the selection.' },
  { id: 'dehum', label: 'De-hum', hint: 'Notch mains hum and its overtones.' },
  { id: 'learn', label: 'Learn', hint: 'Remember this selection as the noise profile.' },
  { id: 'denoise', label: 'De-noise', hint: 'Subtract the learned noise from the clip.' },
]

const ACTION_LABEL: Record<SpectralAction, string> = {
  attenuate: 'Attenuate',
  heal: 'Heal',
  declick: 'De-click',
  dehum: 'De-hum',
  denoise: 'De-noise',
}

export function SpectralSheet({ store }: { store: ProjectStore }) {
  const model = selectSpectral(store)
  const clip = model.clip
  const track = model.track
  const asset = clip ? store.buffers.get(clip.bufferId) : undefined
  const rate = asset?.sampleRate || model.sampleRate
  const nyquist = Math.max(200, rate / 2)
  const [tool, setTool] = useState<SpectralTool | 'pan'>('box')
  const [amount, setAmount] = useState(1)
  const [view, setView] = useState<SpectrogramView>({ t0: 0, t1: 1, hz0: 30, hz1: nyquist })
  const [selection, setSelection] = useState<SpectralRegion | null>(null)
  const [draft, setDraft] = useState<SpectralRegion | null>(null)
  const [note, setNote] = useState(TOOLS[0].hint)
  const [readout, setReadout] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<Uint8ClampedArray | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ mode: 'draw' | 'pan' | 'pinch'; view: SpectrogramView; dist: number; points: SpectralPoint[]; x: number; y: number } | null>(null)
  const imageKey = useRef('')
  const viewRef = useRef(view)
  const toolRef = useRef(tool)
  viewRef.current = view
  toolRef.current = tool
  const clipId = clip?.id ?? ''

  useEffect(() => {
    setView({ t0: 0, t1: 1, hz0: 30, hz1: nyquist })
    setSelection(null)
    setDraft(null)
  }, [clipId, nyquist])

  useEffect(() => {
    const canvas = canvasRef.current
    const channel = asset?.channels[0]
    if (!canvas || !clip || !channel) return
    const start = Math.max(0, clip.offsetSamples)
    const span = Math.max(1, Math.min(clip.durationSamples, channel.length - start))
    const slice = channel.subarray(start, start + span)
    const draw = () => {
      const width = Math.max(2, Math.floor(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1)))
      const height = Math.max(2, Math.floor(canvas.clientHeight * Math.min(2, window.devicePixelRatio || 1)))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        imageRef.current = null
      }
      const current = viewRef.current
      const key = `${clip.id}:${clip.bufferId}:${current.t0}:${current.t1}:${current.hz0}:${current.hz1}:${width}:${height}`
      if (!imageRef.current || imageKey.current !== key) {
        imageRef.current = paintSpectrogram(slice, rate, current, width, height)
        imageKey.current = key
      }
      const ctx = canvas.getContext('2d')
      const image = imageRef.current
      if (!ctx || !image || image.length !== width * height * 4) return
      ctx.putImageData(new ImageData(new Uint8ClampedArray(image), width, height), 0, 0)
      strokeRegion(ctx, width, height, current, draft, 'rgba(224,177,90,0.95)')
      strokeRegion(ctx, width, height, current, selection, 'rgba(115,196,143,0.95)')
    }
    draw()
    const observer = new ResizeObserver(() => {
      imageRef.current = null
      draw()
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [asset, clip, draft, rate, selection, view])

  if (!clip || !track) return null
  const repair = clip.spectral
  const blocked = repair ? spectralBlocked(clip.id, spectralKey(repair)) : false
  const whole = (): SpectralRegion => ({
    tool: 'box',
    points: [
      { t: 0, hz: 30 },
      { t: 1, hz: nyquist },
    ],
  })

  const apply = (action: SpectralAction | 'learn') => {
    const region = selection ?? (action === 'dehum' || action === 'denoise' ? whole() : null)
    if (!region) {
      setNote('Select a spot on the spectrogram first.')
      return
    }
    if (action === 'learn') {
      void store.learnSpectralNoise(track.id, clip.id, region)
      setNote('Noise profile saved. De-noise subtracts it.')
      return
    }
    if (action === 'denoise' && !repair?.noiseBands?.length) {
      setNote('Learn a noise-only selection first.')
      return
    }
    store.applySpectralOp(track.id, clip.id, action, region, amount)
    setNote(ACTIONS.find((item) => item.id === action)?.hint ?? note)
  }

  const locate = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { t: 0, hz: 440 }
    const rect = canvas.getBoundingClientRect()
    const x = (clientX - rect.left) / Math.max(1, rect.width)
    const y = (clientY - rect.top) / Math.max(1, rect.height)
    const current = viewRef.current
    const t = current.t0 + Math.min(1, Math.max(0, x)) * (current.t1 - current.t0)
    const hz = hzAt(Math.min(1, Math.max(0, y)), current.hz0, current.hz1)
    return { t, hz }
  }

  const onDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const at = locate(event.clientX, event.clientY)
    setReadout(formatReadout(at.hz, at.t, clip.durationSamples / rate))
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      gesture.current = {
        mode: 'pinch',
        view: viewRef.current,
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        points: [],
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      }
      return
    }
    gesture.current = { mode: toolRef.current === 'pan' ? 'pan' : 'draw', view: viewRef.current, dist: 1, points: [at], x: event.clientX, y: event.clientY }
    if (toolRef.current !== 'pan') setDraft(regionFrom(toolRef.current, [at], at))
  }

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const at = locate(event.clientX, event.clientY)
    setReadout(formatReadout(at.hz, at.t, clip.durationSamples / rate))
    const current = gesture.current
    if (!current) return
    if (pointers.current.size >= 2 || current.mode === 'pinch') {
      const [a, b] = [...pointers.current.values()]
      const canvas = canvasRef.current
      if (!b || !canvas) return
      const rect = canvas.getBoundingClientRect()
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const x = ((a.x + b.x) / 2 - rect.left) / Math.max(1, rect.width)
      const y = ((a.y + b.y) / 2 - rect.top) / Math.max(1, rect.height)
      const t = current.view.t0 + Math.min(1, Math.max(0, x)) * (current.view.t1 - current.view.t0)
      const hz = hzAt(Math.min(1, Math.max(0, y)), current.view.hz0, current.view.hz1)
      imageRef.current = null
      setView(zoomView(current.view, t, hz, current.dist / dist, nyquist))
      return
    }
    if (current.mode === 'pan') {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const span = current.view.t1 - current.view.t0
      const dt = -((event.clientX - current.x) / Math.max(1, rect.width)) * span
      const dLog = -((event.clientY - current.y) / Math.max(1, rect.height)) * Math.log(current.view.hz1 / Math.max(1.01, current.view.hz0))
      imageRef.current = null
      setView(panView(current.view, dt, dLog, nyquist))
      return
    }
    const points = toolRef.current === 'lasso' ? [...current.points, at] : [current.points[0] || at, at]
    current.points = points
    setDraft(regionFrom(toolRef.current, points, at))
  }

  const onUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size > 0) return
    const drawn = gesture.current
    gesture.current = null
    if (!drawn || drawn.mode !== 'draw') {
      setDraft(null)
      return
    }
    const region = regionFrom(toolRef.current, drawn.points, drawn.points[drawn.points.length - 1] || { t: 0, hz: 0 })
    setDraft(null)
    if (region.points.length >= 2) setSelection(region)
  }

  return (
    <div className="spectral-sheet" role="dialog" aria-label="Spectral repair">
      <header>
        <strong>Spectral repair</strong>
        <TipButton label="Undo" hint="Undo the last edit." onClick={() => store.undo()} />
        <TipButton label="Redo" hint="Redo the edit you undid." onClick={() => store.redo()} />
        <TipButton
          label={repair?.enabled === false ? 'Bypassed' : 'Bypass'}
          hint="Hear the original clip without these repairs."
          pressed={repair?.enabled === false}
          disabled={!repair}
          onClick={() => store.toggleSpectral(track.id, clip.id)}
        />
        <TipButton label="Fit" hint="Show the whole clip." onClick={() => { imageRef.current = null; setView({ t0: 0, t1: 1, hz0: 30, hz1: nyquist }) }} />
        <TipButton label="Close" hint="Close the spectrogram." onClick={() => store.closeSpectral()} />
        <p>{store.spectralStatus || note}</p>
      </header>
      <div className="spectral-stage">
        <canvas
          ref={canvasRef}
          aria-label="Spectrogram. Drag to select time and frequency."
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onWheel={(event) => {
            event.preventDefault()
            const at = locate(event.clientX, event.clientY)
            imageRef.current = null
            setView(zoomView(view, at.t, at.hz, event.deltaY > 0 ? 1.15 : 0.87, nyquist))
          }}
        />
        {readout && <div className="spectral-readout">{readout}</div>}
      </div>
      <div className="spectral-row" role="toolbar" aria-label="Selection">
        {TOOLS.map((item) => (
          <TipButton key={item.id} label={item.label} hint={item.hint} pressed={tool === item.id} onClick={() => { setTool(item.id); setNote(item.hint) }} />
        ))}
      </div>
      <div className="spectral-row" role="toolbar" aria-label="Repair">
        {ACTIONS.map((item) => (
          <TipButton
            key={item.id}
            label={item.label}
            hint={item.hint}
            disabled={store.remoteFollow || (item.id === 'denoise' && !repair?.noiseBands?.length)}
            onClick={() => apply(item.id)}
          />
        ))}
        {blocked && <TipButton label="Retry" hint="Run the repair again." onClick={() => retrySpectral(store, clip.id)} />}
      </div>
      <label className="spectral-strength">
        Strength
        <input
          aria-label="Strength. How much of the selection to remove."
          title="How much of the selection to remove."
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={amount}
          onChange={(event) => setAmount(Number(event.target.value))}
        />
        <span>{Math.round(amount * 100)}%</span>
      </label>
      {!!repair?.ops.length && (
        <div className="spectral-ops" aria-label="Repairs">
          {repair.ops.map((op) => (
            <TipButton
              key={op.id}
              label={`Remove ${ACTION_LABEL[op.action]}`}
              hint="Remove this repair. The original audio stays."
              onClick={() => store.removeSpectralOp(track.id, clip.id, op.id)}
            >
              {ACTION_LABEL[op.action]} ×
            </TipButton>
          ))}
        </div>
      )}
    </div>
  )
}

function regionFrom(tool: SpectralTool | 'pan', points: SpectralPoint[], at: SpectralPoint): SpectralRegion {
  if (tool === 'harmonic') {
    const first = points[0] || at
    const last = points[points.length - 1] || at
    return {
      tool: 'harmonic',
      partials: 8,
      width: 0.03,
      points: [
        { t: Math.min(first.t, last.t), hz: first.hz },
        { t: Math.max(first.t, last.t), hz: first.hz },
      ],
    }
  }
  if (tool === 'lasso') return { tool: 'lasso', points }
  const first = points[0] || at
  const last = points[points.length - 1] || at
  return {
    tool: 'box',
    points: [
      { t: first.t, hz: first.hz },
      { t: last.t, hz: last.hz },
    ],
  }
}

function strokeRegion(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: SpectrogramView,
  region: SpectralRegion | null,
  color: string,
) {
  if (!region || region.points.length < 1) return
  const xOf = (t: number) => ((t - view.t0) / (view.t1 - view.t0 || 1)) * width
  const yOf = (hz: number) => yForHz(hz, view.hz0, view.hz1) * height
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  if (region.tool === 'box' && region.points.length >= 2) {
    const [a, b] = region.points
    const x = Math.min(xOf(a.t), xOf(b.t))
    const y = Math.min(yOf(a.hz), yOf(b.hz))
    ctx.strokeRect(x, y, Math.abs(xOf(b.t) - xOf(a.t)), Math.abs(yOf(b.hz) - yOf(a.hz)))
  } else if (region.tool === 'harmonic') {
    const fundamental = region.points[0]?.hz ?? 0
    const t0 = Math.min(...region.points.map((point) => point.t))
    const t1 = Math.max(...region.points.map((point) => point.t))
    const partials = region.partials ?? 8
    const widthRatio = region.width ?? 0.03
    for (let partial = 1; partial <= partials; partial++) {
      const center = fundamental * partial
      if (center > view.hz1 * 1.05) break
      ctx.strokeRect(xOf(t0), yOf(center * (1 + widthRatio)), Math.max(1, xOf(t1) - xOf(t0)), Math.max(2, yOf(center * (1 - widthRatio)) - yOf(center * (1 + widthRatio))))
    }
  } else {
    region.points.forEach((point, index) => {
      const x = xOf(point.t)
      const y = yOf(point.hz)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.stroke()
  }
  ctx.restore()
}

function formatReadout(hz: number, t: number, seconds: number) {
  const freq = hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`
  return `${freq} · ${(t * seconds).toFixed(2)} s`
}
