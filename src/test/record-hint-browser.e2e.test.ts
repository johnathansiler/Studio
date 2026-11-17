import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const port = 4623
const url = `http://127.0.0.1:${port}`

async function waitForServer(child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 25000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      if ((await fetch(url)).ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

/** Watch the 2800 ms arm-hint timer so the test can tell a cancel from a natural expiry. */
async function watchArmHintTimer(page: Page) {
  await page.addInitScript(() => {
    const realSet = window.setTimeout.bind(window)
    const realClear = window.clearTimeout.bind(window)
    const pending = new Set<number>()
    const cleared = new Set<number>()
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      const id = realSet(fn, ms as number, ...args) as unknown as number
      if (ms === 2800) pending.add(id)
      return id
    }) as typeof window.setTimeout
    window.clearTimeout = ((id?: number) => {
      if (typeof id === 'number' && pending.has(id)) {
        pending.delete(id)
        cleared.add(id)
      }
      return realClear(id)
    }) as typeof window.clearTimeout
    ;(window as unknown as { __armHintTimers: { pending: Set<number>; cleared: Set<number> } }).__armHintTimers = { pending, cleared }
  })
}

async function armHintTimers(page: Page) {
  return page.evaluate(() => {
    const book = (window as unknown as { __armHintTimers: { pending: Set<number>; cleared: Set<number> } }).__armHintTimers
    return { pending: book.pending.size, cleared: book.cleared.size }
  })
}

async function routeLibrary(page: Page) {
  await page.route('**/api/library**', async (route) => {
    const target = route.request().url()
    if (target.includes('/api/library/sign') || route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true }) })
  })
}

