import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function panOf(page: Page, index: number) {
  return page.evaluate((at) => {
    const cue = (window as unknown as { __cueharbor: { store: { project: { tracks: { pan: number }[] } } } }).__cueharbor
    return cue.store.project.tracks[at].pan
  }, index)
}

describe('mixer insert and pan controls', () => {
  it('opens an insert on the clicked track and pans that track', async () => {
    const port = 4318
    const url = `http://127.0.0.1:${port}`
    const child = spawn('./node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Mix/ }).first().click()
      await page.locator('.mixer > .strip .pan-knob').first().waitFor()
      const before = await panOf(page, 1)
      const musicPan = page.locator('.mixer > .strip').nth(1).locator('.pan-knob')
      await musicPan.focus()
      await page.keyboard.press('ArrowRight')
      const after = await panOf(page, 1)
      expect(after).toBeGreaterThan(before)
      expect(await musicPan.getAttribute('aria-valuetext')).toMatch(/Right|Center/)
      await page.locator('.mixer > .strip').nth(1).getByRole('button', { name: /Add insert on/ }).click()
      await page.getByRole('button', { name: 'Delay', exact: true }).click()
      const placed = await page.evaluate(() => {
        const tracks = (window as unknown as { __cueharbor: { store: { project: { tracks: { name: string; plugins: { pluginId: string }[] }[] } } } }).__cueharbor.store.project.tracks
        return tracks.map((track) => ({ name: track.name, plugins: track.plugins.map((plugin) => plugin.pluginId) }))
      })
      const music = placed[1]
      expect(music.plugins).toContain('delay')
      expect(placed[0].plugins).not.toContain('delay')
      await page.locator('.mixer > .strip').nth(1).locator('.strip-insert[data-plugin-id="delay"]').click()
      await page.getByRole('dialog', { name: 'Delay' }).waitFor()
      await page.evaluate(() => {
        const cue = (window as unknown as { __cueharbor: { store: { undo(): void } } }).__cueharbor
        cue.store.undo()
      })
      const undone = await page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { project: { tracks: { plugins: { pluginId: string }[] }[] } } } }).__cueharbor.store
        return store.project.tracks[1].plugins.map((plugin) => plugin.pluginId)
      })
      expect(undone).not.toContain('delay')
    } finally {
      child.kill('SIGTERM')
      await browser?.close()
    }
  }, 60000)
})
