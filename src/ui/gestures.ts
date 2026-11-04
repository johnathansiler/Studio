/**
 * Pointer gestures for knobs, faders, and pads.
 * A finger that starts on a control must change the value. The plugin sheet
 * keeps scrolling only when the drag starts outside a control.
 * A double click, or a second tap within 300 ms that does not move, resets
 * the control through the same onChange path a drag uses.
 */

import { controlDefault } from './paramDefaults'

export const DRAG_PX = 90
export const FINE_PX = 220
/** A second press within this window, and without travel, resets the control. */
export const DOUBLE_TAP_MS = 300
/** Travel under this is a tap. Past it, the press is a drag and must not reset. */
export const TAP_PX = 5
/** How long the reset value stays on screen after the finger lifts. */
export const READOUT_HOLD_MS = 600

/**
 * Two presses on the same control. The reset is decided when the second
 * press ends, so a drag that starts on that press never resets.
 */
export class TapReset {
  private lastAt = Number.NEGATIVE_INFINITY
  private lastMoved = true
  private lastTarget: unknown = null
  private pressTarget: unknown = null
  private candidate = false

  begin(now: number, others: number, target?: unknown): boolean {
    const same = target == null || target === this.lastTarget
    this.candidate = same && others === 0 && !this.lastMoved && now - this.lastAt <= DOUBLE_TAP_MS
    this.pressTarget = target ?? null
    return this.candidate
  }

  /** A drag cancels the pending reset. The value keeps following the finger. */
  move(travel: number) {
    if (travel > TAP_PX) this.candidate = false
  }

  end(now: number, moved: boolean): 'reset' | 'drag' | 'tap' {
    const reset = this.candidate && !moved
    this.lastMoved = reset ? true : moved
    this.lastAt = now
    this.lastTarget = this.pressTarget
    this.candidate = false
    if (reset) return 'reset'
    return moved ? 'drag' : 'tap'
  }
}

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
  fallback: number | null
  axis: 'x' | 'y' | 'pad'
  format?: (value: number) => string
  /** Full-range drag matches the control length, so a long fader moves in small steps. */
  matchLength?: boolean
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
  stopPropagation?: () => void
  stopImmediatePropagation?: () => void
}

export interface GestureElement {
  style: { touchAction?: string }
  className?: string
  dataset?: { fallback?: string }
  getAttribute?(name: string): string | null
  addEventListener(type: string, fn: (event: PointerLike) => void, opts?: { passive?: boolean; capture?: boolean }): void
  removeEventListener(type: string, fn: (event: PointerLike) => void): void
  setPointerCapture?(id: number): void
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number }
}

/** Upward or rightward movement raises the value. `fine` stretches the same travel. */
export function dragValue(start: number, delta: number, min: number, max: number, fine: boolean, travel?: number) {
  const span = max - min || 1
  const pixels = travel && travel > 0 ? travel : (fine ? FINE_PX : DRAG_PX)
  const next = start + (delta / pixels) * span
  return clamp(next, min, max)
}

function travelFor(spec: ControlGesture, el: GestureElement, axis: 'x' | 'y', fine: boolean) {
  if (!spec.matchLength) return fine ? FINE_PX : DRAG_PX
  const box = el.getBoundingClientRect?.()
  const length = axis === 'x' ? box?.width ?? 0 : box?.height ?? 0
  const base = Math.max(length, DRAG_PX)
  return fine ? Math.max(base * 2.5, FINE_PX) : base
}

function controlCues(el: Pick<GestureElement, 'className' | 'dataset' | 'getAttribute'>): { label: string; title: string; className: string; declared: number | null } {
  const raw = el.dataset?.fallback
  const declared = raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null
  return {
    label: el.getAttribute?.('aria-label') ?? '',
    title: el.getAttribute?.('title') ?? '',
    className: typeof el.className === 'string' ? el.className : '',
    declared,
  }
}

/** Default for this press. Null when the parameter never declared one. */
export function resetTarget(el: Pick<GestureElement, 'className' | 'dataset' | 'getAttribute'>, spec: Pick<ControlGesture, 'min' | 'max' | 'fallback' | 'axis'>): number | null {
  if (spec.axis === 'pad') return 0.5
  const cues = controlCues(el)
  return controlDefault({
    label: cues.label,
    title: cues.title,
    className: cues.className,
    min: spec.min,
    max: spec.max,
    fallback: spec.fallback,
    declared: cues.declared,
  })
}

