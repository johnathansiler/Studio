// @vitest-environment jsdom
import { createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '../model/types'
import { placeTempoEntry, tempoEntryBpm, tempoEntryIssue, TEMPO_HOLD_MS } from '../model/tempoEntry'
import { ProjectStore } from '../state/store'
import { TransportBar } from '../ui/TransportBar'

if (typeof PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number
    pointerType: string
    isPrimary: boolean
    constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string; isPrimary?: boolean } = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
      this.pointerType = init.pointerType ?? ''
      this.isPrimary = init.isPrimary ?? true
    }
  }
  Object.defineProperty(globalThis, 'PointerEvent', { configurable: true, value: PointerEventPolyfill })
}

const engine = {
  positionSamples: 0,
  status: 'stopped' as const,
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  unlock() {},
}

function Host({ store }: { store: ProjectStore }) {
  const [, setTick] = useState(0)
  useEffect(() => store.subscribe(() => setTick((value) => value + 1)), [store])
  return createElement(TransportBar, {
    store,
    engine: engine as never,
    simple: true,
    phone: true,
    onPlay() {},
    onStop() {},
    onRecord() {},
    onSeek() {},
  })
}

function pointer(type: string, pointerType: string) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType,
    button: 0,
    clientX: 40,
    clientY: 20,
    isPrimary: true,
  })
}

describe('tempo entry', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let root: Root | null = null
  let host: HTMLDivElement | null = null
  let now = 0

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = null
    host = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function mount(tempo = 96.5) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate })
    const store = new ProjectStore(createEmptyProject())
    store.setTempo(tempo)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => { root?.render(createElement(Host, { store })) })
    const button = host.querySelector('.tempo-tap') as HTMLButtonElement
    return { store, button, vibrate }
  }

  function press(button: HTMLButtonElement, pointerType: string, hold: number) {
    act(() => { button.dispatchEvent(pointer('pointerdown', pointerType)) })
    act(() => { vi.advanceTimersByTime(hold) })
    act(() => { button.dispatchEvent(pointer('pointerup', pointerType)) })
    if (pointerType === 'mouse') {
      act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })) })
    }
  }

  it('clamps typed tempo to 20–300 with one decimal', () => {
    expect(tempoEntryBpm('96.5')).toBe(96.5)
    expect(tempoEntryBpm('120.66')).toBe(120.7)
    expect(tempoEntryBpm('10')).toBe(20)
    expect(tempoEntryBpm('400')).toBe(300)
    expect(tempoEntryBpm('20.04')).toBe(20)
    expect(tempoEntryBpm('')).toBeNull()
    expect(tempoEntryBpm('nope')).toBeNull()
    expect(tempoEntryIssue('96.5')).toBeNull()
    expect(tempoEntryIssue('10')).toMatch(/20/)
    expect(tempoEntryIssue('nope')).toMatch(/20/)
  })

  it('anchors under the button on a phone and a fold, and stays on screen', () => {
    const menu = { width: 176, height: 120 }
    const phone = placeTempoEntry({ left: 240, top: 48, width: 64, height: 40 }, menu, { width: 384, height: 840 })
    expect(phone.side).toBe('down')
    expect(phone.top).toBe(48 + 40 + 6)
    expect(phone.left + menu.width).toBeLessThanOrEqual(384 - 8)
    expect(phone.left).toBeGreaterThanOrEqual(8)
    const fold = placeTempoEntry({ left: 400, top: 52, width: 80, height: 40 }, menu, { width: 884, height: 1104 })
    expect(fold.side).toBe('down')
    expect(fold.top).toBe(52 + 40 + 6)
    expect(fold.left).toBe(400)
    const low = placeTempoEntry({ left: 20, top: 780, width: 64, height: 40 }, menu, { width: 384, height: 840 })
    expect(low.side).toBe('up')
    expect(low.top).toBeLessThan(780)
  })

  it('opens on a long press without counting that press as a tap', () => {
    const { store, button, vibrate } = mount(90)
    press(button, 'touch', TEMPO_HOLD_MS)
    const pop = document.querySelector('[data-tempo-entry]')
    const input = document.querySelector('.tempo-entry-input') as HTMLInputElement
    expect(pop).toBeTruthy()
    expect(input.value).toBe('90')
    expect(input.getAttribute('inputmode')).toBe('decimal')
    expect(document.activeElement).toBe(input)
    expect(vibrate).toHaveBeenCalledWith(10)
    expect(store.project.tempo).toBe(90)
    act(() => { (document.querySelector('.tempo-entry-actions button') as HTMLButtonElement).click() })
    expect(document.querySelector('[data-tempo-entry]')).toBeNull()
    now = 1600
    press(button, 'touch', 0)
    expect(store.project.tempo).toBe(90)
    expect(document.querySelector('[data-tempo-entry]')).toBeNull()
  })

  it('still sets tempo from two short taps', () => {
    const { store, button } = mount(90)
    press(button, 'touch', 0)
    expect(store.project.tempo).toBe(90)
    now = 1500
    press(button, 'touch', 0)
    expect(store.project.tempo).toBe(120)
    expect(document.querySelector('[data-tempo-entry]')).toBeNull()
  })

  it('opens on a desktop double-click without using the second click as a tap', () => {
    const { store, button } = mount(90)
    act(() => { button.dispatchEvent(pointer('pointerdown', 'mouse')) })
    act(() => { button.dispatchEvent(pointer('pointerup', 'mouse')) })
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })) })
    now = 1300
    act(() => { button.dispatchEvent(pointer('pointerdown', 'mouse')) })
    act(() => { button.dispatchEvent(pointer('pointerup', 'mouse')) })
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 })) })
    act(() => { button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 })) })
    expect(document.querySelector('[data-tempo-entry]')).toBeTruthy()
    expect(store.project.tempo).toBe(90)
  })

  it('applies through setTempo so undo restores the previous tempo, and dismiss keeps it', () => {
    const { store, button } = mount(90)
    press(button, 'touch', TEMPO_HOLD_MS)
    const input = document.querySelector('.tempo-entry-input') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '99.5')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(store.project.tempo).toBe(99.5)
    act(() => { store.undo() })
    expect(store.project.tempo).toBe(90)

    press(button, 'touch', TEMPO_HOLD_MS)
    const again = document.querySelector('.tempo-entry-input') as HTMLInputElement
    act(() => { again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('[data-tempo-entry]')).toBeNull()
    expect(store.project.tempo).toBe(90)

    press(button, 'touch', TEMPO_HOLD_MS)
    act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, pointerType: 'touch' })) })
    expect(document.querySelector('[data-tempo-entry]')).toBeNull()
    expect(store.project.tempo).toBe(90)

    press(button, 'touch', TEMPO_HOLD_MS)
    fill('abc')
    act(() => { (document.querySelector('.tempo-entry-actions button.ok') as HTMLButtonElement).click() })
    expect(store.project.tempo).toBe(90)
    expect(document.querySelector('.tempo-entry-error')?.textContent).toMatch(/20/)

    fill('10')
    const typed = document.querySelector('.tempo-entry-input') as HTMLInputElement
    expect(typed.value).toBe('10')
    act(() => { (document.querySelector('.tempo-entry-actions button.ok') as HTMLButtonElement).click() })
    expect(store.project.tempo).toBe(20)
  })
})

function fill(text: string) {
  const field = document.querySelector('.tempo-entry-input') as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
