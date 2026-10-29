/**
 * Pointer gestures for knobs, faders, and pads.
 * A finger that starts on a control must change the value. The plugin sheet
 * keeps scrolling only when the drag starts outside a control.
 */

export const DRAG_PX = 90
export const FINE_PX = 220

export interface GestureChange {
  value: number
  x: number
  y: number
  clientX: number
  clientY: number
  fine: boolean
}

export interface GestureReadout {
  x: number
  y: number
  text: string
}

export interface ControlGesture {
  min: number
  max: number
  getValue: () => number
  fallback: number
  axis: 'x' | 'y' | 'pad'
  format?: (value: number) => string
  onChange: (change: GestureChange) => void
  onStart?: () => void
  onCommit?: () => void
  onReadout?: (readout: GestureReadout | null) => void
}

export interface PointerLike {
  pointerId?: number
  clientX: number
  clientY: number
  shiftKey?: boolean
  cancelable?: boolean
  preventDefault?: () => void
}

export interface GestureElement {
  style: { touchAction?: string }
  addEventListener(type: string, fn: (event: PointerLike) => void, opts?: { passive?: boolean; capture?: boolean }): void
  removeEventListener(type: string, fn: (event: PointerLike) => void): void
  setPointerCapture?(id: number): void
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number }
}

/** Upward or rightward movement raises the value. `fine` stretches the same travel. */
export function dragValue(start: number, delta: number, min: number, max: number, fine: boolean) {
  const span = max - min || 1
  const next = start + (delta / (fine ? FINE_PX : DRAG_PX)) * span
  return clamp(next, min, max)
}