export function attachControlGesture(el: GestureElement, get: () => ControlGesture) {
  el.style.touchAction = 'none'
  let drag: { id: number; x: number; y: number; value: number; moved: boolean; candidate: boolean } | null = null
  let lastClient = { x: 0, y: 0 }
  let lastValue = 0
  let readoutTimer: ReturnType<typeof setTimeout> | null = null
  let swallowUntil = -1
  const pointers = new Set<number>()
  const taps = new TapReset()

  const specOf = () => get()
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const fineNow = (shift?: boolean) => !!shift || pointers.size > 1

  const clearReadoutSoon = (hold: boolean) => {
    if (readoutTimer) clearTimeout(readoutTimer)
    readoutTimer = null
    if (!hold) {
      specOf().onReadout?.(null)
      return
    }
    readoutTimer = setTimeout(() => {
      readoutTimer = null
      specOf().onReadout?.(null)
    }, READOUT_HOLD_MS)
  }

  const emit = (event: PointerLike, value: number, x: number, y: number, fine: boolean) => {
    const spec = specOf()
    lastValue = value
    lastClient = { x: event.clientX, y: event.clientY }
    spec.onChange({ value, x, y, clientX: event.clientX, clientY: event.clientY, fine })
    const text = spec.format ? spec.format(spec.axis === 'pad' ? x : value) : formatReadout(spec.axis === 'pad' ? x : value)
    spec.onReadout?.({ x: event.clientX, y: event.clientY - 28, text: spec.axis === 'pad' ? `${Math.round(x * 100)} ${Math.round(y * 100)}` : text })
  }

  const onTouchStart = (event: PointerLike) => {
    if (event.cancelable !== false) event.preventDefault?.()
  }

  const onDown = (event: PointerLike) => {
    if (event.cancelable !== false) event.preventDefault?.()
    const id = event.pointerId ?? 1
    const others = pointers.size
    pointers.add(id)
    const spec = specOf()
    const candidate = taps.begin(now(), others, el)
    if (readoutTimer) {
      clearTimeout(readoutTimer)
      readoutTimer = null
    }
    spec.onStart?.()
    try { el.setPointerCapture?.(id) } catch { /* the pointer already ended */ }
    drag = { id, x: event.clientX, y: event.clientY, value: spec.getValue(), moved: false, candidate }
    lastValue = spec.getValue()
    if (spec.axis === 'pad' && !candidate) move(event)
  }

  const move = (event: PointerLike) => {
    if (!drag || (event.pointerId ?? 1) !== drag.id) return
    if (event.cancelable !== false) event.preventDefault?.()
    const spec = specOf()
    const travel = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
    if (travel > TAP_PX) {
      drag.moved = true
      taps.move(travel)
    }
    const fine = fineNow(event.shiftKey)
    if (spec.axis === 'pad') {
      if (drag.candidate && !drag.moved) return
      const box = el.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 }
      const x = clamp((event.clientX - box.left) / (box.width || 1), 0, 1)
      const y = clamp((event.clientY - box.top) / (box.height || 1), 0, 1)
      emit(event, x, x, y, fine)
      return
    }
    // A tap, including the second tap of a double tap, must not write until it is a drag.
    if (!drag.moved) return
    const delta = spec.axis === 'x' ? event.clientX - drag.x : drag.y - event.clientY
    const pixels = travelFor(spec, el, spec.axis, fine)
    emit(event, dragValue(drag.value, delta, spec.min, spec.max, fine, pixels), event.clientX, event.clientY, fine)
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
    const moved = drag.moved || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > TAP_PX
    const kind = taps.end(now(), moved)
    const spec = specOf()
    drag = null
    if (kind === 'reset') {
      const next = resetTarget(el, spec)
      if (next != null) {
        // One write, then one commit. The smoother downstream is the drag path.
        if (spec.axis === 'pad') emit(event, 0.5, 0.5, 0.5, false)
        else emit(event, next, event.clientX, event.clientY, false)
        clearReadoutSoon(true)
        swallowUntil = now() + 120
        spec.onCommit?.()
        return
      }
    }
    clearReadoutSoon(false)
    spec.onCommit?.()
  }

  const onClick = (event: PointerLike) => {
    if (now() > swallowUntil) return
    event.preventDefault?.()
    event.stopPropagation?.()
    event.stopImmediatePropagation?.()
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
  el.addEventListener('click', onClick, { capture: true })
  el.addEventListener('dblclick', onClick, { capture: true })
  const host = typeof window !== 'undefined' ? window : null
  host?.addEventListener('pointerdown', onWindowDown as unknown as EventListener)
  host?.addEventListener('pointerup', onWindowUp as unknown as EventListener)
  host?.addEventListener('pointercancel', onWindowUp as unknown as EventListener)

  return () => {
    if (readoutTimer) clearTimeout(readoutTimer)
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', end)
    el.removeEventListener('pointercancel', end)
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('click', onClick)
    el.removeEventListener('dblclick', onClick)
    host?.removeEventListener('pointerdown', onWindowDown as unknown as EventListener)
    host?.removeEventListener('pointerup', onWindowUp as unknown as EventListener)
    host?.removeEventListener('pointercancel', onWindowUp as unknown as EventListener)
  }
}

