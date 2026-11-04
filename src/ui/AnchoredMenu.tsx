import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { placeAnchoredMenu, anchoredShouldClose, type AnchorBox } from './anchorPlace'
import { useScreenOverlay } from './screenOverlay'
import './anchoredMenu.css'
import './screenOverlay.css'

export function AnchoredMenu({
  open,
  onClose,
  label,
  triggerRef,
  trigger,
  anchor,
  prefer = 'auto',
  id,
  className,
  fill = false,
  children,
}: {
  open: boolean
  onClose: () => void
  label: string
  triggerRef?: RefObject<HTMLElement | null>
  /** Live element when a ref is awkward, such as one button in a list. */
  trigger?: HTMLElement | null
  anchor?: AnchorBox | null
  prefer?: 'down' | 'up' | 'auto'
  id?: string
  className?: string
  /** Full-screen sheet under the view tabs. Small selects leave this off. */
  fill?: boolean
  children: ReactNode
}) {
  useScreenOverlay(onClose, open && fill)
  const menuRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<{ top: number; left: number; maxHeight: number; maxWidth: number; side: 'down' | 'up' } | null>(null)

  useLayoutEffect(() => {
    if (!open || fill) {
      setStyle(null)
      return
    }
    const place = () => {
      const node = menuRef.current
      const live = trigger ?? triggerRef?.current ?? null
      const box = anchor ?? (live ? live.getBoundingClientRect() : null)
      if (!node || !box) return
      const clearTop = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--view-tabs-bottom')) || 0
      const next = placeAnchoredMenu({
        trigger: { left: box.left, top: box.top, width: box.width, height: box.height },
        menu: { width: node.offsetWidth || node.scrollWidth, height: node.scrollHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        prefer,
        clearTop,
      })
      setStyle(next)
      live?.classList.add('anchored-trigger')
      live?.setAttribute('data-anchor-side', next.side)
    }
    place()
    const observer = new ResizeObserver(place)
    if (menuRef.current) observer.observe(menuRef.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      const live = trigger ?? triggerRef?.current ?? null
      live?.classList.remove('anchored-trigger')
      live?.removeAttribute('data-anchor-side')
    }
  }, [open, anchor, prefer, trigger, triggerRef, fill])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (fill) return
      const live = trigger ?? triggerRef?.current ?? null
      if (anchoredShouldClose(event.target as Node | null, live, menuRef.current)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, trigger, triggerRef, fill])

  if (fill && open) {
    const sheet = (
      <div
        id={id}
        className={['anchored-menu', 'screen-overlay', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-label={label}
        data-screen-overlay=""
        data-open="true"
      >
        <button type="button" className="overlay-close" onClick={onClose}>Close</button>
        {children}
      </div>
    )
    if (typeof document === 'undefined') return sheet
    return createPortal(sheet, document.body)
  }

  const panel = (
    <div
      ref={menuRef}
      id={id}
      className={['anchored-menu', className].filter(Boolean).join(' ')}
      role="menu"
      aria-label={label}
      data-side={style?.side ?? (prefer === 'up' ? 'up' : 'down')}
      data-open={open ? 'true' : 'false'}
      hidden={!open}
      style={style ? {
        top: style.top,
        left: style.left,
        maxHeight: style.maxHeight,
        maxWidth: style.maxWidth,
      } : undefined}
    >
      {children}
    </div>
  )
  if (!open && typeof document !== 'undefined') return null
  if (typeof document === 'undefined') return panel
  return createPortal(panel, document.body)
}
