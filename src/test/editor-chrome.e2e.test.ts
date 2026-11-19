import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const MODES = ['Roll', 'Step', 'Drums', 'Score'] as const

const viewports = [
  { name: '390x844', width: 390, height: 844, phone: true },
  { name: '344x882', width: 344, height: 882, phone: true },
  { name: '844x390', width: 844, height: 390, phone: true },
  { name: '1440x900', width: 1440, height: 900, phone: false },
]

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 404) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function launch() {
  const options = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }
  return chromium.launch(options).catch(() => chromium.launch({
    ...options,
    executablePath: '/usr/bin/google-chrome',
  }))
}

async function openRoll(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-track-name="Keys"]').first().waitFor()
  await page.evaluate(() => {
    const hook = (window as unknown as {
      __cueharbor: { store: { project: { tracks: { id: string; name: string }[] }; addMidiClip: (id: string, beat: number) => void } }
    }).__cueharbor
    const keys = hook.store.project.tracks.find((track) => track.name === 'Keys')!
    hook.store.addMidiClip(keys.id, 0)
  })
  await page.locator('[data-midi="1"]').first().dblclick()
  await page.locator('.midi-dock .mode-tabs').waitFor()
}

function overlaps(a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }) {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
}

async function readModes(page: Page) {
  return page.evaluate((labels) => {
    const tabs = [...document.querySelectorAll<HTMLElement>('.mode-tabs button.mode-tab')]
    return tabs.map((node) => {
      const box = node.getBoundingClientRect()
      const midX = box.left + box.width / 2
      const midY = box.top + box.height / 2
      const hit = document.elementFromPoint(midX, midY)
      return {
        text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        clipped: node.scrollWidth > node.clientWidth + 2,
        hit: !!hit && (hit === node || node.contains(hit)),
      }
    }).filter((tab) => labels.includes(tab.text as typeof labels[number]))
  }, [...MODES])
}

