import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { dockVisible, EDITOR_DOCK_DEFAULT, fittedDockWidth, nextSessionDock, paneAfterRestore, sessionDockOpen } from '../ui/sessionDock'

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
    expect(fittedDockWidth(800, 700, 'bottom')).toBeLessThanOrEqual(520)
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
  const start = clip.locator('[data-edge="start"]')
  const startBox = await start.boundingBox()
  const mid = await clip.boundingBox()
  if (!startBox || !mid) throw new Error('start edge missing')
  const startX = startBox.x + 8
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
      await page.locator('[data-session-view="open"]').waitFor()
      expect(await page.locator('.track-stop').first().getAttribute('aria-label')).toMatch(/Stop/)
      await page.locator('[data-session-browser="open"]').waitFor()
      await page.locator('[data-session-detail="open"]').waitFor()
      await page.locator('[data-mixer]').first().waitFor()
      const slot = page.locator('.session-col').nth(2).locator('.slot').first()
      await slot.dblclick()
      await expect.poll(async () => slot.innerText()).toContain('Clip')
      await page.getByRole('button', { name: /^Play/ }).click()
      await page.waitForFunction(() => /1\.2\./.test(document.querySelector('.lcd .bars')?.textContent || ''), null, { timeout: 8000 })
      await slot.locator('[data-slot-launch]').click()
      await page.locator('.slot[data-phase="queued"]').waitFor()
      const fit = await page.evaluate(() => {
        const browser = document.querySelector('.sl-browser')!.getBoundingClientRect()
        const detail = document.querySelector('.sl-detail')!.getBoundingClientRect()
        const work = document.querySelector('.workspace')!.getBoundingClientRect()
        const rights = [...document.querySelectorAll('.sl-browser button, .sl-detail button, .sl-detail select, .sl-head, .slot')].map((el) => el.getBoundingClientRect().right)
        return {
          browserRight: browser.right,
          detailRight: detail.right,
          detailBottom: detail.bottom,
          workRight: work.right,
          vw: window.innerWidth,
          vh: window.innerHeight,
          maxControl: Math.max(...rights),
        }
      })
      expect(fit.browserRight).toBeLessThanOrEqual(fit.vw + 1)
      expect(fit.detailRight).toBeLessThanOrEqual(fit.vw + 1)
      expect(fit.detailBottom).toBeLessThanOrEqual(fit.vh + 1)
      expect(fit.workRight).toBeLessThanOrEqual(fit.vw + 1)
      expect(fit.maxControl).toBeLessThanOrEqual(fit.vw + 1)
      expect(await page.getByRole('button', { name: /Create invite/ }).count()).toBe(0)
      expect(await page.locator('[data-collab-panel="open"]').count()).toBe(0)
      for (const tab of [/^Arrange/, /^Mix/, /^Beats/]) {
        await page.getByRole('button', { name: tab }).first().click()
        expect(await page.locator('[data-collab-panel="open"]').count()).toBe(0)
        expect(await page.getByRole('button', { name: /Create invite/ }).count()).toBe(0)
      }
      await page.getByRole('button', { name: /^Collab/ }).click()
      await page.getByRole('button', { name: /Create invite/ }).waitFor()
      expect(await page.locator('[data-session-view="open"]').count()).toBe(0)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /Create invite/ }).waitFor()
      const opened = await page.evaluate(() => document.querySelector('.shell')?.getAttribute('data-collab'))
      expect(opened).toBe('open')
      await page.getByRole('button', { name: /^Arrange/ }).first().click()
      expect(await page.locator('[data-collab-panel="open"]').count()).toBe(0)
      await page.getByRole('button', { name: /^Collab/ }).click()
      await page.getByRole('button', { name: /^Hide/ }).click()
      await spansArrange(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await spansArrange(page)
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 90000)
})