export function attachControlGesture(el: GestureElement, get: () => ControlGesture) {
  el.style.touchAction = 'none'
  let drag: { id: number; x: number; y: number; value: number; moved: boolean } | null = null
  let lastDown = 0
  let lastMoved = true
  let lastClient = { x: 0, y: 0 }
  let lastValue = 0
  const pointers = new Set<number>()

  const specOf = () => get()
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const fineNow = (shift?: boolean) => !!shift || pointers.size > 1

  const emit = (event: PointerLike, value: number, x: number, y: number, fine: boolean) => {
    const spec = specOf()
    lastValue = value
    lastClient = { x: event.clientX, y: event.clientY }
    spec.onChange({ value, x, y, clientX: event.clientX, clientY: event.clientY, fine })
    const text = spec.format ? spec.format(spec.axis === 'pad' ? x : value) : formatReadout(spec.axis === 'pad' ? x : value)
    spec.onReadout?.({ x: event.clientX, y: event.clientY - 28, text: spec.axis === 'pad' ? `${Math.round(x * 100)} ${Math.round(y * 100)}` : text })
  }

  const reset = (event: PointerLike) => {
    const spec = specOf()
    spec.onStart?.()
    if (spec.axis === 'pad') emit(event, 0.5, 0.5, 0.5, false)
    else emit(event, spec.fallback, event.clientX, event.clientY, false)
    spec.onReadout?.(null)
    spec.onCommit?.()
    drag = null
    lastMoved = true
  }

  const onTouchStart = (event: PointerLike) => {
    if (event.cancelable !== false) event.preventDefault?.()
  }

  const onDown = (event: PointerLike) => {
    if (event.cancelable !== false) event.preventDefault?.()
    const id = event.pointerId ?? 1
    pointers.add(id)
    const stamp = now()
    const quick = !lastMoved && stamp - lastDown < 340
    lastDown = stamp
    if (quick && pointers.size < 2) {
      reset(event)
      return
    }
    const spec = specOf()
    spec.onStart?.()
    try { el.setPointerCapture?.(id) } catch { /* the pointer already ended */ }
    drag = { id, x: event.clientX, y: event.clientY, value: spec.getValue(), moved: false }
    lastMoved = false
    lastValue = spec.getValue()
    if (spec.axis === 'pad') move(event)
  }

  const move = (event: PointerLike) => {
    if (!drag || (event.pointerId ?? 1) !== drag.id) return
    if (event.cancelable !== false) event.preventDefault?.()
    const spec = specOf()
    const travel = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
    if (travel > 5) {
      drag.moved = true
      lastMoved = true
    }
    const fine = fineNow(event.shiftKey)
    if (spec.axis === 'pad') {
      const box = el.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 }
      const x = clamp((event.clientX - box.left) / (box.width || 1), 0, 1)
      const y = clamp((event.clientY - box.top) / (box.height || 1), 0, 1)
      emit(event, x, x, y, fine)
      return
    }
    const delta = spec.axis === 'x' ? event.clientX - drag.x : drag.y - event.clientY
    emit(event, dragValue(drag.value, delta, spec.min, spec.max, fine), event.clientX, event.clientY, fine)
  }

  const rebase = (event: PointerLike) => {
    if (!drag) return
    pointers.add(event.pointerId ?? 1)
    drag.x = lastClient.x || event.clientX
    drag.y = lastClient.y || event.clientY
    drag.value = lastValue
  }

  const end = (event: PointerLike) => {
    pointers.delete(event.pointerId ?? 1)
    if (!drag || (event.pointerId ?? 1) !== drag.id) return
    if (!drag.moved) lastMoved = false
    drag = null
    specOf().onReadout?.(null)
    specOf().onCommit?.()
  }

  const onWheel = (event: PointerLike & { deltaY?: number }) => {
    if (event.cancelable !== false) event.preventDefault?.()
    const spec = specOf()
    if (spec.axis === 'pad') return
    const span = spec.max - spec.min || 1
    const step = (event.shiftKey ? span / 200 : span / 40) * ((event.deltaY ?? 0) < 0 ? 1 : -1)
    spec.onStart?.()
    const next = clamp(spec.getValue() + step, spec.min, spec.max)
    emit(event, next, event.clientX, event.clientY, !!event.shiftKey)
    spec.onReadout?.(null)
    spec.onCommit?.()
  }

  const onWindowDown = (event: PointerLike) => {
    if (!drag) return
    rebase(event)
  }
  const onWindowUp = (event: PointerLike) => {
    pointers.delete(event.pointerId ?? 1)
  }

  el.addEventListener('touchstart', onTouchStart, { passive: false })
  el.addEventListener('pointerdown', onDown, { passive: false })
  el.addEventListener('pointermove', move, { passive: false })
  el.addEventListener('pointerup', end, { passive: false })
  el.addEventListener('pointercancel', end, { passive: false })
  el.addEventListener('wheel', onWheel, { passive: false })
  const host = typeof window !== 'undefined' ? window : null
  host?.addEventListener('pointerdown', onWindowDown as unknown as EventListener)
  host?.addEventListener('pointerup', onWindowUp as unknown as EventListener)
  host?.addEventListener('pointercancel', onWindowUp as unknown as EventListener)

  return () => {
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', end)
    el.removeEventListener('pointercancel', end)
    el.removeEventListener('wheel', onWheel)
    host?.removeEventListener('pointerdown', onWindowDown as unknown as EventListener)
    host?.removeEventListener('pointerup', onWindowUp as unknown as EventListener)
    host?.removeEventListener('pointercancel', onWindowUp as unknown as EventListener)
  }
}

const CONTROL = '.kit-knob button, .kit-fader button, .knob button, .tune-knob, .rack-knob, .touch-slider, .xy-pad, .kit-eq, input[type="range"]'

