import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { createServer } from 'vite'
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

function markup(store: ProjectStore, roomRole?: 'host' | 'guest', phone = false) {
  return renderToStaticMarkup(createElement(TransportBar, {
    store,
    engine: engineStub as never,
    roomRole,
    phone,
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

  it('shows Metronome and Count-in on the transport row, with no More menu', () => {
    const store = new ProjectStore()
    store.project.metronomeEnabled = false
    store.project.countIn = false
    store.project.countInBars = 0
    const off = markup(store)
    expect(off).toContain('id="transport-click"')
    expect(off).toContain('id="transport-count"')
    expect(off).toContain('id="transport-reset"')
    expect(off).toContain('aria-label="Metronome. Metronome while you play and record."')
    expect(off).toContain('aria-label="Count-in. Count one bar before recording starts."')
    expect(off).toContain('>1-2<')
    expect(off).not.toContain('>More<')
    expect(off).not.toContain('id="transport-menu"')
    expect(off).not.toContain('transport-drawer')
    expect(off).not.toContain('click on')
    expect(off).not.toContain('count on')
    expect(off).toContain('aria-pressed="false"')

    store.toggle('metronomeEnabled')
    store.toggle('countIn')
    expect(store.project.metronomeEnabled).toBe(true)
    expect(store.project.countIn).toBe(true)
    expect(store.project.countInBars).toBe(1)
    const on = markup(store)
    expect(on).toContain('click on')
    expect(on).toContain('count on')
    expect(on).toContain('aria-pressed="true"')
    store.toggle('metronomeEnabled')
    store.toggle('countIn')
    expect(store.project.metronomeEnabled).toBe(false)
    expect(store.project.countIn).toBe(false)

    const phone = markup(store, undefined, true)
    expect(phone).not.toContain('id="transport-click"')
    expect(phone).not.toContain('>Click<')
    expect(phone).not.toContain('id="transport-count"')
    expect(phone).not.toContain('>1-2<')
    expect(phone).toContain('id="transport-reset"')
    const ids = TRANSPORT_COPY.map((item) => item.id)
    expect(ids.filter((id) => id === 'click')).toHaveLength(1)
    expect(ids.filter((id) => id === 'count-in')).toHaveLength(1)
  })
})

describe('transport row actions', () => {
  it('toggles metronome and count-in, and reset calls the transport reset', async () => {
    const server = await createServer({
      configFile: resolve(import.meta.dirname, '../../vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await server.listen()
    const address = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${server.config.server.port}`
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      await page.goto(`${address}src/test/transport-row.harness.html`, { waitUntil: 'networkidle' })
      expect(await page.locator('#transport-count').count()).toBe(0)
      expect(await page.locator('#transport-click').count()).toBe(0)
      expect(await page.locator('.t-word', { hasText: /^Click$/ }).count()).toBe(0)
      expect(await page.locator('.t-word', { hasText: '1-2' }).count()).toBe(0)
      expect(await page.locator('.t-btn.menu, #transport-menu').count()).toBe(0)
      const names = await page.locator('.t-main > .t-btn, .t-main > .tempo-cluster').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') || node.getAttribute('aria-label')))
      expect(names).toHaveLength(6)
      const row = await page.locator('.t-main > .t-btn, .t-main > .tempo-cluster').evaluateAll((nodes) => {
        const boxes = nodes.map((node) => node.getBoundingClientRect())
        return {
          count: boxes.length,
          tops: boxes.map((box) => Math.round(box.top)),
          min: Math.min(...boxes.map((box) => box.width)),
          minHeight: Math.min(...boxes.map((box) => box.height)),
        }
      })
      expect(row.count).toBe(6)
      expect(new Set(row.tops).size).toBe(1)
      expect(row.min).toBeGreaterThanOrEqual(40)
      expect(row.minHeight).toBeGreaterThanOrEqual(40)

      expect(await page.locator('#resets').getAttribute('data-n')).toBe('0')
      await page.locator('#transport-reset').click()
      expect(await page.locator('#resets').getAttribute('data-n')).toBe('1')
    } finally {
      await browser.close()
      await server.close()
    }
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
    expect(host).toContain('aria-label="Reset. Reset – fix glitches"')
    expect(host).toContain('fix glitches')
    expect(host).not.toContain('Host only')
    expect(solo).toContain('aria-label="Reset. Reset – fix glitches"')
    expect(solo).toContain('fix glitches')
    expect(guest).toContain('aria-label="Host only. Host only"')
    expect(guest).toContain('disabled')
    expect(guest).not.toContain('aria-label="Reset.')
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
