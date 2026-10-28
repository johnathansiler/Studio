import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { attachGlissando } from '../glissando'
import type { FaceTheme } from '../faces/themes'
import './kit.css'

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
  const start = useRef({ y: 0, value })
  const [drag, setDrag] = useState(false)
  const unitValue = clampUnit(value, min, max)
  const angle = -140 + unitValue * 280
  const shown = formatValue(value, unit)
  return (
    <div className={`kit-knob${drag ? ' dragging' : ''}`}>
      <button
        type="button"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={shown}
        style={{ ['--arc' as string]: String(unitValue) }}
        onDoubleClick={() => onChange(fallback)}
        onPointerDown={(event) => {
          start.current = { y: event.clientY, value }
          setDrag(true)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!drag && event.currentTarget.hasPointerCapture(event.pointerId) === false) return
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          onChange(valueFromDrag(start.current.value, event.clientY - start.current.y, min, max, event.shiftKey))
        }}
        onPointerUp={() => setDrag(false)}
        onPointerCancel={() => setDrag(false)}
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
      {(drag || true) && <small>{shown}</small>}
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
  const start = useRef({ y: 0, value })
  const [drag, setDrag] = useState(false)
  const unitValue = clampUnit(value, min, max)
  const shown = formatValue(value, unit)
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    onChange(valueFromDrag(start.current.value, event.clientY - start.current.y, min, max, event.shiftKey))
  }
  return (
    <div className={`kit-fader${drag ? ' dragging' : ''}`}>
      <button
        type="button"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={shown}
        onDoubleClick={() => onChange(fallback)}
        onPointerDown={(event) => {
          start.current = { y: event.clientY, value }
          setDrag(true)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={move}
        onPointerUp={() => setDrag(false)}
        onPointerCancel={() => setDrag(false)}
      >
        <span className="track"><i style={{ height: `${unitValue * 100}%` }} /><b style={{ bottom: `calc(${unitValue * 100}% - 7px)` }} /></span>
      </button>
      <em>{label}</em>
      <small>{shown}</small>
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
