import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

mkdirSync('/opt/cursor/artifacts', { recursive: true })

const port = 4491
const url = `http://127.0.0.1:${port}`
/** Portrait zooms. 0.72 is the inclusive min cutoff, so a 0.58 revert fails at 0.6. */
const SWEEP = [0.5, 0.55, 0.6, 0.65, 0.7, 0.72, 0.8, 0.85] as const
const SHOTS = new Set<number>([0.5, 0.6, 0.72])

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
  const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
  }))
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: true, isMobile: true })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^Arrange/ }).first().click()
  await page.locator('.arrange .track-more').first().waitFor()
  return { browser, page }
}

async function setLaneZoom(page: Page, zoom: number) {
  const result = await page.evaluate((next) => {
    const arrange = document.querySelector('.arrange') as HTMLElement | null
    if (!arrange) return { ok: false, reason: 'missing arrange' }
    const current = Number(getComputedStyle(arrange).getPropertyValue('--lane-zoom'))
    const key = Object.keys(arrange).find((name) => name.startsWith('__reactFiber'))
    type Hook = { memoizedState: unknown; queue?: { dispatch?: (value: number) => void }; next: Hook | null }
    type Fiber = { memoizedState: Hook | null; return: Fiber | null }
    let fiber = key ? (arrange as unknown as Record<string, Fiber>)[key] : null
    const seen = new Set<Fiber>()
    while (fiber && !seen.has(fiber)) {
      seen.add(fiber)
      let hook = fiber.memoizedState
      while (hook) {
        const dispatch = hook.queue?.dispatch
        if (typeof hook.memoizedState === 'number' && typeof dispatch === 'function' && Math.abs(hook.memoizedState - current) < 0.0005) {
          dispatch(next)
          return { ok: true, from: hook.memoizedState }
        }
        hook = hook.next
      }
      fiber = fiber.return
    }
    return { ok: false, reason: 'no zoom state', current }
  }, zoom)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  await page.waitForFunction((target) => {
    const value = Number(getComputedStyle(document.querySelector('.arrange')!).getPropertyValue('--lane-zoom'))
    return Math.abs(value - target) < 0.0005
  }, zoom)
}

type TrackReport = {
  name: string
  nameVisible: boolean
  nameHeight: number
  menuHeight: number
  menuWidth: number
  menuInsideHead: boolean
  menuInsideLane: boolean
  hitMenu: boolean
  hitRuler: boolean
  hit: string
  laneHeight: number
}

type LayoutReport = {
  zoom: number
  scale: string | null
  compact: string | null
  tracks: TrackReport[]
}

async function readLayout(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const arrange = document.querySelector('.arrange') as HTMLElement
    const heads = [...document.querySelectorAll('.arrange .heads .head')] as HTMLElement[]
    const lanes = [...document.querySelectorAll('.timeline-scroll .timeline-inner > .lane')] as HTMLElement[]
    const tracks = heads.map((head, index) => {
      const name = head.querySelector('.name') as HTMLElement | null
      const menu = head.querySelector('.track-more') as HTMLElement | null
      const lane = lanes[index]
      const nameBox = name?.getBoundingClientRect()
      const menuBox = menu?.getBoundingClientRect()
      const headBox = head.getBoundingClientRect()
      const laneBox = lane?.getBoundingClientRect()
      const style = name ? getComputedStyle(name) : null
      const nameVisible = Boolean(
        name && style && style.display !== 'none' && style.visibility !== 'hidden'
        && nameBox && nameBox.width > 1 && nameBox.height > 1 && name.checkVisibility(),
      )
      const cx = menuBox ? menuBox.left + menuBox.width / 2 : 0
      const cy = menuBox ? menuBox.top + menuBox.height / 2 : 0
      const hit = menuBox ? document.elementFromPoint(cx, cy) : null
      const slop = 1
      const inside = (box: DOMRect, outer: DOMRect, verticalOnly = false) => box.top >= outer.top - slop
        && box.bottom <= outer.bottom + slop
        && (verticalOnly || (box.left >= outer.left - slop && box.right <= outer.right + slop))
      return {
        name: (name as HTMLInputElement | null)?.value ?? '',
        nameVisible,
        nameHeight: nameBox?.height ?? 0,
        menuHeight: menuBox?.height ?? 0,
        menuWidth: menuBox?.width ?? 0,
        menuInsideHead: Boolean(menuBox && inside(menuBox, headBox)),
        menuInsideLane: Boolean(menuBox && laneBox && inside(menuBox, laneBox, true)),
        hitMenu: Boolean(hit?.closest('.track-more')),
        hitRuler: Boolean(hit?.closest('.ruler, [data-loop-region], .loop-grip, .ruler-gap, .loop-gap')),
        hit: (hit?.getAttribute('aria-label') || hit?.className || hit?.tagName || 'none').toString().replace(/\s+/g, ' ').slice(0, 80),
        laneHeight: laneBox?.height ?? headBox.height,
      }
    })
    return {
      zoom: Number(getComputedStyle(arrange).getPropertyValue('--lane-zoom')),
      scale: arrange.getAttribute('data-lane-scale'),
      compact: arrange.getAttribute('data-lane-compact'),
      tracks,
    }
  })
}

