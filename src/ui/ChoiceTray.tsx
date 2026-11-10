import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ButtonTray } from './ButtonTray'
import { trayColumns } from './choiceTray'

/** Select and Snap share this recessed tray. It hugs its chips and sits in the arrange column. */
export function ChoiceTray({
  id,
  label,
  title,
  value,
  onClose,
  children,
}: {
  id: string
  label: string
  title: string
  value: string
  onClose: () => void
  children: ReactNode
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const count = Children.toArray(children).filter(Boolean).length
  const [cols, setCols] = useState(() => trayColumns(count, 360))
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useLayoutEffect(() => {
    const body = bodyRef.current
    const well = body?.querySelector<HTMLElement>('.choice-tray-well') ?? null
    if (!body || !well) return
    const measure = () => {
      const style = getComputedStyle(body)
      const pad = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
      const width = Math.max(0, body.clientWidth - pad)
      let next = trayColumns(count, width)
      well.style.setProperty('--tray-cols', String(next))
      let guard = 0
      while (next > 1 && well.scrollWidth > width + 1 && guard < count) {
        next -= 1
        well.style.setProperty('--tray-cols', String(next))
        guard += 1
      }
      setCols((prev) => (prev === next ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [count])
  return (
    <section
      id={id}
      className="bottom-sheet arrange-sheet choice-tray"
      data-bottom-sheet="open"
      data-arrange-sheet={id}
      data-choice-tray="open"
      role="dialog"
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <header className="choice-tray-head">
        <div className="choice-tray-title">
          <strong>{title}</strong>
          <span className="choice-tray-value">{value}</span>
        </div>
        <button type="button" className="guide-x overlay-close choice-tray-close" aria-label="Close" title="Close" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3L3 11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div ref={bodyRef} className="bottom-sheet-body choice-tray-body">
        <ButtonTray
          className="choice-tray-well"
          role="listbox"
          aria-label={label}
          data-tray-cols={cols}
          style={{ ['--tray-cols' as string]: String(cols) }}
        >
          {children}
        </ButtonTray>
      </div>
    </section>
  )
}

/** Quiet beveled chip. The button is the 40px hit; the face inside can be shorter. */
export function ChoiceChip({
  label,
  name,
  hint,
  pressed = false,
  onClick,
}: {
  label: string
  /** Accessible name when it should differ from the visible chip. */
  name?: string
  hint?: string
  pressed?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`choice-chip${pressed ? ' on' : ''}`}
      aria-pressed={pressed}
      title={hint}
      aria-label={name}
      onClick={onClick}
    >
      <span className="choice-chip-face">{label}</span>
    </button>
  )
}
