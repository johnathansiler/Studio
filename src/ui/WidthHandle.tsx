import { useEffect, useRef, useState } from 'react'
import { formFactor, type FormFactor } from './form'
import {
  clearLayoutValue,
  defaultSlot,
  defaultStrip,
  displayWidth,
  nudgeWidth,
  readLayoutValue,
  resizeWidth,
  slotBounds,
  stripBounds,
  writeLayoutValue,
  type Bounds,
  type LayoutKind,
  type LayoutStorage,
} from './layoutWidths'

function browserStorage(): LayoutStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function useLayoutWidth(kind: LayoutKind) {
  const [form, setForm] = useState<FormFactor>(() => formFactor(window.innerWidth, window.innerHeight))
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [stored, setStored] = useState<number | null>(() => readLayoutValue(browserStorage(), kind))
  const boundsRef = useRef<Bounds>(kind === 'strip' ? stripBounds(form, viewport) : slotBounds(form, viewport))

  useEffect(() => {
    const onResize = () => {
      setForm(formFactor(window.innerWidth, window.innerHeight))
      setViewport(window.innerWidth)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const bounds = kind === 'strip' ? stripBounds(form, viewport) : slotBounds(form, viewport)
  boundsRef.current = bounds
  const fallback = kind === 'strip' ? defaultStrip(form) : defaultSlot(form)
  const value = displayWidth(stored, fallback, bounds)

  const setValue = (next: number) => {
    const clamped = displayWidth(next, fallback, boundsRef.current)
    setStored(clamped)
    writeLayoutValue(browserStorage(), kind, clamped)
  }

  const reset = () => {
    setStored(null)
    clearLayoutValue(browserStorage(), kind)
  }

  return { value, bounds, setValue, reset }
}

export function WidthHandle({
  label,
  value,
  min,
  max,
  onChange,
  onReset,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (next: number) => void
  onReset: () => void
}) {
  const drag = useRef<{ x: number; value: number } | null>(null)
  const bounds = { min, max }
  return (
    <div
      className="width-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* the move handler still follows the pointer */ }
        drag.current = { x: event.clientX, value }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start) return
        onChange(resizeWidth(start.value, event.clientX - start.x, bounds))
      }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
      onLostPointerCapture={() => { drag.current = null }}
      onDoubleClick={(event) => {
        event.preventDefault()
        onReset()
      }}
      onKeyDown={(event) => {
        const next = nudgeWidth(value, event.key, bounds, event.shiftKey)
        if (next == null) return
        event.preventDefault()
        onChange(next)
      }}
    />
  )
}
