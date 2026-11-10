/**
 * Pointer gestures for knobs, faders, and pads.
 * A finger that starts on a control must change the value. The plugin sheet
 * keeps scrolling only when the drag starts outside a control.
 * A double click, or a second tap within 300 ms that does not move, resets
 * the control through the same onChange path a drag uses.
 */

import { dragNumeric } from '../model/dragNumeric'
import { controlLaw, DB_STEP, dragGain, dragPan, formatPan, quantizeDb, type MixLaw } from '../model/mixLaw'
import { gainToDb } from '../model/time'
import { markIntegerLand, armFinePress } from './integerTick'
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
  pointerType?: string
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

/** Upward or rightward movement raises the value. Whole numbers catch the finger unless `fine`. */
export function dragValue(start: number, delta: number, min: number, max: number, fine: boolean, travel?: number, release = false, law: MixLaw | null = null) {
  if (law === 'pan') return dragPan({ origin: start, deltaPx: delta, min, max, fine })
  if (law === 'db') return dragGain({ origin: start, deltaPx: delta, min, max, fine })
  const pixels = travel && travel > 0 ? travel : (fine ? FINE_PX : DRAG_PX)
  return dragNumeric({ origin: start, deltaPx: delta, min, max, fine, spanPx: pixels, release })
}

/** Phone: a slow drag, or a drag on the crossed axis, is the fine scale. */
const SLOW_PX_PER_MS = 0.12
const SLOW_AFTER_MS = 140

function lawOf(el: GestureElement, spec: Pick<ControlGesture, 'min' | 'max'>): MixLaw | null {
  const cues = controlCues(el)
  return controlLaw({ label: cues.label, title: cues.title, className: cues.className, min: spec.min, max: spec.max })
}

function steerFine(input: {
  law: MixLaw | null
  pointerType?: string
  shift: boolean
  extra: boolean
  fineLatch: boolean
  axis: 'x' | 'y'
  originX: number
  originY: number
  downX: number
  downY: number
  started: number
  now: number
  clientX: number
  clientY: number
}): { fine: boolean; cross: boolean } {
  let fine = input.shift || input.extra || input.fineLatch
  if (!input.law || input.pointerType !== 'touch') return { fine, cross: false }
  const primary = input.axis === 'x' ? input.clientX - input.originX : input.originY - input.clientY
  const cross = input.axis === 'x' ? input.originY - input.clientY : input.clientX - input.originX
  const crossFine = Math.abs(cross) > Math.abs(primary) + 6 && Math.abs(cross) > TAP_PX
  const elapsed = input.now - input.started
  const travel = Math.hypot(input.clientX - input.downX, input.clientY - input.downY)
  const slow = elapsed > SLOW_AFTER_MS && travel > TAP_PX && travel / elapsed < SLOW_PX_PER_MS
  if (crossFine || slow) fine = true
  return { fine, cross: crossFine }
}

function mixText(law: MixLaw | null, value: number, fallback: string) {
  if (law === 'pan') return formatPan(value)
  if (law === 'db') return gainToDb(value)
  return fallback
}

