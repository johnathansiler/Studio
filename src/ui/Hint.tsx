import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { bindSwipeDismiss } from './swipeDismiss'

interface HintState {
  text: string
  x: number
  y: number
}

const listeners = new Set<(hint: HintState | null) => void>()
let current: HintState | null = null

function publish(next: HintState | null) {
  current = next
  for (const listener of listeners) listener(next)
}

export function showHint(text: string, clientX: number, clientY: number) {
  const width = typeof window === 'undefined' ? 360 : window.innerWidth
  const height = typeof window === 'undefined' ? 640 : window.innerHeight
  const left = Math.min(width - 220, Math.max(8, clientX - 16))
  const top = clientY > 72 ? Math.max(8, clientY - 52) : Math.min(height - 48, clientY + 28)
  publish({ text, x: left, y: top })
}

export function hideHint() {
  publish(null)
}

function subscribe(listener: (hint: HintState | null) => void) {
  listeners.add(listener)
  listener(current)
  return () => {
    listeners.delete(listener)
  }
}

/** Floating description after a long-press. Hover uses the button title. */
export function HintBubble() {
  const [hint, setHint] = useState<HintState | null>(null)
  useEffect(() => subscribe(setHint), [])
  useEffect(() => {
    if (!hint) return
    const timer = window.setTimeout(hideHint, 2400)
    const hide = (event: PointerEvent) => {
      if (bubble.current?.contains(event.target as Node)) return
      hideHint()
    }
    window.addEventListener('pointerdown', hide)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', hide)
    }
  }, [hint])
  const bubble = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bubble.current
    if (!hint || !el) return
    return bindSwipeDismiss(el, hideHint)
  }, [hint])
  if (!hint) return null
  return (
    <div ref={bubble} className="hint-bubble" role="tooltip" style={{ left: hint.x, top: hint.y }}>
      {hint.text}
    </div>
  )
}

export function TipButton({
  label,
  hint,
  className,
  pressed,
  disabled,
  id,
  onClick,
  onPress,
  onRelease,
  style,
  children,
}: {
  label: string
  hint: string
  className?: string
  pressed?: boolean
  disabled?: boolean
  id?: string
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  onPress?: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onRelease?: () => void
  style?: CSSProperties
  children?: ReactNode
}) {
  const block = useRef(false)
  const timer = useRef(0)
  const origin = useRef({ x: 0, y: 0 })
  const arm = (event: ReactPointerEvent) => {
    origin.current = { x: event.clientX, y: event.clientY }
    block.current = false
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      block.current = true
      showHint(hint, origin.current.x, origin.current.y)
    }, 520)
  }
  const move = (event: ReactPointerEvent) => {
    if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 12) {
      window.clearTimeout(timer.current)
    }
  }
  const end = () => window.clearTimeout(timer.current)
  return (
    <button
      type="button"
      id={id}
      className={className}
      disabled={disabled}
      title={hint}
      aria-label={`${label}. ${hint}`}
      aria-pressed={pressed}
      style={style}
      onPointerDown={(event) => {
        arm(event)
        onPress?.(event)
      }}
      onPointerMove={move}
      onPointerUp={() => {
        end()
        onRelease?.()
      }}
      onPointerCancel={() => {
        end()
        onRelease?.()
      }}
      onClick={(event) => {
        if (block.current) {
          block.current = false
          event.preventDefault()
          event.stopPropagation()
          return
        }
        onClick?.(event)
      }}
    >
      {children ?? label}
    </button>
  )
}

export function SheetRow({
  label,
  hint,
  pressed,
  disabled,
  onClick,
}: {
  label: string
  hint: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`sheet-row ch-row ${pressed ? 'on' : ''}`} disabled={disabled} aria-pressed={pressed} onClick={onClick}>
      <span>{label}</span>
      <small>{hint}</small>
    </button>
  )
}

function MenuCheck() {
  return (
    <svg className="menu-check" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3.5 8.2 6.6 11.3 12.6 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function MenuRow({
  label,
  hint,
  pressed,
  disabled,
  className,
  id,
  action,
  trailing,
  onClick,
}: {
  label: string
  hint: string
  pressed?: boolean
  disabled?: boolean
  className?: string
  id?: string
  action?: string
  trailing?: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      id={id}
      className={['menu-row', className].filter(Boolean).join(' ')}
      disabled={disabled}
      title={hint}
      aria-label={`${label}. ${hint}`}
      aria-pressed={pressed}
      data-menu-action={action}
      onClick={onClick}
    >
      <span className="menu-copy">
        <span className="menu-label">{label}</span>
        {hint ? <small>{hint}</small> : null}
      </span>
      {pressed || trailing ? (
        <span className="menu-aside">
          {pressed ? <MenuCheck /> : null}
          {trailing}
        </span>
      ) : null}
    </button>
  )
}
