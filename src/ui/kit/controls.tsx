import { useEffect, useRef, useState, type ReactNode } from 'react'
import { attachGlissando } from '../glissando'
import { attachControlGesture, type GestureChange, type GestureElement, type GestureReadout } from '../gestures'
import type { FaceTheme } from '../faces/themes'
import './kit.css'

export function useDragValue<T extends HTMLElement = HTMLElement>({
  min,
  max,
  value,
  fallback,
  axis = 'y',
  format,
  onChange,
  onStart,
  onCommit,
}: {
  min: number
  max: number
  value: number
  fallback: number
  axis?: 'x' | 'y' | 'pad'
  format?: (value: number) => string
  onChange: (value: number, change: GestureChange) => void
  onStart?: () => void
  onCommit?: () => void
}) {
  const ref = useRef<T | null>(null)
  const latest = useRef({ min, max, value, fallback, axis, format, onChange, onStart, onCommit })
  latest.current = { min, max, value, fallback, axis, format, onChange, onStart, onCommit }
  const [readout, setReadout] = useState<GestureReadout | null>(null)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return attachControlGesture(el as unknown as GestureElement, () => ({
      min: latest.current.min,
      max: latest.current.max,
      fallback: latest.current.fallback,
      axis: latest.current.axis,
      format: latest.current.format,
      getValue: () => latest.current.value,
      onStart: () => {
        setDragging(true)
        latest.current.onStart?.()
      },
      onChange: (change) => latest.current.onChange(change.value, change),
      onCommit: () => {
        setDragging(false)
        setReadout(null)
        latest.current.onCommit?.()
      },
      onReadout: setReadout,
    }))
  }, [])
  return { ref, readout, dragging }
}

export function GestureReadout({ readout }: { readout: GestureReadout | null }) {
  if (!readout) return null
  return <span className="gesture-readout" style={{ left: readout.x, top: readout.y }}>{readout.text}</span>
}

export function clampUnit(value: number, min: number, max: number) {
  const span = max - min || 1
  return Math.max(0, Math.min(1, (value - min) / span))
}

export function valueFromDrag(start: number, dy: number, min: number, max: number, fine: boolean) {
  const span = max - min || 1
  const next = start + (-dy / (fine ? 220 : 90)) * span
  return Math.max(min, Math.min(max, next))
}

export function formatValue(value: number, unit: string) {
  const text = Math.abs(value) >= 100 ? Math.round(value).toString() : (Math.round(value * 100) / 100).toString()
  return unit ? `${text} ${unit}` : text
}

export function Knob({
  label,
  min,
  max,
  value,
  unit = '',
  fallback,
  onChange,
}: {
  label: string
  min: number
  max: number
  value: number
  unit?: string
  fallback: number
  onChange: (value: number) => void
}) {
  const { ref, readout, dragging } = useDragValue<HTMLButtonElement>({
    min,
    max,
    value,
    fallback,
    format: (next) => formatValue(next, unit),
    onChange,
  })
  const unitValue = clampUnit(value, min, max)
  const angle = -140 + unitValue * 280
  const shown = formatValue(value, unit)
  return (
    <div className={`kit-knob${dragging ? ' dragging' : ''}`}>
      <button
        ref={ref}
        type="button"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={shown}
        style={{ ['--arc' as string]: String(unitValue) }}
        onKeyDown={(event) => {
          const span = max - min || 1
          const step = event.shiftKey ? span / 200 : span / 40
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(Math.min(max, value + step))
          if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(Math.max(min, value - step))
          if (event.key === 'Home') onChange(min)
          if (event.key === 'End') onChange(max)
        }}
      >
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="24" />
          <circle cx="32" cy="32" r="24" className="arc" />
        </svg>
        <i style={{ transform: `rotate(${angle}deg)` }} />
      </button>
      <em>{label}</em>
      <small>{shown}</small>
      <GestureReadout readout={readout} />
    </div>
  )
}

export function Fader({
  label,
  min,
  max,
  value,
  unit = '',
  fallback,
  onChange,
}: {
  label: string
  min: number
  max: number
  value: number
  unit?: string
  fallback: number
  onChange: (value: number) => void
}) {
  const { ref, readout, dragging } = useDragValue<HTMLButtonElement>({ min, max, value, fallback, format: (next) => formatValue(next, unit), onChange })
  const unitValue = clampUnit(value, min, max)
  const shown = formatValue(value, unit)
  return (
    <div className={`kit-fader${dragging ? ' dragging' : ''}`}>
      <button
        ref={ref}
        type="button"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={shown}
      >
        <span className="track"><i style={{ height: `${unitValue * 100}%` }} /><b style={{ bottom: `calc(${unitValue * 100}% - 7px)` }} /></span>
      </button>
      <em>{label}</em>
      <small>{shown}</small>
      <GestureReadout readout={readout} />
    </div>
  )
}

