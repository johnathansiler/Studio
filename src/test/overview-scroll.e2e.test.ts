import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      if ((await fetch(url)).ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

function trackErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  return errors
}

async function openArrange(browser: Browser, viewport: { width: number; height: number }, touch: boolean) {
  const page = await browser.newPage({
    viewport,
    hasTouch: touch,
    isMobile: touch,
    deviceScaleFactor: 1,
  })
  return page
}

describe('timeline overview and loop handles', () => {
  const port = 5194
  const url = `http://127.0.0.1:${port}`
  let child: ChildProcess
  let browser: Browser

  beforeAll(async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(url, child)
    browser = await chromium.launch({ headless: true })
  }, 40000)

  afterAll(async () => {
    await browser?.close()
    child?.kill('SIGTERM')
  })

  async function boot(viewport: { width: number; height: number }, touch: boolean) {
    const page = await openArrange(browser, viewport, touch)
    const errors = trackErrors(page)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-loop-region="arrange"]').waitFor()
    await page.locator('[data-overview="x"]').waitFor()
    await page.waitForTimeout(250)
    return { page, errors }
  }

  it('keeps loop handles on the beat at every horizontal scroll step', async () => {
    const { page, errors } = await boot({ width: 1440, height: 900 }, false)
    const placed = await page.evaluate(() => {
      const store = (window as unknown as {
        __cueharbor: { store: { project: { sampleRate: number; tempo: number }; setLoop: (on: boolean, start?: number, end?: number) => void } }
      }).__cueharbor.store
      const beat = store.project.sampleRate * (60 / store.project.tempo)
      const scroller = document.querySelector('.timeline-scroll') as HTMLElement
      const px = Number((document.querySelector('.timeline-inner') as HTMLElement).dataset.px)
      const beatPx = (60 / store.project.tempo) * px
      const startBeat = 4
      const endBeat = 4 + Math.max(4, Math.floor(scroller.clientWidth / beatPx / 3))
      store.setLoop(true, Math.round(beat * startBeat), Math.round(beat * endBeat))
      return { startBeat, endBeat, beatPx, view: scroller.clientWidth }
    })
    await page.waitForTimeout(50)
    const maxScroll = Math.max(0, placed.beatPx * placed.startBeat - 8)
    const steps = [0, maxScroll * 0.25, maxScroll * 0.5, maxScroll * 0.75, maxScroll]
    for (const left of steps) {
      const row = await page.evaluate(async (scrollLeft) => {
        const scroller = document.querySelector('.timeline-scroll') as HTMLElement
        const inner = document.querySelector('.timeline-inner') as HTMLElement
        const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement
        scroller.scrollLeft = scrollLeft
        const read = () => {
          const project = (window as unknown as {
            __cueharbor: { store: { project: { tempo: number; loopStartSample: number; loopEndSample: number; sampleRate: number } } }
          }).__cueharbor.store.project
          const px = Number(inner.dataset.px)
          const beatPx = (60 / project.tempo) * px
          const origin = inner.getBoundingClientRect().left
          const start = host.querySelector('[data-loop-edge="start"] .loop-grip-face')!.getBoundingClientRect()
          const end = host.querySelector('[data-loop-edge="end"] .loop-grip-face')!.getBoundingClientRect()
          const startBeat = project.loopStartSample / project.sampleRate / (60 / project.tempo)
          const endBeat = project.loopEndSample / project.sampleRate / (60 / project.tempo)
          return {
            start: start.left,
            end: end.right,
            expectStart: origin + startBeat * beatPx,
            expectEnd: origin + endBeat * beatPx,
            parkStart: host.dataset.parkStart,
            parkEnd: host.dataset.parkEnd,
            scroll: scroller.scrollLeft,
          }
        }
        const immediate = read()
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        return { immediate, later: read() }
      }, left)
      for (const sample of [row.immediate, row.later]) {
        expect(sample.parkStart, `start park at ${left}`).toBe('track')
        expect(sample.parkEnd, `end park at ${left}`).toBe('track')
        expect(Math.abs(sample.start - sample.expectStart), `start x at ${left}`).toBeLessThan(1.5)
        expect(Math.abs(sample.end - sample.expectEnd), `end x at ${left}`).toBeLessThan(1.5)
      }
    }
    expect(errors, errors.join('\n')).toEqual([])
    await page.close()
  }, 60000)

  it('parks an off-screen end handle on the viewport edge and still drags it', async () => {
    const { page, errors } = await boot({ width: 390, height: 844 }, true)
    await page.evaluate(() => {
      const store = (window as unknown as {
        __cueharbor: { store: { project: { sampleRate: number }; setLoop: (on: boolean, start?: number, end?: number) => void } }
      }).__cueharbor.store
      store.setLoop(true, 0, Math.round(store.project.sampleRate * 120))
    })
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement | null
      const grip = host?.querySelector('[data-loop-edge="end"]') as HTMLElement | null
      const scroll = document.querySelector('.timeline-scroll') as HTMLElement | null
      if (!host || !grip || !scroll) return false
      if (host.dataset.parkEnd !== 'right') return false
      const contentRight = scroll.getBoundingClientRect().left + scroll.clientLeft + scroll.clientWidth
      return contentRight - grip.getBoundingClientRect().right < 8 && grip.getBoundingClientRect().width >= 44
    })
    const before = await page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { loopEndSample: number } } } }).__cueharbor.store.project.loopEndSample)
    const box = await page.locator('[data-loop-region="arrange"] [data-loop-edge="end"]').boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    const client = await page.context().newCDPSession(page)
    const from = { x: box!.x + box!.width - 8, y: box!.y + box!.height / 2 }
    const to = { x: from.x - 70, y: from.y }
    const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }]
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) })
    for (let step = 1; step <= 6; step++) {
      const x = from.x + ((to.x - from.x) * step) / 6
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, from.y) })
      await page.waitForTimeout(16)
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await client.detach()
    await page.waitForTimeout(40)
    const after = await page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { loopEndSample: number; loopStartSample: number } } } }).__cueharbor.store.project)
    expect(after.loopEndSample).toBeLessThan(before)
    expect(after.loopStartSample).toBe(0)
    expect(errors, errors.join('\n')).toEqual([])
    await page.close()
  }, 60000)

  it('drags the overview with touch at 390x844 and a mouse at 1440x900', async () => {
    const phone = await boot({ width: 390, height: 844 }, true)
    const phoneBars = await phone.page.evaluate(() => {
      const scroll = document.querySelector('.timeline-scroll')!.getBoundingClientRect()
      const bar = document.querySelector('[data-overview="x"]')!.getBoundingClientRect()
      const side = document.querySelector('[data-overview="y"]')!.getBoundingClientRect()
      const head = document.querySelector('.heads')!.getBoundingClientRect()
      const transport = document.querySelector('.transport')?.getBoundingClientRect()
      const lane = document.querySelector('.timeline-scroll .lane')?.getBoundingClientRect()
      return {
        barH: bar.height,
        sideW: side.width,
        scrollBottom: scroll.bottom,
        barTop: bar.top,
        barBottom: bar.bottom,
        sideLeft: side.left,
        scrollRight: scroll.right,
        headRight: head.right,
        transportTop: transport?.top ?? null,
        toolsTop: document.querySelector('.tool-slot')?.getBoundingClientRect().top ?? null,
        laneBottom: lane?.bottom ?? null,
      }
    })
    expect(phoneBars.barH).toBeGreaterThanOrEqual(40)
    expect(phoneBars.sideW).toBeGreaterThanOrEqual(40)
    expect(phoneBars.scrollBottom).toBeLessThanOrEqual(phoneBars.barTop + 1)
    expect(phoneBars.scrollRight).toBeLessThanOrEqual(phoneBars.sideLeft + 1)
    expect(phoneBars.sideLeft).toBeGreaterThanOrEqual(phoneBars.headRight - 1)
    if (phoneBars.toolsTop != null) expect(phoneBars.barBottom).toBeLessThanOrEqual(phoneBars.toolsTop + 1)
    if (phoneBars.laneBottom != null) expect(phoneBars.laneBottom).toBeLessThanOrEqual(phoneBars.barTop + 1)

    const toast = phone.page.locator('.select-hint')
    if (await toast.count()) {
      await phone.page.locator('.hint-close').click()
      await toast.waitFor({ state: 'detached' })
    }
    const thumb = await phone.page.locator('[data-overview-thumb="x"]').boundingBox()
    expect(thumb).toBeTruthy()
    const beforeScroll = await phone.page.evaluate(() => (document.querySelector('.timeline-scroll') as HTMLElement).scrollLeft)
    const client = await phone.page.context().newCDPSession(phone.page)
    const start = { x: thumb!.x + thumb!.width / 2, y: thumb!.y + thumb!.height / 2 }
    const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }]
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(start.x, start.y) })
    for (let step = 1; step <= 6; step++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(start.x + step * 12, start.y) })
      await phone.page.waitForTimeout(16)
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await client.detach()
    await phone.page.waitForTimeout(40)
    const afterScroll = await phone.page.evaluate(() => (document.querySelector('.timeline-scroll') as HTMLElement).scrollLeft)
    expect(afterScroll).toBeGreaterThan(beforeScroll + 4)

    const endGrip = await phone.page.locator('[data-overview-thumb="x"]').boundingBox()
    const pxBefore = await phone.page.evaluate(() => Number((document.querySelector('.timeline-inner') as HTMLElement).dataset.px))
    const zoomClient = await phone.page.context().newCDPSession(phone.page)
    const zoomFrom = { x: endGrip!.x + endGrip!.width - 4, y: endGrip!.y + endGrip!.height / 2 }
    await zoomClient.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(zoomFrom.x, zoomFrom.y) })
    for (let step = 1; step <= 8; step++) {
      await zoomClient.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(zoomFrom.x - step * 10, zoomFrom.y) })
      await phone.page.waitForTimeout(16)
    }
    await zoomClient.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await zoomClient.detach()
    await phone.page.waitForTimeout(50)
    const pxAfter = await phone.page.evaluate(() => Number((document.querySelector('.timeline-inner') as HTMLElement).dataset.px))
    expect(pxAfter).toBeGreaterThan(pxBefore)
    await phone.page.screenshot({ path: '/opt/cursor/artifacts/overview_390x844.png' })
    expect(phone.errors, phone.errors.join('\n')).toEqual([])
    await phone.page.close()

    const desk = await boot({ width: 1440, height: 900 }, false)
    const deskToast = desk.page.locator('.select-hint')
    if (await deskToast.count()) {
      await desk.page.locator('.hint-close').click()
      await deskToast.waitFor({ state: 'detached' })
    }
    const before = await desk.page.evaluate(() => ({
      left: (document.querySelector('.timeline-scroll') as HTMLElement).scrollLeft,
      px: Number((document.querySelector('.timeline-inner') as HTMLElement).dataset.px),
      lane: getComputedStyle(document.querySelector('.arrange')!).getPropertyValue('--lane-zoom').trim(),
    }))
    const mouseThumb = await desk.page.locator('[data-overview-thumb="x"]').boundingBox()
    await desk.page.mouse.move(mouseThumb!.x + mouseThumb!.width / 2, mouseThumb!.y + mouseThumb!.height / 2)
    await desk.page.mouse.down()
    await desk.page.mouse.move(mouseThumb!.x + mouseThumb!.width / 2 + 80, mouseThumb!.y + mouseThumb!.height / 2, { steps: 8 })
    await desk.page.mouse.up()
    await desk.page.waitForTimeout(40)
    const scrolled = await desk.page.evaluate(() => (document.querySelector('.timeline-scroll') as HTMLElement).scrollLeft)
    expect(scrolled).toBeGreaterThan(before.left + 4)

    const zoomThumb = await desk.page.locator('[data-overview-thumb="x"]').boundingBox()
    await desk.page.mouse.move(zoomThumb!.x + 6, zoomThumb!.y + zoomThumb!.height / 2)
    await desk.page.mouse.down()
    await desk.page.mouse.move(zoomThumb!.x + 6 + 70, zoomThumb!.y + zoomThumb!.height / 2, { steps: 8 })
    await desk.page.mouse.up()
    await desk.page.waitForTimeout(40)
    const zoomed = await desk.page.evaluate(() => Number((document.querySelector('.timeline-inner') as HTMLElement).dataset.px))
    expect(zoomed).toBeGreaterThan(before.px)

    const vThumb = await desk.page.locator('[data-overview-thumb="y"]').boundingBox()
    await desk.page.mouse.move(vThumb!.x + vThumb!.width / 2, vThumb!.y + vThumb!.height - 4)
    await desk.page.mouse.down()
    await desk.page.mouse.move(vThumb!.x + vThumb!.width / 2, vThumb!.y + vThumb!.height - 4 - 80, { steps: 8 })
    await desk.page.mouse.up()
    await desk.page.waitForTimeout(40)
    const lane = await desk.page.evaluate(() => getComputedStyle(document.querySelector('.arrange')!).getPropertyValue('--lane-zoom').trim())
    expect(Number(lane)).toBeGreaterThan(Number(before.lane || '1'))
    await desk.page.screenshot({ path: '/opt/cursor/artifacts/overview_1440x900.png' })
    expect(desk.errors, desk.errors.join('\n')).toEqual([])
    await desk.page.close()
  }, 90000)

  it('shows the overview bars at five viewports', async () => {
    const viewports = [
      { width: 390, height: 844, touch: true },
      { width: 476, height: 752, touch: true },
      { width: 880, height: 1000, touch: false },
      { width: 844, height: 390, touch: true },
      { width: 1440, height: 900, touch: false },
    ]
    for (const viewport of viewports) {
      const { page, errors } = await boot(viewport, viewport.touch)
      const box = await page.evaluate(() => {
        const x = document.querySelector('[data-overview="x"]')!.getBoundingClientRect()
        const y = document.querySelector('[data-overview="y"]')!.getBoundingClientRect()
        const scroll = document.querySelector('.timeline-scroll')!.getBoundingClientRect()
        return {
          xh: x.height,
          yw: y.width,
          gapX: x.top - scroll.bottom,
          gapY: y.left - scroll.right,
        }
      })
      expect(box.xh, `${viewport.width}x${viewport.height} horizontal hit`).toBeGreaterThanOrEqual(40)
      expect(box.yw, `${viewport.width}x${viewport.height} vertical hit`).toBeGreaterThanOrEqual(40)
      expect(Math.abs(box.gapX), `${viewport.width} horizontal gap`).toBeLessThan(2)
      expect(Math.abs(box.gapY), `${viewport.width} vertical gap`).toBeLessThan(2)
      await page.screenshot({ path: `/opt/cursor/artifacts/overview_${viewport.width}x${viewport.height}.png` })
      expect(errors, errors.join('\n')).toEqual([])
      await page.close()
    }
  }, 90000)
})
