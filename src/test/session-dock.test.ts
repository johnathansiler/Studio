import { mkdirSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AUDIO_DEVICES, DRUM_DEVICES, INSTRUMENT_DEVICES, MIDI_DEVICES, PLUGIN_DEVICES } from '../model/sessionBoard'
import type { SoundEntry } from '../sounds/types'
import { ProjectStore } from '../state/store'
import { addBrowserDevice } from '../ui/sessionBrowser'
import { SoundBrowser } from '../ui/SoundBrowser'
import { dockVisible, EDITOR_DOCK_DEFAULT, fittedDockWidth, nextSessionDock, paneAfterRestore, pianoDockWidth, sessionDockOpen } from '../ui/sessionDock'

describe('session dock choice', () => {
  it('stays closed until someone opens it, including older saved rooms', () => {
    expect(sessionDockOpen(null)).toBe(false)
    expect(sessionDockOpen('')).toBe(false)
    expect(sessionDockOpen('closed')).toBe(false)
    expect(sessionDockOpen('open')).toBe(true)
    expect(paneAfterRestore('room', false)).toBe('edit')
    expect(paneAfterRestore('room', true)).toBe('room')
    expect(paneAfterRestore('edit', true)).toBe('edit')
    expect(nextSessionDock({ dockOpen: false, phonePane: 'edit', action: 'session' })).toEqual({ dockOpen: true, phonePane: 'room' })
    expect(nextSessionDock({ dockOpen: true, phonePane: 'room', action: 'session' })).toEqual({ dockOpen: false, phonePane: 'edit' })
    expect(nextSessionDock({ dockOpen: true, phonePane: 'edit', action: 'session' })).toEqual({ dockOpen: true, phonePane: 'room' })
    expect(nextSessionDock({ dockOpen: true, phonePane: 'room', action: 'hide' })).toEqual({ dockOpen: false, phonePane: 'edit' })
    expect(dockVisible({ surface: 'studio', panel: 'room', dockOpen: false })).toBe(false)
    expect(dockVisible({ surface: 'studio', panel: 'room', dockOpen: true })).toBe(false)
    expect(dockVisible({ surface: 'studio', panel: 'piano', dockOpen: false })).toBe(true)
    expect(dockVisible({ surface: 'studio', panel: 'rack', dockOpen: false })).toBe(true)
    expect(dockVisible({ surface: 'studio', panel: 'scaler', dockOpen: false })).toBe(true)
    expect(dockVisible({ surface: 'studio', panel: 'pads', dockOpen: false })).toBe(true)
    expect(dockVisible({ surface: 'artist', panel: 'room', dockOpen: true })).toBe(false)
  })

  it('keeps a side editor inside the viewport and leaves the work visible', () => {
    expect(fittedDockWidth(1280, EDITOR_DOCK_DEFAULT)).toBe(EDITOR_DOCK_DEFAULT)
    const wide = fittedDockWidth(1280, 900)
    expect(wide).toBeLessThanOrEqual(640)
    expect(wide).toBeGreaterThanOrEqual(280)
    expect(1280 - wide).toBeGreaterThanOrEqual(320)
    expect(fittedDockWidth(1100, 760)).toBeLessThanOrEqual(550)
    expect(fittedDockWidth(1280, 200)).toBe(280)
    expect(fittedDockWidth(500, 400)).toBeLessThanOrEqual(180)
    expect(500 - fittedDockWidth(500, 400)).toBeGreaterThanOrEqual(320)
    expect(fittedDockWidth(800, 700, 'bottom')).toBeLessThanOrEqual(520)
    expect(pianoDockWidth(1280)).toBeGreaterThanOrEqual(Math.round(1280 * 0.6))
    expect(pianoDockWidth(1440)).toBeGreaterThanOrEqual(Math.round(1440 * 0.6))
    expect(pianoDockWidth(1280)).toBeLessThanOrEqual(Math.floor(1280 * 0.72))
  })
})

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function spansArrange(page: Page) {
  await page.getByRole('button', { name: /Arrange/ }).first().waitFor()
  const box = await page.evaluate(() => {
    const work = document.querySelector('.workspace')!.getBoundingClientRect()
    const main = document.querySelector('.main-pane')!.getBoundingClientRect()
    const dock = document.querySelector('.dock-slot')
    return {
      work: work.width,
      main: main.width,
      dock: dock ? dock.getBoundingClientRect().width : 0,
      open: document.querySelector('.shell')?.getAttribute('data-dock'),
      invite: !!document.body.textContent?.includes('Host a Collab'),
    }
  })
  expect(box.open).toBe('closed')
  expect(box.invite).toBe(false)
  expect(box.dock).toBe(0)
  expect(box.main).toBeGreaterThan(box.work - 4)
}

