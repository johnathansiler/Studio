import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

mkdirSync('/opt/cursor/artifacts', { recursive: true })

const port = 4319
const url = `http://127.0.0.1:${port}`

async function waitForServer(child: ChildProcess) {
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

async function boot(width: number, height: number) {
  const browser = await chromium.launch({ headless: true })
  const phone = width < 900 || height <= 520
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: true, isMobile: phone })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
  return { browser, page }
}

async function dragLaneEnd(page: Page, direction: 1 | -1) {
  const before = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.arrange')!).getPropertyValue('--lane-zoom')))
  const thumb = await page.locator('[data-overview-thumb="y"]').boundingBox()
  const track = await page.locator('[data-overview="y"] .overview-track').boundingBox()
  if (!thumb || !track) throw new Error('missing vertical overview')
  const viewport = page.viewportSize()
  const touch = true
  const x = thumb.x + thumb.width / 2
  const y = touch
    ? Math.min(thumb.y + Math.max(8, thumb.height - 8), track.y + track.height - 4)
    : thumb.y + Math.max(12, thumb.height - (direction > 0 ? 24 : 36))
  const dest = direction > 0 ? Math.min((viewport?.height ?? 900) - 4, y + 180) : Math.max(4, y - 220)
  if (touch) {
    const client = await page.context().newCDPSession(page)
    const point = (py: number) => [{ x: Math.round(x), y: Math.round(py), id: 1 }]
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(y) })
    for (let step = 1; step <= 8; step++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(y + ((dest - y) * step) / 8) })
      await page.waitForTimeout(16)
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await client.detach()
  } else {
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, dest, { steps: 12 })
    await page.mouse.up()
  }
  await page.waitForTimeout(40)
  const measured = await page.evaluate(() => ({
    zoom: Number(getComputedStyle(document.querySelector('.arrange')!).getPropertyValue('--lane-zoom')),
    inner: window.innerWidth,
  }))
  return { before, after: measured.zoom, y: Math.round(y), dest: Math.round(dest), touch, x: Math.round(x), inner: measured.inner }
}

