import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import {
  COLUMN_BOUNDS,
  COLUMN_DEFAULT,
  STRIP_BOUNDS,
  STRIP_DEFAULT,
  STRIP_HALF,
  readLayout,
  widthFromDrag,
  widthFromKey,
  widthFromPinch,
  withColumn,
  withStrip,
  writeLayout,
  type LayoutWidths,
  type WidthBounds,
} from '../model/layoutWidth'

export function useLayoutWidths(projectId: string) {
  const [layout, setLayout] = useState<LayoutWidths>(() => readLayout(projectId))
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const setStrip = useCallback((strip: number) => {
    const next = withStrip(layoutRef.current, strip)
    layoutRef.current = next
    writeLayout(projectId, next)
    setLayout(next)
  }, [projectId])

  const setColumn = useCallback((column: number) => {
    const next = withColumn(layoutRef.current, column)
    layoutRef.current = next
    writeLayout(projectId, next)
    setLayout(next)
  }, [projectId])

  const resetStrip = useCallback(() => setStrip(STRIP_DEFAULT), [setStrip])
  const resetColumn = useCallback(() => setColumn(COLUMN_DEFAULT), [setColumn])

  return { layout, setStrip, setColumn, resetStrip, resetColumn }
}

export function usePinchResize(
  ref: RefObject<HTMLElement | null>,
  read: () => number,
  write: (next: number) => void,
  bounds: WidthBounds,
) {
  const readRef = useRef(read)
  const writeRef = useRef(write)
  readRef.current = read
  writeRef.current = write

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let startDist = 0
    let startWidth = 0
    let clearTimer = 0
    const distance = (touches: TouchList) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    )
    const mark = (on: boolean) => {
      if (on) el.dataset.pinching = '1'
      else delete el.dataset.pinching
    }
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return
      event.preventDefault()
      window.clearTimeout(clearTimer)
      mark(true)
      startDist = distance(event.touches)
      startWidth = readRef.current()
    }
    const onMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || startDist <= 0) return
      event.preventDefault()
      writeRef.current(widthFromPinch(startWidth, startDist, distance(event.touches), bounds))
    }
    const onEnd = (event: TouchEvent) => {
      if (event.touches.length >= 2) return
      startDist = 0
      window.clearTimeout(clearTimer)
      clearTimer = window.setTimeout(() => mark(false), 400)
    }
    el.addEventListener('touchstart', onStart, { passive: false, capture: true })
    el.addEventListener('touchmove', onMove, { passive: false, capture: true })
    el.addEventListener('touchend', onEnd, { capture: true })
    el.addEventListener('touchcancel', onEnd, { capture: true })
    return () => {
      window.clearTimeout(clearTimer)
      mark(false)
      el.removeEventListener('touchstart', onStart, true)
      el.removeEventListener('touchmove', onMove, true)
      el.removeEventListener('touchend', onEnd, true)
      el.removeEventListener('touchcancel', onEnd, true)
    }
  }, [bounds, ref])
}

export function pinchBlocked(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('[data-pinching="1"]')
}

const COPY = {
  strip: {
    label: 'Channel strip width',
    hint: 'Drag or pinch to resize channel strips',
    reset: 'Reset channel width',
  },
  column: {
    label: 'Clip column width',
    hint: 'Drag or pinch to resize clip columns',
    reset: 'Reset column width',
  },
} as const

export function WidthBar({
  axis,
  value,
  onChange,
  onReset,
}: {
  axis: 'strip' | 'column'
  value: number
  onChange: (next: number) => void
  onReset: () => void
}) {
  const copy = COPY[axis]
  const bounds = axis === 'strip' ? STRIP_BOUNDS : COLUMN_BOUNDS
  return (
    <div className="width-tools">
      <span className="width-label" id={`${axis}-width-label`}>Width</span>
      <WidthHandle
        labelledBy={`${axis}-width-label`}
        label={copy.label}
        hint={copy.hint}
        value={value}
        bounds={bounds}
        onChange={onChange}
      />
      <span className="width-value" aria-hidden>{value}</span>
      {axis === 'strip' && (
        <button
          type="button"
          className="width-reset"
          aria-pressed={value <= STRIP_HALF}
          aria-label={value <= STRIP_HALF ? 'Normal channel width' : 'Narrow channel width'}
          title={value <= STRIP_HALF ? 'Use the normal channel width.' : 'Make channels half as wide.'}
          onClick={() => onChange(value <= STRIP_HALF ? STRIP_DEFAULT : STRIP_HALF)}
        >
          {value <= STRIP_HALF ? 'Normal' : 'Narrow'}
        </button>
      )}
      <button type="button" className="width-reset" aria-label={copy.reset} title={copy.reset} onClick={onReset}>
        Reset
      </button>
    </div>
  )
}

export function ColumnGrip({
  value,
  onChange,
  labelled = true,
}: {
  value: number
  onChange: (next: number) => void
  labelled?: boolean
}) {
  return (
    <WidthHandle
      className="col-grip"
      label="Clip column width"
      hint="Drag to resize clip columns"
      value={value}
      bounds={COLUMN_BOUNDS}
      onChange={onChange}
      labelled={labelled}
    />
  )
}

function WidthHandle({
  label,
  hint,
  value,
  bounds,
  onChange,
  className = 'width-grip',
  labelledBy,
  labelled = true,
}: {
  label: string
  hint: string
  value: number
  bounds: WidthBounds
  onChange: (next: number) => void
  className?: string
  labelledBy?: string
  labelled?: boolean
}) {
  const dragged = useRef(false)
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragged.current = false
    const handle = event.currentTarget
    const origin = event.clientX
    const start = value
    handle.setPointerCapture(event.pointerId)
    const move = (ev: PointerEvent) => {
      const next = widthFromDrag(start, ev.clientX - origin, bounds)
      if (Math.abs(ev.clientX - origin) > 3) dragged.current = true
      onChange(next)
    }
    const up = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  return (
    <button
      type="button"
      className={className}
      role="slider"
      aria-hidden={labelled ? undefined : true}
      tabIndex={labelled ? 0 : -1}
      aria-labelledby={labelled ? labelledBy : undefined}
      aria-label={labelled && !labelledBy ? label : undefined}
      title={hint}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      aria-orientation="horizontal"
      onPointerDown={onPointerDown}
      onClick={(event) => {
        if (!dragged.current) return
        event.preventDefault()
        event.stopPropagation()
        dragged.current = false
      }}
      onKeyDown={(event) => {
        const next = widthFromKey(value, event.key, bounds, event.shiftKey ? 16 : 4)
        if (next == null) return
        event.preventDefault()
        onChange(next)
      }}
    >
      <span className="grip-icon" />
    </button>
  )
}
