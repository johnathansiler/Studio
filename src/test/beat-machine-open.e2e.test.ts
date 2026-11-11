import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

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

async function beatOpen(page: Page) {
  const state = await page.evaluate(() => {
    const hook = (window as unknown as { __cueharbor?: { store: { padsTrackId: string | null } } }).__cueharbor
    const mark = (history.state as { cueharbor?: string } | null)?.cueharbor ?? null
    return {
      panel: document.querySelector('[data-pads="plugin"]') != null,
      pads: hook?.store.padsTrackId ?? null,
      mark,
    }
  })
  expect(state.panel).toBe(true)
  expect(state.pads).toBeTruthy()
  expect(state.mark).toBe('pads')
}

describe('beat machine stays open', () => {
  it('stays open from the Keys sheet and the track, including More and a pad menu', async () => {
    const port = 4388
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true })
    try {
      await waitForServer(url, child)
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('[data-track-name="Keys"]').waitFor()

      const keysHead = page.locator('[data-track-name="Keys"]')
      await keysHead.getByRole('button', { name: /Track\. Input/ }).tap()
      await page.locator('#track-options').waitFor()
      await page.locator('[data-track-action="drums"]').tap()
      await page.locator('[data-pads="plugin"]').waitFor()
      await page.waitForTimeout(1000)
      await beatOpen(page)
      expect(await page.locator('#track-options').count()).toBe(0)

      await page.getByRole('button', { name: 'Close Beat Machine. The track keeps the instrument.' }).tap()
      await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })

      await page.locator('[data-track-name="Beat Machine 1"] .track-meter-row').tap()
      await page.locator('[data-pads="plugin"]').waitFor()
      await page.waitForTimeout(1000)
      await beatOpen(page)

      await page.getByRole('button', { name: 'More', exact: true }).tap()
      const moreMenu = page.locator('.anchored-menu[aria-label="More"][data-open="true"]')
      await moreMenu.waitFor()
      await page.waitForTimeout(1000)
      await beatOpen(page)
      expect(await moreMenu.count()).toBe(1)
      expect(await moreMenu.getByRole('button', { name: 'Sync' }).count()).toBe(1)

      await page.getByRole('button', { name: 'Chop', exact: true }).tap()
      await page.getByRole('button', { name: 'Load sample' }).tap()
      const padMenu = page.locator('.anchored-menu[aria-label="Load sample"][data-open="true"]')
      await padMenu.waitFor()
      const padMenuText = await padMenu.innerText()
      expect(padMenuText).toContain('Browser')
      expect(padMenuText).toContain('Upload')
      await page.waitForTimeout(1000)
      await beatOpen(page)
      expect(await padMenu.count()).toBe(1)
      expect(await padMenu.innerText()).toContain('Browser')
      await context.close()
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 90000)
})
