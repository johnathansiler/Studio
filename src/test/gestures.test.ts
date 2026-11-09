import { describe, expect, it, vi } from 'vitest'
import { attachControlGesture, READOUT_HOLD_MS, type GestureElement, type PointerLike } from '../ui/gestures'

interface Stored {
  fn: (event: PointerLike) => void
  passive?: boolean
  capture?: boolean
}

class FakeControl implements GestureElement {
  style: { touchAction?: string } = {}
  className = ''
  dataset: { fallback?: string } = {}
  attrs: Record<string, string> = {}
  scrollParent = { scrollTop: 24 }
  private listeners = new Map<string, Stored[]>()
  setPointerCapture() {}
  getAttribute(name: string) {
    return this.attrs[name] ?? null
  }
  addEventListener(type: string, fn: (event: PointerLike) => void, opts?: { passive?: boolean; capture?: boolean }) {
    const list = this.listeners.get(type) ?? []
    list.push({ fn, passive: opts?.passive, capture: opts?.capture })
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, fn: (event: PointerLike) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item.fn !== fn))
  }
  passive(type: string) {
    return this.listeners.get(type)?.[0]?.passive
  }
  dispatch(type: string, init: Partial<PointerLike> & { clientX: number; clientY: number }) {
    const event: PointerLike & { defaultPrevented?: boolean; stopped?: boolean } = {
      pointerId: 1,
      cancelable: true,
      shiftKey: false,
      ...init,
      preventDefault() {
        event.defaultPrevented = true
      },
      stopPropagation() {
        event.stopped = true
      },
      stopImmediatePropagation() {
        event.stopped = true
      },
    }
    const list = this.listeners.get(type) ?? []
    for (const item of [...list.filter((entry) => entry.capture), ...list.filter((entry) => !entry.capture)]) {
      item.fn(event)
      if (event.stopped) break
    }
    if (!event.defaultPrevented) this.scrollParent.scrollTop += 40
    return event
  }
}

describe('knob gestures', () => {
  it('changes the value on pointerdown then pointermove and leaves the container scroll alone', () => {
    const knob = new FakeControl()
    let value = 0.2
    const stop = attachControlGesture(knob, () => ({
      min: 0,
      max: 1,
      fallback: 0.5,
      axis: 'y',
      getValue: () => value,
      onChange: (change) => {
        value = change.value
      },
    }))
    expect(knob.style.touchAction).toBe('none')
    expect(knob.passive('pointerdown')).toBe(false)
    expect(knob.passive('touchstart')).toBe(false)
    knob.dispatch('touchstart', { clientX: 20, clientY: 100 })
    knob.dispatch('pointerdown', { clientX: 20, clientY: 100 })
    knob.dispatch('pointermove', { clientX: 22, clientY: 40 })
    expect(value).toBeGreaterThan(0.2)
    expect(knob.scrollParent.scrollTop).toBe(24)
    stop()
  })

  it('uses a finer travel while shift is held', () => {
    const knob = new FakeControl()
    let coarse = 0
    let fine = 0
    const run = (shift: boolean) => {
      let value = 0
      const stop = attachControlGesture(knob, () => ({
        min: 0,
        max: 1,
        fallback: 0,
        axis: 'y',
        getValue: () => value,
        onChange: (change) => {
          value = change.value
        },
      }))
      knob.dispatch('pointerdown', { clientX: 0, clientY: 100, shiftKey: shift })
      knob.dispatch('pointermove', { clientX: 0, clientY: 10, shiftKey: shift })
      stop()
      return value
    }
    coarse = run(false)
    fine = run(true)
    expect(fine).toBeGreaterThan(0)
    expect(fine).toBeLessThan(coarse)
  })

  it('rounds a normal release to an integer and keeps decimals when shift is held', () => {
    const knob = new FakeControl()
    const run = (shift: boolean) => {
      let value = 120
      const stop = attachControlGesture(knob, () => ({
        min: 30,
        max: 300,
        fallback: 120,
        axis: 'y',
        getValue: () => value,
        onChange: (change) => {
          value = change.value
        },
      }))
      knob.dispatch('pointerdown', { clientX: 0, clientY: 100, shiftKey: shift })
      knob.dispatch('pointermove', { clientX: 0, clientY: 85, shiftKey: shift })
      knob.dispatch('pointerup', { clientX: 0, clientY: 85, shiftKey: shift })
      stop()
      return value
    }
    expect(Number.isInteger(run(false))).toBe(true)
    expect(Number.isInteger(run(true))).toBe(false)
  })
})