describe('editor chrome on a phone', () => {
  it('keeps mode labels whole, clears the last drum lane, and fills the score', async () => {
    const port = 4471
    const url = `http://127.0.0.1:${port}`
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await launch()
    try {
      await waitForServer(url, web)
      for (const viewport of viewports) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
        await openRoll(page, url)
        const modes = await readModes(page)
        expect(modes.map((tab) => tab.text), viewport.name).toEqual([...MODES])
        for (const tab of modes) {
          expect(tab.clipped, `${viewport.name} ${tab.text}`).toBe(false)
          expect(tab.hit, `${viewport.name} ${tab.text} is covered`).toBe(true)
          expect(tab.left, `${viewport.name} ${tab.text}`).toBeGreaterThanOrEqual(-1)
          expect(tab.right, `${viewport.name} ${tab.text}`).toBeLessThanOrEqual(viewport.width + 1)
          expect(tab.width, `${viewport.name} ${tab.text}`).toBeGreaterThanOrEqual(40)
          expect(tab.height, `${viewport.name} ${tab.text}`).toBeGreaterThanOrEqual(40)
        }
        const roll = modes[0]
        const score = modes[3]
        expect(overlaps(roll, score), `${viewport.name} Score covers Roll`).toBe(false)
        for (let index = 1; index < modes.length; index += 1) {
          expect(overlaps(modes[index - 1], modes[index]), `${viewport.name} ${modes[index].text}`).toBe(false)
        }

        await page.getByRole('button', { name: /^Drums\./ }).click()
        await page.locator('[data-drum-grid]').waitFor()
        const drums = await page.evaluate(() => {
          const scroller = document.querySelector('.me-lanes') as HTMLElement
          scroller.scrollTop = scroller.scrollHeight
          const dock = document.querySelector('.shell.phone .tool-slot.phone-dock-slot')?.getBoundingClientRect()
          const scrollerBox = scroller.getBoundingClientRect()
          const loopBottom = document.querySelector('.me-loop')?.getBoundingClientRect().bottom ?? scrollerBox.top
          const rows = [...document.querySelectorAll<HTMLElement>('.me-lane')].map((row) => {
            const box = row.getBoundingClientRect()
            const cell = row.querySelector('.me-cell') as HTMLElement
            const cellBox = cell.getBoundingClientRect()
            const visibleTop = Math.max(scrollerBox.top, loopBottom, cellBox.top)
            const visibleBottom = Math.min(scrollerBox.bottom, dock?.top ?? scrollerBox.bottom, cellBox.bottom)
            const y = (visibleTop + visibleBottom) / 2
            const hit = visibleBottom - visibleTop > 8
              ? document.elementFromPoint(cellBox.left + Math.min(cellBox.width / 2, 18), y)
              : null
            return {
              name: (row.querySelector('.me-pad')?.textContent || '').trim(),
              top: box.top,
              bottom: box.bottom,
              height: box.height,
              shown: visibleBottom - visibleTop,
              reachable: !!hit && (hit === cell || cell.contains(hit) || row.contains(hit)),
            }
          })
          return {
            phone: document.querySelector('.shell.phone') != null,
            dockTop: dock?.top ?? null,
            names: rows.map((row) => row.name),
            last: rows.at(-1) ?? null,
            cow: rows.find((row) => row.name === 'Cow') ?? null,
          }
        })
        expect(drums.names, viewport.name).toEqual(expect.arrayContaining(['Cow', 'Clave']))
        expect(drums.last?.name, viewport.name).toBe('Clave')
        expect(drums.last!.height, viewport.name).toBeGreaterThanOrEqual(viewport.phone ? 28 : 20)
        if (viewport.phone) {
          expect(drums.dockTop, viewport.name).not.toBeNull()
          expect(drums.last!.bottom, viewport.name).toBeLessThanOrEqual(drums.dockTop! + 1)
          expect(drums.last!.top, viewport.name).toBeLessThan(drums.dockTop!)
          expect(drums.cow!.bottom, viewport.name).toBeLessThanOrEqual(drums.dockTop! + 1)
          expect(drums.last!.shown, viewport.name).toBeGreaterThanOrEqual(24)
          expect(drums.last!.reachable, viewport.name).toBe(true)
        }
        const drumModes = await readModes(page)
        expect(drumModes.map((tab) => tab.text), `${viewport.name} drums`).toEqual([...MODES])
        expect(drumModes.every((tab) => !tab.clipped && tab.hit && tab.right <= viewport.width + 1), viewport.name).toBe(true)

        await page.getByRole('button', { name: /^Score\./ }).click()
        await page.locator('.me-staff svg.score-svg').waitFor()
        const scoreBox = await page.evaluate(() => {
          const staff = document.querySelector('.me-staff')!.getBoundingClientRect()
          const svg = document.querySelector('.me-staff svg.score-svg')!.getBoundingClientRect()
          const dock = document.querySelector('.shell.phone .tool-slot.phone-dock-slot')?.getBoundingClientRect()
          const limit = dock ? dock.top : staff.bottom
          const room = Math.max(1, Math.min(staff.bottom, limit) - staff.top)
          return {
            ratio: svg.height / room,
            svgBottom: svg.bottom,
            staffBottom: staff.bottom,
            dockTop: dock?.top ?? null,
            svgHeight: svg.height,
          }
        })
        expect(scoreBox.ratio, viewport.name).toBeGreaterThanOrEqual(0.8)
        expect(scoreBox.svgHeight, viewport.name).toBeGreaterThan(80)
        if (viewport.phone) {
          expect(scoreBox.svgBottom, viewport.name).toBeLessThanOrEqual(scoreBox.dockTop! + 2)
        }
        const scoreModes = await readModes(page)
        expect(overlaps(scoreModes[0], scoreModes[3]), `${viewport.name} score page`).toBe(false)
        expect(scoreModes[0].text, viewport.name).toBe('Roll')
        expect(scoreModes[3].text, viewport.name).toBe('Score')
        expect(scoreModes[3].clipped, viewport.name).toBe(false)
        expect(scoreModes[0].hit, `${viewport.name} Roll covered on the score page`).toBe(true)
        await page.close()
      }
    } finally {
      await browser.close()
      web.kill('SIGTERM')
    }
  }, 120000)
})