/** Stop the page from scrolling when a press starts on a control, and drive native sliders ourselves. */
export function installControlGuards(doc: Document) {
  let drag: { id: number; x: number; y: number; value: number; vertical: boolean; el: HTMLInputElement } | null = null
  const pointers = new Set<number>()
  let lastDown = 0
  let lastMoved = true
  let tip: HTMLElement | null = null

  const show = (x: number, y: number, text: string) => {
    if (!tip) {
      tip = doc.createElement('span')
      tip.className = 'gesture-readout'
      doc.body.appendChild(tip)
    }
    tip.textContent = text
    tip.style.left = `${x}px`
    tip.style.top = `${y - 28}px`
  }
  const hide = () => {
    tip?.remove()
    tip = null
  }
  const rangeOf = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null
    const found = target.closest('input[type="range"]')
    return found instanceof HTMLInputElement ? found : null
  }
  const blocked = (target: EventTarget | null) => target instanceof Element && !!target.closest(CONTROL)

  const onTouch = (event: TouchEvent) => {
    if (!blocked(event.target) || !event.cancelable) return
    event.preventDefault()
  }
  const onDown = (event: PointerEvent) => {
    const range = rangeOf(event.target)
    if (!range && !blocked(event.target)) return
    if (event.cancelable) event.preventDefault()
    pointers.add(event.pointerId)
    if (!range) return
    const stamp = performance.now()
    const quick = !lastMoved && stamp - lastDown < 340
    lastDown = stamp
    if (quick) {
      const fallback = Number(range.dataset.fallback)
      if (Number.isFinite(fallback)) writeRange(range, fallback)
      lastMoved = true
      hide()
      return
    }
    const box = range.getBoundingClientRect()
    const vertical = verticalRange(range, box)
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, value: Number(range.value), vertical, el: range }
    lastMoved = false
    try { range.setPointerCapture(event.pointerId) } catch { /* already gone */ }
  }
  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return
    if (event.cancelable) event.preventDefault()
    const travel = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
    if (travel > 5) lastMoved = true
    const delta = drag.vertical ? drag.y - event.clientY : event.clientX - drag.x
    const next = dragValue(drag.value, delta, Number(drag.el.min), Number(drag.el.max), event.shiftKey || pointers.size > 1)
    writeRange(drag.el, next)
    show(event.clientX, event.clientY, drag.el.value)
  }
  const onUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId)
    if (!drag || event.pointerId !== drag.id) return
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) lastMoved = false
    drag = null
    hide()
  }
  const onWheel = (event: WheelEvent) => {
    const range = rangeOf(event.target)
    if (!range) return
    event.preventDefault()
    const span = Number(range.max) - Number(range.min) || 1
    const stepAttr = Number(range.step)
    const step = (Number.isFinite(stepAttr) && stepAttr > 0 ? stepAttr : span / 40) * (event.shiftKey ? 1 : 1) * (event.deltaY < 0 ? 1 : -1)
    writeRange(range, Number(range.value) + (event.shiftKey ? step * 0.25 : step))
  }

  doc.addEventListener('touchstart', onTouch, { capture: true, passive: false })
  doc.addEventListener('pointerdown', onDown, { capture: true, passive: false })
  doc.addEventListener('pointermove', onMove, { capture: true, passive: false })
  doc.addEventListener('pointerup', onUp, { capture: true })
  doc.addEventListener('pointercancel', onUp, { capture: true })
  doc.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => {
    doc.removeEventListener('touchstart', onTouch, true)
    doc.removeEventListener('pointerdown', onDown, true)
    doc.removeEventListener('pointermove', onMove, true)
    doc.removeEventListener('pointerup', onUp, true)
    doc.removeEventListener('pointercancel', onUp, true)
    doc.removeEventListener('wheel', onWheel, true)
    hide()
  }
}

function verticalRange(el: HTMLElement, box: DOMRect) {
  const mode = getComputedStyle(el).writingMode || ''
  if (mode.startsWith('vertical')) return true
  return box.height > box.width + 8
}

function writeRange(el: HTMLInputElement, value: number) {
  const min = Number(el.min)
  const max = Number(el.max)
  const step = Number(el.step)
  let next = clamp(value, min, max)
  if (Number.isFinite(step) && step > 0) next = clamp(min + Math.round((next - min) / step) * step, min, max)
  const text = String(next)
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  proto?.set?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function formatReadout(value: number) {
  return Math.abs(value) >= 100 ? Math.round(value).toString() : (Math.round(value * 100) / 100).toString()
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
