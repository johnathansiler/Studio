import { useEffect, useRef, useState } from 'react'
import type { ParamSpec } from '../audio/plugins/types'
import { NOTE_NAMES } from '../model/scale'

const RATIOS = ['4', '8', '12', '20', 'All']
const BUS_RATIOS = ['2', '4', '10']
const SPEEDS = ['7.5', '15', '30']
const HALLS = ['Room', 'Hall', 'Chamber']

export function Faceplate({
  pluginId,
  title,
  params,
  values,
  vu,
  gr,
  trace,
  onChange,
}: {
  pluginId: string
  title: string
  params: ParamSpec[]
  values: Record<string, number>
  vu: number
  gr: number
  trace: Float32Array | null
  onChange: (id: string, value: number) => void
}) {
  return (
    <section className={`faceplate face-${pluginId}`} aria-label={`${title} faceplate`}>
      <div className="face-meters">
        <Needle label="VU" value={vu} min={-20} max={3} />
        <Needle label="GR" value={Math.min(20, gr)} min={0} max={20} invert />
      </div>
      <div className="face-knobs">
        {params.filter((param) => param.id !== 'mask').map((param) => (
          <Knob
            key={param.id}
            spec={param}
            value={values[param.id] ?? param.default}
            pluginId={pluginId}
            onChange={(value) => onChange(param.id, value)}
          />
        ))}
      </div>
      {pluginId === 'tune' && (
        <TuneGraph
          trace={trace}
          mask={values.mask ?? 0}
          onMask={(mask) => onChange('mask', mask)}
        />
      )}
      {pluginId === 'focus' && <FocusHint ms={values.ms ?? 0} linear={values.linear ?? 0} />}
    </section>
  )
}

function Needle({ label, value, min, max, invert = false }: { label: string; value: number; min: number; max: number; invert?: boolean }) {
  const span = max - min || 1
  const unit = Math.max(0, Math.min(1, (value - min) / span))
  const angle = (invert ? 1 - unit : unit) * 80 - 40
  return (
    <div className="needle" aria-label={`${label} ${value.toFixed(1)}`}>
      <span>{label}</span>
      <div className="needle-face">
        <i style={{ transform: `rotate(${angle}deg)` }} />
      </div>
    </div>
  )
}

function Knob({ spec, value, pluginId, onChange }: { spec: ParamSpec; value: number; pluginId: string; onChange: (value: number) => void }) {
  const start = useRef({ y: 0, value })
  const dragging = useRef(false)
  const [drag, setDrag] = useState(false)
  const span = spec.max - spec.min || 1
  const unit = Math.max(0, Math.min(1, (value - spec.min) / span))
  const angle = -140 + unit * 280
  const move = (clientY: number, fine: boolean) => {
    const delta = (start.current.y - clientY) / (fine ? 220 : 90)
    const next = clamp(start.current.value + delta * span, spec.min, spec.max)
    onChange(next)
  }
  return (
    <div className="knob">
      <button
        type="button"
        role="slider"
        className={drag ? 'dragging' : ''}
        aria-label={spec.name}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={shown(pluginId, spec, value)}
        onDoubleClick={() => onChange(spec.default)}
        onPointerDown={(event) => {
          start.current = { y: event.clientY, value }
          dragging.current = true
          setDrag(true)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!dragging.current) return
          move(event.clientY, event.shiftKey)
        }}
        onPointerUp={() => {
          dragging.current = false
          setDrag(false)
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? span / 200 : span / 40
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(clamp(value + step, spec.min, spec.max))
          if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(clamp(value - step, spec.min, spec.max))
          if (event.key === 'Home') onChange(spec.min)
          if (event.key === 'End') onChange(spec.max)
        }}
      >
        <span style={{ transform: `rotate(${angle}deg)` }} />
      </button>
      <em>{spec.name}</em>
      <small>{shown(pluginId, spec, value)}</small>
    </div>
  )
}

function TuneGraph({ trace, mask, onMask }: { trace: Float32Array | null; mask: number; onMask: (mask: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const view = canvas.current
    const ctx = view?.getContext('2d')
    if (!view || !ctx || !trace) return
    ctx.clearRect(0, 0, view.width, view.height)
    ctx.strokeStyle = 'rgba(232, 196, 122, 0.35)'
    for (let note = 0; note < 12; note++) {
      const y = view.height - ((note + 0.5) / 12) * view.height
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(view.width, y)
      ctx.stroke()
    }
    ctx.strokeStyle = '#e8c47a'
    ctx.beginPath()
    let started = false
    for (let i = 0; i < trace.length; i++) {
      const hz = trace[i]
      if (!hz) continue
      const midi = 69 + 12 * Math.log2(hz / 440)
      const y = view.height - (((midi % 12) + 12) % 12) / 12 * view.height
      const x = (i / trace.length) * view.width
      if (!started) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
      started = true
    }
    ctx.stroke()
  }, [trace])
  return (
    <div className="tune-graph">
      <canvas ref={canvas} width={320} height={96} aria-label="Detected pitch" />
      <div className="tune-keys" role="group" aria-label="Note targets">
        {NOTE_NAMES.map((name, index) => {
          const on = (Math.round(mask) & (1 << index)) !== 0
          return (
            <button
              key={name}
              type="button"
              className={on ? 'on' : ''}
              aria-pressed={on}
              onClick={() => onMask(Math.round(mask) ^ (1 << index))}
            >
              {name}
            </button>
          )
        })}
        <button type="button" onClick={() => onMask(0)}>All</button>
      </div>
    </div>
  )
}

function FocusHint({ ms, linear }: { ms: number; linear: number }) {
  const place = Math.round(ms) === 1 ? 'Mid' : Math.round(ms) === 2 ? 'Side' : 'Stereo'
  return <p className="face-hint">{place}{linear >= 0.5 ? ' · linear phase' : ''}</p>
}

function shown(pluginId: string, spec: ParamSpec, value: number) {
  if (pluginId === 'fet' && spec.id === 'ratio') return RATIOS[clamp(Math.round(value), 0, 4)]
  if (pluginId === 'bus' && spec.id === 'ratio') return BUS_RATIOS[clamp(Math.round(value), 0, 2)]
  if (pluginId === 'tape' && spec.id === 'speed') return SPEEDS[clamp(Math.round(value), 0, 2)]
  if (pluginId === 'hall' && spec.id === 'mode') return HALLS[clamp(Math.round(value), 0, 2)]
  if (spec.id === 'mode' && pluginId === 'ensemble') return value >= 0.5 ? 'Wide' : 'Rich'
  if (spec.id === 'speed' && pluginId === 'rotor') return value >= 0.5 ? 'Fast' : 'Slow'
  if (spec.id === 'tube') return value >= 0.5 ? 'Tube' : 'Console'
  if (spec.id === 'linear') return value >= 0.5 ? 'Linear' : 'Min'
  const text = Math.abs(value) >= 100 ? Math.round(value).toString() : (Math.round(value * 100) / 100).toString()
  return spec.unit ? `${text} ${spec.unit}` : text
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