describe('phone and landscape layout bugs', () => {
  let child: ChildProcess
  beforeAll(async () => {
    child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(child)
  }, 30000)
  afterAll(() => { child?.kill('SIGTERM') })

  it('opens MIDI from the phone menu and every menu row does something', async () => {
    const { browser, page } = await boot(390, 844)
    try {
      await page.getByRole('button', { name: /^Menu/ }).click()
      await page.locator('#shell-menu').waitFor()
      const actions = await page.locator('#shell-menu [data-menu-action]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-action')))
      expect(actions).toEqual(['undo', 'redo', 'new', 'open', 'save', 'export', 'midi', 'latency', 'shortcuts'])

      await page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { project: { tracks: { id: string }[] }; updateTrack: (id: string, patch: { name: string }) => void } } }).__cueharbor.store
        store.updateTrack(store.project.tracks[0].id, { name: 'Renamed Vocal' })
      })
      expect(await page.locator('[data-menu-action="undo"]').isDisabled()).toBe(false)
      await page.locator('[data-menu-action="undo"]').click()
      expect((await page.locator('.arrange .head .track-title').first().innerText()).trim()).toBe('Vocal')
      await page.getByRole('button', { name: /^Menu/ }).click()
      expect(await page.locator('[data-menu-action="redo"]').isDisabled()).toBe(false)
      await page.locator('[data-menu-action="redo"]').click()
      expect((await page.locator('.arrange .head .track-title').first().innerText()).trim()).toBe('Renamed Vocal')

      await page.getByRole('button', { name: /^Menu/ }).click()
      await page.locator('[data-menu-action="latency"] select').selectOption('playback')
      await page.waitForFunction(() => document.querySelector('[data-menu-action="latency"] .menu-value')?.textContent?.includes('Playback'))
      await page.locator('[data-menu-action="shortcuts"]').click()
      const shortcuts = page.getByRole('dialog', { name: 'Shortcuts' })
      await shortcuts.waitFor()
      await shortcuts.getByRole('button', { name: 'Close', exact: true }).click()
      await shortcuts.waitFor({ state: 'hidden' })

      await page.getByRole('button', { name: /^Menu/ }).click()
      await page.locator('[data-menu-action="midi"]').click()
      const sheet = page.locator('#midi-tools-sheet')
      await sheet.waitFor()
      const place = await page.evaluate(() => {
        const box = document.querySelector('#midi-tools-sheet')!.getBoundingClientRect()
        const tabs = document.querySelector('.phone-tabs')!.getBoundingClientRect()
        const close = document.querySelector('#midi-tools-sheet .sheet-close')!
        const closeBox = close.getBoundingClientRect()
        const tabHit = document.elementFromPoint(tabs.left + 24, tabs.top + tabs.height / 2)
        return {
          coversTabs: box.bottom > tabs.top + 1,
          close: { w: closeBox.width, h: closeBox.height, text: close.textContent?.trim() ?? '' },
          tabHit: (tabHit?.getAttribute('aria-label') || tabHit?.textContent || '').trim(),
          learn: !!document.querySelector('#midi-tools-sheet [role="tab"]'),
        }
      })
      expect(place.coversTabs).toBe(false)
      expect(place.close.w).toBeGreaterThanOrEqual(40)
      expect(place.close.h).toBeGreaterThanOrEqual(40)
      expect(place.close.text).not.toMatch(/Close/)
      expect(place.tabHit.startsWith('Menu')).toBe(true)
      expect(place.learn).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/fix-midi-390.png' })
      await sheet.getByRole('button', { name: 'Close', exact: true }).click()
      await sheet.waitFor({ state: 'hidden' })
    } finally {
      await browser.close()
    }
  }, 60000)

  it('still opens MIDI tools on fold and desk widths', async () => {
    for (const viewport of [{ width: 880, height: 1000, name: '880' }, { width: 1440, height: 900, name: '1440' }]) {
      const { browser, page } = await boot(viewport.width, viewport.height)
      try {
        await page.getByRole('button', { name: /^Menu/ }).click()
        await page.locator('[data-menu-action="midi"]').click()
        await page.locator('.midi-tools').waitFor()
        expect(await page.locator('#midi-tools-sheet').count()).toBe(0)
        await page.screenshot({ path: `/opt/cursor/artifacts/fix-midi-${viewport.name}.png` })
      } finally {
        await browser.close()
      }
    }
  }, 60000)

  it('opens Browse on My Library without the old sound lists', async () => {
    const namesAt = async (width: number, height: number) => {
      const { browser, page } = await boot(width, height)
      try {
        await page.getByRole('button', { name: 'Browse', exact: true }).click()
        await page.locator('[data-playlist-browser="open"]').waitFor()
        const result = await page.evaluate(() => {
          const sheet = document.querySelector('[data-playlist-browser="open"]')!
          const tabs = [...sheet.querySelectorAll('.browser-tabs .browser-chip-scroll > button')].map((node) => node.textContent?.trim() ?? '')
          const dock = document.querySelector('.tool-slot')?.getBoundingClientRect()
          const sheetBox = sheet.getBoundingClientRect()
          return {
            tabs,
            harbor: sheet.querySelectorAll('[data-harbor]').length,
            kind: sheet.querySelectorAll('.sound-chips[aria-label="Kind"]').length,
            aboveDock: !dock || sheetBox.bottom <= dock.top + 1,
          }
        })
        await page.screenshot({ path: `/opt/cursor/artifacts/fix-sounds-${width}x${height}.png` })
        return result
      } finally {
        await browser.close()
      }
    }
    const land = await namesAt(844, 390)
    const phone = await namesAt(390, 844)
    const wide = await namesAt(476, 752)
    for (const result of [land, phone, wide]) {
      expect(result.tabs).toEqual(['My Library', 'Patterns', 'Clips'])
      expect(result.harbor).toBe(0)
      expect(result.kind).toBe(0)
      expect(result.aboveDock).toBe(true)
    }
  }, 90000)

  it('keeps the track menu tappable when lanes are zoomed fully out and fully in', async () => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 1440, height: 900 },
    ]) {
      const { browser, page } = await boot(viewport.width, viewport.height)
      try {
        await page.evaluate(() => {
          const store = (window as unknown as { __cueharbor: { store: { addTrack: (type: 'audio') => void } } }).__cueharbor.store
          for (let i = 0; i < 4; i++) store.addTrack('audio')
        })
        await page.waitForFunction(() => document.querySelectorAll('.timeline-scroll .lane').length >= 6)
        const start = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.arrange')!).getPropertyValue('--lane-zoom')))
        expect(start).toBeCloseTo(1, 1)
        let zoom = start
        const steps: { before: number; after: number }[] = []
        for (let i = 0; i < 8; i++) {
          const step = await dragLaneEnd(page, 1)
          steps.push({ before: step.before, after: step.after })
          zoom = step.after
          if (zoom < 0.58) break
        }
        expect(zoom, `${viewport.width}x${viewport.height} ${JSON.stringify(steps)}`).toBeLessThan(0.58)
        const out = await page.evaluate(() => {
          const head = document.querySelector('.arrange .head')!
          const more = head.querySelector('.track-more')!
          const name = head.querySelector('.track-title') as HTMLElement
          const headBox = head.getBoundingClientRect()
          const moreBox = more.getBoundingClientRect()
          const cx = moreBox.left + moreBox.width / 2
          const cy = moreBox.top + moreBox.height / 2
          const hit = document.elementFromPoint(cx, cy)
          return {
            scale: document.querySelector('.arrange')!.getAttribute('data-lane-scale'),
            lane: headBox.height,
            menu: Boolean(hit?.closest('.track-more')),
            menuInside: cy >= headBox.top - 1 && cy <= headBox.bottom + 1 && cx >= headBox.left && cx <= headBox.right && moreBox.height >= 36 && moreBox.height <= 44,
            nameHidden: name.checkVisibility() === false,
          }
        })
        expect(out.scale).toBe('min')
        expect(out.lane).toBeGreaterThanOrEqual(40)
        expect(out.lane).toBeLessThan(58)
        expect(out.menu).toBe(true)
        expect(out.menuInside).toBe(true)
        expect(out.nameHidden).toBe(true)
        await page.screenshot({ path: `/opt/cursor/artifacts/fix-zoom-${viewport.width}x${viewport.height}.png` })

        let grown = zoom
        const up: { before: number; after: number; y: number; dest: number }[] = []
        for (let i = 0; i < 8; i++) {
          const step = await dragLaneEnd(page, -1)
          up.push(step)
          grown = step.after
          if (grown > 1) break
          if (i > 1 && step.after < step.before + 0.01) break
        }
        expect(grown, `${viewport.width}x${viewport.height} from ${zoom} ${JSON.stringify(up)}`).toBeGreaterThan(1)
      } finally {
        await browser.close()
      }
    }
  }, 90000)

  it('scrolls every landscape track name clear of the dock', async () => {
    const { browser, page } = await boot(844, 390)
    try {
      const result = await page.evaluate(() => {
        const heads = document.querySelector('.arrange .heads') as HTMLElement
        const dock = document.querySelector('.tool-slot')!.getBoundingClientRect()
        const names = [...document.querySelectorAll('.arrange .head .track-title')] as HTMLElement[]
        const gap = document.querySelector('.ruler-gap')?.getBoundingClientRect().height ?? 0
        const hits = names.map((name) => {
          const frame = heads.getBoundingClientRect()
          heads.scrollTop += name.getBoundingClientRect().top - frame.top - gap - 4
          const box = name.getBoundingClientRect()
          const hit = document.elementFromPoint(box.left + 16, box.top + box.height / 2)
          return {
            value: (name.textContent || '').trim(),
            above: box.bottom <= dock.top + 1,
            hit: hit === name || Boolean(hit?.closest('.track-title')),
          }
        })
        return {
          headsBottom: heads.getBoundingClientRect().bottom,
          dockTop: dock.top,
          hits,
        }
      })
      expect(result.headsBottom).toBeLessThanOrEqual(result.dockTop + 1)
      expect(result.hits.map((hit) => hit.value)).toEqual(['Vocal', 'Music', 'Keys'])
      for (const hit of result.hits) {
        expect(hit.above, hit.value).toBe(true)
        expect(hit.hit, hit.value).toBe(true)
      }
      await page.screenshot({ path: '/opt/cursor/artifacts/fix-land-tracks.png' })
    } finally {
      await browser.close()
    }
  }, 60000)

  it('keeps phone toasts off Record, the overview, and the dock tabs', async () => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      const { browser, page } = await boot(viewport.width, viewport.height)
      try {
        await page.evaluate(() => {
          const store = (window as unknown as { __cueharbor: { store: { toast: (text: string, tone?: string) => void } } }).__cueharbor.store
          store.toast('Saved in this browser.', 'good')
          store.toast('Undid: Edit')
        })
        await page.locator('.toast', { hasText: 'Undid: Edit' }).waitFor()
        const place = await page.evaluate(() => {
          const over = (a: DOMRect, b: DOMRect | undefined) => Boolean(b) && a.top < b!.bottom - 1 && a.bottom > b!.top + 1 && a.left < b!.right - 1 && a.right > b!.left + 1
          const rec = document.querySelector('.t-btn.rec')?.getBoundingClientRect()
          const overview = document.querySelector('[data-overview="x"]')?.getBoundingClientRect()
          const tabs = document.querySelector('.phone-tabs')?.getBoundingClientRect()
          return [...document.querySelectorAll('.toasts .toast')].map((el) => {
            const box = el.getBoundingClientRect()
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
            return {
              text: el.textContent?.trim(),
              coversRec: over(box, rec),
              coversOverview: over(box, overview),
              coversTabs: over(box, tabs),
              blocks: Boolean(hit?.closest('.toast')),
            }
          })
        })
        expect(place.length).toBeGreaterThanOrEqual(2)
        for (const toast of place) {
          expect(toast.coversRec, toast.text).toBe(false)
          expect(toast.coversOverview, toast.text).toBe(false)
          expect(toast.coversTabs, toast.text).toBe(false)
          expect(toast.blocks, toast.text).toBe(false)
        }
        await page.screenshot({ path: `/opt/cursor/artifacts/fix-toast-${viewport.width}x${viewport.height}.png` })
      } finally {
        await browser.close()
      }
    }
  }, 60000)
})
