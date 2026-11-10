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

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'wide-phone', width: 476, height: 752 },
  { name: 'fold', width: 880, height: 1000 },
  { name: 'desk', width: 1440, height: 900 },
  { name: 'land', width: 844, height: 390 },
] as const

async function controlRows(page: Page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll<HTMLElement>('[data-track-controls]')].map((row) => {
      const buttons = [...row.querySelectorAll<HTMLElement>('button')]
      const head = row.closest('.head')!.getBoundingClientRect()
      const tops = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))
      const clipped = buttons.map((button) => {
        const box = button.getBoundingClientRect()
        const controls = button.closest('.track-controls') as HTMLElement | null
        const pl = button.closest('.pl-head') as HTMLElement | null
        return {
          label: (button.textContent || '').trim(),
          right: Math.round(box.right),
          headRight: Math.round(head.right),
          bottom: Math.round(box.bottom),
          headBottom: Math.round(head.bottom),
          top: Math.round(box.top),
          headTop: Math.round(head.top),
          height: Math.round(box.height),
          pos: getComputedStyle(button).position,
          controls: controls ? Math.round(controls.getBoundingClientRect().width) : 0,
          pl: pl ? Math.round(pl.getBoundingClientRect().width) : 0,
        }
      }).filter((box) => box.bottom > box.headBottom + 1 || box.right > box.headRight + 1 || box.top < box.headTop - 1 || box.height < 39)
      const arrange = document.querySelector('.arrange') as HTMLElement | null
      const sample = document.querySelector('.head') as HTMLElement | null
      return {
        count: buttons.length,
        rows: tops.size,
        clipped: clipped.length > 0,
        detail: clipped,
        columns: arrange ? getComputedStyle(arrange).gridTemplateColumns : '',
        headCss: sample ? getComputedStyle(sample).width : '',
        shell: document.querySelector('.shell')?.className || '',
      }
    })
  })
}

describe('arrange track row and browser', () => {
  it('keeps one control row and loads sounds without a plugins catalog', async () => {
    const port = 4197
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    try {
      await waitForServer(url, child)
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage()
        for (const viewport of VIEWPORTS) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height })
          await page.goto(url, { waitUntil: 'domcontentloaded' })
          await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
          const closed = await controlRows(page)
          await page.screenshot({ path: `/opt/cursor/artifacts/arrange-${viewport.name}.png` })
          expect(closed.length, viewport.name).toBeGreaterThan(0)
          for (const row of closed) {
            expect(row.rows, `${viewport.name} closed`).toBe(1)
            expect(row.clipped, `${viewport.name} ${row.shell} ${row.headCss} ${row.columns}`).toBe(false)
          }
        }

        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await page.getByRole('button', { name: 'Browse', exact: true }).click()
        await page.locator('[data-playlist-browser="open"]').waitFor()
        const tabs = await page.locator('.browser-tabs button').allTextContents()
        expect(tabs.join(' ')).not.toMatch(/Plugins/)
        expect(tabs.map((label) => label.trim())).toEqual(expect.arrayContaining(['Sounds', 'Loops', 'Instruments', 'Patterns', 'Clips']))
        expect(tabs.join(' ')).not.toMatch(/\bProject\b/)
        expect(tabs.join(' ')).not.toMatch(/\bDrums\b/)
        await page.locator('.sound-chips').getByRole('button', { name: 'Drums' }).waitFor()
        await page.getByRole('button', { name: 'Load' }).first().waitFor({ timeout: 15000 })
        await page.locator('.playlist-browser').getByRole('button', { name: 'Patterns', exact: true }).click()
        await page.locator('[data-browser-title="patterns"]').waitFor()
        expect(await page.locator('[data-browser-title]').innerText()).toBe('Patterns')
        expect(await page.locator('.playlist-browser').getByRole('button', { name: /^Save/ }).count()).toBe(0)
        const open = await controlRows(page)
        for (const row of open) {
          expect(row.rows, 'phone browser open').toBe(1)
          expect(row.clipped, 'phone browser open clip').toBe(false)
        }
        await page.screenshot({ path: '/opt/cursor/artifacts/arrange-phone-browser.png' })

        if ((await page.getByRole('button', { name: 'Browse', exact: true }).getAttribute('aria-pressed')) === 'true') {
          await page.getByRole('button', { name: 'Browse', exact: true }).click()
        }
        await page.locator('.head.is-selected .track-more').click()
        await page.getByRole('button', { name: /^Plugins/ }).click()
        await page.getByRole('button', { name: 'Add plugin' }).first().waitFor()
        await page.screenshot({ path: '/opt/cursor/artifacts/arrange-phone-plugins.png' })
      } finally {
        await browser.close()
      }
    } finally {
      child.kill('SIGTERM')
    }
  }, 120000)
})
