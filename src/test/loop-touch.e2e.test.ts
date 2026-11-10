import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

function trackErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  return errors
}

async function setLoop(page: Page, startBeats: number, endBeats: number) {
  await page.evaluate(({ startBeats, endBeats }) => {
    const store = (window as unknown as {
      __cueharbor: { store: { project: { sampleRate: number; tempo: number }; setLoop: (on: boolean, start?: number, end?: number) => void } }
    }).__cueharbor.store
    const beat = store.project.sampleRate * (60 / store.project.tempo)
    store.setLoop(true, Math.round(beat * startBeats), Math.round(beat * endBeats))
  }, { startBeats, endBeats })
  await page.waitForTimeout(80)
}

async function readLoop(page: Page) {
  return page.evaluate(() => {
    const project = (window as unknown as {
      __cueharbor: { store: { project: { sampleRate: number; tempo: number; loopStartSample: number; loopEndSample: number; snap: boolean } } }
    }).__cueharbor.store.project
    const scroller = document.querySelector('.timeline-scroll') as HTMLElement | null
    return {
      start: project.loopStartSample,
      end: project.loopEndSample,
      beat: project.sampleRate * (60 / project.tempo),
      snap: project.snap,
      scroll: scroller?.scrollLeft ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
      status: (window as unknown as { __cueharborStatus?: string }).__cueharborStatus ?? '',
    }
  })
}

function onGrid(sample: number, beat: number) {
  if (!(beat > 0)) return false
  return Math.abs(sample / beat - Math.round(sample / beat)) < 0.03
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement | null
    const start = host?.querySelector('[data-loop-edge="start"]') as HTMLElement | null
    const end = host?.querySelector('[data-loop-edge="end"]') as HTMLElement | null
    if (!host || !start || !end) return null
    const sr = start.getBoundingClientRect()
    const er = end.getBoundingClientRect()
    const overlapX = Math.min(sr.right, er.right) - Math.max(sr.left, er.left)
    const overlapY = Math.min(sr.bottom, er.bottom) - Math.max(sr.top, er.top)
    const face = (edge: string) => {
      const node = host.querySelector(`[data-loop-edge="${edge}"] .loop-grip-face`) as HTMLElement | null
      const box = node?.getBoundingClientRect()
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2, top: box.top, height: box.height } : null
    }
    return {
      mode: host.dataset.loopHit ?? '',
      startY: sr.y,
      endY: er.y,
      startW: sr.width,
      endW: er.width,
      startH: sr.height,
      endH: er.height,
      overlap: overlapX > 0.5 && overlapY > 0.5,
      hostTouch: getComputedStyle(host).touchAction,
      endTouch: getComputedStyle(end).touchAction,
      startFace: face('start'),
      endFace: face('end'),
    }
  })
}

function expectStableHandles(grip: Awaited<ReturnType<typeof geometry>>, label: string, minHeight = 40) {
  expect(grip, label).toBeTruthy()
  expect(grip!.startW, label).toBeGreaterThanOrEqual(44)
  expect(grip!.endW, label).toBeGreaterThanOrEqual(44)
  expect(grip!.startH, label).toBeGreaterThanOrEqual(minHeight)
  expect(grip!.endH, label).toBeGreaterThanOrEqual(minHeight)
  expect(Math.abs(grip!.startY - grip!.endY), label).toBeLessThanOrEqual(1)
  expect(grip!.overlap, label).toBe(false)
  expect(grip!.hostTouch, label).toBe('none')
  expect(grip!.endTouch, label).toBe('none')
  expect(Math.abs((grip!.startFace?.top ?? 0) - (grip!.endFace?.top ?? 1)), label).toBeLessThanOrEqual(1)
}

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
  const client = await page.context().newCDPSession(page)
  const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }]
  const rows: Awaited<ReturnType<typeof geometry>>[] = []
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) })
  for (let step = 1; step <= steps; step++) {
    const x = from.x + ((to.x - from.x) * step) / steps
    const y = from.y + ((to.y - from.y) * step) / steps
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) })
    await page.waitForTimeout(20)
    rows.push(await geometry(page))
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
  await page.waitForTimeout(40)
  return rows
}

async function mouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(40)
}

