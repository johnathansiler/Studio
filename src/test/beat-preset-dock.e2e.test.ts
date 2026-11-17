import { mkdirSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

/** Phone sizes where the Sampler row used to sit under the dock, plus a folded Z Fold. */
const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '476x752', width: 476, height: 752 },
  { name: '844x390', width: 844, height: 390 },
  { name: '344x882', width: 344, height: 882 },
]

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

async function openBeatMachine(page: Page) {
  await page.locator('[data-track-name="Keys"]').waitFor()
  const keysHead = page.locator('[data-track-name="Keys"]')
  await keysHead.getByRole('button', { name: /Track\. Input/ }).tap()
  await page.locator('#track-options').waitFor()
  await page.locator('[data-track-action="drums"]').tap()
  await page.locator('[data-pads="plugin"]').waitFor()
  await page.locator('.hw-lip').getByRole('button', { name: 'Presets', exact: true }).waitFor()
}

type HitReport = {
  preset: string
  presetBottom: number
  dockTop: number
  record: string
  tabs: { name: string; hit: string }[]
  pages: { name: string; hit: string }[]
  close: string
  closeOverlaps: string[]
  trayBottom: number
  recordTop: number
}

async function readHits(page: Page, trayOpen: boolean): Promise<HitReport> {
  return page.evaluate((open) => {
    const labelOf = (node: Element | null) => {
      if (!node) return ''
      const button = node.closest('button')
      const name = button?.getAttribute('aria-label') || button?.textContent || node.textContent || ''
      return name.replace(/\s+/g, ' ').trim()
    }
    const centerHit = (node: Element | null) => {
      if (!node) return ''
      const box = node.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return labelOf(hit)
    }
    const overlaps = (a: DOMRect, b: DOMRect) => {
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      return width > 1 && height > 1
    }
    const preset = document.querySelector('.hw-lip .preset-anchor > button')
    const record = document.querySelector('[data-beat-transport] [aria-label="Record"]')
    const dock = document.querySelector('.phone-dock-slot')
    const close = document.querySelector('.anchored-menu.preset-menu > button.sheet-close')
    const tray = document.querySelector('.anchored-menu.preset-menu[data-menu-size="tray"]')
    const presetBox = preset?.getBoundingClientRect()
    const dockBox = dock?.getBoundingClientRect()
    const recordBox = record?.getBoundingClientRect()
    const closeBox = close?.getBoundingClientRect()
    const trayBox = tray?.getBoundingClientRect()
    const closeOverlaps: string[] = []
    if (closeBox && closeBox.width > 0) {
      const others = [
        preset,
        record,
        ...document.querySelectorAll('[data-phone-tab], [data-plugin-tab], .hw-lip .preset-dock > button'),
      ]
      for (const node of others) {
        if (!node || node === close) continue
        const box = node.getBoundingClientRect()
        if (box.width > 0 && overlaps(closeBox, box)) closeOverlaps.push(labelOf(node))
      }
    }
    return {
      preset: centerHit(preset),
      presetBottom: presetBox ? Math.round(presetBox.bottom) : -1,
      dockTop: dockBox ? Math.round(dockBox.top) : -1,
      record: open ? centerHit(record) : '',
      tabs: [...document.querySelectorAll('[data-phone-tab]')].map((node) => ({
        name: node.getAttribute('data-phone-tab') || '',
        hit: centerHit(node),
      })),
      pages: [...document.querySelectorAll('[data-plugin-tab]')].map((node) => ({
        name: node.getAttribute('data-plugin-tab') || '',
        hit: centerHit(node),
      })),
      close: open ? centerHit(close) : '',
      closeOverlaps,
      trayBottom: trayBox ? Math.round(trayBox.bottom) : -1,
      recordTop: recordBox ? Math.round(recordBox.top) : -1,
    }
  }, trayOpen)
}

describe('beat machine preset row stays above the phone dock', () => {
  it('keeps Presets, Record, and the bottom tabs hittable with the tray open', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4477
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true })
    try {
      await waitForServer(url, child)
      const context = await browser.newContext({
        viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
        hasTouch: true,
        isMobile: true,
      })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await openBeatMachine(page)

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.waitForTimeout(300)
        const preset = page.locator('.hw-lip').getByRole('button', { name: 'Presets', exact: true })
        await preset.waitFor()
        const closed = await readHits(page, false)
        await page.screenshot({ path: `/opt/cursor/artifacts/beat-presets-${viewport.name}-closed.png` })
        expect(closed.preset, `${viewport.name} presets`).toBe('Presets')
        expect(closed.tabs.map((item) => item.hit), `${viewport.name} phone tabs`).toEqual(['Menu. Project, edit, view, and settings.', 'Browse', 'Tools'])
        expect(closed.dockTop, `${viewport.name} dock`).toBeGreaterThan(0)
        expect(closed.presetBottom, `${viewport.name} preset above dock`).toBeLessThanOrEqual(closed.dockTop)
        expect(closed.pages.map((item) => item.hit), `${viewport.name} page tabs`).toEqual(['Pads', 'Sound', 'Pattern'])

        await preset.tap()
        await page.locator('.anchored-menu.preset-menu[data-menu-size="tray"]').waitFor()
        await page.waitForTimeout(100)
        const opened = await readHits(page, true)
        await page.screenshot({ path: `/opt/cursor/artifacts/beat-presets-${viewport.name}-open.png` })
        expect(opened.record, `${viewport.name} record`).toBe('Record')
        expect(opened.tabs.map((item) => item.hit), `${viewport.name} phone tabs`).toEqual(['Menu. Project, edit, view, and settings.', 'Browse', 'Tools'])
        expect(opened.trayBottom, `${viewport.name} tray above record`).toBeLessThanOrEqual(opened.recordTop)
        expect(opened.close, `${viewport.name} close`).toBe('Close')
        expect(opened.closeOverlaps, `${viewport.name} close overlap`).toEqual([])
        expect(opened.pages.map((item) => item.hit), `${viewport.name} page tabs with tray`).toEqual(['Pads', 'Sound', 'Pattern'])
        await page.locator('.anchored-menu.preset-menu > button.sheet-close').tap()
        await page.locator('.anchored-menu.preset-menu').waitFor({ state: 'detached' })
      }

      await page.setViewportSize({ width: 880, height: 1000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: '/opt/cursor/artifacts/beat-presets-880x1000-closed.png' })
      const foldClosed = await readHits(page, false)
      expect(foldClosed.preset, '880x1000 presets').toBe('Presets')
      await page.locator('.hw-lip').getByRole('button', { name: 'Presets', exact: true }).tap()
      await page.locator('.anchored-menu.preset-menu[data-menu-size="tray"]').waitFor()
      await page.screenshot({ path: '/opt/cursor/artifacts/beat-presets-880x1000-open.png' })
      const foldOpen = await readHits(page, true)
      expect(foldOpen.record, '880x1000 record').toBe('Record')
      expect(foldOpen.trayBottom, '880x1000 tray above record').toBeLessThanOrEqual(foldOpen.recordTop)
      expect(foldOpen.closeOverlaps, '880x1000 close overlap').toEqual([])
      await context.close()
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 120000)
})
