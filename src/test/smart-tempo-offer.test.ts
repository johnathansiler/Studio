// @vitest-environment jsdom
import { createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { SMART_TEMPO_OFFER_MS, SmartTempoBar } from '../ui/SongMap'

function Host({ store }: { store: ProjectStore }) {
  const [, setTick] = useState(0)
  useEffect(() => store.subscribe(() => setTick((value) => value + 1)), [store])
  return createElement(SmartTempoBar, { store })
}

describe('BPM detection offer', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let root: Root
  let host: HTMLDivElement

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    vi.useRealTimers()
  })

  function mount() {
    vi.useFakeTimers()
    const store = new ProjectStore(createEmptyProject())
    store.smartTempo = { trackId: 'track', clipId: 'clip', bpm: 96.5 }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => { root.render(createElement(Host, { store })) })
    return store
  }

  it('leaves on its own after a few seconds', () => {
    const store = mount()
    expect(host.querySelector('[data-smart-tempo]')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(SMART_TEMPO_OFFER_MS) })
    expect(store.smartTempo).toBeNull()
    expect(host.querySelector('[data-smart-tempo]')).toBeNull()
  })

  it('leaves on the next action outside the banner and stays for a tap on the banner', () => {
    const store = mount()
    const bar = host.querySelector('[data-smart-tempo]') as HTMLElement
    act(() => { bar.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(store.smartTempo?.bpm).toBe(96.5)
    act(() => { window.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(store.smartTempo).toBeNull()
    expect(host.querySelector('[data-smart-tempo]')).toBeNull()
  })
})
