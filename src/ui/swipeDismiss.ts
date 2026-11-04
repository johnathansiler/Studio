/** A sideways flick dismisses a toast. A vertical move is a scroll, not a dismiss. */

export function swipeShouldDismiss(dx: number, dy: number, distance = 48) {
  return Math.abs(dx) >= distance && Math.abs(dx) > Math.abs(dy)
}

export function bindSwipeDismiss(el: HTMLElement, onDismiss: () => void) {
  let pointer = -1
  let startX = 0
  let startY = 0
  let active = false
  const finish = (dx: number, dy: number) => {
    active = false
    if (swipeShouldDismiss(dx, dy)) {
      onDismiss()
      return
    }
    el.style.transform = ''
    el.style.opacity = ''
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType !== 'touch') return
    pointer = event.pointerId
    startX = event.clientX
    startY = event.clientY
    active = true
    el.setPointerCapture?.(event.pointerId)
  }
  const move = (event: PointerEvent) => {
    if (!active || event.pointerId !== pointer) return
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (Math.abs(dx) <= Math.abs(dy)) return
    event.preventDefault()
    el.style.transform = `translateX(${dx}px)`
    el.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / 180))
  }
  const up = (event: PointerEvent) => {
    if (!active || event.pointerId !== pointer) return
    finish(event.clientX - startX, event.clientY - startY)
  }
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  return () => {
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
  }
}
