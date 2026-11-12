import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { describe, expect, it } from 'vitest'
import { dragGain } from '../model/mixLaw'
import { encodeWav } from '../model/wav'

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

async function boot() {
  mkdirSync('/opt/cursor/artifacts', { recursive: true })
  const port = 5198
  const url = `http://127.0.0.1:${port}`
  const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForServer(url, child)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
  await page.waitForTimeout(300)
  return { child, browser, page }
}

describe('phone reach, dock, loop handle, and fader', () => {
  let child: ChildProcess
  let browser: Browser
  let page: Page

  it('fills the loop handle, fits the dock, and keeps Add Track reachable', async () => {
    const started = await boot()
    child = started.child
    browser = started.browser
    page = started.page
    try {
      const loop = await page.evaluate(() => {
        const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement
        const face = host.querySelector('[data-loop-edge="start"] .loop-grip-face') as HTMLElement
        const end = host.querySelector('[data-loop-edge="end"] .loop-grip-face') as HTMLElement
        const hostBox = host.getBoundingClientRect()
        const startBox = face.getBoundingClientRect()
        const endBox = end.getBoundingClientRect()
        const hit = host.querySelector('[data-loop-edge="start"]') as HTMLElement
        return {
          hostTop: hostBox.top,
          hostBottom: hostBox.bottom,
          hostHeight: hostBox.height,
          startTop: startBox.top,
          startBottom: startBox.bottom,
          startHeight: startBox.height,
          endTop: endBox.top,
          endBottom: endBox.bottom,
          endHeight: endBox.height,
          hitWidth: hit.getBoundingClientRect().width,
        }
      })
      expect(Math.abs(loop.startTop - loop.hostTop)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(loop.startBottom - loop.hostBottom)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(loop.startHeight - loop.hostHeight)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(loop.endTop - loop.hostTop)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(loop.endBottom - loop.hostBottom)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(loop.endHeight - loop.hostHeight)).toBeLessThanOrEqual(0.5)
      expect(loop.hitWidth).toBeGreaterThanOrEqual(44)
      const grip = page.locator('[data-loop-region="arrange"] [data-loop-edge="start"] .loop-grip-face')
      const box = await grip.boundingBox()
      if (box) {
        await page.screenshot({
          path: '/opt/cursor/artifacts/loop-handle-after-phone.png',
          clip: { x: Math.max(0, box.x - 30), y: Math.max(0, box.y - 20), width: 180, height: 90 },
        })
      }

      const dock = await page.evaluate(() => {
        const row = document.querySelector('[data-phone-context="arrange"]') as HTMLElement
        const buttons = [...row.querySelectorAll('button, .bpm-readout')] as HTMLElement[]
        const boxes = buttons.map((button) => {
          const rect = button.getBoundingClientRect()
          const label = button.querySelector('.phone-face, .t-word, .tempo-figure, .tempo-kicker') as HTMLElement | null
          const text = (button.innerText || '').replace(/\s+/g, ' ').trim()
          const name = button.getAttribute('aria-label') || ''
          return {
            text,
            name,
            width: rect.width,
            height: rect.height,
            icon: Boolean(button.querySelector('svg')),
            clipped: label && getComputedStyle(label).display !== 'none' ? label.scrollWidth > label.clientWidth + 0.5 : false,
          }
        })
        return { boxes, rowHeight: row.getBoundingClientRect().height }
      })
      expect(dock.boxes.length).toBeGreaterThanOrEqual(8)
      const widths = dock.boxes.map((item) => item.width)
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
      for (const item of dock.boxes) {
        expect(item.height, item.name || item.text).toBeGreaterThanOrEqual(40)
        expect(item.width, item.name || item.text).toBeGreaterThanOrEqual(40)
        expect(item.clipped, item.name || item.text).toBe(false)
      }
      const tempo = dock.boxes.find((item) => item.name.includes('Tap to set tempo'))
      expect(tempo?.text).toMatch(/Tap\s+120/)
      const setup = dock.boxes.find((item) => item.name.startsWith('Setup'))
      expect(setup?.icon).toBe(true)
      expect(setup?.text).not.toContain('Setup')
      const remove = dock.boxes.find((item) => item.name.startsWith('Delete'))
      const copy = dock.boxes.find((item) => item.name.startsWith('Duplicate'))
      expect(remove?.icon).toBe(true)
      expect(copy?.icon).toBe(true)
      expect(remove?.text).not.toContain('Delete')
      expect(copy?.text).not.toContain('Duplicate')
      await page.screenshot({ path: '/opt/cursor/artifacts/dock-after-phone.png', clip: { x: 0, y: 640, width: 390, height: 204 } })

      const three = await page.evaluate(() => {
        const heads = [...document.querySelectorAll('.arrange .head')] as HTMLElement[]
        const last = heads[heads.length - 1].getBoundingClientRect()
        const add = document.querySelector('.track-add .add-track-btn') as HTMLElement
        const addBox = add.getBoundingClientRect()
        const dockTop = (document.querySelector('.tool-slot') as HTMLElement).getBoundingClientRect().top
        return { tracks: heads.length, lastBottom: last.bottom, addTop: addBox.top, addBottom: addBox.bottom, addHeight: addBox.height, dockTop }
      })
      expect(three.tracks).toBeGreaterThanOrEqual(2)
      expect(three.addTop).toBeGreaterThanOrEqual(three.lastBottom - 2)
      expect(three.addTop).toBeLessThan(three.lastBottom + 12)
      expect(three.addBottom).toBeLessThan(three.dockTop - 8)
      expect(three.addHeight).toBeGreaterThanOrEqual(40)
      await page.screenshot({ path: '/opt/cursor/artifacts/add-track-after-3-phone.png', clip: { x: 0, y: 70, width: 230, height: 560 } })

      await page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { project: { tracks: unknown[] }; addTrack: (type: 'audio') => void } } }).__cueharbor.store
        const need = 20 - store.project.tracks.length
        for (let i = 0; i < need; i++) store.addTrack('audio')
      })
      await page.waitForTimeout(150)
      const many = await page.evaluate(() => {
        const add = document.querySelector('.track-add .add-track-btn') as HTMLElement
        const box = add.getBoundingClientRect()
        const dock = (document.querySelector('.tool-slot') as HTMLElement).getBoundingClientRect()
        const x = box.left + box.width / 2
        const y = box.top + box.height / 2
        const hit = document.elementFromPoint(x, y)
        const before = window.__cueharbor.store.project.tracks.length
        return {
          before,
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          dockTop: dock.top,
          inView: box.top >= 0 && box.bottom <= window.innerHeight,
          aboveDock: box.bottom <= dock.top + 0.5,
          hit: hit === add || add.contains(hit),
        }
      })
      expect(many.before).toBeGreaterThanOrEqual(20)
      expect(many.inView).toBe(true)
      expect(many.aboveDock).toBe(true)
      expect(many.height).toBeGreaterThanOrEqual(40)
      expect(many.hit).toBe(true)
      await page.locator('.track-add .add-track-btn').click()
      await page.getByRole('button', { name: /Audio \/ Vocal/ }).click()
      const after = await page.evaluate(() => window.__cueharbor.store.project.tracks.length)
      expect(after).toBe(many.before + 1)
      await page.screenshot({ path: '/opt/cursor/artifacts/add-track-after-20-phone.png' })
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 60000)

  it('tracks a touch drag down, back past the start, and down again', async () => {
    const started = await boot()
    child = started.child
    browser = started.browser
    page = started.page
    try {
      await page.evaluate(() => window.__cueharbor.store.setView('mix'))
      await page.locator('.mixer .volume-row .touch-slider').first().waitFor()
      await page.evaluate(() => {
        const scroller = document.querySelector('.mixer') as HTMLElement
        scroller.scrollLeft = 40
      })
      const trace = await page.evaluate(() => {
        const el = document.querySelector('.mixer .volume-row .touch-slider') as HTMLElement
        const box = el.getBoundingClientRect()
        const x = box.left + box.width / 2
        const y = box.top + Math.min(box.height * 0.45, box.height - 30)
        const track = window.__cueharbor.store.project.tracks[0]
        const values: number[] = []
        const read = () => values.push(window.__cueharbor.store.project.tracks[0].volume)
        const fire = (type: string, clientY: number) => {
          el.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 4,
            pointerType: 'touch',
            clientX: x,
            clientY,
            buttons: type === 'pointerup' ? 0 : 1,
          }))
          read()
        }
        const origin = track.volume
        fire('pointerdown', y)
        const down: number[] = []
        for (let step = 1; step <= 16; step++) {
          fire('pointermove', y + step * 6)
          down.push(values[values.length - 1])
        }
        const up: number[] = []
        for (let step = 1; step <= 24; step++) {
          fire('pointermove', y + 96 - step * 6)
          up.push(values[values.length - 1])
        }
        const again: number[] = []
        for (let step = 1; step <= 10; step++) {
          fire('pointermove', y + 96 - 144 + step * 6)
          again.push(values[values.length - 1])
        }
        const endY = y + 12
        fire('pointerup', endY)
        const mono = (series: number[], direction: 1 | -1) => series.every((value, index) => index === 0 || (value - series[index - 1]) * direction >= -1e-4)
        return {
          origin,
          down,
          up,
          again,
          end: window.__cueharbor.store.project.tracks[0].volume,
          downMono: mono(down, -1),
          upMono: mono(up, 1),
          againMono: mono(again, -1),
          delta: y - endY,
        }
      })
      expect(trace.downMono).toBe(true)
      expect(trace.upMono).toBe(true)
      expect(trace.againMono).toBe(true)
      expect(trace.down[trace.down.length - 1]).toBeLessThan(trace.origin)
      expect(trace.up[trace.up.length - 1]).toBeGreaterThan(trace.down[trace.down.length - 1])
      expect(trace.up[trace.up.length - 1]).toBeGreaterThan(trace.origin)
      expect(trace.again[trace.again.length - 1]).toBeLessThan(trace.up[trace.up.length - 1])
      const expected = dragGain({ origin: trace.origin, deltaPx: trace.delta, min: 0, max: 1.25 })
      expect(trace.end).toBeCloseTo(expected, 4)
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 60000)

  it('shows the bass notes as one instrument and plays different pitches', async () => {
    const notes = ['A', 'B', 'C#', 'C', 'D#', 'D']
    const catalog = {
      version: 1,
      generated_at: '2026-11-12T00:00:00Z',
      count: notes.length,
      pending: '',
      entries: notes.map((note) => ({
        key: `Goldbaby/Bass/${note}.wav`,
        size: 200,
        format: 'wav',
        pack: 'Goldbaby',
        type: 'one-shot',
        category: 'bass',
        instrument: 'bass',
        genre: [],
        bpm: null,
        musical_key: '',
        root: note,
        note,
        mood: [],
        tags: ['bass'],
        license: 'private',
        search: `${note} bass`,
      })),
    }
    const gzip = gzipSync(Buffer.from(JSON.stringify(catalog)))
    const wav = Buffer.from(encodeWav([Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 8) * 0.2)], 48000))
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 5199
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(url, child)
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    const fulfill = async (route: Route) => {
      const target = route.request().url()
      if (target.includes('/api/library/sign')) {
        const body = route.request().postDataJSON() as { keys?: string[] }
        const urls = (body.keys ?? []).map((key) => ({
          key,
          url: key.endsWith('.gz') ? `${url}/library-test/catalog.json.gz` : `${url}/library-test/audio.wav`,
        }))
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, expiresIn: 900, urls }) })
        return
      }
      if (target.includes('/api/library')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true }) })
        return
      }
      if (target.includes('/library-test/catalog')) {
        await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: gzip })
        return
      }
      if (target.includes('/library-test/audio')) {
        await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav })
        return
      }
      await route.continue()
    }
    await page.route('**/*', fulfill)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await page.getByRole('button', { name: 'Browse', exact: true }).click()
      await page.getByLabel('Library passphrase').fill('harbor-key')
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.getByLabel('Search my library').waitFor()
      await page.getByRole('button', { name: 'Play Bass' }).waitFor()
      const names = await page.locator('.my-library .sound-row strong').allTextContents()
      expect(names.map((name) => name.trim())).toEqual(['Bass'])
      await page.screenshot({ path: '/opt/cursor/artifacts/bass-one-row-phone.png' })
      await page.getByRole('button', { name: 'Load Bass' }).click()
      await page.waitForTimeout(200)
      const roots = await page.evaluate(() => {
        const tracks = (window as unknown as { __cueharbor: { store: { project: { tracks: { library?: { zones?: { root: number }[] } }[] } } } }).__cueharbor.store.project.tracks
        const zones = tracks.find((item) => item.library?.zones?.length)?.library?.zones ?? []
        return [...new Set(zones.map((zone) => zone.root))]
      })
      expect(roots.length).toBeGreaterThanOrEqual(6)
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 60000)
})
