import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
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

async function setLoopBeats(page: Page, startBeats: number, endBeats: number) {
  await page.evaluate(({ startBeats, endBeats }) => {
    const store = (window as unknown as {
      __cueharbor: { store: { project: { sampleRate: number; tempo: number }; setLoop: (on: boolean, start?: number, end?: number) => void } }
    }).__cueharbor.store
    const beat = store.project.sampleRate * (60 / store.project.tempo)
    store.setLoop(true, Math.round(beat * startBeats), Math.round(beat * endBeats))
  }, { startBeats, endBeats })
  await page.waitForTimeout(60)
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const project = (window as unknown as {
      __cueharbor: { store: { project: { sampleRate: number; tempo: number; timeSignature: { numerator: number; denominator: number }; loopStartSample: number; loopEndSample: number; snap: boolean } } }
    }).__cueharbor.store.project
    const beat = project.sampleRate * (60 / project.tempo)
    const barBeats = project.timeSignature.numerator * (4 / project.timeSignature.denominator)
    const inner = document.querySelector('.timeline-inner') as HTMLElement
    const px = Number(inner.dataset.px)
    const beatPx = (60 / project.tempo) * px
    return {
      start: project.loopStartSample,
      end: project.loopEndSample,
      beat,
      barBeats,
      barSamples: beat * barBeats,
      barPx: beatPx * barBeats,
      sampleRate: project.sampleRate,
      snap: project.snap,
      px,
    }
  })
}

async function placeEnd(page: Page) {
  await page.evaluate(() => {
    const scroller = document.querySelector('.timeline-scroll') as HTMLElement
    const inner = document.querySelector('.timeline-inner') as HTMLElement
    const project = (window as unknown as { __cueharbor: { store: { project: { sampleRate: number; loopEndSample: number } } } }).__cueharbor.store.project
    const endPx = (project.loopEndSample / project.sampleRate) * Number(inner.dataset.px)
    scroller.scrollLeft = Math.max(0, endPx - scroller.clientWidth + 28)
  })
  await page.waitForFunction(() => {
    const face = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"] .loop-grip-face') as HTMLElement | null
    const scroll = document.querySelector('.timeline-scroll') as HTMLElement | null
    if (!face || !scroll) return false
    const box = face.getBoundingClientRect()
    const view = scroll.getBoundingClientRect()
    return box.width > 8 && box.left > view.left + 4 && box.right < view.right - 2 && box.top < view.bottom
  })
}

async function endPoint(page: Page) {
  return page.evaluate(() => {
    const face = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"] .loop-grip-face') as HTMLElement
    const box = face.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, kind: 'touch' | 'mouse', shot?: string) {
  const capture = async () => {
    if (!shot) return ''
    await page.waitForTimeout(40)
    await page.waitForSelector('[data-loop-drag-label]')
    const label = (await page.getAttribute('[data-loop-drag-label]', 'data-loop-drag-label')) ?? ''
    const unit = await page.getAttribute('[data-loop-region="arrange"]', 'data-loop-snap')
    const line = await page.locator('[data-loop-snap-target]').boundingBox()
    expect(unit, 'drag snaps by bar').toBe('bar')
    expect(label, 'length and start bar').toMatch(/^\d+ bars? \/ \d+/)
    expect(line, 'target bar line').toBeTruthy()
    await page.screenshot({ path: shot })
    return label
  }
  if (kind === 'mouse') {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    const label = await capture()
    await page.mouse.up()
    await page.waitForTimeout(40)
    return label
  }
  const client = await page.context().newCDPSession(page)
  const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }]
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) })
  for (let step = 1; step <= 10; step++) {
    const x = from.x + ((to.x - from.x) * step) / 10
    const y = from.y + ((to.y - from.y) * step) / 10
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) })
    await page.waitForTimeout(16)
  }
  const label = await capture()
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
  await page.waitForTimeout(40)
  return label
}

function wholeBars(start: number, end: number, barSamples: number) {
  const bars = (end - start) / barSamples
  return Math.abs(bars - Math.round(bars)) < 0.03 ? Math.round(bars) : -1
}