function assertLayout(layout: LayoutReport, zoom: number | null, where: string) {
  if (zoom == null) expect(layout.zoom, where).toBeCloseTo(1, 2)
  else expect(layout.zoom, where).toBeCloseTo(zoom, 2)
  const scale = zoom != null && zoom <= 0.72 ? 'min' : zoom != null ? 'tight' : 'roomy'
  expect(layout.tracks.length, where).toBeGreaterThan(0)
  for (const track of layout.tracks) {
    const label = `${where} ${track.name} lane ${track.laneHeight} name ${track.nameHeight}px hit ${track.hit}`
    if (scale === 'min') expect(track.nameVisible, label).toBe(false)
    else {
      expect(track.nameVisible, label).toBe(true)
      expect(track.nameHeight, label).toBeGreaterThanOrEqual(16)
    }
    expect(track.nameVisible && track.nameHeight < 16, `${label} squashed name`).toBe(false)
    expect(track.menuWidth, label).toBeGreaterThanOrEqual(36)
    expect(track.menuHeight, label).toBeGreaterThanOrEqual(36)
    expect(track.menuHeight, label).toBeLessThanOrEqual(44)
    expect(track.menuInsideHead, label).toBe(true)
    expect(track.menuInsideLane, label).toBe(true)
    expect(track.hitMenu, label).toBe(true)
    expect(track.hitRuler, label).toBe(false)
  }
  expect(layout.scale, where).toBe(scale)
}

async function tapMenus(page: Page, where: string) {
  const count = await page.locator('.arrange .heads .head .track-more').count()
  for (let index = 0; index < count; index++) {
    const button = page.locator('.arrange .heads .head .track-more').nth(index)
    await button.click({ timeout: 3000 })
    await page.locator('#track-options').waitFor()
    expect(await page.locator('#track-options').count(), `${where} track ${index}`).toBe(1)
    await page.keyboard.press('Escape')
    await page.locator('#track-options').waitFor({ state: 'hidden' })
  }
}

async function dragLaneOut(page: Page) {
  const thumb = await page.locator('[data-overview-thumb="y"]').boundingBox()
  const track = await page.locator('[data-overview="y"] .overview-track').boundingBox()
  if (!thumb || !track) throw new Error('missing vertical overview')
  const viewport = page.viewportSize()
  const x = thumb.x + thumb.width / 2
  const y = Math.min(thumb.y + Math.max(8, thumb.height - 8), track.y + track.height - 4)
  const dest = Math.min((viewport?.height ?? 800) - 4, y + 220)
  const client = await page.context().newCDPSession(page)
  const point = (py: number) => [{ x: Math.round(x), y: Math.round(py), id: 1 }]
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(y) })
  for (let step = 1; step <= 8; step++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(y + ((dest - y) * step) / 8) })
    await page.waitForTimeout(16)
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
  await page.waitForTimeout(40)
}

describe('portrait lane zoom sweep', () => {
  let child: ChildProcess
  beforeAll(async () => {
    child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(child)
  }, 30000)
  afterAll(() => { child?.kill('SIGTERM') })

  it('hides a squashed name and keeps the track menu inside the lane', async () => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 476, height: 752 },
    ]) {
      const { browser, page } = await boot(viewport.width, viewport.height)
      try {
        const where = `${viewport.width}x${viewport.height}`
        const initial = await readLayout(page)
        if (viewport.width === 390) await page.screenshot({ path: '/opt/cursor/artifacts/lane-zoom-default-390x844.png' })
        assertLayout(initial, null, `${where} default`)
        await tapMenus(page, `${where} default`)

        for (const zoom of SWEEP) {
          await setLaneZoom(page, zoom)
          const layout = await readLayout(page)
          if (viewport.width === 390 && SHOTS.has(zoom)) {
            await page.screenshot({ path: `/opt/cursor/artifacts/lane-zoom-${zoom}-390x844.png` })
          }
          // At 0.6 a 0.58 cutoff stays 'tight': the name is a few pixels tall
          // and the menu center hits the loop ruler instead of the button.
          assertLayout(layout, zoom, `${where} zoom ${zoom}`)
          await tapMenus(page, `${where} zoom ${zoom}`)
        }

        if (viewport.width === 390) {
          await setLaneZoom(page, 0.8)
          let zoom = 0.8
          for (let step = 0; step < 6; step++) {
            const before = zoom
            await dragLaneOut(page)
            zoom = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.arrange')!).getPropertyValue('--lane-zoom')))
            if (zoom > before - 0.01) break
          }
          expect(zoom, 'zoom floor').toBeGreaterThanOrEqual(0.5 - 0.001)
          expect(zoom, 'zoom floor').toBeLessThanOrEqual(0.52)
          const lane = await page.evaluate(() => document.querySelector('.timeline-scroll .lane')!.getBoundingClientRect().height)
          expect(lane, 'lane at the floor').toBeGreaterThanOrEqual(40)
        }
      } finally {
        await browser.close()
      }
    }
  }, 180000)
})
