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
  { name: 'land', width: 844, height: 390 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

async function layout(page: Page) {
  return page.evaluate(() => {
    const round = (value: number) => Math.round(value)
    const heads = document.querySelector('.heads')
    const lane = document.querySelector('.timeline-scroll')
    const arrange = document.querySelector('.arrange')
    const add = document.querySelector('.add-track-btn')
    const rows = [...document.querySelectorAll<HTMLElement>('.head')].map((head) => {
      const headBox = head.getBoundingClientRect()
      const controls = head.querySelector<HTMLElement>('[data-track-controls]')
      const buttons = [...head.querySelectorAll<HTMLElement>('.track-controls button')].map((button) => {
        const box = button.getBoundingClientRect()
        return {
          name: button.getAttribute('aria-label') || '',
          top: round(box.top),
          height: round(box.height),
          right: round(box.right),
          width: round(box.width),
        }
      })
      const beat = head.querySelector<HTMLElement>('.beat-open')
      const beatBox = beat?.getBoundingClientRect()
      const mute = head.querySelector<HTMLElement>('.track-controls .mini')
      return {
        name: (head.querySelector('input.name') as HTMLInputElement | null)?.value || '',
        nameWidth: round((head.querySelector('input.name') as HTMLElement | null)?.getBoundingClientRect().width ?? 0),
        head: round(headBox.width),
        headRight: round(headBox.right),
        headHeight: round(headBox.height),
        controls: controls ? round(controls.getBoundingClientRect().width) : 0,
        rows: new Set(buttons.map((button) => button.top)).size,
        clipped: buttons.some((button) => button.right > headBox.right + 1 || button.height < 39),
        beat: beat && beatBox ? {
          width: round(beatBox.width),
          height: round(beatBox.height),
          left: round(beatBox.left),
          right: round(beatBox.right),
          top: round(beatBox.top),
          label: beat.getAttribute('aria-label'),
          title: beat.getAttribute('title'),
          text: (beat.textContent || '').trim(),
          shadow: getComputedStyle(beat).boxShadow,
          radius: getComputedStyle(beat).borderRadius,
        } : null,
        muteShadow: mute ? getComputedStyle(mute).boxShadow : '',
        buttons,
      }
    })
    const addBox = add?.getBoundingClientRect()
    return {
      column: heads ? round(heads.getBoundingClientRect().width) : 0,
      lane: lane ? round(lane.getBoundingClientRect().width) : 0,
      arrange: arrange ? round(arrange.getBoundingClientRect().width) : 0,
      add: addBox ? { width: round(addBox.width), height: round(addBox.height), text: (add?.textContent || '').replace(/\s+/g, ' ').trim() } : null,
      rows,
    }
  })
}

describe('beat machine arrange header', () => {
  it('uses a 40px pad icon and keeps the phone lane beside the other headers', async () => {
    const port = 4231
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
        for (const viewport of VIEWPORTS) {
          const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
          const page = await context.newPage()
          await page.goto(url, { waitUntil: 'domcontentloaded' })
          await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
          await page.getByRole('button', { name: 'Add Track' }).click()
          await page.getByRole('button', { name: /Beat Machine\. Pads/ }).click()
          await page.locator('[data-pads="plugin"]').waitFor()
          await page.getByRole('button', { name: /Close Beat Machine/ }).click()
          await page.locator('.arrange .beat-open').waitFor()
          await page.getByRole('textbox', { name: 'Vocal name' }).click()

          const closed = await layout(page)
          await page.screenshot({ path: `/opt/cursor/artifacts/beat-header-${viewport.name}.png` })
          const beat = closed.rows.find((row) => row.beat)
          const others = closed.rows.filter((row) => !row.beat)
          expect(beat, viewport.name).toBeTruthy()
          expect(beat!.beat!.label, viewport.name).toBe('Open Beat Machine')
          expect(beat!.beat!.title, viewport.name).toBe('Open Beat Machine')
          expect(beat!.beat!.text, viewport.name).toBe('')
          expect(beat!.beat!.width, viewport.name).toBeGreaterThanOrEqual(40)
          expect(beat!.beat!.width, viewport.name).toBeLessThanOrEqual(44)
          expect(beat!.beat!.height, viewport.name).toBeGreaterThanOrEqual(40)
          expect(beat!.beat!.height, viewport.name).toBeLessThanOrEqual(44)
          expect(beat!.beat!.left, viewport.name).toBeGreaterThanOrEqual(0)
          expect(beat!.beat!.right, viewport.name).toBeLessThanOrEqual(beat!.headRight + 1)
          expect(beat!.beat!.shadow, viewport.name).toBe(beat!.muteShadow)
          expect(beat!.beat!.radius, viewport.name).toBe('999px')
          const widest = Math.max(...others.map((row) => row.controls))
          const widestHead = Math.max(...others.map((row) => row.head))
          expect(beat!.controls, `${viewport.name} controls ${beat!.controls} vs ${widest}`).toBeLessThanOrEqual(widest + 8)
          expect(beat!.head, `${viewport.name} head`).toBeLessThanOrEqual(widestHead + 2)
          if (viewport.name === 'phone') expect(beat!.nameWidth, 'phone name').toBeGreaterThan(36)
          else expect(beat!.nameWidth, `${viewport.name} name`).toBeGreaterThan(100)
          for (const row of closed.rows) {
            expect(row.rows, `${viewport.name} ${row.name}`).toBe(1)
            expect(row.clipped, `${viewport.name} ${row.name}`).toBe(false)
          }
          expect(closed.add?.text, viewport.name).toContain('Add Track')
          expect(closed.add!.height, viewport.name).toBeGreaterThanOrEqual(48)
          expect(closed.add!.width, viewport.name).toBeGreaterThanOrEqual((viewport.name === 'phone' ? closed.arrange : closed.column) - 16)
          if (viewport.name === 'phone') {
            expect(closed.column, 'phone column').toBeLessThanOrEqual(190)
            expect(closed.lane, 'phone lane').toBeGreaterThanOrEqual(200)
            await page.locator('.arrange .beat-open').click()
            await page.locator('[data-pads="plugin"]').waitFor()
            await page.getByRole('button', { name: /Close Beat Machine/ }).click()
            await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })
          }

          const browserButton = page.getByRole('button', { name: 'Browser', exact: true })
          if ((await browserButton.getAttribute('aria-pressed')) !== 'true') await browserButton.click()
          await page.locator('[data-playlist-browser="open"]').waitFor()
          const docked = await layout(page)
          await page.screenshot({ path: `/opt/cursor/artifacts/beat-header-${viewport.name}-browser.png` })
          const dockBeat = docked.rows.find((row) => row.beat)!
          const dockWidest = Math.max(...docked.rows.filter((row) => !row.beat).map((row) => row.controls))
          expect(dockBeat.beat!.label, `${viewport.name} browser`).toBe('Open Beat Machine')
          expect(dockBeat.beat!.width, `${viewport.name} browser`).toBeGreaterThanOrEqual(40)
          expect(dockBeat.beat!.width, `${viewport.name} browser`).toBeLessThanOrEqual(44)
          expect(dockBeat.controls, `${viewport.name} browser`).toBeLessThanOrEqual(dockWidest + 8)
          expect(dockBeat.head, `${viewport.name} browser head`).toBeLessThanOrEqual(Math.max(...docked.rows.filter((row) => !row.beat).map((row) => row.head)) + 2)
          for (const row of docked.rows) {
            expect(row.rows, `${viewport.name} browser ${row.name}`).toBe(1)
            expect(row.clipped, `${viewport.name} browser ${row.name}`).toBe(false)
          }
          expect(docked.add!.width, `${viewport.name} browser add`).toBeGreaterThanOrEqual((viewport.name === 'phone' ? docked.arrange : docked.column) - 16)
          expect(docked.add!.height, `${viewport.name} browser add`).toBeGreaterThanOrEqual(48)
          if (viewport.name === 'phone') {
            expect(docked.column, 'phone browser column').toBeLessThanOrEqual(190)
            expect(docked.lane, 'phone browser lane').toBeGreaterThan(40)
          }
          await context.close()
        }
      } finally {
        await browser.close()
      }
    } finally {
      child.kill('SIGTERM')
    }
  }, 120000)
})