describe('record arm hint and desktop browser', () => {
  let child: ChildProcess
  let browser: Browser

  beforeAll(async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(child)
    browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    })
  }, 30000)

  afterAll(async () => {
    await browser?.close()
    child?.kill('SIGTERM')
  })

  it('clears the arm hint as soon as count-in or recording starts', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await watchArmHintTimer(page)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await page.getByRole('button', { name: /^Record\./ }).click()
      await page.locator('.rec-hint').filter({ hasText: 'Arm a track to record.' }).waitFor()
      const shownAt = Date.now()
      const scheduled = await armHintTimers(page)
      expect(scheduled.pending).toBe(1)
      expect(scheduled.cleared).toBe(0)

      const keysArm = page.locator('[data-track-name="Keys"]').getByRole('button', { name: /^Arm\b/ })
      if (await keysArm.count()) await keysArm.click()
      else {
        await page.evaluate(() => {
          const store = (window as unknown as {
            __cueharbor: { store: { project: { tracks: { id: string; name: string }[] }; updateTrack: (id: string, patch: { armed: boolean }) => void } }
          }).__cueharbor.store
          const keys = store.project.tracks.find((track) => track.name === 'Keys')
          if (!keys) throw new Error('missing Keys')
          store.updateTrack(keys.id, { armed: true })
        })
      }
      await page.waitForFunction(() => {
        const store = (window as unknown as { __cueharbor?: { store: { project: { tracks: { name: string; armed: boolean }[] } } } }).__cueharbor?.store
        return store?.project.tracks.some((track) => track.name === 'Keys' && track.armed)
      })
      expect(await page.locator('.rec-hint').innerText()).toBe('Arm a track to record.')

      await page.getByRole('button', { name: /^Record\./ }).click()
      await page.waitForFunction(() => !document.querySelector('.rec-hint'), undefined, { timeout: 2000 })
      expect(Date.now() - shownAt, 'the hint lasted until its 2800 ms timer').toBeLessThan(2800)
      await page.waitForFunction(() => {
        const status = (window as unknown as { __cueharbor?: { engine: { status: string } } }).__cueharbor?.engine.status
        return status === 'counting-in' || status === 'recording'
      }, undefined, { timeout: 15000 })
      expect(await page.locator('.rec-hint').count()).toBe(0)
      const booked = await armHintTimers(page)
      expect(booked.pending, 'the 2800 ms hint timer is still running').toBe(0)
      expect(booked.cleared, 'the hint timer was not cancelled').toBeGreaterThanOrEqual(1)
      const status = await page.evaluate(() => (window as unknown as { __cueharbor: { engine: { status: string } } }).__cueharbor.engine.status)
      expect(['counting-in', 'recording']).toContain(status)
      await page.screenshot({ path: '/opt/cursor/artifacts/record-hint-cleared-1440x900.png' })
    } finally {
      await page.close()
    }
  }, 40000)

  it('starts desktop with the browser closed and still opens the passphrase gate', async () => {
    const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await routeLibrary(desk)
    try {
      await desk.goto(url, { waitUntil: 'domcontentloaded' })
      await desk.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await desk.locator('.shell[data-form="desk"]').waitFor()
      await desk.locator('.timeline-scroll').waitFor()
      expect(await desk.locator('[data-playlist-browser="open"]').count()).toBe(0)
      expect(await desk.getByLabel('Library passphrase').count()).toBe(0)
      const browserButton = desk.locator('.arrange-panels').getByRole('button', { name: /^Browser/ })
      expect(await browserButton.getAttribute('aria-pressed')).toBe('false')
      const heads = await desk.locator('.heads-col').boundingBox()
      expect(heads).toBeTruthy()
      expect(heads!.x).toBeLessThan(24)
      await desk.screenshot({ path: '/opt/cursor/artifacts/desktop-browser-closed-1440x900.png' })

      await browserButton.click()
      const open = desk.locator('[data-playlist-browser="open"]')
      await open.waitFor()
      await desk.getByLabel('Library passphrase').waitFor()
      expect(await browserButton.getAttribute('aria-pressed')).toBe('true')
      const pane = await open.boundingBox()
      const arrange = await desk.locator('.arrange').boundingBox()
      const gate = await desk.getByLabel('Library passphrase').boundingBox()
      expect(pane).toBeTruthy()
      expect(arrange).toBeTruthy()
      expect(gate).toBeTruthy()
      expect(pane!.x).toBeLessThan(24)
      expect(pane!.x + pane!.width).toBeLessThanOrEqual((arrange!.x ?? 0) + 2)
      expect(gate!.x).toBeGreaterThanOrEqual(pane!.x)
      expect(gate!.x + gate!.width).toBeLessThanOrEqual(pane!.x + pane!.width + 2)
      await desk.screenshot({ path: '/opt/cursor/artifacts/desktop-browser-passphrase-1440x900.png' })
    } finally {
      await desk.close()
    }

    const requested = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await routeLibrary(requested)
    try {
      await requested.goto(`${url}/?sounds=1`, { waitUntil: 'domcontentloaded' })
      await requested.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await requested.locator('[data-playlist-browser="open"]').waitFor()
      await requested.getByLabel('Library passphrase').waitFor()
    } finally {
      await requested.close()
    }

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await routeLibrary(phone)
    try {
      await phone.goto(url, { waitUntil: 'domcontentloaded' })
      await phone.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await phone.locator('.shell[data-form="phone"]').waitFor()
      expect(await phone.locator('[data-playlist-browser="open"]').count()).toBe(0)
      expect(await phone.getByLabel('Library passphrase').count()).toBe(0)
      await phone.getByRole('button', { name: 'Browse', exact: true }).click()
      const sheet = phone.locator('[data-playlist-browser="open"][data-bottom-sheet="open"]')
      await sheet.waitFor()
      await phone.getByLabel('Library passphrase').waitFor()
      const box = await sheet.boundingBox()
      expect(box).toBeTruthy()
      expect(box!.x).toBeLessThanOrEqual(2)
      expect(box!.width).toBeGreaterThanOrEqual(390 - 4)
      await phone.screenshot({ path: '/opt/cursor/artifacts/phone-browser-still-opens-390x844.png' })
    } finally {
      await phone.close()
    }
  }, 40000)
})
