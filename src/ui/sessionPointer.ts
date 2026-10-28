import type { PointerEvent as ReactPointerEvent } from 'react'
import { targetFromAttrs, type SessionDrag, type SessionTarget } from '../model/sessionInteract'

export function sessionTargetAt(x: number, y: number): SessionTarget | null {
  const el = document.elementFromPoint(x, y)
  if (!(el instanceof Element)) return null
  const slot = el.closest('[data-session-slot]')
  if (slot) {
    return targetFromAttrs({
      slotTrack: slot.getAttribute('data-session-slot'),
      slotScene: slot.getAttribute('data-scene'),
      trackType: slot.getAttribute('data-track-type'),
    })
  }
  const head = el.closest('[data-session-head]')
  if (head) {
    return targetFromAttrs({
      headTrack: head.getAttribute('data-session-head'),
      trackType: head.getAttribute('data-track-type'),
    })
  }
  return null
}

/** Mouse and touch drag. A vertical touch keeps scrolling the list. */
export function beginSessionDrag(
  event: ReactPointerEvent,
  drag: SessionDrag,
  label: string,
  onDrop: (drag: SessionDrag, point: { x: number; y: number }) => void,
) {
  if (!event.isPrimary || event.button !== 0) return
  const startX = event.clientX
  const startY = event.clientY
  const pointerId = event.pointerId
  const pointerType = event.pointerType
  let dragging = false
  let ghost: HTMLDivElement | null = null
  const finish = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    ghost?.remove()
  }
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    if (!dragging) {
      if (Math.hypot(dx, dy) < 8) return
      if (pointerType === 'touch' && Math.abs(dy) > Math.abs(dx) + 4) {
        finish()
        return
      }
      dragging = true
      ghost = document.createElement('div')
      ghost.className = 'sl-drag-ghost'
      ghost.textContent = label
      document.body.appendChild(ghost)
    }
    if (!ghost) return
    ghost.style.left = `${ev.clientX + 14}px`
    ghost.style.top = `${ev.clientY + 14}px`
  }
  const up = (ev: PointerEvent) => {
    const did = dragging
    finish()
    if (!did || ev.pointerId !== pointerId) return
    onDrop(drag, { x: ev.clientX, y: ev.clientY })
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}