function pageWindow(): Window | null {
  return (globalThis as { window?: Window }).window ?? null
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
  let drag: { id: number; x: number; y: number; downX: number; downY: number; started: number; value: number; moved: boolean; candidate: boolean; fine: boolean; fineLatch: boolean; pointerType?: string } | null = null
  let cancelFine: () => void = () => undefined
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
    const shown = spec.axis === 'pad' ? x : value
    const fallback = spec.format ? spec.format(shown) : formatReadout(shown)
    const text = spec.axis === 'pad' ? `${Math.round(x * 100)} ${Math.round(y * 100)}` : spec.format ? fallback : mixText(lawOf(el, spec), shown, fallback)
    spec.onReadout?.({ x: event.clientX, y: event.clientY - 28, text })
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
    const value = spec.getValue()
    lastClient = { x: event.clientX, y: event.clientY }
    lastValue = value
    drag = { id, x: event.clientX, y: event.clientY, downX: event.clientX, downY: event.clientY, started: now(), value, moved: false, candidate, fine: !!event.shiftKey || pointers.size > 1, fineLatch: false, pointerType: event.pointerType }
    cancelFine()
    cancelFine = armFinePress(event.pointerType, () => {
      if (!drag) return
      drag.fineLatch = true
      drag.fine = true
      drag.x = lastClient.x
      drag.y = lastClient.y
      drag.value = lastValue
    })
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
      cancelFine()
    }
    const law = spec.axis === 'pad' ? null : lawOf(el, spec)
    const steered = steerFine({
      law,
      pointerType: drag.pointerType,
      shift: fineNow(event.shiftKey),
      extra: false,
      fineLatch: !!drag.fineLatch,
      axis: spec.axis === 'y' ? 'y' : 'x',
      originX: drag.x,
      originY: drag.y,
      downX: drag.downX,
      downY: drag.downY,
      started: drag.started,
      now: now(),
      clientX: event.clientX,
      clientY: event.clientY,
    })
    const fine = steered.fine
    if (fine !== drag.fine) {
      drag.fine = fine
      drag.x = event.clientX
      drag.y = event.clientY
      drag.value = lastValue
    }
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
    const delta = steered.cross
      ? (spec.axis === 'x' ? drag.y - event.clientY : event.clientX - drag.x)
      : (spec.axis === 'x' ? event.clientX - drag.x : drag.y - event.clientY)
    const pixels = travelFor(spec, el, spec.axis, fine)
    const before = lastValue
    const next = dragValue(drag.value, delta, spec.min, spec.max, fine, pixels, false, law)
    emit(event, next, event.clientX, event.clientY, fine)
    markIntegerLand(el as { classList?: DOMTokenList }, before, next)
  }

  const rebase = (event: PointerLike) => {
    if (!drag) return
    pointers.add(event.pointerId ?? 1)
    drag.x = lastClient.x
    drag.y = lastClient.y
    drag.value = lastValue
    if (pointers.size > 1) drag.fine = true
  }

  const end = (event: PointerLike) => {
    pointers.delete(event.pointerId ?? 1)
    if (!drag || (event.pointerId ?? 1) !== drag.id) return
    cancelFine()
    cancelFine = () => undefined
    const moved = drag.moved || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > TAP_PX
    const fine = !!(drag.fine || drag.fineLatch)
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
    const law = spec.axis === 'pad' ? null : lawOf(el, spec)
    if (moved && kind === 'drag' && spec.axis !== 'pad' && !fine && !law) {
      const next = dragValue(lastValue, 0, spec.min, spec.max, false, undefined, true)
      if (next !== lastValue) {
        emit(event, next, event.clientX, event.clientY, false)
        markIntegerLand(el as { classList?: DOMTokenList }, lastValue, next)
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
    const fine = !!event.shiftKey
    const current = spec.getValue()
    const law = lawOf(el, spec)
    const deltaPx = ((event.deltaY ?? 0) < 0 ? 1 : -1) * (fine ? 4 : 10)
    spec.onStart?.()
    const next = dragValue(current, deltaPx, spec.min, spec.max, fine, undefined, !fine && !law, law)
    emit(event, next, event.clientX, event.clientY, fine)
    markIntegerLand(el as { classList?: DOMTokenList }, current, next)
    spec.onReadout?.(null)
    spec.onCommit?.()
  }

  const onWindowDown = (event: PointerLike) => {
    if (!drag || (event.pointerId ?? 1) === drag.id) return
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
  const host = pageWindow()
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
  let drag: { id: number; x: number; y: number; downX: number; downY: number; started: number; value: number; vertical: boolean; el: HTMLInputElement; moved: boolean; fine: boolean; fineLatch: boolean; pointerType?: string } | null = null
  let cancelFine: () => void = () => undefined
  let lastPoint = { x: 0, y: 0 }
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
    if (drag && event.pointerId !== drag.id) {
      pointers.add(event.pointerId)
      drag.x = lastPoint.x
      drag.y = lastPoint.y
      drag.value = Number(drag.el.value)
      drag.fine = true
      if (event.cancelable) event.preventDefault()
      return
    }
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
    lastPoint = { x: event.clientX, y: event.clientY }
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, downX: event.clientX, downY: event.clientY, started: performance.now(), value: Number(range.value), vertical: verticalRange(range, box), el: range, moved: false, fine: event.shiftKey || pointers.size > 1, fineLatch: false, pointerType: event.pointerType }
    cancelFine()
    cancelFine = armFinePress(event.pointerType, () => {
      if (!drag) return
      drag.fineLatch = true
      drag.fine = true
      drag.value = Number(drag.el.value)
      drag.x = lastPoint.x
      drag.y = lastPoint.y
    })
    try { range.setPointerCapture(event.pointerId) } catch { /* already gone */ }
  }
  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return
    if (event.cancelable) event.preventDefault()
    lastPoint = { x: event.clientX, y: event.clientY }
    const travel = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
    if (travel > TAP_PX) {
      drag.moved = true
      taps.move(travel)
      cancelFine()
    }
    if (!drag.moved) return
    const law = inputLaw(drag.el)
    const steered = steerFine({
      law,
      pointerType: drag.pointerType,
      shift: event.shiftKey || pointers.size > 1,
      extra: false,
      fineLatch: drag.fineLatch,
      axis: drag.vertical ? 'y' : 'x',
      originX: drag.x,
      originY: drag.y,
      downX: drag.downX,
      downY: drag.downY,
      started: drag.started,
      now: performance.now(),
      clientX: event.clientX,
      clientY: event.clientY,
    })
    const fine = steered.fine
    if (fine !== drag.fine) {
      drag.fine = fine
      drag.x = event.clientX
      drag.y = event.clientY
      drag.value = Number(drag.el.value)
    }
    const delta = steered.cross
      ? (drag.vertical ? event.clientX - drag.x : drag.y - event.clientY)
      : (drag.vertical ? drag.y - event.clientY : event.clientX - drag.x)
    const before = Number(drag.el.value)
    const next = dragValue(drag.value, delta, Number(drag.el.min), Number(drag.el.max), fine, undefined, false, law)
    writeRange(drag.el, next)
    markIntegerLand(drag.el, before, Number(drag.el.value))
    show(event.clientX, event.clientY, mixText(law, Number(drag.el.value), drag.el.value))
  }
  const finish = (event: PointerEvent, cancel: boolean) => {
    pointers.delete(event.pointerId)
    if (!drag || event.pointerId !== drag.id) return
    const range = drag.el
    const fine = event.shiftKey || drag.fineLatch || pointers.size > 1
    cancelFine()
    cancelFine = () => undefined
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
    const law = inputLaw(range)
    if (!cancel && moved && kind === 'drag' && !fine && !law) {
      const before = Number(range.value)
      const next = dragValue(before, 0, Number(range.min), Number(range.max), false, undefined, true)
      if (next !== before) {
        writeRange(range, next)
        markIntegerLand(range, before, Number(range.value))
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
  const numberOf = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null
    const found = target.closest('input[type="number"]')
    return found instanceof HTMLInputElement ? found : null
  }
  const onWheel = (event: WheelEvent) => {
    const range = rangeOf(event.target)
    const field = range ? null : numberOf(event.target)
    const el = range ?? field
    if (!el) return
    event.preventDefault()
    const fine = event.shiftKey
    const label = el.getAttribute('aria-label') || ''
    if (/decibel/i.test(label)) {
      const quantum = fine ? DB_STEP : 1
      const current = Number(el.value)
      const before = Number.isFinite(current) ? current : 0
      const next = quantizeDb(before + (event.deltaY < 0 ? quantum : -quantum))
      writeNumber(el, next)
      return
    }
    const min = el.min === '' ? Number.NEGATIVE_INFINITY : Number(el.min)
    const max = el.max === '' ? Number.POSITIVE_INFINITY : Number(el.max)
    const current = Number(el.value)
    const law = inputLaw(el)
    const deltaPx = (event.deltaY < 0 ? 1 : -1) * (fine ? 4 : 10)
    const before = Number.isFinite(current) ? current : 0
    const next = dragValue(before, deltaPx, Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY, Number.isFinite(max) ? max : Number.POSITIVE_INFINITY, fine, undefined, !fine && !law, law)
    if (range) writeRange(range, next)
    else writeNumber(el, next)
    markIntegerLand(el, before, Number(el.value))
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

function writeNumber(el: HTMLInputElement, value: number) {
  const min = el.min === '' ? Number.NEGATIVE_INFINITY : Number(el.min)
  const max = el.max === '' ? Number.POSITIVE_INFINITY : Number(el.max)
  const step = Number(el.step)
  let next = clamp(value, Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY, Number.isFinite(max) ? max : Number.POSITIVE_INFINITY)
  if (el.step !== 'any' && Number.isFinite(step) && step > 0) {
    const base = Number.isFinite(min) ? min : 0
    next = base + Math.round((next - base) / step) * step
    next = clamp(next, Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY, Number.isFinite(max) ? max : Number.POSITIVE_INFINITY)
  }
  const text = String(Math.round(next * 1e6) / 1e6)
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  proto?.set?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function inputLaw(el: HTMLInputElement): MixLaw | null {
  const min = el.min === '' ? Number.NEGATIVE_INFINITY : Number(el.min)
  const max = el.max === '' ? Number.POSITIVE_INFINITY : Number(el.max)
  return controlLaw({
    label: el.getAttribute('aria-label') ?? '',
    title: el.getAttribute('title') ?? '',
    className: typeof el.className === 'string' ? el.className : '',
    min,
    max,
  })
}

function writeRange(el: HTMLInputElement, value: number, notify: 'input' | 'both' = 'both') {
  const min = Number(el.min)
  const max = Number(el.max)
  const step = Number(el.step)
  const law = inputLaw(el)
  let next = clamp(value, min, max)
  if (!law && Number.isFinite(step) && step > 0) next = clamp(min + Math.round((next - min) / step) * step, min, max)
  const text = String(Math.round(next * 1e8) / 1e8)
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