describe('loop handles snap to bars on touch', () => {
  const port = 5244
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

  async function open(viewport: { width: number; height: number }, touch: boolean) {
    const context = await browser.newContext({
      viewport,
      hasTouch: touch,
      isMobile: touch && viewport.width < 500,
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    await page.addInitScript(() => {
      const calls: number[] = []
      ;(navigator as Navigator & { vibrate: (pattern: number | number[]) => boolean }).vibrate = (pattern) => {
        calls.push(Array.isArray(pattern) ? Number(pattern[0]) : Number(pattern))
        return true
      }
      ;(window as unknown as { __vibrations: number[] }).__vibrations = calls
    })
    const errors = trackErrors(page)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-loop-region="arrange"]').waitFor()
    await page.waitForTimeout(300)
    return { page, errors, context }
  }

  async function exercise(viewport: { width: number; height: number }, touch: boolean, shot: string, shell: 'phone' | 'fold' | 'desk') {
    const { page, errors, context } = await open(viewport, touch)
    const kind = touch ? 'touch' : 'mouse'
    const shellClass = await page.locator('.shell').getAttribute('class')
    if (shell === 'desk') {
      expect(shellClass).not.toContain('phone')
      expect(shellClass).not.toContain('fold')
    } else {
      expect(shellClass, viewport.width.toString()).toContain(shell)
    }

    await setLoopBeats(page, 0, 16)
    const fit = await page.evaluate(() => {
      const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement
      const face = host.querySelector('[data-loop-edge="end"] .loop-grip-face') as HTMLElement
      const grip = host.querySelector('[data-loop-edge="end"]') as HTMLElement
      const ruler = host.closest('.ruler') as HTMLElement
      const strip = document.querySelector('[data-playhead-strip]') as HTMLElement | null
      const faceBox = face.getBoundingClientRect()
      const gripBox = grip.getBoundingClientRect()
      const rulerBox = ruler.getBoundingClientRect()
      const stripBox = strip?.getBoundingClientRect()
      const probe = stripBox ? document.elementFromPoint(stripBox.left + stripBox.width * 0.45, stripBox.top + stripBox.height / 2) : null
      return {
        faceW: faceBox.width,
        faceH: faceBox.height,
        hitW: gripBox.width,
        rulerH: rulerBox.height,
        gripBottom: gripBox.bottom,
        stripTop: stripBox?.top ?? null,
        stripHit: probe ? Boolean(probe.closest('[data-loop-edge], .loop-grip')) : false,
      }
    })
    expect(fit.hitW, 'hit target').toBeGreaterThanOrEqual(44)
    expect(fit.faceW, 'slim grip').toBeGreaterThanOrEqual(10)
    expect(fit.faceW, 'slim grip').toBeLessThanOrEqual(14)
    expect(fit.faceH, 'grip face stays slim').toBeLessThanOrEqual(Math.max(fit.rulerH + 6, 46))
    if (shell === 'phone') {
      expect(fit.stripTop).not.toBeNull()
      expect(fit.gripBottom).toBeLessThanOrEqual((fit.stripTop ?? 0) + 1)
      expect(fit.stripHit, 'playhead strip stays clear').toBe(false)
    }

    await placeEnd(page)
    const beforeStay = await metrics(page)
    expect(beforeStay.snap, JSON.stringify(beforeStay)).toBe(true)
    const stayAt = await endPoint(page)
    await drag(page, stayAt, { x: stayAt.x - beforeStay.barPx * 0.4, y: stayAt.y }, kind)
    const afterStay = await metrics(page)
    expect(afterStay.end, 'a short drag sticks to the bar').toBe(beforeStay.end)
    expect(afterStay.start).toBe(beforeStay.start)

    await placeEnd(page)
    const before = await metrics(page)
    const from = await endPoint(page)
    const label = await drag(page, from, { x: from.x - before.barPx * 0.75, y: from.y }, kind, shot)
    const after = await metrics(page)
    const bars = wholeBars(after.start, after.end, after.barSamples)
    expect(after.start, 'start stays').toBe(before.start)
    expect(bars, `length ${after.end - after.start}`).toBe(wholeBars(before.start, before.end, before.barSamples) - 1)
    expect(label).toBe(`${bars} bars / 1`)
    const feedback = await page.evaluate(() => (window as unknown as { __vibrations?: number[] }).__vibrations ?? [])
    expect(feedback, 'haptic on the snap').toContain(8)
    expect(wholeBars(after.start, after.end, after.barSamples)).toBeGreaterThanOrEqual(1)

    await setLoopBeats(page, 0, 8)
    await placeEnd(page)
    const minBefore = await metrics(page)
    const minAt = await endPoint(page)
    await drag(page, minAt, { x: minAt.x - minBefore.barPx * 3, y: minAt.y }, kind)
    const minAfter = await metrics(page)
    expect(minAfter.start).toBe(0)
    expect(wholeBars(minAfter.start, minAfter.end, minAfter.barSamples), 'cannot shrink under one bar').toBe(1)

    await page.evaluate(() => {
      const store = (window as unknown as { __cueharbor: { store: { project: { snap: boolean }; toggle: (key: 'snap') => void } } }).__cueharbor.store
      if (store.project.snap) store.toggle('snap')
    })
    await setLoopBeats(page, 0, 8)
    await placeEnd(page)
    const freeBefore = await metrics(page)
    expect(freeBefore.snap).toBe(false)
    const freeAt = await endPoint(page)
    await drag(page, freeAt, { x: freeAt.x - 48, y: freeAt.y }, kind)
    const freeAfter = await metrics(page)
    const delta = freeBefore.end - freeAfter.end
    const samples = (48 / freeBefore.px) * freeBefore.sampleRate
    expect(delta, 'snap off follows the finger').toBeGreaterThan(freeBefore.beat * 0.2)
    expect(Math.abs(delta - samples), `delta ${delta} vs ${samples}`).toBeLessThan(freeBefore.beat * 0.2)
    expect(Math.abs(delta - freeBefore.barSamples), 'snap off is not forced onto a bar').toBeGreaterThan(freeBefore.beat)

    expect(errors, errors.join('\n')).toEqual([])
    await context.close()
  }

  it('snaps a finger to whole bars at 384x840', async () => {
    await exercise({ width: 384, height: 840 }, true, '/opt/cursor/artifacts/loop-bar-snap-384x840.png', 'phone')
  }, 90000)

  it('snaps a finger to whole bars on an 884 fold', async () => {
    await exercise({ width: 884, height: 1104 }, true, '/opt/cursor/artifacts/loop-bar-snap-884-fold.png', 'fold')
  }, 90000)

  it('snaps a mouse to whole bars on the desktop', async () => {
    await exercise({ width: 1440, height: 900 }, false, '/opt/cursor/artifacts/loop-bar-snap-desktop.png', 'desk')
  }, 90000)
})