const CONTROL = '.kit-knob button, .kit-fader button, .knob button, .tune-knob, .rack-knob, .touch-slider, .xy-pad, .kit-eq, input[type="range"]'

/** Stop the page from scrolling when a press starts on a control, and drive native sliders ourselves. */
export function installControlGuards(doc: Document) {
  let drag: { id: number; x: number; y: number; value: number; vertical: boolean; el: HTMLInputElement; moved: boolean } | null = null
  const pointers = new Set<number>()
  const taps = new TapReset()
  let tip: HTMLElement | null = null
  let tipTimer: ReturnType<typeof setTimeout> | null = null
  let swallow: { until: number; el: EventTarget } | null = null

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
    if (tipTimer) clearTimeout(tipTimer)
    tipTimer = null
    tip?.remove()
    tip = null
  }
  const hold = (x: number, y: number, text: string) => {
    if (tipTimer) clearTimeout(tipTimer)
    show(x, y, text)
    tipTimer = setTimeout(hide, READOUT_HOLD_MS)
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
    const others = pointers.size
    pointers.add(event.pointerId)
    if (!range) return
    if (tipTimer) {
      clearTimeout(tipTimer)
      tipTimer = null
    }
    taps.begin(performance.now(), others, range)
    const box = range.getBoundingClientRect()
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, value: Number(range.value), vertical: verticalRange(range, box), el: range, moved: false }
    try { range.setPointerCapture(event.pointerId) } catch { /* already gone */ }
  }
  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return
    if (event.cancelable) event.preventDefault()
    const travel = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
    if (travel > TAP_PX) {
      drag.moved = true
      taps.move(travel)
    }
    if (!drag.moved) return
    const delta = drag.vertical ? drag.y - event.clientY : event.clientX - drag.x
    const next = dragValue(drag.value, delta, Number(drag.el.min), Number(drag.el.max), event.shiftKey || pointers.size > 1)
    writeRange(drag.el, next)
    show(event.clientX, event.clientY, drag.el.value)
  }
  const finish = (event: PointerEvent, cancel: boolean) => {
    pointers.delete(event.pointerId)
    if (!drag || event.pointerId !== drag.id) return
    const range = drag.el
    const moved = cancel || drag.moved || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > TAP_PX
    const kind = taps.end(performance.now(), moved)
    drag = null
    if (kind === 'reset') {
      const next = resetTarget(range as unknown as GestureElement, { min: Number(range.min), max: Number(range.max), fallback: null, axis: 'x' })
      if (next != null) {
        writeRange(range, next, 'input')
        hold(event.clientX, event.clientY, range.value)
        swallow = { until: performance.now() + 120, el: range }
        return
      }
    }
    hide()
  }
  const onUp = (event: PointerEvent) => finish(event, false)
  const onCancel = (event: PointerEvent) => finish(event, true)
  const onClick = (event: MouseEvent) => {
    if (!swallow || performance.now() > swallow.until) return
    const target = event.target
    const host = swallow.el
    if (target !== host && !(target instanceof Node && host instanceof Node && host.contains(target))) return
    event.preventDefault()
    event.stopPropagation()
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
  doc.addEventListener('pointercancel', onCancel, { capture: true })
  doc.addEventListener('wheel', onWheel, { capture: true, passive: false })
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('dblclick', onClick, true)
  return () => {
    doc.removeEventListener('touchstart', onTouch, true)
    doc.removeEventListener('pointerdown', onDown, true)
    doc.removeEventListener('pointermove', onMove, true)
    doc.removeEventListener('pointerup', onUp, true)
    doc.removeEventListener('pointercancel', onCancel, true)
    doc.removeEventListener('wheel', onWheel, true)
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('dblclick', onClick, true)
    hide()
  }
}

function verticalRange(el: HTMLElement, box: DOMRect) {
  const mode = getComputedStyle(el).writingMode || ''
  if (mode.startsWith('vertical')) return true
  return box.height > box.width + 8
}

function writeRange(el: HTMLInputElement, value: number, notify: 'input' | 'both' = 'both') {
  const min = Number(el.min)
  const max = Number(el.max)
  const step = Number(el.step)
  let next = clamp(value, min, max)
  if (Number.isFinite(step) && step > 0) next = clamp(min + Math.round((next - min) / step) * step, min, max)
  const text = String(next)
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  proto?.set?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  // A reset sends one event. Drag keeps both so older listeners still hear the move.
  if (notify === 'both') el.dispatchEvent(new Event('change', { bubbles: true }))
}

function formatReadout(value: number) {
  return Math.abs(value) >= 100 ? Math.round(value).toString() : (Math.round(value * 100) / 100).toString()
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