export function TouchSlider({
  label,
  min,
  max,
  step,
  value,
  fallback,
  vertical = false,
  className = '',
  title,
  onChange,
  onStart,
  onCommit,
}: {
  label: string
  min: number
  max: number
  step?: number
  value: number
  fallback?: number
  vertical?: boolean
  className?: string
  title?: string
  onChange: (value: number) => void
  onStart?: () => void
  onCommit?: () => void
}) {
  const snap = (next: number) => {
    const span = step && step > 0 ? step : 0
    const raw = span ? min + Math.round((next - min) / span) * span : next
    return Math.max(min, Math.min(max, raw))
  }
  const { ref, readout, dragging } = useDragValue<HTMLDivElement>({
    min,
    max,
    value,
    fallback: fallback ?? value,
    axis: vertical ? 'y' : 'x',
    onChange: (next) => onChange(snap(next)),
    onStart,
    onCommit,
  })
  const unit = clampUnit(value, min, max)
  const shown = formatValue(value, '')
  return (
    <div
      ref={ref}
      className={`touch-slider${vertical ? ' vertical' : ''}${dragging ? ' dragging' : ''} ${className}`.trim()}
      role="slider"
      aria-label={label}
      title={title || label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100) / 100}
      aria-valuetext={shown}
    >
      <i style={vertical ? { height: `${unit * 100}%` } : { width: `${unit * 100}%` }} />
      <b style={vertical ? { bottom: `calc(${unit * 100}% - 7px)` } : { left: `calc(${unit * 100}% - 7px)` }} />
      <GestureReadout readout={readout} />
    </div>
  )
}

export function Meter({ label, value, max = 1 }: { label: string; value: number; max?: number }) {
  const unit = Math.max(0, Math.min(1, value / (max || 1)))
  const cells = 12
  return (
    <div className="kit-meter" aria-label={`${label} ${value.toFixed(1)}`}>
      <span>{label}</span>
      <div>
        {Array.from({ length: cells }, (_, index) => (
          <i key={index} className={unit >= (index + 1) / cells ? 'lit' : ''} data-hot={index > 8 ? '1' : undefined} />
        ))}
      </div>
    </div>
  )
}

export function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`kit-toggle${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>
      <i />
      {label}
    </button>
  )
}

const WHITE = [0, 2, 4, 5, 7, 9, 11]

export function keyboardNotes(octaves: number, start = 48) {
  const whites: number[] = []
  for (let octave = 0; octave < octaves; octave++) for (const step of WHITE) whites.push(start + octave * 12 + step)
  whites.push(start + octaves * 12)
  return whites
}

/** Black keys sit only between C-D, D-E, F-G, G-A, and A-B. */
export function blackAfter(note: number): number | null {
  const pc = ((note % 12) + 12) % 12
  if (pc === 0 || pc === 2 || pc === 5 || pc === 7 || pc === 9) return note + 1
  return null
}

export function octaveName(note: number) {
  return `C${Math.floor(note / 12) - 1}`
}

export function Keyboard({
  compact = false,
  onDown,
  onUp,
}: {
  compact?: boolean
  /** Velocity follows pointer pressure. A mouse press uses 0.85. */
  onDown?: (note: number, velocity?: number) => void
  onUp?: (note: number) => void
}) {
  const octaves = compact ? 2 : 3
  const base = compact ? 48 : 36
  const [shift, setShift] = useState(0)
  const start = Math.max(0, Math.min(96, base + shift * 12))
  const whites = keyboardNotes(octaves, start)
  const top = whites[whites.length - 1]
  const root = useRef<HTMLDivElement>(null)
  const downRef = useRef(onDown)
  const upRef = useRef(onUp)
  downRef.current = onDown
  upRef.current = onUp
  useEffect(() => {
    const el = root.current
    if (!el) return
    return attachGlissando(el, {
      accept: (key) => key.classList.contains('white') || key.classList.contains('black'),
      onOn: (pitch, event) => {
        const pressure = event.pressure > 0 && event.pressure < 1 ? event.pressure : 0.85
        downRef.current?.(pitch, Math.max(0.08, Math.min(1, pressure)))
      },
      onOff: (pitch) => upRef.current?.(pitch),
    })
  }, [start])
  return (
    <div className={`kit-keyboard${compact ? ' compact' : ''}`}>
      <div className="kit-octave">
        <button type="button" aria-label="Octave down" title="Lower the keyboard by one octave." disabled={start <= 0} onClick={() => setShift((value) => Math.max(-3, value - 1))}>−</button>
        <span>{octaveName(start)}</span>
        <button type="button" aria-label="Octave up" title="Raise the keyboard by one octave." disabled={start >= 96} onClick={() => setShift((value) => Math.min(4, value + 1))}>+</button>
      </div>
      <div ref={root} className={`kit-keys${compact ? ' compact' : ''}`} role="group" aria-label="Keyboard">
        {whites.map((note) => {
          const black = blackAfter(note)
          const showBlack = black != null && black < top
          return (
            <div className="slot" key={note}>
              <button
                type="button"
                className="white"
                data-pitch={note}
                aria-label={((note % 12) + 12) % 12 === 0 ? octaveName(note) : `Note ${note}`}
              >
                {((note % 12) + 12) % 12 === 0 ? <span>{octaveName(note)}</span> : null}
              </button>
              {showBlack && (
                <button
                  type="button"
                  className="black"
                  data-pitch={black}
                  aria-label={`Note ${black}`}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Shell({
  theme,
  children,
  compact = false,
}: {
  theme: FaceTheme
  children: ReactNode
  compact?: boolean
}) {
  return (
    <section
      className={`kit-shell${compact ? ' compact' : ''} face-${theme.id}`}
      data-family={theme.family}
      aria-label={`${theme.badge} faceplate`}
      style={{
        ['--panel' as string]: theme.panel,
        ['--ink' as string]: theme.ink,
        ['--accent' as string]: theme.accent,
        ['--accent2' as string]: theme.accent2,
        ['--metal' as string]: theme.metal,
      }}
    >
      <header className="kit-brand">
        <b>{theme.mark}</b>
        <strong>{theme.badge}</strong>
        <em>{theme.family}</em>
      </header>
      {children}
    </section>
  )
}
