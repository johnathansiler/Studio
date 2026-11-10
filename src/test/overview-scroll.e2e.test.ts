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
    const toast = page.locator('.select-hint')
    if (await toast.count()) {
      await page.locator('.hint-close').click()
      await toast.waitFor({ state: 'detached' })
    }
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
          const thumb = host.ownerDocument.querySelector('[data-overview-thumb="x"]') as HTMLElement
          const match = /translateX\(([-\d.]+)px\)/.exec(thumb.style.transform)
          return {
            start: start.left,
            end: end.right,
            expectStart: origin + startBeat * beatPx,
            expectEnd: origin + endBeat * beatPx,
            parkStart: host.dataset.parkStart,
            parkEnd: host.dataset.parkEnd,
            scroll: scroller.scrollLeft,
            px,
            thumb: match ? Number(match[1]) : 0,
          }
        }
        let hostWrites = 0
        const observer = new MutationObserver(() => { hostWrites += 1 })
        observer.observe(host, { subtree: true, attributes: true, attributeFilter: ['style', 'class', 'data-park-start', 'data-park-end'] })
        const immediate = read()
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        observer.disconnect()
        return { immediate, later: read(), hostWrites }
      }, left)
      for (const sample of [row.immediate, row.later]) {
        expect(sample.parkStart, `start park at ${left}`).toBe('track')
        expect(sample.parkEnd, `end park at ${left}`).toBe('track')
        expect(Math.abs(sample.start - sample.expectStart), `start x at ${left}`).toBeLessThan(1.5)
        expect(Math.abs(sample.end - sample.expectEnd), `end x at ${left}`).toBeLessThan(1.5)
        expect(sample.px, `px stays put while scrolling at ${left}`).toBe(row.immediate.px)
      }
      expect(row.hostWrites, `loop host restyle at ${left}`).toBe(0)
      if (row.later.scroll > 1) expect(row.later.thumb, `thumb tracks scroll at ${left}`).toBeGreaterThan(1)
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
    const parked = await page.evaluate(() => {
      const grip = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"]') as HTMLElement
      const face = grip.querySelector('.loop-grip-face') as HTMLElement
      const ruler = document.querySelector('.arrange .timeline-scroll .ruler') as HTMLElement
      const gripBox = grip.getBoundingClientRect()
      const faceBox = face.getBoundingClientRect()
      const rulerBox = ruler.getBoundingClientRect()
      return {
        gripH: gripBox.height,
        gripW: gripBox.width,
        faceTop: faceBox.top,
        faceBottom: faceBox.bottom,
        rulerTop: rulerBox.top,
        rulerBottom: rulerBox.bottom,
      }
    })
    expect(parked.gripW).toBeGreaterThanOrEqual(44)
    expect(parked.gripH).toBeGreaterThanOrEqual(44)
    expect(parked.faceTop).toBeGreaterThanOrEqual(parked.rulerTop - 1)
    expect(parked.faceBottom).toBeLessThanOrEqual(parked.rulerBottom + 1)
    const box = await page.locator('[data-loop-region="arrange"] [data-loop-edge="end"]').boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
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
      laneH: (document.querySelector('.timeline-scroll .lane') as HTMLElement).getBoundingClientRect().height,
      headH: (document.querySelector('.arrange .heads .head') as HTMLElement).getBoundingClientRect().height,
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
    const lane = await desk.page.evaluate(() => ({
      zoom: getComputedStyle(document.querySelector('.arrange')!).getPropertyValue('--lane-zoom').trim(),
      laneH: (document.querySelector('.timeline-scroll .lane') as HTMLElement).getBoundingClientRect().height,
      headH: (document.querySelector('.arrange .heads .head') as HTMLElement).getBoundingClientRect().height,
      rule: getComputedStyle(document.querySelector('.timeline-scroll .lane') as HTMLElement).height,
    }))
    expect(Number(lane.zoom)).toBeGreaterThan(Number(before.lane || '1'))
    expect(lane.laneH).toBeGreaterThan(before.laneH + 4)
    expect(Math.abs(lane.headH - lane.laneH)).toBeLessThan(2)

    const wheeled = await desk.page.evaluate(async () => {
      const scroller = document.querySelector('.timeline-scroll') as HTMLElement
      const inner = document.querySelector('.timeline-inner') as HTMLElement
      const thumb = document.querySelector('[data-overview-thumb="x"]') as HTMLElement
      const beforePx = Number(inner.dataset.px)
      const beforeWidth = thumb.getBoundingClientRect().width
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -140, ctrlKey: true, bubbles: true, cancelable: true }))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      return {
        px: Number(inner.dataset.px),
        beforePx,
        thumb: thumb.getBoundingClientRect().width,
        beforeWidth,
        scroll: scroller.scrollLeft,
      }
    })
    expect(wheeled.px).toBeGreaterThan(wheeled.beforePx)
    expect(wheeled.thumb).toBeLessThan(wheeled.beforeWidth - 0.5)
    await desk.page.screenshot({ path: '/opt/cursor/artifacts/overview_1440x900.png' })
    expect(desk.errors, desk.errors.join('\n')).toEqual([])
    await desk.page.close()
  }, 90000)

  it('shrinks and grows lanes from the vertical bar at 390x844 and 1440x900', async () => {
    const sizes = [
      { width: 390, height: 844, touch: true },
      { width: 1440, height: 900, touch: false },
    ]
    for (const viewport of sizes) {
      const { page, errors } = await boot(viewport, viewport.touch)
      const read = () => page.evaluate(() => {
        const lane = document.querySelector('.timeline-scroll .lane') as HTMLElement
        const head = document.querySelector('.arrange .heads .head') as HTMLElement
        const mute = document.querySelector('.arrange .heads button[aria-label="Mute track"]') as HTMLElement
        const face = document.querySelector('[data-loop-region="arrange"] .loop-grip-face') as HTMLElement
        const trackX = document.querySelector('[data-overview="x"] .overview-track') as HTMLElement
        const trackY = document.querySelector('[data-overview="y"] .overview-track') as HTMLElement
        const thumbX = document.querySelector('[data-overview-thumb="x"]') as HTMLElement
        const thumbY = document.querySelector('[data-overview-thumb="y"]') as HTMLElement
        const zoom = Number(getComputedStyle(document.querySelector('.arrange')!).getPropertyValue('--lane-zoom'))
        const muteBox = mute.getBoundingClientRect()
        const hit = document.elementFromPoint(muteBox.left + muteBox.width / 2, muteBox.top + muteBox.height / 2) as HTMLElement | null
        return {
          zoom,
          laneH: lane.getBoundingClientRect().height,
          headH: head.getBoundingClientRect().height,
          muteH: muteBox.height,
          muteHit: !!hit?.closest('button[aria-label="Mute track"]'),
          faceW: face.getBoundingClientRect().width,
          barX: trackX.getBoundingClientRect().height,
          barY: trackY.getBoundingClientRect().width,
          thumbX: thumbX.getBoundingClientRect().height,
          thumbY: thumbY.getBoundingClientRect().width,
          gutterX: (document.querySelector('[data-overview="x"]') as HTMLElement).getBoundingClientRect().height,
          gutterY: (document.querySelector('[data-overview="y"]') as HTMLElement).getBoundingClientRect().width,
        }
      })
      const before = await read()
      expect(before.zoom).toBeGreaterThan(0.5)
      expect(before.zoom).toBeLessThan(2.25)
      expect(Math.abs(before.barX - before.faceW)).toBeLessThan(1)
      expect(Math.abs(before.barY - before.faceW)).toBeLessThan(1)
      expect(Math.abs(before.thumbX - before.faceW)).toBeLessThan(1)
      expect(Math.abs(before.thumbY - before.faceW)).toBeLessThan(1)
      expect(before.gutterX).toBeGreaterThanOrEqual(40)
      expect(before.gutterY).toBeGreaterThanOrEqual(40)

      const dragEnd = async (deltaY: number) => {
        const thumb = await page.locator('[data-overview-thumb="y"]').boundingBox()
        expect(thumb).toBeTruthy()
        const x = thumb!.x + thumb!.width / 2
        // Stay inside the end grip (the bottom 40px) and inside the viewport.
        const y = thumb!.y + Math.max(12, thumb!.height - 24)
        const dest = Math.max(4, Math.min(viewport.height - 4, y + deltaY))
        if (viewport.touch) {
          const client = await page.context().newCDPSession(page)
          const point = (py: number) => [{ x: Math.round(x), y: Math.round(py), id: 1 }]
          await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(y) })
          const steps = 8
          for (let step = 1; step <= steps; step++) {
            const py = y + ((dest - y) * step) / steps
            await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(py) })
            await page.waitForTimeout(16)
          }
          await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await client.detach()
        } else {
          await page.mouse.move(x, y)
          await page.mouse.down()
          await page.mouse.move(x, dest, { steps: 10 })
          await page.mouse.up()
        }
        await page.waitForTimeout(40)
      }

      const thumbBox = await page.locator('[data-overview-thumb="y"]').boundingBox()
      const endY = thumbBox!.y + Math.max(12, thumbBox!.height - 24)
      const shrinkRoom = Math.min(160, Math.max(48, viewport.height - 8 - endY))
      await dragEnd(shrinkRoom)
      const shrunk = await read()
      expect(shrunk.zoom, `${viewport.width} shrink zoom`).toBeLessThan(before.zoom - 0.04)
      expect(shrunk.laneH, `${viewport.width} shrink lanes`).toBeLessThan(before.laneH - 4)
      expect(Math.abs(shrunk.headH - shrunk.laneH), `${viewport.width} header tracks the lane`).toBeLessThan(2)
      expect(shrunk.muteH, `${viewport.width} mute stays a touch target`).toBeGreaterThanOrEqual(40)
      expect(shrunk.muteHit, `${viewport.width} mute stays hittable`).toBe(true)
      await page.screenshot({ path: `/opt/cursor/artifacts/overview_lanes_${viewport.width}x${viewport.height}.png` })

      const grownThumb = await page.locator('[data-overview-thumb="y"]').boundingBox()
      const grownEnd = grownThumb!.y + Math.max(12, grownThumb!.height - 24)
      const growRoom = Math.min(180, Math.max(90, grownEnd - 20))
      await dragEnd(-growRoom)
      const grown = await read()
      expect(grown.zoom, `${viewport.width} grow zoom`).toBeGreaterThan(shrunk.zoom + 0.08)
      expect(grown.laneH, `${viewport.width} grow lanes`).toBeGreaterThan(shrunk.laneH + 6)
      expect(grown.zoom, `${viewport.width} grows past the default`).toBeGreaterThan(before.zoom + 0.04)
      expect(grown.laneH).toBeGreaterThan(before.laneH + 4)
      expect(errors, errors.join('\n')).toEqual([])
      await page.close()
    }
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
        const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? null
        const x = rect('[data-overview="x"]')!
        const y = rect('[data-overview="y"]')!
        const scroll = rect('.timeline-scroll')!
        const paintedX = rect('[data-overview="x"] .overview-track')!
        const paintedY = rect('[data-overview="y"] .overview-track')!
        const thumbX = rect('[data-overview-thumb="x"]')!
        const thumbY = rect('[data-overview-thumb="y"]')!
        const tools = rect('.tool-slot')
        const heads = rect('.arrange .heads')!
        const ruler = rect('.arrange .timeline-scroll .ruler')!
        const grip = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"]') as HTMLElement | null
        const face = grip?.querySelector('.loop-grip-face') as HTMLElement | null
        const hitAt = (xPx: number, yPx: number) => {
          const node = document.elementFromPoint(xPx, yPx) as HTMLElement | null
          return {
            overview: !!node?.closest('[data-overview]'),
            clip: !!node?.closest('.clip'),
            head: !!node?.closest('.head, .heads'),
            grip: !!node?.closest('[data-loop-edge]'),
            ruler: !!node?.closest('.ruler'),
          }
        }
        const clip = document.querySelector('.timeline-scroll .clip') as HTMLElement | null
        const clipBox = clip?.getBoundingClientRect()
        const headBtn = document.querySelector('.arrange .heads .track-controls button') as HTMLElement | null
        const headBox = headBtn?.getBoundingClientRect()
        const gripBox = grip?.getBoundingClientRect()
        const faceBox = face?.getBoundingClientRect()
        const scrollRight = scroll.right
        const play = rect('[data-playhead="arrange"]')
        const scrubX = play ? Math.min(Math.max(play.left + 2, ruler.left + 80), ruler.right - 8) : ruler.left + Math.min(80, ruler.width / 2)
        return {
          xh: x.height,
          yw: y.width,
          gapX: x.top - scroll.bottom,
          gapY: y.left - scroll.right,
          paintedXH: paintedX.height,
          paintedYW: paintedY.width,
          thumbXH: thumbX.height,
          thumbYW: thumbY.width,
          faceW: faceBox?.width ?? 0,
          faceH: faceBox?.height ?? 0,
          barBottom: x.bottom,
          toolsTop: tools?.top ?? null,
          sideLeft: y.left,
          headRight: heads.right,
          laneLeft: scroll.left,
          rulerH: ruler.height,
          gripH: gripBox?.height ?? 0,
          gripW: gripBox?.width ?? 0,
          gripRight: gripBox?.right ?? 0,
          scrollRight,
          faceTop: faceBox ? faceBox.top - ruler.top : 0,
          faceBottom: faceBox ? faceBox.bottom - ruler.top : 0,
          clipHit: clipBox && clipBox.width > 8 && clipBox.bottom > scroll.top && clipBox.top < scroll.bottom
            ? hitAt(clipBox.left + Math.min(24, clipBox.width / 2), clipBox.top + Math.min(18, clipBox.height / 2))
            : null,
          headHit: headBox && headBox.width > 8 ? hitAt(headBox.left + headBox.width / 2, headBox.top + headBox.height / 2) : null,
          gripHit: gripBox ? hitAt(gripBox.left + Math.min(12, gripBox.width / 2), ruler.top + Math.min(8, ruler.height / 2)) : null,
          scrubHit: hitAt(scrubX, ruler.top + ruler.height / 2),
        }
      })
      const name = `${viewport.width}x${viewport.height}`
      expect(box.xh, `${name} horizontal hit`).toBeGreaterThanOrEqual(40)
      expect(box.yw, `${name} vertical hit`).toBeGreaterThanOrEqual(40)
      expect(Math.abs(box.gapX), `${name} horizontal gap`).toBeLessThan(2)
      expect(Math.abs(box.gapY), `${name} vertical gap`).toBeLessThan(2)
      expect(box.faceW, `${name} loop grip thickness`).toBeGreaterThan(10)
      expect(Math.abs(box.paintedXH - box.faceW), `${name} horizontal bar matches the loop grip`).toBeLessThan(1)
      expect(Math.abs(box.paintedYW - box.faceW), `${name} vertical bar matches the loop grip`).toBeLessThan(1)
      expect(Math.abs(box.thumbXH - box.faceW), `${name} horizontal thumb matches the loop grip`).toBeLessThan(1)
      expect(Math.abs(box.thumbYW - box.faceW), `${name} vertical thumb matches the loop grip`).toBeLessThan(1)
      if (box.toolsTop != null) expect(box.barBottom, `${name} bar above the edit bar`).toBeLessThanOrEqual(box.toolsTop + 1)
      expect(box.sideLeft, `${name} vertical bar clears the track headers`).toBeGreaterThanOrEqual(box.headRight - 1)
      expect(Math.abs(box.laneLeft - box.headRight), `${name} lane meets the header column`).toBeLessThanOrEqual(2)
      expect(box.gripW, `${name} loop hit width`).toBeGreaterThanOrEqual(44)
      expect(box.gripH, `${name} loop hit height`).toBeGreaterThanOrEqual(44)
      expect(box.gripRight, `${name} loop hit stays inside the timeline`).toBeLessThanOrEqual(box.scrollRight + 1)
      expect(box.faceTop, `${name} loop cap inside the strip`).toBeGreaterThanOrEqual(-1)
      expect(box.faceBottom, `${name} loop cap inside the strip`).toBeLessThanOrEqual(box.rulerH + (box.rulerH <= 26 ? 1 : 8))
      if (box.clipHit) {
        expect(box.clipHit.overview, `${name} clip touch`).toBe(false)
        expect(box.clipHit.clip, `${name} clip touch`).toBe(true)
      }
      if (box.headHit) {
        expect(box.headHit.overview, `${name} header touch`).toBe(false)
        expect(box.headHit.head, `${name} header touch`).toBe(true)
      }
      if (box.gripHit) {
        expect(box.gripHit.overview, `${name} loop touch`).toBe(false)
        expect(box.gripHit.grip, `${name} loop touch`).toBe(true)
      }
      expect(box.scrubHit.overview, `${name} ruler scrub`).toBe(false)
      expect(box.scrubHit.ruler, `${name} ruler scrub`).toBe(true)
      await page.screenshot({ path: `/opt/cursor/artifacts/overview_${viewport.width}x${viewport.height}.png` })
      expect(errors, errors.join('\n')).toEqual([])
      await page.close()
    }
  }, 90000)
})
