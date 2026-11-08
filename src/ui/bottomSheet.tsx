import type { PointerEvent as ReactPointerEvent } from 'react'

/** Drag the pill to change the sheet height. The list under it keeps its own scroll. */
export function SheetGrab({ label }: { label: string }) {
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.pointerType !== 'touch') return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    const sheet = handle.closest('.bottom-sheet') as HTMLElement | null
    if (!sheet) return
    try { handle.setPointerCapture(event.pointerId) } catch { /* The pointer can already be gone. */ }
    const parent = sheet.parentElement
    const limit = parent?.clientHeight || window.innerHeight
    const bar = document.querySelector('.tool-slot')
    const barH = bar instanceof HTMLElement ? bar.getBoundingClientRect().height : 0
    const visible = Math.max(160, Math.min(limit, window.innerHeight - Math.max(0, barH)))
    const startY = event.clientY
    const startH = sheet.getBoundingClientRect().height
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return
      const next = startH + (startY - ev.clientY)
      const max = Math.max(160, visible - 48)
      const min = Math.min(168, max)
      const height = Math.round(Math.min(max, Math.max(min, next)))
      sheet.style.setProperty('--sheet-h', `${height}px`)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  return (
    <div
      className="bottom-sheet-grab"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
    />
  )
}
