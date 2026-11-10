import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { placeAnchoredMenu, anchoredShouldClose, menuFillsViewport, type AnchorBox } from './anchorPlace'
import { syncPhoneSheetFrame } from './overlayHost'
import { SheetClose } from './SheetClose'
import { useScreenOverlay } from './screenOverlay'
import './anchoredMenu.css'
import './screenOverlay.css'

type MenuSize = 'dock' | 'fill' | 'sheet' | 'pending'

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
  sheet = false,
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
  /** Eligible to fill the screen. A short menu still docks under its button. */
  fill?: boolean
  /** Phone project menu: a bottom sheet above the bar, as tall as the browser sheet. */
  sheet?: boolean
  children: ReactNode
}) {
  useScreenOverlay(onClose, open)
  const menuRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<MenuSize>(open && sheet ? 'sheet' : open && fill ? 'pending' : 'dock')
  const [style, setStyle] = useState<{ top: number; left: number; maxHeight: number; maxWidth: number; side: 'down' | 'up' } | null>(null)
  const sizing = open && fill && !sheet
  const [tracked, setTracked] = useState(sizing)
  if (open && sheet && mode !== 'sheet') {
    setMode('sheet')
  } else if (!sheet && sizing !== tracked) {
    setTracked(sizing)
    setMode(sizing ? 'pending' : 'dock')
  }

  useLayoutEffect(() => {
    if (open && (mode === 'sheet' || sheet)) syncPhoneSheetFrame(document.querySelector('.shell'))
  }, [open, mode, sheet])

  useLayoutEffect(() => {
    if (!open || !fill || mode !== 'pending') return
    const node = menuRef.current
    if (!node) return
    const clearTop = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--view-tabs-bottom')) || 0
    const fills = menuFillsViewport(
      { width: node.scrollWidth, height: node.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
      clearTop,
    )
    const phone = !!document.querySelector('.shell.phone')
    setMode(fills ? (phone ? 'sheet' : 'fill') : 'dock')
  }, [open, fill, mode, children])

  const filling = open && (mode === 'fill' || mode === 'sheet')
  const measuring = open && fill && !sheet && mode === 'pending'

  useLayoutEffect(() => {
    if (!open || filling || measuring) {
      if (!open) setStyle(null)
      return
    }
    const place = () => {
      const node = menuRef.current
      const live = trigger ?? triggerRef?.current ?? null
      const box = anchor ?? (live ? live.getBoundingClientRect() : null)
      if (!node || !box) return
      const clearTop = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--view-tabs-bottom')) || 0
      const clearBottom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--phone-chrome-bottom')) || 0
      const next = placeAnchoredMenu({
        trigger: { left: box.left, top: box.top, width: box.width, height: box.height },
        menu: { width: node.offsetWidth || node.scrollWidth, height: node.scrollHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        prefer,
        clearTop,
        clearBottom,
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
  }, [open, anchor, prefer, trigger, triggerRef, filling, measuring])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (filling && mode !== 'sheet') return
      const live = trigger ?? triggerRef?.current ?? null
      if (anchoredShouldClose(event.target as Node | null, live, menuRef.current)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, trigger, triggerRef, filling, mode])

  if (!open && typeof document !== 'undefined') return null

  const showClose = Boolean(fill && open && !measuring)
  const phoneSheet = open && fill && mode === 'sheet'
  const menu = phoneSheet ? (
    <div
      ref={menuRef}
      id={id}
      className={['anchored-menu', 'screen-overlay', 'phone-sheet', className].filter(Boolean).join(' ')}
      role="dialog"
      aria-label={label}
      data-screen-overlay=""
      data-open={open ? 'true' : 'false'}
      data-menu-size="sheet"
    >
      <SheetClose onClick={onClose} />
      <div className="phone-sheet-body">{children}</div>
    </div>
  ) : filling ? (
    <div
      id={id}
      className={['anchored-menu', 'screen-overlay', className].filter(Boolean).join(' ')}
      role="dialog"
      aria-label={label}
      data-screen-overlay=""
      data-open={open ? 'true' : 'false'}
      hidden={!open}
      data-menu-size="fill"
    >
      <SheetClose onClick={onClose} />
      {children}
    </div>
  ) : (
    <div
      ref={menuRef}
      id={id}
      className={['anchored-menu', className].filter(Boolean).join(' ')}
      role="menu"
      aria-label={label}
      data-side={style?.side ?? (prefer === 'up' ? 'up' : 'down')}
      data-open={open ? 'true' : 'false'}
      hidden={!open}
      data-menu-size={measuring ? 'pending' : 'dock'}
      style={measuring || !style ? undefined : {
        top: style.top,
        left: style.left,
        maxHeight: style.maxHeight,
        maxWidth: style.maxWidth,
      }}
    >
      {showClose ? <SheetClose onClick={onClose} /> : null}
      {children}
    </div>
  )
  if (typeof document === 'undefined') return menu
  return createPortal(menu, document.body)
}
