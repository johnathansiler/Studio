import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const VIEWPORTS = [
  { name: '844x390', width: 844, height: 390, land: true },
  { name: '915x412', width: 915, height: 412, land: true },
  { name: '390x844', width: 390, height: 844, land: false },
  { name: '344x882', width: 344, height: 882, land: false },
  { name: '880x1000', width: 880, height: 1000, land: false },
  { name: '1440x900', width: 1440, height: 900, land: false },
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

type ButtonHit = {
  track: string
  label: string
  same: boolean
  hit: string
  fully: boolean
  aboveDock: boolean
  scrollTop: number
}

async function headerHits(page: Page) {
  return page.evaluate(async () => {
    const scroller = document.querySelector('.heads-scroll') as HTMLElement | null
    const timeline = document.querySelector('.timeline-scroll') as HTMLElement | null
    const dock = document.querySelector('.tool-slot')?.getBoundingClientRect()
    const heads = document.querySelector('.arrange .heads')?.getBoundingClientRect()
    if (!scroller || !dock || !heads) return null
    const wanted = /^(Mute|Unmute|Solo|Unsolo|Arm|Disarm|Track)\b/
    const tracks = [...document.querySelectorAll('.arrange .head')]
    const hits: ButtonHit[] = []
    for (const track of tracks) {
      const name = track.getAttribute('data-track-name') || ''
      const buttons = [...track.querySelectorAll('button')].filter((button) => wanted.test(button.getAttribute('aria-label') || ''))
      for (const button of buttons) {
        for (let step = 0; step < 8; step++) {
          const view = scroller.getBoundingClientRect()
          const gap = document.querySelector('.ruler-gap')?.getBoundingClientRect()
          const clearTop = Math.max(view.top + 1, gap ? gap.bottom : view.top)
          const clearBottom = Math.min(view.bottom - 1, dock.top - 1, window.innerHeight - 1)
          const box = button.getBoundingClientRect()
          if (box.top >= clearTop - 1 && box.bottom <= clearBottom + 1) break
          if (box.top < clearTop) scroller.scrollTop -= clearTop - box.top
          else scroller.scrollTop += box.bottom - clearBottom
          if (timeline) timeline.scrollTop = scroller.scrollTop
        }
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        const view = scroller.getBoundingClientRect()
        const box = button.getBoundingClientRect()
        const x = box.left + box.width / 2
        const y = box.top + box.height / 2
        const hit = document.elementFromPoint(x, y)
        hits.push({
          track: name,
          label: (button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          same: Boolean(hit && (hit === button || button.contains(hit))),
          hit: (hit?.getAttribute('aria-label') || hit?.textContent || hit?.className || 'none').toString().replace(/\s+/g, ' ').trim().slice(0, 48),
          fully: box.top >= view.top - 1 && box.bottom <= view.bottom + 1 && box.left >= -1 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
          aboveDock: box.bottom <= dock.top + 1,
          scrollTop: scroller.scrollTop,
        })
      }
    }
    const add = document.querySelector('.track-add .add-track-btn') as HTMLElement | null
    const addBox = add?.getBoundingClientRect()
    const addHit = addBox ? document.elementFromPoint(addBox.left + addBox.width / 2, addBox.top + addBox.height / 2) : null
    return {
      hits,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      headsBottom: heads.bottom,
      dockTop: dock.top,
      add: add ? (addHit === add || add.contains(addHit)) : false,
    }
  })
}

describe('phone landscape track headers', () => {
  it('keeps Mute, Solo, Arm, and the track menu hittable on short landscape and the other shells', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4492
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().click()
        await page.locator('.heads-scroll').waitFor()
        await page.locator('.arrange .head .track-controls button').first().waitFor()
        const layout = await headerHits(page)
        expect(layout, viewport.name).toBeTruthy()
        if (!layout) continue
        expect(layout.headsBottom, viewport.name).toBeLessThanOrEqual(layout.dockTop + 1)
        expect(layout.add, viewport.name).toBe(true)
        const tracks = [...new Set(layout.hits.map((hit) => hit.track))]
        expect(tracks, viewport.name).toEqual(['Vocal', 'Music', 'Keys'])
        if (viewport.land) {
          expect(layout.scrollHeight, viewport.name).toBeGreaterThan(layout.clientHeight + 40)
          const vocal = layout.hits.filter((hit) => hit.track === 'Vocal')
          expect(vocal.every((hit) => hit.scrollTop === 0), `${viewport.name} vocal ${JSON.stringify(vocal)}`).toBe(true)
        }
        for (const hit of layout.hits) {
          const where = `${viewport.name} ${hit.track} ${hit.label} -> ${hit.hit}`
          expect(hit.same, where).toBe(true)
          expect(hit.fully, where).toBe(true)
          expect(hit.aboveDock, where).toBe(true)
        }
        if (viewport.land) {
          await page.screenshot({ path: `/opt/cursor/artifacts/land-tracks-${viewport.name}.png` })
        }
        await page.close()
      }
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 90000)
})
