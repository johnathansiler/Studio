import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 25000) {
    if (child.exitCode != null) throw new Error(detail || 'process exited')
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 404) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'server did not start')
}

async function openScaler(page: Page) {
  await page.goto('http://127.0.0.1:5217/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const size = page.viewportSize()
  const phone = !!size && size.width <= 520 && size.height >= size.width
  if (phone) await page.locator('.track-more').first().click()
  await page.locator('[data-arrange-plugins="toggle"]').click()
  await page.getByRole('button', { name: 'Add Plugin', exact: true }).click()
  await page.locator('[data-plugin-choice="scaler"]').click()
  await page.locator('.scaler-panel [data-key-picker]').waitFor()
}

describe('scaler in the app shell', () => {
  it('fits one column on a phone without overlapping controls', async () => {
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '5217', '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let browser: Browser | null = null
    try {
      await waitForServer('http://127.0.0.1:5217/', web)
      browser = await chromium.launch({ headless: true })
      mkdirSync('/opt/cursor/artifacts', { recursive: true })
      const shots = [
        { width: 390, height: 844, file: '/opt/cursor/artifacts/scaler-live-phone-390x844.png' },
        { width: 476, height: 752, file: '/opt/cursor/artifacts/scaler-live-fold-476x752.png' },
      ]
      for (const shot of shots) {
        const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 1 })
        await openScaler(page)
        const box = await page.evaluate(() => {
          const panel = document.querySelector('.scaler-panel') as HTMLElement
          const controls = [...panel.querySelectorAll('button, select, input')].filter((el) => {
            if (el.closest('[hidden]') || el.closest('.scaler-keys')) return false
            const style = getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden') return false
            const rect = el.getBoundingClientRect()
            return rect.width > 1 && rect.height > 1
          })
          const hits: string[] = []
          const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
          for (let i = 0; i < controls.length; i++) {
            for (let j = i + 1; j < controls.length; j++) {
              const left = controls[i]
              const right = controls[j]
              if (left.contains(right) || right.contains(left)) continue
              if (!overlap(left.getBoundingClientRect(), right.getBoundingClientRect())) continue
              const name = (node: Element) => (node.getAttribute('aria-label') || node.textContent || node.tagName).replace(/\s+/g, ' ').trim().slice(0, 40)
              hits.push(`${name(left)} × ${name(right)}`)
            }
          }
          const rect = (el: Element) => {
            const item = el.getBoundingClientRect()
            return { top: item.top, bottom: item.bottom, left: item.left, right: item.right, height: item.height }
          }
          const views = document.querySelector('.views') as HTMLElement
          const key = document.querySelector('[data-key-picker]') as HTMLSelectElement
          const scale = document.querySelector('[data-scale-picker] select') as HTMLElement
          const pads = document.querySelector('.scaler-pad-cells') as HTMLElement
          const perform = document.querySelector('.scaler-perform') as HTMLElement
          const source = document.querySelector('.scaler-pad-source') as HTMLElement
          const tools = document.querySelector('[data-output]') as HTMLElement
          const drawer = document.querySelector('#scaler-options') as HTMLElement
          return {
            hits,
            tabs: views.innerText.replace(/\s+/g, ' ').trim(),
            viewsBottom: views.getBoundingClientRect().bottom,
            panelTop: panel.getBoundingClientRect().top,
            panelScroll: panel.scrollHeight - panel.clientHeight,
            keyTag: key.tagName,
            keyOptions: key.options.length,
            key: rect(key),
            scale: rect(scale),
            pads: rect(pads),
            perform: rect(perform),
            source: rect(source),
            tools: tools.innerText.replace(/\s+/g, ' ').trim(),
            drawerHidden: drawer.hidden,
            drawerText: drawer.textContent ?? '',
            performLabels: [...perform.querySelectorAll('button')].map((button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
          }
        })
        const where = `${shot.width}x${shot.height}`
        expect(box.tabs, where).toContain('Collab')
        expect(box.tabs, where).toContain('Arrange')
        expect(box.tabs, where).toContain('Mix')
        expect(box.panelTop, where).toBeGreaterThanOrEqual(box.viewsBottom - 1)
        expect(box.panelScroll, where).toBeLessThanOrEqual(2)
        expect(box.hits, `${where}\n${box.hits.join('\n')}`).toEqual([])
        expect(box.keyTag, where).toBe('SELECT')
        expect(box.keyOptions, where).toBe(12)
        expect(Math.abs(box.key.top - box.scale.top), where).toBeLessThanOrEqual(2)
        expect(box.scale.bottom, where).toBeLessThanOrEqual(box.source.top + 1)
        expect(box.perform.top, where).toBeGreaterThanOrEqual(box.pads.bottom - 1)
        expect(box.pads.height, where).toBeGreaterThan(120)
        expect(box.tools, where).not.toMatch(/Audio output|MIDI output|MIDI input|Audio input/)
        expect(box.drawerHidden, where).toBe(true)
        expect(box.drawerText, where).toContain('Audio output')
        expect(box.drawerText, where).toContain('MIDI output')
        expect(box.performLabels.filter(Boolean), where).toEqual(['Performance Block', 'Keys lock Off'])
        await page.screenshot({ path: shot.file })
        const png = readFileSync(shot.file)
        expect(png.readUInt32BE(16), where).toBe(shot.width)
        expect(png.readUInt32BE(20), where).toBe(shot.height)
        await page.getByRole('button', { name: 'Options', exact: true }).click()
        for (const label of ['Audio output', 'MIDI output', 'MIDI input', 'Audio input']) {
          expect(await page.locator('#scaler-options').getByRole('button', { name: label, exact: true }).isVisible(), `${where} ${label}`).toBe(true)
        }
        await page.close()
      }
    } finally {
      await browser?.close()
      if (web.pid) {
        try { process.kill(-web.pid, 'SIGTERM') } catch { /* already exited */ }
      }
    }
  }, 60000)
})
