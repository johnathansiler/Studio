import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const PHONES = [
  { name: '390x844', width: 390, height: 844 },
  { name: '344x844', width: 344, height: 844 },
  { name: '844x390', width: 844, height: 390 },
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

type Hit = { label: string; width: number; height: number }

async function hits(page: Page, selector: string): Promise<Hit[]> {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((node) => {
      const rect = node.getBoundingClientRect()
      const label = (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim()
      return { label, width: rect.width, height: rect.height }
    }).filter((hit) => hit.width > 1 && hit.height > 1)
  }, selector)
}

function expectBox(hit: Hit, where: string) {
  expect(hit.width, `${where} ${hit.label} width`).toBeGreaterThanOrEqual(44)
  expect(hit.height, `${where} ${hit.label} height`).toBeGreaterThanOrEqual(44)
}

describe('phone tap targets, toasts, and the browser handle', () => {
  it('keeps phone hits at 44px and parks toasts off the headers and the dock', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4494
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({
      headless: true,
      executablePath: '/usr/bin/google-chrome',
    }))
    try {
      await waitForServer(url, child)
      const page = await browser.newPage()
      for (const viewport of PHONES) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().click()
        await page.locator('.phone-context[data-phone-context="arrange"]').waitFor()
        const dock = await hits(page, '.phone-context button, .phone-context .bpm-readout')
        expect(dock.length, `${viewport.name} ${dock.map((hit) => `${hit.label} ${Math.round(hit.width)}x${Math.round(hit.height)}`).join(' | ')}`).toBeGreaterThan(6)
        for (const hit of dock) expectBox(hit, `${viewport.name} dock`)
        const flags = await hits(page, '.arrange .track-controls .mini')
        expect(flags.length, viewport.name).toBeGreaterThan(3)
        for (const hit of flags) expectBox(hit, `${viewport.name} header`)
        const titles = await hits(page, '.arrange .track-title')
        expect(titles.length, viewport.name).toBeGreaterThan(0)
        for (const hit of titles) expectBox(hit, `${viewport.name} name`)
        const tempo = dock.filter((hit) => hit.label.startsWith('Tempo'))
        expect(tempo.length, viewport.name).toBeGreaterThan(0)
        for (const hit of tempo) expectBox(hit, `${viewport.name} tempo`)
        const clear = await page.evaluate(() => {
          const dockBox = document.querySelector('.phone-dock-slot, .tool-slot')!.getBoundingClientRect()
          const scroller = document.querySelector('.arrange .heads-scroll, .arrange .heads')!.getBoundingClientRect()
          const tabs = [...document.querySelectorAll('.phone-tabs button')].map((node) => (node.textContent || '').trim())
          return {
            scrollerBottom: scroller.bottom,
            dockTop: dockBox.top,
            tabs,
          }
        })
        expect(clear.tabs, viewport.name).toEqual(expect.arrayContaining(['Browse', 'Tools']))
        expect(clear.tabs.some((tab) => tab.startsWith('Menu')), viewport.name).toBe(true)
        expect(clear.scrollerBottom, `${viewport.name} headers above dock`).toBeLessThanOrEqual(clear.dockTop + 1)
        await page.evaluate(() => (window as unknown as { __cueharbor: { store: { toast: (text: string, tone: string) => void } } }).__cueharbor.store.toast('Saved the mix. Undo takes it back.', 'good'))
        await page.locator('.toast').first().waitFor()
        await page.waitForTimeout(50)
        const parked = await page.evaluate(() => {
          const toast = document.querySelector('.toast')!.getBoundingClientRect()
          const zones = [
            ...document.querySelectorAll('.arrange .track-controls button, .arrange .track-title, .phone-dock-slot, .tool-slot'),
          ].map((node) => node.getBoundingClientRect())
          const hit = zones.some((zone) => toast.left < zone.right - 1 && toast.right > zone.left + 1 && toast.top < zone.bottom - 1 && toast.bottom > zone.top + 1)
          return { hit, park: document.querySelector('.toasts')?.getAttribute('data-toast-park') }
        })
        expect(parked.hit, `${viewport.name} toast`).toBe(false)
        expect(parked.park, viewport.name).toBe('clear')
        await page.screenshot({ path: `/opt/cursor/artifacts/after-phone-${viewport.name}.png` })
        await page.getByRole('button', { name: /^Mix/ }).first().click()
        await page.locator('.pan-knob').first().waitFor()
        const pans = await hits(page, '.pan-knob')
        expect(pans.length, viewport.name).toBeGreaterThan(0)
        for (const hit of pans) expectBox(hit, `${viewport.name} pan`)
        await page.screenshot({ path: `/opt/cursor/artifacts/after-mix-${viewport.name}.png` })
      }

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().click()
      await page.locator('.arrange').first().waitFor()
      await page.getByRole('button', { name: /^Browser/ }).click()
      await page.locator('.browser-resize').waitFor()
      const handle = await page.locator('.browser-resize').boundingBox()
      expect(handle?.width ?? 0).toBeGreaterThanOrEqual(24)
      const line = await page.evaluate(() => {
        const node = document.querySelector('.browser-resize') as HTMLElement
        const before = getComputedStyle(node, '::before')
        return { width: Number.parseFloat(before.width), box: node.getBoundingClientRect().width }
      })
      expect(line.box).toBeGreaterThanOrEqual(24)
      expect(line.width).toBeLessThanOrEqual(4)
      await page.evaluate(() => (window as unknown as { __cueharbor: { store: { toast: (text: string, tone: string) => void } } }).__cueharbor.store.toast('Saved the mix. Undo takes it back.', 'good'))
      await page.locator('.toast').first().waitFor()
      await page.waitForTimeout(50)
      const desk = await page.evaluate(() => {
        const toast = document.querySelector('.toast')!.getBoundingClientRect()
        const zones = [...document.querySelectorAll('.arrange .track-controls button, .arrange .track-title, .tool-slot')].map((node) => node.getBoundingClientRect())
        const hit = zones.some((zone) => toast.left < zone.right - 1 && toast.right > zone.left + 1 && toast.top < zone.bottom - 1 && toast.bottom > zone.top + 1)
        return { hit, park: document.querySelector('.toasts')?.getAttribute('data-toast-park') }
      })
      expect(desk.hit, 'desktop toast').toBe(false)
      expect(desk.park).toBe('clear')
      await page.screenshot({ path: '/opt/cursor/artifacts/after-desktop-1440x900.png' })
    } finally {
      await browser.close()
      child.kill()
    }
  }, 180000)
})
