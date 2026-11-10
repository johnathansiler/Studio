import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844, kind: 'portrait' },
  { name: '476x752', width: 476, height: 752, kind: 'portrait' },
  { name: '880x1000', width: 880, height: 1000, kind: 'wide' },
  { name: '844x390', width: 844, height: 390, kind: 'land' },
  { name: '1440x900', width: 1440, height: 900, kind: 'wide' },
] as const

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 25000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 404) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(selector) as HTMLElement | null
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const ruler = document.querySelector('.arrange .timeline-scroll .ruler') as HTMLElement | null
    const gap = document.querySelector('.arrange .ruler-gap') as HTMLElement | null
    const grip = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"]') as HTMLElement | null
    const face = grip?.querySelector('.loop-grip-face') as HTMLElement | null
    const heads = document.querySelector('.arrange .heads') as HTMLElement | null
    const lane = document.querySelector('.timeline-scroll') as HTMLElement | null
    const add = document.querySelector('.arrange-add') as HTMLElement | null
    const addBtn = document.querySelector('.arrange-add .add-track-btn') as HTMLElement | null
    const slot = document.querySelector('.tool-slot') as HTMLElement | null
    const slotBox = slot?.getBoundingClientRect()
    const barButtons = slot
      ? [...slot.querySelectorAll<HTMLElement>('button')].filter((button) => {
          const rect = button.getBoundingClientRect()
          return rect.width > 8 && rect.height > 8 && getComputedStyle(button).display !== 'none'
        }).map((button) => {
          const rect = button.getBoundingClientRect()
          return {
            label: (button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/g, ' ').trim(),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            clipped: slotBox ? rect.left < slotBox.left - 1 || rect.right > slotBox.right + 1 || rect.bottom > slotBox.bottom + 1 : false,
          }
        })
      : []
    const controls = [...document.querySelectorAll<HTMLElement>('.arrange .track-controls')].map((row) => {
      const buttons = [...row.querySelectorAll<HTMLElement>('button')]
      const tops = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))
      const rowBox = row.getBoundingClientRect()
      const wrapped = buttons.some((button) => {
        const rect = button.getBoundingClientRect()
        return rect.right > rowBox.right + 1 || rect.height < 39
      })
      return { tops: tops.size, wrapped, width: rowBox.width }
    })
    const overlaps: string[] = []
    for (const head of document.querySelectorAll<HTMLElement>('.arrange .head')) {
      const name = head.querySelector('input.name') as HTMLElement | null
      const meter = head.querySelector('.mini-meter') as HTMLElement | null
      const buttons = [...head.querySelectorAll<HTMLElement>('button')]
      if (name) {
        const nameBox = name.getBoundingClientRect()
        for (const button of buttons) {
          const rect = button.getBoundingClientRect()
          const hit = nameBox.left < rect.right - 1 && nameBox.right > rect.left + 1 && nameBox.top < rect.bottom - 1 && nameBox.bottom > rect.top + 1
          if (hit) overlaps.push((name as HTMLInputElement).value)
        }
      }
      if (meter) {
        const meterBox = meter.getBoundingClientRect()
        for (const button of buttons) {
          const rect = button.getBoundingClientRect()
          const hit = meterBox.left < rect.right - 1 && meterBox.right > rect.left + 1 && meterBox.top < rect.bottom - 1 && meterBox.bottom > rect.top + 1
          if (hit) overlaps.push(`meter ${(name as HTMLInputElement | null)?.value || ''}`)
        }
      }
    }
    return {
      ruler: ruler ? ruler.getBoundingClientRect().height : 0,
      gap: gap ? gap.getBoundingClientRect().height : 0,
      grip: grip ? grip.getBoundingClientRect().height : 0,
      face: face ? face.getBoundingClientRect().height : 0,
      headRight: heads ? heads.getBoundingClientRect().right : 0,
      laneLeft: lane ? lane.getBoundingClientRect().left : 0,
      laneWidth: lane ? lane.getBoundingClientRect().width : 0,
      addHeight: add ? add.getBoundingClientRect().height : 0,
      addBtnHeight: addBtn ? addBtn.getBoundingClientRect().height : 0,
      topMenu: !!document.querySelector('.topbar .menu-btn'),
      topName: !!document.querySelector('.topbar .project-name'),
      topUndo: !!document.querySelector('.topbar [data-history="undo"]'),
      topIdeas: !!document.querySelector('.topbar .unstuck-btn'),
      addUndo: !!document.querySelector('.arrange-add [data-history="undo"]'),
      addRedo: !!document.querySelector('.arrange-add [data-history="redo"]'),
      bulb: document.querySelector('.arrange-add .ideas-bulb')?.getAttribute('aria-label') ?? '',
      pluginsInBar: barButtons.some((button) => button.label.startsWith('Plugins')),
      barButtons,
      controls,
      overlaps,
      head: box('.arrange .heads'),
    }
  })
}

