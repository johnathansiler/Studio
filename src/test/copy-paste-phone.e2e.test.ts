import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const PHONES = [
  { name: '384x840', width: 384, height: 840 },
  { name: '884x960', width: 884, height: 960 },
] as const

async function waitForServer(url: string, child: ChildProcess) {
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

async function arrange(page: Page) {
  await page.goto('http://127.0.0.1:4661', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^Arrange/ }).first().click()
  await page.locator('.timeline-scroll').waitFor()
  await page.locator('[data-phone-context="arrange"]').waitFor()
}

describe('phone copy and paste', () => {
  it('shows Copy, Cut, Paste, and Duplicate for a selected clip at both phone sizes', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '4661', '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer('http://127.0.0.1:4661', child)
      browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' })
      for (const viewport of PHONES) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: true,
          isMobile: true,
          deviceScaleFactor: 1,
        })
        const page = await context.newPage()
        await arrange(page)
        await page.evaluate(() => {
          const store = (window as unknown as {
            __cueharbor: { store: { project: { tracks: { id: string; type: string }[]; sampleRate: number }; drawRegion: (id: string, a: number, b: number) => void } }
          }).__cueharbor.store
          const track = store.project.tracks.find((item) => item.type === 'audio')
          if (!track) throw new Error('no audio track')
          store.drawRegion(track.id, 0, store.project.sampleRate)
        })
        await page.locator('[data-edit-row="clips"]').waitFor()
        const before = await page.evaluate(() => {
          const row = document.querySelector('[data-edit-row="clips"]') as HTMLElement
          const buttons = [...row.querySelectorAll('button')].map((button) => ({
            action: button.getAttribute('data-phone-action') || button.id,
            label: (button.textContent || '').replace(/\s+/g, ' ').trim(),
            width: button.getBoundingClientRect().width,
            height: button.getBoundingClientRect().height,
            right: button.getBoundingClientRect().right,
          })).filter((button) => button.width > 1 && button.height > 1)
          return {
            shell: document.querySelector('.shell')?.className ?? '',
            buttons,
          }
        })
        expect(before.shell, viewport.name).toContain('phone')
        const labels = before.buttons.map((button) => button.label).join(' ')
        expect(labels, viewport.name).toContain('Copy')
        expect(labels, viewport.name).toContain('Cut')
        expect(labels, viewport.name).toContain('Duplicate')
        expect(labels, viewport.name).not.toContain('Paste')
        for (const button of before.buttons) {
          expect(button.height, `${viewport.name} ${button.label}`).toBeGreaterThanOrEqual(40)
          expect(button.width, `${viewport.name} ${button.label}`).toBeGreaterThanOrEqual(44)
          expect(button.right, `${viewport.name} ${button.label}`).toBeLessThanOrEqual(viewport.width + 1)
        }
        await page.locator('[data-phone-action="copy"]').click()
        await page.locator('[data-phone-action="paste"]').waitFor()
        const paste = await page.locator('[data-phone-action="paste"]').boundingBox()
        expect(paste?.width ?? 0, viewport.name).toBeGreaterThanOrEqual(44)
        await page.screenshot({ path: `/opt/cursor/artifacts/copy-paste-${viewport.name}.png`, fullPage: true })
        await page.locator('[data-phone-action="paste"]').click()
        await expect.poll(async () => page.evaluate(() => {
          const store = (window as unknown as {
            __cueharbor: { store: { project: { tracks: { type: string; clips: unknown[] }[] } } }
          }).__cueharbor.store
          return store.project.tracks.find((track) => track.type === 'audio')?.clips.length ?? 0
        })).toBe(2)
        await context.close()
      }
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 120000)
})