describe('shared knob, slider, and fader reset', () => {
  function harness(axis: 'x' | 'y', fallback = 0.5) {
    const control = new FakeControl()
    control.attrs['aria-label'] = 'Drive'
    let value = 0.2
    let readout: string | null = null
    let changes = 0
    let steps = 0
    let open = false
    let dirty = false
    const stop = attachControlGesture(control, () => ({
      min: 0,
      max: 1,
      fallback,
      axis,
      format: (next) => `value ${next}`,
      getValue: () => value,
      onStart: () => {
        open = true
      },
      onChange: (change) => {
        changes += 1
        value = change.value
        if (open) dirty = true
        else steps += 1
      },
      onCommit: () => {
        if (open && dirty) steps += 1
        open = false
        dirty = false
      },
      onReadout: (next) => {
        readout = next?.text ?? null
      },
    }))
    return { control, stop, readout: () => readout, value: () => value, changes: () => changes, steps: () => steps }
  }

  function tap(control: FakeControl, at: { x: number; y: number }) {
    control.dispatch('pointerdown', { clientX: at.x, clientY: at.y })
    control.dispatch('pointerup', { clientX: at.x, clientY: at.y })
  }

  it('resets a knob, a slider, and a fader to the declared default on a second tap', () => {
    for (const axis of ['y', 'x'] as const) {
      const box = harness(axis, 0.5)
      tap(box.control, { x: 10, y: 80 })
      expect(box.changes()).toBe(0)
      tap(box.control, { x: 10, y: 80 })
      expect(box.value()).toBe(0.5)
      expect(box.changes()).toBe(1)
      expect(box.steps()).toBe(1)
      expect(box.readout()).toBe('value 0.5')
      box.stop()
    }
  })

  it('does not reset when the second press drags', () => {
    const box = harness('y', 0.5)
    tap(box.control, { x: 0, y: 100 })
    box.control.dispatch('pointerdown', { clientX: 0, clientY: 100 })
    box.control.dispatch('pointermove', { clientX: 0, clientY: 10 })
    box.control.dispatch('pointerup', { clientX: 0, clientY: 10 })
    expect(box.value()).toBeGreaterThan(0.5)
    expect(box.steps()).toBe(1)
    box.stop()
  })

  it('does not reset after a drag, or when the second tap is later than 300 ms', () => {
    const dragged = harness('y', 0.5)
    dragged.control.dispatch('pointerdown', { clientX: 0, clientY: 100 })
    dragged.control.dispatch('pointermove', { clientX: 0, clientY: 40 })
    dragged.control.dispatch('pointerup', { clientX: 0, clientY: 40 })
    tap(dragged.control, { x: 0, y: 40 })
    expect(dragged.value()).not.toBe(0.5)
    dragged.stop()

    let now = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const edge = harness('x', 0.25)
    tap(edge.control, { x: 4, y: 4 })
    now = 300
    tap(edge.control, { x: 4, y: 4 })
    expect(edge.value()).toBe(0.25)
    edge.stop()
    const late = harness('x', 0.25)
    now = 1_000
    tap(late.control, { x: 4, y: 4 })
    now = 1_301
    tap(late.control, { x: 4, y: 4 })
    expect(late.value()).toBe(0.2)
    expect(late.changes()).toBe(0)
    late.stop()
    spy.mockRestore()
  })

  it('keeps the reset value on screen briefly and swallows the second click', () => {
    vi.useFakeTimers()
    let now = 1_000
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const box = harness('y', 0.5)
    let clicks = 0
    box.control.addEventListener('click', () => {
      clicks += 1
    })
    tap(box.control, { x: 8, y: 8 })
    box.control.dispatch('click', { clientX: 8, clientY: 8 })
    now = 1_100
    tap(box.control, { x: 8, y: 8 })
    box.control.dispatch('click', { clientX: 8, clientY: 8 })
    expect(clicks).toBe(1)
    expect(box.readout()).toBe('value 0.5')
    vi.advanceTimersByTime(READOUT_HOLD_MS - 1)
    expect(box.readout()).toBe('value 0.5')
    vi.advanceTimersByTime(1)
    expect(box.readout()).toBeNull()
    box.stop()
    spy.mockRestore()
    vi.useRealTimers()
  })

  it('uses the fader and pan defaults from the control label', () => {
    const fader = new FakeControl()
    fader.className = 'touch-slider vertical volume'
    fader.attrs['aria-label'] = 'Master volume. How loud the whole mix is.'
    let value = 0.4
    const stopFader = attachControlGesture(fader, () => ({
      min: 0,
      max: 1.25,
      fallback: 0.9,
      axis: 'y',
      getValue: () => value,
      onChange: (change) => {
        value = change.value
      },
    }))
    tap(fader, { x: 2, y: 20 })
    tap(fader, { x: 2, y: 20 })
    expect(value).toBe(1)
    stopFader()

    const pan = new FakeControl()
    pan.className = 'pan-knob'
    pan.attrs['aria-label'] = 'Vocal pan. Left or right.'
    let panned = 0.6
    const stopPan = attachControlGesture(pan, () => ({
      min: -1,
      max: 1,
      fallback: 0.6,
      axis: 'x',
      getValue: () => panned,
      onChange: (change) => {
        panned = change.value
      },
    }))
    tap(pan, { x: 3, y: 3 })
    tap(pan, { x: 3, y: 3 })
    expect(panned).toBe(0)
    stopPan()
  })
})
