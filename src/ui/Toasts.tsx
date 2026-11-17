import { useEffect, useRef } from 'react'
import type { ProjectStore } from '../state/store'
import { bindSwipeDismiss } from './swipeDismiss'

type Box = { left: number; top: number; right: number; bottom: number }

function intersects(a: Box, b: Box) {
  return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
}

function boxOf(node: Element): Box | null {
  const rect = node.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return null
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

/** Buttons a toast must not cover: track headers, pan, and the dock. */
function blockedZones(): Box[] {
  const selectors = [
    '.arrange .track-controls button',
    '.arrange .track-title',
    '.arrange .piano-open',
    '.arrange .beat-open',
    '.mixer-view .pan-knob',
    '.mixer-view .strip-name',
    '.mixer-view .touch-slider > b',
    '.mixer-view .strip button.mini',
    '.mixer-view .strip-foot button',
    '.phone-dock-slot',
    '.tool-slot',
    '.phone-tabs',
    '.views',
  ]
  const zones: Box[] = []
  for (const node of document.querySelectorAll(selectors.join(','))) {
    const box = boxOf(node)
    if (box) zones.push(box)
  }
  return zones
}

/** Park the stack in the timeline, clear of track-header buttons and the dock. */
export function parkToasts(el: HTMLElement) {
  const phone = !!document.querySelector('.shell.phone')
  const sample = el.querySelector('.toast')
  const width = Math.min(280, Math.max(140, sample?.getBoundingClientRect().width || 220))
  const height = Math.max(36, el.scrollHeight || sample?.getBoundingClientRect().height || 44)
  const heads = boxOf(document.querySelector('.arrange .heads') ?? document.createElement('div'))
  const viewW = window.innerWidth
  const viewH = window.innerHeight
  const zones = blockedZones()
  const spots: Box[] = []
  if (heads && heads.right < viewW - 96) {
    const left = heads.right + 8
    const right = viewW - 8
    spots.push({ left, top: Math.max(8, heads.top + 4), right, bottom: heads.top + 4 + height })
    spots.push({ left, top: Math.max(heads.top + 8, viewH * 0.42), right, bottom: 0 })
  }
  const centered = Math.max(8, (viewW - width) / 2)
  for (const frac of phone ? [0.28, 0.46, 0.58] : [0.22]) {
    const top = phone ? viewH * frac : 188
    spots.push({ left: centered, top, right: centered + width, bottom: 0 })
    spots.push({ left: Math.max(8, viewW - width - 12), top, right: viewW - 12, bottom: 0 })
  }

  for (const spot of spots) {
    const box: Box = {
      left: spot.left,
      top: spot.top,
      right: Math.min(spot.right, spot.left + width),
      bottom: spot.top + height,
    }
    if (box.right - box.left < 96 || box.bottom > viewH - 8) continue
    if (zones.some((zone) => intersects(box, zone))) continue
    el.style.left = `${Math.round(box.left)}px`
    el.style.top = `${Math.round(box.top)}px`
    el.style.right = 'auto'
    el.style.bottom = 'auto'
    el.style.width = `${Math.round(box.right - box.left)}px`
    el.style.maxWidth = `${Math.round(box.right - box.left)}px`
    el.style.transform = 'none'
    el.dataset.toastPark = 'clear'
    return
  }
  el.dataset.toastPark = 'fallback'
}

/** Floating messages. A sideways drag dismisses one. The stack does not take clicks. */
export function Toasts({ store }: { store: ProjectStore }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      if (store.toasts.length) parkToasts(el)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(document.documentElement)
    for (const node of document.querySelectorAll('.shell, .arrange .heads, .tool-slot, .phone-dock-slot, .workspace')) observer.observe(node)
    window.addEventListener('resize', place)
    const stop = store.subscribe(place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      stop()
    }
  }, [store, store.toasts.length])
  return (
    <div className="toasts" ref={ref} data-toast-park="timeline">
      {store.toasts.map((toast) => (
        <ToastLine key={toast.id} id={toast.id} text={toast.text} tone={toast.tone} store={store} />
      ))}
    </div>
  )
}

function ToastLine({ id, text, tone, store }: { id: string; text: string; tone?: string; store: ProjectStore }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return bindSwipeDismiss(el, () => store.dismissToast(id))
  }, [id, store])
  return (
    <div ref={ref} className={`toast ${tone || ''}`} role="status">
      {text}
    </div>
  )
}