async function closeToolSheet(page: Page) {
  const sheet = page.locator('#tool-choices')
  if (await sheet.count()) {
    const close = sheet.getByRole('button', { name: 'Close', exact: true })
    if (await close.count()) await close.click()
    else await page.getByRole('button', { name: 'Tools', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })
  }
}

async function drawAndTrim(page: Page) {
  const draw = page.getByRole('button', { name: /^Draw/ })
  if (!(await draw.isVisible().catch(() => false))) {
    const legacy = page.getByRole('button', { name: /^Tool:/ })
    if (await legacy.count()) await legacy.click()
    else await page.getByRole('button', { name: 'Tools', exact: true }).click()
  }
  await draw.click()
  await closeToolSheet(page)
  const view = await page.locator('.timeline-scroll').boundingBox()
  const lane = await page.locator('.timeline-scroll .lane').first().boundingBox()
  if (!view || !lane) throw new Error('no lane')
  const y = Math.min(lane.y + 36, view.y + view.height - 12)
  const left = view.x + 28
  const right = view.x + Math.max(120, view.width - 36)
  await page.mouse.move(left, y)
  await page.mouse.down()
  await page.mouse.move(right, y, { steps: 8 })
  await page.mouse.up()
  const clip = page.locator('[data-clip]').first()
  await clip.waitFor()
  const select = page.getByRole('button', { name: /^Select/ })
  if (!(await select.isVisible().catch(() => false))) {
    const picker = page.getByRole('button', { name: /^Tool:/ })
    if (await picker.count()) {
      if ((await picker.getAttribute('aria-expanded')) !== 'true') await picker.click()
    } else await page.getByRole('button', { name: 'Tools', exact: true }).click()
  }
  await select.click()
  await closeToolSheet(page)
  await page.mouse.click(view.x + 30, Math.min(lane.y + 110, view.y + view.height - 12))
  await page.mouse.move(2, 2)
  const edge = clip.locator('[data-edge="end"]')
  await edge.scrollIntoViewIfNeeded()
  const grip = await edge.evaluate((el) => {
    const after = getComputedStyle(el, '::after')
    return { opacity: Number(after.opacity), width: after.width, selected: el.parentElement?.classList.contains('selected') ?? false }
  })
  expect(grip.selected).toBe(false)
  expect(grip.opacity).toBeGreaterThan(0.9)
  const before = await clip.boundingBox()
  const edgeBox = await edge.boundingBox()
  if (!before || !edgeBox) throw new Error('clip edge missing')
  expect(edgeBox.width).toBeGreaterThanOrEqual(28)
  const startEdge = await clip.locator('[data-edge="start"]').boundingBox()
  expect(startEdge?.width).toBeGreaterThanOrEqual(28)
  const gripX = Math.min(edgeBox.x + 8, view.x + view.width - 8)
  const gripY = edgeBox.y + Math.min(20, edgeBox.height / 2)
  const roomy = before.width > 160
  const drag = roomy ? Math.min(70, Math.max(36, before.width * 0.4)) : Math.max(14, Math.min(28, before.width * 0.22))
  await page.mouse.move(gripX, gripY)
  await page.mouse.down()
  await page.mouse.move(gripX - drag, gripY, { steps: 12 })
  if ((await page.evaluate(() => window.innerWidth)) < 500) {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    await page.screenshot({ path: '/opt/cursor/artifacts/arrange-drag-shadow-412.png' })
  }
  await page.mouse.up()
  await page.waitForTimeout(80)
  const after = await clip.boundingBox()
  if (!after) throw new Error('clip vanished')
  expect(after.width).toBeLessThan(before.width - (roomy ? 12 : 2))
  expect(Math.abs(after.x - before.x)).toBeLessThan(8)
  const narrow = (await page.evaluate(() => window.innerWidth)) < 500
  if (!narrow) {
    const start = clip.locator('[data-edge="start"]')
    const startBox = await start.boundingBox()
    const mid = await clip.boundingBox()
    if (!startBox || !mid) throw new Error('start edge missing')
    const startX = startBox.x + Math.min(8, startBox.width / 2)
    const startY = startBox.y + Math.min(20, startBox.height / 2)
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 60, startY, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(80)
    const trimmedStart = await clip.boundingBox()
    if (!trimmedStart) throw new Error('clip vanished')
    expect(trimmedStart.x).toBeGreaterThan(mid.x + 12)
    expect(trimmedStart.width).toBeLessThan(mid.width - 12)
  }
}

const loop: SoundEntry = {
  id: 'loop-dust',
  path: 'loops/dust.wav',
  name: 'Dust',
  type: 'loop',
  tags: ['pad'],
  bpm: 90,
  key: 'C major',
  durationSec: 2,
  sampleRate: 48000,
  license: 'CC0',
  source: 'CueHarbor',
}

