import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { dockVisible, nextSessionDock, paneAfterRestore, sessionDockOpen } from '../ui/sessionDock'

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
    expect(dockVisible({ surface: 'studio', panel: 'room', dockOpen: true })).toBe(true)
    expect(dockVisible({ surface: 'studio', panel: 'piano', dockOpen: false })).toBe(true)
    expect(dockVisible({ surface: 'artist', panel: 'room', dockOpen: false })).toBe(true)
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
      invite: !!document.body.textContent?.includes('Create invite'),
    }
  })
  expect(box.open).toBe('closed')
  expect(box.invite).toBe(false)
  expect(box.dock).toBe(0)
  expect(box.main).toBeGreaterThan(box.work - 4)
}

async function drawAndTrim(page: Page) {
  await page.getByRole('button', { name: /^Draw/ }).click()
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
  await page.getByRole('button', { name: /^Select/ }).click()
  const edge = clip.locator('[data-edge="end"]')
  await edge.scrollIntoViewIfNeeded()
  const before = await clip.boundingBox()
  const edgeBox = await edge.boundingBox()
  if (!before || !edgeBox) throw new Error('clip edge missing')
  expect(edgeBox.width).toBeGreaterThanOrEqual(24)
  const startEdge = await clip.locator('[data-edge="start"]').boundingBox()
  expect(startEdge?.width).toBeGreaterThanOrEqual(24)
  const gripX = Math.min(edgeBox.x + 8, view.x + view.width - 8)
  const gripY = edgeBox.y + Math.min(20, edgeBox.height / 2)
  const drag = Math.min(70, Math.max(36, before.width * 0.4))
  await page.mouse.move(gripX, gripY)
  await page.mouse.down()
  await page.mouse.move(gripX - drag, gripY, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(80)
  const after = await clip.boundingBox()
  if (!after) throw new Error('clip vanished')
  expect(after.width).toBeLessThan(before.width - 12)
  expect(Math.abs(after.x - before.x)).toBeLessThan(8)
}

describe('arrange on first load', () => {
  it('keeps Session closed at phone and desktop widths, and trims a clip from its edge', async () => {
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
      await page.getByRole('button', { name: /^Session/ }).click()
      await page.getByRole('button', { name: /Create invite/ }).waitFor()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /Create invite/ }).waitFor()
      const opened = await page.evaluate(() => {
        const work = document.querySelector('.workspace')!.getBoundingClientRect().width
        const main = document.querySelector('.main-pane')!.getBoundingClientRect().width
        return { work, main, dock: document.querySelector('.shell')?.getAttribute('data-dock') }
      })
      expect(opened.dock).toBe('open')
      expect(opened.main).toBeLessThan(opened.work - 40)
      await page.getByRole('button', { name: /^Hide/ }).click()
      await spansArrange(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await spansArrange(page)
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 60000)
})
