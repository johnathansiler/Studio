/**
 * @vitest-environment jsdom
 *
 * A store write and the drag that follows it share one commit.
 * The drag starts in that commit's layout phase, before passive effects
 * can copy the prop into local state. The finger must start at the value
 * just written, for both pan and the fader.
 */
import { act, createElement, StrictMode, useEffect, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { dbFromGain, dbPixels, gainFromDb, panPixels } from '../model/mixLaw'
import { ProjectStore } from '../state/store'
import { AutoFader, PanKnob } from '../ui/AutomationLane'

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  previewMix() {},
  armMixFollow() {},
  clearMixFollow() {},
  currentTimelineSample: () => 0,
} as unknown as AudioEngine

class TestPointerEvent extends MouseEvent {
  pointerId: number
  pointerType: string
  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string }) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
    this.pointerType = init.pointerType ?? 'mouse'
  }
}

function drag(el: HTMLElement, dx: number, dy: number) {
  const box = el.getBoundingClientRect()
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const fire = (type: string, clientX: number, clientY: number) => {
    el.dispatchEvent(new TestPointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      clientX,
      clientY,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    }))
  }
  fire('pointerdown', x, y)
  fire('pointermove', x + dx, y + dy)
  fire('pointerup', x + dx, y + dy)
}

function OriginHarness({
  store,
  kind,
  pending,
}: {
  store: ProjectStore
  kind: 'pan' | 'fader'
  pending: { current: null | (() => void) }
}) {
  const [, bump] = useState(0)
  const track = store.project.tracks[0]
  useEffect(() => store.subscribe(() => bump((n) => n + 1)), [store])
  useLayoutEffect(() => {
    const run = pending.current
    if (!run) return
    pending.current = null
    run()
  })
  if (kind === 'pan') {
    return createElement(PanKnob, {
      store,
      engine,
      label: 'Vocal pan',
      value: track.pan,
      spec: { trackId: track.id, target: 'pan', param: 'pan', min: -1, max: 1 },
    })
  }
  return createElement(AutoFader, {
    store,
    engine,
    label: 'Vocal volume',
    className: 'volume',
    value: track.volume,
    spec: { trackId: track.id, target: 'volume', param: 'volume', min: 0, max: 1.25 },
  })
}

function mount(kind: 'pan' | 'fader') {
  const store = new ProjectStore()
  const track = store.project.tracks[0]
  store.updateTrack(track.id, { pan: -0.375, volume: gainFromDb(-6.3) })
  const pending: { current: null | (() => void) } = { current: null }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    flushSync(() => {
      root.render(createElement(StrictMode, null, createElement(OriginHarness, { store, kind, pending })))
    })
  })
  return {
    store,
    trackId: track.id,
    pending,
    root,
    host,
    writeThenDrag(write: () => void, start: () => void) {
      const version = store.version
      pending.current = start
      act(() => {
        flushSync(write)
      })
      return store.version - version
    },
  }
}

describe('live mix drag origin', () => {
  const cleanups: Array<{ root: Root; host: HTMLElement }> = []
  const raf = globalThis.requestAnimationFrame
  const cancel = globalThis.cancelAnimationFrame

  beforeAll(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    // Screen updates wait for a frame. The store write does not, so leave the frame queued.
    globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame
  })

  afterEach(() => {
    const item = cleanups.pop()
    if (!item) return
    act(() => {
      item.root.unmount()
    })
    item.host.remove()
  })

  afterAll(() => {
    globalThis.requestAnimationFrame = raf
    globalThis.cancelAnimationFrame = cancel
  })

  it('starts a pan drag from the pan written in the same turn', () => {
    const view = mount('pan')
    cleanups.push(view)
    const knob = document.querySelector('.pan-knob') as HTMLElement
    expect(knob.getAttribute('aria-valuenow')).toBe('-0.375')
    let atDrag = ''
    const steps = view.writeThenDrag(
      () => view.store.updateTrack(view.trackId, { pan: 0 }),
      () => {
        const el = document.querySelector('.pan-knob') as HTMLElement
        atDrag = el.getAttribute('aria-valuenow') ?? ''
        drag(el, panPixels(12), 0)
      },
    )
    expect(view.store.project.tracks[0].pan).toBeCloseTo(0.12, 4)
    expect(atDrag).toBe('0')
    expect(steps).toBe(2)
    act(() => {
      view.store.undo()
    })
    expect(view.store.project.tracks[0].pan).toBeCloseTo(0, 4)
  })

  it('starts a fader drag from the level written in the same turn', () => {
    const view = mount('fader')
    cleanups.push(view)
    const fader = document.querySelector('.touch-slider') as HTMLElement
    expect(dbFromGain(Number(fader.getAttribute('aria-valuenow')))).toBeCloseTo(-6.3, 2)
    let atDrag = 0
    const steps = view.writeThenDrag(
      () => view.store.updateTrack(view.trackId, { volume: 1 }),
      () => {
        const el = document.querySelector('.touch-slider') as HTMLElement
        atDrag = dbFromGain(Number(el.getAttribute('aria-valuenow')))
        drag(el, 0, -dbPixels(1.7))
      },
    )
    expect(dbFromGain(view.store.project.tracks[0].volume)).toBeCloseTo(1.7, 4)
    expect(atDrag).toBeCloseTo(0, 4)
    expect(steps).toBe(2)
    act(() => {
      view.store.undo()
    })
    expect(dbFromGain(view.store.project.tracks[0].volume)).toBeCloseTo(0, 4)
  })
})
