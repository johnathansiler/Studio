import { describe, expect, it } from 'vitest'
import { attachControlGesture, type GestureElement, type PointerLike } from '../ui/gestures'

interface Stored {
  fn: (event: PointerLike) => void
  passive?: boolean
}

class FakeControl implements GestureElement {
  style: { touchAction?: string } = {}
  scrollParent = { scrollTop: 24 }
  private listeners = new Map<string, Stored[]>()
  setPointerCapture() {}
  addEventListener(type: string, fn: (event: PointerLike) => void, opts?: { passive?: boolean }) {
    const list = this.listeners.get(type) ?? []
    list.push({ fn, passive: opts?.passive })
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, fn: (event: PointerLike) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item.fn !== fn))
  }
  passive(type: string) {
    return this.listeners.get(type)?.[0]?.passive
  }
  dispatch(type: string, init: Partial<PointerLike> & { clientX: number; clientY: number }) {
    const event: PointerLike & { defaultPrevented?: boolean } = {
      pointerId: 1,
      cancelable: true,
      shiftKey: false,
      ...init,
      preventDefault() {
        event.defaultPrevented = true
      },
    }
    for (const item of this.listeners.get(type) ?? []) item.fn(event)
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
})