async function bodyPoint(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('[data-loop-region="arrange"] [data-loop-body]') as HTMLElement | null
    if (!body) return null
    const rect = body.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    for (let x = rect.left + 6; x <= rect.right - 6; x += 4) {
      const hit = document.elementFromPoint(x, y)
      if (hit?.closest('[data-loop-edge]')?.getAttribute('data-loop-edge') === 'move') return { x, y }
    }
    return null
  })
}

describe('loop handles follow a finger on a phone', () => {
  const port = 5217
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

  it('drags the loop with touch at 390x844 and does not stack the handles', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const errors = trackErrors(page)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-loop-region="arrange"]').waitFor()
    await page.waitForTimeout(400)

    await setLoop(page, 0, 1)
    const short = await geometry(page)
    expectStableHandles(short, '1-beat layout', 20)
    await page.screenshot({ path: '/opt/cursor/artifacts/after-loop-390x844-one-beat.png' })

    const beforeEnd = await readLoop(page)
    const endFace = short!.endFace!
    const endRows = await touchDrag(page, endFace, { x: endFace.x + 90, y: endFace.y })
    const afterEnd = await readLoop(page)
    expect(afterEnd.start, '1-beat start stays').toBe(beforeEnd.start)
    expect(afterEnd.end, '1-beat end grows').toBeGreaterThan(beforeEnd.end)
    expect(afterEnd.end - afterEnd.start, 'stays at least one beat').toBeGreaterThanOrEqual(beforeEnd.beat - 1)
    expect(onGrid(afterEnd.end, afterEnd.beat), `end ${afterEnd.end} beat ${afterEnd.beat}`).toBe(true)
    expect(afterEnd.scroll, 'timeline did not scroll').toBe(beforeEnd.scroll)
    expect(afterEnd.scrollTop).toBe(beforeEnd.scrollTop)
    for (const row of endRows) expectStableHandles(row, 'during 1-beat end drag', 20)

    await setLoop(page, 1, 5)
    const startGrip = await geometry(page)
    expectStableHandles(startGrip, 'start layout', 20)
    const beforeStart = await readLoop(page)
    const startAt = startGrip!.startFace!
    await touchDrag(page, startAt, { x: startAt.x + 80, y: startAt.y })
    const afterStart = await readLoop(page)
    expect(afterStart.start, 'start moves').toBeGreaterThan(beforeStart.start)
    expect(afterStart.end, 'end stays while the start moves').toBe(beforeStart.end)
    expect(onGrid(afterStart.start, afterStart.beat)).toBe(true)
    expect(afterStart.scroll).toBe(beforeStart.scroll)

    await page.evaluate(() => {
      const scroller = document.querySelector('.timeline-scroll') as HTMLElement | null
      const face = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"] .loop-grip-face') as HTMLElement | null
      if (!scroller || !face) return
      const box = face.getBoundingClientRect()
      const view = scroller.getBoundingClientRect()
      if (box.right > view.right - 16) scroller.scrollLeft += box.right - view.right + 36
      if (box.left < view.left + 16) scroller.scrollLeft -= view.left + 16 - box.left
    })
    const endGrip = await geometry(page)
    expectStableHandles(endGrip, 'end layout', 20)
    const beforeStretch = await readLoop(page)
    const stretchAt = endGrip!.endFace!
    await touchDrag(page, stretchAt, { x: stretchAt.x + 80, y: stretchAt.y })
    const afterStretch = await readLoop(page)
    expect(afterStretch.end, 'end moves').toBeGreaterThan(beforeStretch.end)
    expect(afterStretch.start, 'start stays while the end moves').toBe(beforeStretch.start)
    expect(onGrid(afterStretch.end, afterStretch.beat)).toBe(true)

    await setLoop(page, 0, 4)
    const moveAt = await bodyPoint(page)
    expect(moveAt, 'body has a move target').toBeTruthy()
    const beforeMove = await readLoop(page)
    await touchDrag(page, moveAt!, { x: moveAt!.x + 70, y: moveAt!.y })
    const afterMove = await readLoop(page)
    const deltaStart = afterMove.start - beforeMove.start
    const deltaEnd = afterMove.end - beforeMove.end
    expect(deltaStart, 'body moves the start').toBeGreaterThan(0)
    expect(deltaEnd, 'body moves the end').toBe(deltaStart)
    expect(onGrid(afterMove.start, afterMove.beat)).toBe(true)
    expect(onGrid(afterMove.end, afterMove.beat)).toBe(true)
    expect(afterMove.scroll).toBe(beforeMove.scroll)

    await setLoop(page, 2, 6)
    const tapAt = await bodyPoint(page)
    expect(tapAt).toBeTruthy()
    const beforeTap = await readLoop(page)
    await touchDrag(page, tapAt!, { x: tapAt!.x + 3, y: tapAt!.y + 1 }, 2)
    const afterTap = await readLoop(page)
    expect(afterTap.start, 'a tap does not jump the start').toBe(beforeTap.start)
    expect(afterTap.end, 'a tap does not jump the end').toBe(beforeTap.end)

    await page.evaluate(() => {
      const store = (window as unknown as {
        __cueharbor: { store: { project: { countIn: boolean }; toggle: (key: string) => void } }
      }).__cueharbor.store
      if (store.project.countIn) store.toggle('countIn')
    })
    await setLoop(page, 1, 4)
    await page.getByRole('button', { name: /^Play/ }).first().tap()
    await page.waitForFunction(() => (window as unknown as { __cueharborStatus?: string }).__cueharborStatus === 'playing', null, { timeout: 4000 })
    const playingGrip = await geometry(page)
    expectStableHandles(playingGrip, 'playback layout', 20)
    const beforePlay = await readLoop(page)
    const playAt = playingGrip!.endFace!
    const playRows = await touchDrag(page, playAt, { x: playAt.x + 70, y: playAt.y })
    const afterPlay = await readLoop(page)
    expect(afterPlay.status).toBe('playing')
    expect(afterPlay.end, 'end follows the finger during playback').not.toBe(beforePlay.end)
    expect(afterPlay.start).toBe(beforePlay.start)
    expect(onGrid(afterPlay.end, afterPlay.beat)).toBe(true)
    for (const row of playRows) expectStableHandles(row, 'during playback drag', 20)
    await page.screenshot({ path: '/opt/cursor/artifacts/after-loop-390x844.png' })

    expect(errors, errors.join('\n')).toEqual([])
    await context.close()
  }, 90000)

  it('drags the loop with a mouse at 1440x900', async () => {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: false,
      isMobile: false,
    })
    const page = await context.newPage()
    const errors = trackErrors(page)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-loop-region="arrange"]').waitFor()
    await page.waitForTimeout(400)

    await setLoop(page, 0, 1)
    expectStableHandles(await geometry(page), 'desktop 1-beat')

    await setLoop(page, 1, 6)
    const startGrip = await geometry(page)
    expectStableHandles(startGrip, 'desktop start')
    const beforeStart = await readLoop(page)
    await mouseDrag(page, startGrip!.startFace!, { x: startGrip!.startFace!.x + 90, y: startGrip!.startFace!.y })
    const afterStart = await readLoop(page)
    expect(afterStart.start).toBeGreaterThan(beforeStart.start)
    expect(afterStart.end).toBe(beforeStart.end)
    expect(onGrid(afterStart.start, afterStart.beat)).toBe(true)

    const endGrip = await geometry(page)
    const beforeEnd = await readLoop(page)
    await mouseDrag(page, endGrip!.endFace!, { x: endGrip!.endFace!.x + 90, y: endGrip!.endFace!.y })
    const afterEnd = await readLoop(page)
    expect(afterEnd.end).toBeGreaterThan(beforeEnd.end)
    expect(afterEnd.start).toBe(beforeEnd.start)
    expect(onGrid(afterEnd.end, afterEnd.beat)).toBe(true)

    await setLoop(page, 2, 8)
    const moveAt = await bodyPoint(page)
    expect(moveAt).toBeTruthy()
    const beforeMove = await readLoop(page)
    await mouseDrag(page, moveAt!, { x: moveAt!.x + 80, y: moveAt!.y })
    const afterMove = await readLoop(page)
    expect(afterMove.start - beforeMove.start).toBeGreaterThan(0)
    expect(afterMove.end - beforeMove.end).toBe(afterMove.start - beforeMove.start)
    await page.screenshot({ path: '/opt/cursor/artifacts/after-loop-1440x900.png' })

    expect(errors, errors.join('\n')).toEqual([])
    await context.close()
  }, 60000)
})
