import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
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

async function shot(page: Page, name: string) {
  mkdirSync('/opt/cursor/artifacts', { recursive: true })
  await page.screenshot({ path: `/opt/cursor/artifacts/${name}.png` })
}

describe('phone fit at 412x915', () => {
  it('gives the timeline, the step grid, and the mixer room to work', async () => {
    const port = 4183
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await waitForServer(url, child)
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage({ viewport: { width: 412, height: 915 } })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        const timeline = await page.evaluate(() => {
          const lane = document.querySelector('.timeline-scroll')!.getBoundingClientRect()
          const names = [...document.querySelectorAll<HTMLInputElement>('.pl-head .name')].map((name) => ({
            value: name.value,
            width: name.getBoundingClientRect().width,
            clipped: name.scrollWidth > name.clientWidth + 2,
          }))
          return { ratio: lane.height / window.innerHeight, names }
        })
        const history = await page.evaluate(() => {
          return ['[data-history="undo"]', '[data-history="redo"]'].map((selector) => {
            const button = document.querySelector(selector) as HTMLElement
            const word = button.querySelector('.history-word') as HTMLElement
            const box = button.getBoundingClientRect()
            return {
              text: word.textContent,
              display: getComputedStyle(word).display,
              top: box.top,
              bottom: box.bottom,
              right: box.right,
            }
          })
        })
        for (const button of history) {
          expect(button.display).not.toBe('none')
          expect(button.text === 'Undo' || button.text === 'Redo').toBe(true)
          expect(button.top).toBeGreaterThanOrEqual(0)
          expect(button.bottom).toBeLessThanOrEqual(96)
          expect(button.right).toBeLessThanOrEqual(412 + 1)
        }
        const loop = await page.locator('.t-btn.loop .t-word').boundingBox()
        expect(loop).toBeTruthy()
        expect(loop!.x + loop!.width).toBeLessThanOrEqual(412 + 1)
        expect(timeline.ratio).toBeGreaterThanOrEqual(0.65)
        expect(timeline.names.map((item) => item.value)).toEqual(['Vocal', 'Music', 'Keys'])
        for (const name of timeline.names) {
          expect(name.width, name.value).toBeGreaterThan(48)
          expect(name.clipped, name.value).toBe(false)
        }
        const buttonsFit = await page.evaluate(() => {
          return [...document.querySelectorAll<HTMLElement>('.pl-head .mini, .pl-head .piano-open')].every((button) => {
            const head = button.closest('.head')!.getBoundingClientRect()
            const box = button.getBoundingClientRect()
            return box.bottom <= head.bottom + 1 && box.right <= head.right + 1
          })
        })
        expect(buttonsFit).toBe(true)
        await shot(page, 'live-arrange-412')

        await page.getByRole('button', { name: /^Beats/ }).click()
        await page.locator('.rack-step').first().waitFor()
        const grid = await page.evaluate(() => {
          const steps = [...document.querySelectorAll('.rack-row[data-channel="Kick"] .rack-step')].map((el) => el.getBoundingClientRect())
          const view = document.querySelector('.rack-scroll')?.getBoundingClientRect()
          return {
            count: steps.length,
            height: steps[0]?.height ?? 0,
            rows: new Set(steps.map((box) => Math.round(box.top))).size,
            within: steps.every((box) => box.right <= window.innerWidth + 1 && box.left >= -1),
            names: [...document.querySelectorAll<HTMLElement>('.rack-name')].map((el) => el.textContent?.trim()),
            viewHeight: view?.height ?? 0,
          }
        })
        expect(grid.count).toBe(16)
        expect(grid.height).toBeGreaterThanOrEqual(40)
        expect(grid.rows).toBe(2)
        expect(grid.within).toBe(true)
        expect(grid.names).toContain('Kick')
        await shot(page, 'live-beats-steps-412')
        await page.getByRole('button', { name: /^Roll/ }).click()
        await page.locator('[data-drum-roll="open"]').waitFor()
        const roll = await page.locator('.drum-lane').count()
        expect(roll).toBeGreaterThan(0)
        await shot(page, 'live-beats-412')

        await page.getByRole('button', { name: /^Mix/ }).click()
        await page.locator('.mixer .strip').first().waitFor()
        const mix = await page.evaluate(() => {
          const mute = document.querySelector('.strip button[aria-label*="Mute"]') as HTMLElement
          mute.scrollIntoView({ block: 'center' })
          const box = mute.getBoundingClientRect()
          const caption = getComputedStyle(mute.querySelector('.mini-caption')!).display
          const safe = document.querySelector('.strip .solo-safe .mode-caption') as HTMLElement | null
          return { top: box.top, bottom: box.bottom, caption, safe: safe ? getComputedStyle(safe).display : 'missing', view: window.innerHeight }
        })
        expect(mix.top).toBeGreaterThanOrEqual(0)
        expect(mix.bottom).toBeLessThanOrEqual(mix.view + 1)
        expect(mix.caption).not.toBe('none')
        expect(mix.safe).not.toBe('none')
        await shot(page, 'live-mix-412')

        const fold = await browser.newPage({ viewport: { width: 923, height: 1024 } })
        await fold.goto(url, { waitUntil: 'domcontentloaded' })
        await fold.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await shot(fold, 'live-arrange-923')
        await fold.close()
        await page.close()
      } finally {
        await browser.close()
      }
    } finally {
      child.kill('SIGTERM')
    }
  }, 60000)
})
