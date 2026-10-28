import { glideUpdate, pointerAction } from '../model/glissando'

export function attachGlissando(root: HTMLElement, opts: {
  accept: (key: HTMLElement) => boolean
  onOn: (pitch: number, event: PointerEvent, pointerId: number, fine?: number) => void
  onOff: (pitch: number, event: PointerEvent, pointerId: number) => void
  onMove?: (pitch: number, event: PointerEvent, pointerId: number, element: HTMLElement) => void
  onTwoFinger?: (deltaY: number) => void
}) {
  const held = new Map<number, number>()
  const lit = new Map<number, HTMLElement>()
  const points = new Map<number, { y: number; key: boolean }>()
  let scrolling = false
  let lastY = 0

  const keyAt = (event: PointerEvent) => {
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    const key = hit?.closest?.('[data-pitch]') as HTMLElement | null
    if (!key || !root.contains(key) || !opts.accept(key)) return null
    const pitch = Number(key.dataset.pitch)
    if (!Number.isFinite(pitch)) return null
    return { key, pitch }
  }

  const apply = (pointerId: number, event: PointerEvent, phase: 'down' | 'move' | 'up', found: { key: HTMLElement; pitch: number } | null) => {
    const step = glideUpdate(held, pointerId, phase === 'up' ? null : found?.pitch ?? null, phase)
    held.clear()
    for (const [id, pitch] of step.held) held.set(id, pitch)
    if (!step.change) {
      if (phase === 'move' && found && held.get(pointerId) === found.pitch) opts.onMove?.(found.pitch, event, pointerId, found.key)
      return
    }
    if (step.change.off != null) {
      lit.get(pointerId)?.classList.remove('lit')
      lit.delete(pointerId)
      opts.onOff(step.change.off, event, pointerId)
    }
    if (step.change.on != null && found) {
      found.key.classList.add('lit')
      lit.set(pointerId, found.key)
      const raw = found.key.dataset.fine
      const fine = raw == null || raw === '' ? undefined : Number(raw)
      opts.onOn(step.change.on, event, pointerId, Number.isFinite(fine) ? fine : undefined)
    }
  }

  const down = (event: PointerEvent) => {
    if (!root.contains(event.target as Node)) return
    if ((event.target as HTMLElement).closest?.('[data-scroll]')) return
    const found = keyAt(event)
    const onControl = !!(event.target as HTMLElement).closest?.('[data-pitch], [data-sample]')
    points.set(event.pointerId, { y: event.clientY, key: !!found })
    const action = pointerAction(!!found, onControl, points.size, held.size)
    if (action === 'scroll') {
      scrolling = true
      lastY = centroid()
      return
    }
    if (action !== 'play' || !found) return
    event.preventDefault()
    try { root.setPointerCapture(event.pointerId) } catch { /* the pointer is already gone */ }
    apply(event.pointerId, event, 'down', found)
  }

  const move = (event: PointerEvent) => {
    const point = points.get(event.pointerId)
    if (!point) return
    point.y = event.clientY
    if (scrolling && !held.has(event.pointerId)) {
      const y = centroid()
      opts.onTwoFinger?.(y - lastY)
      lastY = y
      event.preventDefault()
      return
    }
    if (!held.has(event.pointerId)) return
    event.preventDefault()
    apply(event.pointerId, event, 'move', keyAt(event))
  }

  const up = (event: PointerEvent) => {
    if (!points.has(event.pointerId)) return
    points.delete(event.pointerId)
    if (points.size < 2) scrolling = false
    if (!held.has(event.pointerId)) return
    apply(event.pointerId, event, 'up', null)
  }

  const menu = (event: Event) => {
    const key = (event.target as HTMLElement).closest?.('[data-pitch]') as HTMLElement | null
    if (key && root.contains(key) && opts.accept(key)) event.preventDefault()
  }

  function centroid() {
    let sum = 0
    for (const point of points.values()) sum += point.y
    return points.size ? sum / points.size : lastY
  }

  root.addEventListener('pointerdown', down, { passive: false })
  window.addEventListener('pointermove', move, { passive: false })
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  root.addEventListener('contextmenu', menu)
  return () => {
    root.removeEventListener('pointerdown', down)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    root.removeEventListener('contextmenu', menu)
    for (const id of [...held.keys()]) {
      const pitch = held.get(id)
      if (pitch == null) continue
      lit.get(id)?.classList.remove('lit')
      opts.onOff(pitch, new PointerEvent('pointerup'), id)
    }
    held.clear()
    lit.clear()
  }
}