describe('phone arrange layout', () => {
  it('fits the moved chrome, short loop, and short add bar on five viewports', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4471
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await waitForServer(url, child)
      const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({
        headless: true,
        executablePath: '/usr/bin/google-chrome',
      }))
      try {
        const page = await browser.newPage()
        for (const viewport of VIEWPORTS) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height })
          await page.goto(url, { waitUntil: 'domcontentloaded' })
          await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
          await page.locator('[data-loop-region="arrange"]').waitFor()
          const layout = await measure(page)
          await page.screenshot({ path: `/opt/cursor/artifacts/arrange-chrome-${viewport.name}.png` })
          expect(layout.grip, viewport.name).toBeGreaterThanOrEqual(44)
          expect(layout.overlaps, viewport.name).toEqual([])
          for (const row of layout.controls) {
            expect(row.tops, viewport.name).toBe(1)
            expect(row.wrapped, viewport.name).toBe(false)
          }
          if (viewport.kind === 'portrait') {
            expect(layout.ruler, viewport.name).toBeGreaterThanOrEqual(20)
            expect(layout.ruler, viewport.name).toBeLessThanOrEqual(24)
            expect(Math.abs(layout.gap - layout.ruler), viewport.name).toBeLessThanOrEqual(2)
            expect(layout.face, viewport.name).toBeLessThanOrEqual(layout.ruler)
            expect(layout.addHeight, viewport.name).toBeGreaterThanOrEqual(40)
            expect(layout.addHeight, viewport.name).toBeLessThanOrEqual(44)
            expect(layout.addBtnHeight, viewport.name).toBeGreaterThanOrEqual(40)
            expect(layout.topMenu, viewport.name).toBe(false)
            expect(layout.topName, viewport.name).toBe(false)
            expect(layout.topUndo, viewport.name).toBe(false)
            expect(layout.topIdeas, viewport.name).toBe(false)
            expect(layout.addUndo, viewport.name).toBe(true)
            expect(layout.addRedo, viewport.name).toBe(true)
            expect(layout.bulb, viewport.name).toBe('Ideas')
            expect(layout.pluginsInBar, viewport.name).toBe(false)
            expect(Math.abs(layout.laneLeft - layout.headRight), viewport.name).toBeLessThanOrEqual(2)
            expect(layout.laneWidth, viewport.name).toBeGreaterThan(viewport.width * 0.4)
            const labels = layout.barButtons.map((button) => button.label)
            expect(labels.some((label) => label.startsWith('Menu')), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Browser')), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Setup')), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Tool:') || label.startsWith('Select')), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Snap')), viewport.name).toBe(true)
            const menu = layout.barButtons.find((button) => button.label.startsWith('Menu'))!
            const browserBtn = layout.barButtons.find((button) => button.label.startsWith('Browser'))!
            expect(menu.left, viewport.name).toBeLessThan(browserBtn.left)
            expect(menu.right, viewport.name).toBeLessThanOrEqual(browserBtn.left + 8)
            for (const button of layout.barButtons) {
              expect(button.clipped, `${viewport.name} ${button.label}`).toBe(false)
              expect(button.height, `${viewport.name} ${button.label}`).toBeGreaterThanOrEqual(40)
            }
          } else if (viewport.kind === 'land') {
            expect(layout.ruler, viewport.name).toBeGreaterThanOrEqual(20)
            expect(layout.ruler, viewport.name).toBeLessThanOrEqual(24)
            expect(layout.face, viewport.name).toBeLessThanOrEqual(layout.ruler + 1)
            expect(layout.topMenu, viewport.name).toBe(true)
            expect(layout.topName, viewport.name).toBe(true)
            expect(layout.pluginsInBar, viewport.name).toBe(false)
            expect(layout.addHeight, viewport.name).toBeGreaterThanOrEqual(48)
          } else {
            expect(layout.ruler, viewport.name).toBeGreaterThanOrEqual(36)
            expect(layout.topMenu, viewport.name).toBe(true)
            expect(layout.topName, viewport.name).toBe(true)
            expect(layout.topUndo, viewport.name).toBe(true)
            expect(layout.topIdeas, viewport.name).toBe(true)
            expect(layout.addUndo, viewport.name).toBe(false)
            expect(layout.pluginsInBar, viewport.name).toBe(true)
            expect(layout.addBtnHeight, viewport.name).toBeGreaterThanOrEqual(48)
          }
        }

        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await page.getByRole('button', { name: /^Menu/ }).click()
        const session = page.getByRole('textbox', { name: 'Project name' })
        await session.waitFor()
        await session.fill('Harbor Night')
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: /^Menu/ }).click()
        expect(await page.getByRole('textbox', { name: 'Project name' }).inputValue()).toBe('Harbor Night')
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: 'Ideas', exact: true }).click()
        await page.locator('.unstuck-sheet, [data-unstuck]').first().waitFor()
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: /^Mix/ }).first().click()
        await page.locator('.mixer').first().waitFor()
        const mix = await page.evaluate(() => ({
          menu: !!document.querySelector('.topbar .menu-btn'),
          name: !!document.querySelector('.topbar .project-name'),
          undo: !!document.querySelector('.topbar [data-history="undo"]'),
        }))
        expect(mix.menu).toBe(true)
        expect(mix.name).toBe(true)
        expect(mix.undo).toBe(true)
        await page.screenshot({ path: '/opt/cursor/artifacts/arrange-chrome-390x844-mix.png' })
      } finally {
        await browser.close()
      }
    } finally {
      child.kill('SIGTERM')
    }
  }, 120000)
})
