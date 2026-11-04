import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AudioEngine } from '../audio/engine'
import { midiPanicMessages } from '../model/midiTools'
import { RESET_REJECTED, relayTransportMessage } from '../model/roomReset'
import { countInAt } from '../model/tempoMap'
import { countInBarsOf, countInSeconds } from '../model/time'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { TRANSPORT_COPY, visibleMenu } from '../ui/chrome'
import { TransportBar } from '../ui/TransportBar'

const engineStub = {
  positionSamples: 0,
  status: 'stopped' as const,
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  unlock() {},
}

function markup(store: ProjectStore, roomRole?: 'host' | 'guest') {
  return renderToStaticMarkup(createElement(TransportBar, {
    store,
    engine: engineStub as never,
    roomRole,
    onPlay() {},
    onStop() {},
    onRecord() {},
    onSeek() {},
    onReset() {},
  }))
}

describe('count-in on the transport', () => {
  it('cycles off, one bar, and two bars, and the menu does not repeat it', () => {
    const store = new ProjectStore()
    expect(countInBarsOf(store.project)).toBe(1)
    store.cycleCountIn()
    expect(store.project.countIn).toBe(true)
    expect(store.project.countInBars).toBe(2)
    store.cycleCountIn()
    expect(store.project.countIn).toBe(false)
    expect(countInBarsOf(store.project)).toBe(0)
    store.cycleCountIn()
    expect(countInBarsOf(store.project)).toBe(1)
    store.undo()
    expect(countInBarsOf(store.project)).toBe(0)

    const project = createEmptyProject()
    const one = countInSeconds(project.tempo, project.timeSignature)
    project.countIn = true
    project.countInBars = 2
    expect(countInAt(project, 0)).toBeCloseTo(one * 2)
    project.countIn = false
    expect(countInAt(project, 0)).toBe(0)

    for (const phone of [false, true]) {
      const actions = visibleMenu({ phone, session: false, dockBottom: false, hardwareMidi: true }).map((item) => item.action)
      expect(actions).not.toContain('click')
      expect(actions).not.toContain('count-in')
    }
    expect(TRANSPORT_COPY.map((item) => item.id)).toEqual(expect.arrayContaining(['click', 'count-in', 'reset']))
  })

  it('shows Click and Count on the transport with a lit on state', () => {
    const store = new ProjectStore()
    store.project.metronomeEnabled = false
    store.project.countIn = false
    store.project.countInBars = 0
    const off = markup(store)
    expect(off).toContain('id="transport-click"')
    expect(off).toContain('id="transport-count"')
    expect(off).toContain('>Metronome<')
    expect(off).toContain('>Count<')
    expect(off).toContain('>Off<')
    expect(off).not.toContain('click on')
    expect(off).not.toContain('count on')
    expect(off).toContain('aria-pressed="false"')

    store.project.metronomeEnabled = true
    store.project.countIn = true
    store.project.countInBars = 2
    const on = markup(store)
    expect(on).toContain('click on')
    expect(on).toContain('count on')
    expect(on).toContain('>2 bars<')
    expect(on).toContain('aria-pressed="true"')
  })
})

describe('room reset', () => {
  it('broadcasts a host reset and rejects a guest', () => {
    expect(relayTransportMessage('host', { t: 'transport', payload: { action: 'reset' } })).toEqual({
      broadcast: { action: 'reset' },
    })
    expect(relayTransportMessage('host', { t: 'transport', payload: { action: 'play' } })).toEqual({
      broadcast: { action: 'play' },
    })
    expect(relayTransportMessage('guest', { t: 'transport', payload: { action: 'reset' } })).toEqual({
      error: RESET_REJECTED,
    })
    expect(relayTransportMessage('guest', { t: 'transport-request', payload: { action: 'reset' } })).toEqual({
      error: RESET_REJECTED,
    })
    expect(relayTransportMessage('guest', { t: 'transport', payload: { action: 'play' } })).toEqual({})
    expect(relayTransportMessage('guest', { t: 'transport-request', payload: { action: 'play' } })).toBeNull()
    expect(RESET_REJECTED).toMatch(/host/i)
  })

  it('shows Reset for the host and a disabled Host only control for a guest', () => {
    const store = new ProjectStore()
    const host = markup(store, 'host')
    const guest = markup(store, 'guest')
    const solo = markup(store)
    expect(host).toContain('>Reset<')
    expect(host).toContain('fix glitches')
    expect(host).not.toContain('>Host only<')
    expect(solo).toContain('>Reset<')
    expect(solo).toContain('fix glitches')
    expect(guest).toContain('>Host only<')
    expect(guest).toContain('disabled')
    expect(guest).not.toContain('>Reset<')
  })

  it('stops at the start and clears toasts without changing the project or undo history', async () => {
    vi.useFakeTimers()
    const store = new ProjectStore()
    store.setTempo(99)
    const before = JSON.stringify(store.project)
    const undo = store.canUndo
    const redo = store.canRedo
    const pending = store.sync.peek().length
    store.toast('The audio graph stalled.', 'warn')
    expect(store.toasts.some((toast) => toast.text.includes('stalled'))).toBe(true)
    store.clearToasts()
    expect(store.toasts).toEqual([])

    const engine = new AudioEngine()
    engine.positionSamples = 48000
    engine.status = 'recording'
    const sent: number[][] = []
    engine.midiSink = (bytes) => { sent.push(bytes) }
    await engine.panic()
    vi.runOnlyPendingTimers()

    expect(engine.positionSamples).toBe(0)
    expect(engine.status).toBe('stopped')
    expect(sent).toEqual(midiPanicMessages())
    expect(sent.some((bytes) => bytes[0] === 0xb0 && bytes[1] === 123)).toBe(true)
    expect(sent.some((bytes) => bytes[0] === 0xb0 && bytes[1] === 121)).toBe(true)
    expect(sent.at(-1)).toEqual([0xfc])
    expect(JSON.stringify(store.project)).toBe(before)
    expect(store.canUndo).toBe(undo)
    expect(store.canRedo).toBe(redo)
    expect(store.sync.peek().length).toBe(pending)
    expect(store.toasts).toEqual([])
    vi.useRealTimers()
  })
})