describe('session browser devices', () => {
  it('keeps tempo, key, and favorites inside the Filter menu', () => {
    const store = new ProjectStore()
    const markup = renderToStaticMarkup(createElement(SoundBrowser, {
      store,
      phone: true,
      engine: { unlock() {}, stopPreview() {}, previewPcm() {}, currentTimelineSample: () => 0 },
      onClose() {},
      initial: { entries: [loop], status: 'ok' },
      instruments: [],
    }))
    expect(markup).toContain('>Filter<')
    expect(markup).toContain('sound-filter-menu')
    expect(markup).toContain('Any tempo')
    expect(markup).toContain('Song tempo')
    expect(markup).toContain('Any key')
    expect(markup).toContain('C major')
    expect(markup).toContain('Favorite')
    expect(markup).not.toContain('>Favorites<')
    expect(markup).toContain('>Load<')
    expect(markup).not.toContain('>Save<')
  })

  it('adds an effect, an instrument, and a plugin from the browser onto a track', () => {
    const store = new ProjectStore()
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    store.selectTrack(vocal.id)
    addBrowserDevice(store, AUDIO_DEVICES.find((item) => item.id === 'eq')!)
    expect(store.track(vocal.id)!.plugins.some((plugin) => plugin.pluginId === 'eq')).toBe(true)
    addBrowserDevice(store, INSTRUMENT_DEVICES.find((item) => item.id === 'synth')!)
    expect(store.track(keys.id)!.instrument).toBe('synth')
    addBrowserDevice(store, MIDI_DEVICES.find((item) => item.id === 'arp')!)
    expect(store.track(keys.id)!.midiFx?.some((fx) => fx.kind === 'arp')).toBe(true)
    store.selectTrack(keys.id)
    addBrowserDevice(store, PLUGIN_DEVICES.find((item) => item.id === 'steps')!)
    expect(store.track(keys.id)!.plugins.some((plugin) => plugin.pluginId === 'steps')).toBe(true)
    addBrowserDevice(store, AUDIO_DEVICES.find((item) => item.id === 'reverb')!)
    expect(store.track(keys.id)!.plugins.some((plugin) => plugin.pluginId === 'reverb')).toBe(true)
    addBrowserDevice(store, DRUM_DEVICES.find((item) => item.id === '808')!)
    expect(store.track(keys.id)!.instrument).toBe('808')
    addBrowserDevice(store, DRUM_DEVICES.find((item) => item.id === 'drum-machine')!)
    expect(store.track(keys.id)!.instrument).toBe('drum-machine')
    expect(store.track(keys.id)!.plugins.some((plugin) => plugin.pluginId === 'steps')).toBe(true)
  })
})

describe('arrange on first load', () => {
  it('keeps Arrange and Collab working with no Session UI, and trims a clip from its edge', async () => {
    const port = 4179
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 1280, height: 800 },
      ]) {
        const context = await browser.newContext({ viewport })
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await spansArrange(page)
        await drawAndTrim(page)
        await context.close()
      }
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await spansArrange(page)
      expect(await page.getByRole('button', { name: /^Session/ }).count()).toBe(0)
      expect(await page.locator('[data-session-view="open"]').count()).toBe(0)
      expect(await page.locator('[data-session-browser="open"]').count()).toBe(0)
      expect(await page.getByRole('button', { name: /To arrangement/ }).count()).toBe(0)
      await page.locator('.menu-btn').click()
      await page.locator('#shell-menu [data-menu-action]').first().waitFor()
      const actions = await page.locator('#shell-menu [data-menu-action]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-action')))
      expect(actions).not.toContain('session-mode')
      expect(actions).not.toContain('capture')
      await page.keyboard.press('Escape')
      expect(await page.getByRole('button', { name: /Host a Collab/ }).count()).toBe(0)
      expect(await page.locator('[data-collab-panel="open"]').count()).toBe(0)
      expect(await page.locator('.views button').count()).toBe(3)
      for (const tab of [/^Arrange/, /^Mix/]) {
        await page.getByRole('button', { name: tab }).first().click()
        expect(await page.locator('[data-collab-panel="open"]').count()).toBe(0)
        expect(await page.getByRole('button', { name: /Host a Collab/ }).count()).toBe(0)
      }
      await page.getByRole('button', { name: /^Collab/ }).click()
      await page.getByRole('button', { name: /Host a Collab/ }).waitFor()
      expect(await page.locator('[data-session-view="open"]').count()).toBe(0)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /Host a Collab/ }).waitFor()
      const opened = await page.evaluate(() => document.querySelector('.shell')?.getAttribute('data-collab'))
      expect(opened).toBe('open')
      await page.getByRole('button', { name: /^Arrange/ }).first().click()
      expect(await page.locator('[data-collab-panel="open"]').count()).toBe(0)
      await page.getByRole('button', { name: /^Collab/ }).click()
      await page.getByRole('button', { name: /^Arrange/ }).first().click()
      await spansArrange(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await spansArrange(page)
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 90000)
})
