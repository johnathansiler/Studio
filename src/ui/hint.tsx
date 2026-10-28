import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

type HintProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  hint: string
  shortcut?: string
  children: ReactNode
}

/** Desktop gets a native tooltip. A long-press on touch shows the same short description and does not activate the control. */
export function HintButton({ label, hint, shortcut, children, title, onClick, onPointerDown, onPointerUp, onPointerLeave, onPointerCancel, ...rest }: HintProps) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef(0)
  const suppress = useRef(false)
  const text = shortcut ? `${label} (${shortcut}) — ${hint}` : `${label} — ${hint}`

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <>
      <button
        {...rest}
        title={title ?? text}
        aria-label={rest['aria-label'] ?? `${label}. ${hint}`}
        onPointerDown={(event) => {
          suppress.current = false
          window.clearTimeout(timer.current)
          const point = { x: event.clientX, y: event.clientY }
          timer.current = window.setTimeout(() => {
            suppress.current = true
            setTip(point)
          }, 450)
          onPointerDown?.(event)
        }}
        onPointerUp={(event) => {
          window.clearTimeout(timer.current)
          if (suppress.current) window.setTimeout(() => setTip(null), 1400)
          onPointerUp?.(event)
        }}
        onPointerLeave={(event) => {
          window.clearTimeout(timer.current)
          onPointerLeave?.(event)
        }}
        onPointerCancel={(event) => {
          window.clearTimeout(timer.current)
          suppress.current = false
          setTip(null)
          onPointerCancel?.(event)
        }}
        onClick={(event) => {
          if (suppress.current) {
            suppress.current = false
            event.preventDefault()
            event.stopPropagation()
            return
          }
          onClick?.(event)
        }}
      >
        {children}
      </button>
      {tip && (
        <div
          className="hint-pop"
          role="tooltip"
          style={{ left: Math.max(8, Math.min(tip.x - 12, window.innerWidth - 200)), top: Math.max(8, tip.y - 58) }}
        >
          <b>{label}</b>
          <span>{hint}</span>
        </div>
      )}
    </>
  )
}

export function MoreItem({
  label,
  hint,
  onClick,
  pressed,
}: {
  label: string
  hint: string
  onClick: () => void
  pressed?: boolean
}) {
  return (
    <button type="button" role="menuitem" className={pressed ? 'on' : ''} aria-pressed={pressed} onClick={onClick}>
      <b>{label}</b>
      <i>{hint}</i>
    </button>
  )
}

/** Less-used controls. The trigger stays visible; the list closes after a choice. */
export function MoreMenu({
  label,
  hint,
  trigger,
  active,
  children,
}: {
  label: string
  hint: string
  trigger: string
  active?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={`overflow ${open ? 'open' : ''}`} ref={root}>
      <HintButton
        type="button"
        className={`more ${active ? 'on' : ''} ${open ? 'open' : ''}`}
        label={label}
        hint={hint}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-pressed={active || undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </HintButton>
      {open && (
        <div
          className="overflow-menu"
          role="menu"
          aria-label={label}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('[role="menuitem"]')) setOpen(false)
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
