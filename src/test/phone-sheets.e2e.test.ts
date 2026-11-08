import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '844x390', width: 844, height: 390 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1440x900', width: 1440, height: 900 },
] as const

async function waitForServer(url: string, child: ChildProcess) {
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

async function arrangeScroll(page: Page) {
  return page.evaluate(() => {
    const timeline = document.querySelector('.timeline-scroll') as HTMLElement | null
    const heads = document.querySelector('.arrange .heads') as HTMLElement | null
    return {
      timeline: timeline?.scrollTop ?? 0,
      heads: heads?.scrollTop ?? 0,
    }
  })
}

async function laneWidth(page: Page) {
  return page.locator('.timeline-scroll').evaluate((node) => Math.round(node.getBoundingClientRect().width))
}

async function touchScroll(page: Page, selector: string, distance: number) {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`missing ${selector}`)
  const x = Math.round(box.x + Math.min(48, box.width / 2))
  const y = Math.round(box.y + Math.min(box.height * 0.55, box.height - 28))
  const client = await page.context().newCDPSession(page)
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: Math.round(y - (distance * i) / steps), id: 1 }],
    })
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
}

describe('phone browser sheet, plugins scroll, and loop grips', () => {
  it('opens the browser as a bottom sheet and keeps arrange scroll independent', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4277
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      const laneBefore = await laneWidth(page)
      const scrollBefore = await arrangeScroll(page)
      await page.getByRole('button', { name: 'Browser', exact: true }).click()
      const sheet = page.locator('.arrange-stage > [data-playlist-browser="open"][data-bottom-sheet="open"]')
      await sheet.waitFor()
      await page.locator('.sound-row, .sound-status').first().waitFor({ timeout: 15000 })
      const box = await sheet.boundingBox()
      const arrange = await page.locator('.arrange').boundingBox()
      const bar = await page.locator('.tool-slot').boundingBox()
      expect(box).toBeTruthy()
      expect(arrange).toBeTruthy()
      expect(box!.x).toBeLessThanOrEqual(1)
      expect(box!.width).toBeGreaterThanOrEqual(388)
      expect(box!.y).toBeGreaterThan(arrange!.y)
      expect(box!.height).toBeGreaterThan(300)
      expect(box!.height).toBeLessThan(844 * 0.75)
      if (bar) expect(box!.y + box!.height).toBeLessThanOrEqual(bar.y + 2)
      expect(await laneWidth(page)).toBe(laneBefore)
      expect(arrange!.width).toBeGreaterThan(laneBefore)

      const body = sheet.locator('.bottom-sheet-body')
      const metrics = await body.evaluate((el) => {
        const style = getComputedStyle(el)
        return {
          overflowY: style.overflowY,
          overscroll: style.overscrollBehaviorY,
          touch: style.touchAction,
          scrollable: el.scrollHeight > el.clientHeight + 8,
        }
      })
      expect(metrics.overflowY).toBe('auto')
      expect(metrics.overscroll).toBe('contain')
      expect(metrics.touch).toContain('pan-y')
      if (metrics.scrollable) {
        const start = await body.evaluate((el) => el.scrollTop)
        await touchScroll(page, '.arrange-stage > [data-bottom-sheet="open"] .bottom-sheet-body', 180)
        const next = await body.evaluate((el) => el.scrollTop)
        expect(next).toBeGreaterThan(start)
      }
      const scrollAfter = await arrangeScroll(page)
      expect(scrollAfter).toEqual(scrollBefore)
      await page.screenshot({ path: '/opt/cursor/artifacts/after-browser-390x844.png' })

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.waitForTimeout(200)
        const open = page.locator('[data-playlist-browser="open"]')
        if (await open.count() === 0) await page.getByRole('button', { name: 'Browser', exact: true }).click()
        await open.first().waitFor()
        await page.screenshot({ path: `/opt/cursor/artifacts/after-browser-${viewport.name}.png` })
        if (viewport.name === '390x844' || viewport.name === '844x390') {
          const phone = await open.first().boundingBox()
          const lane = await laneWidth(page)
          expect(phone!.width).toBeGreaterThanOrEqual(viewport.width - 4)
          expect(phone!.x).toBeLessThanOrEqual(1)
          expect(lane).toBeGreaterThan(80)
        }
        if (viewport.name === '768x1024' || viewport.name === '1280x800' || viewport.name === '1440x900') {
          const side = await open.first().boundingBox()
          const arrangeBox = await page.locator('.arrange').boundingBox()
          expect(side!.x + side!.width).toBeLessThanOrEqual((arrangeBox?.x ?? 0) + 2)
        }
      }
      await context.close()
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 90000)

  it('scrolls the plugins sheet by touch without moving the arrange tracks', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4278
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 412, height: 915 },
      ]) {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true })
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await page.getByRole('textbox', { name: 'Keys name' }).click()
        const added = await page.evaluate(() => {
          const store = (window as unknown as {
            __cueharbor: { store: { selectedTrackId: string; project: { tracks: { id: string; name: string; plugins: { pluginId: string }[] }[] }; addPlugin: (id: string, pluginId: string) => void; track: (id: string) => { name: string; plugins: { pluginId: string }[] } } }
          }).__cueharbor.store
          const id = store.selectedTrackId
          for (const pluginId of ['eq', 'compressor', 'reverb', 'delay', 'saturator', 'mod', 'limiter', 'vocal', 'tune']) {
            store.addPlugin(id, pluginId)
          }
          return { name: store.track(id).name, plugins: store.track(id).plugins.map((plugin) => plugin.pluginId) }
        })
        expect(added.plugins.length, JSON.stringify(added)).toBeGreaterThan(6)
        const scrollBefore = await arrangeScroll(page)
        await page.getByRole('button', { name: /^Plugins/ }).click()
        const sheet = page.locator('#arrange-plugins.bottom-sheet')
        await sheet.waitFor()
        await page.getByRole('button', { name: 'Add Plugin' }).click()
        const select = sheet.locator('select[aria-label="Plugin group"]')
        if (await select.count()) {
          const count = await select.locator('option').count()
          await select.selectOption({ index: count - 1 })
        }
        const body = sheet.locator('.bottom-sheet-body')
        const beforeFit = await body.evaluate((el) => {
          const style = getComputedStyle(el)
          const bar = document.querySelector('.tool-slot')?.getBoundingClientRect()
          const sheetBox = el.closest('.bottom-sheet')?.getBoundingClientRect()
          return {
            overflowY: style.overflowY,
            overscroll: style.overscrollBehaviorY,
            touch: style.touchAction,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            sheetBottom: sheetBox?.bottom ?? 0,
            barTop: bar?.top ?? window.innerHeight,
            rows: el.querySelectorAll('.plugin-row').length,
            choices: el.querySelectorAll('button.plugins-choice').length,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
          }
        })
        expect(beforeFit.overflowY).toBe('auto')
        expect(beforeFit.overscroll).toBe('contain')
        expect(beforeFit.touch).toContain('pan-y')
        expect(beforeFit.sheetBottom).toBeLessThanOrEqual(beforeFit.barTop + 2)
        expect(beforeFit.rows).toBeGreaterThan(4)
        expect(beforeFit.scrollHeight).toBeGreaterThan(beforeFit.clientHeight + 8)

        const start = await body.evaluate((el) => el.scrollTop)
        await touchScroll(page, '#arrange-plugins .bottom-sheet-body', 240)
        let top = await body.evaluate((el) => el.scrollTop)
        if (top <= start) {
          await touchScroll(page, '#arrange-plugins .bottom-sheet-body', 320)
          top = await body.evaluate((el) => el.scrollTop)
        }
        expect(top).toBeGreaterThan(start)
        const placed = await body.evaluate((el) => {
          el.scrollTop = el.scrollHeight
          const rows = [...el.querySelectorAll<HTMLElement>('.plugin-row')]
          const last = rows[rows.length - 1]
          if (!last) return null
          const box = last.getBoundingClientRect()
          const view = el.getBoundingClientRect()
          const bar = document.querySelector('.tool-slot')?.getBoundingClientRect()
          const button = last.querySelector('button')
          return {
            text: (button?.textContent || '').replace(/\s+/g, ' ').trim(),
            top: box.top,
            bottom: box.bottom,
            viewTop: view.top,
            viewBottom: view.bottom,
            barTop: bar?.top ?? window.innerHeight,
          }
        })
        expect(placed).toBeTruthy()
        const visible = Math.min(placed!.bottom, placed!.viewBottom) - Math.max(placed!.top, placed!.viewTop)
        expect(visible).toBeGreaterThan(32)
        expect(placed!.bottom).toBeLessThanOrEqual(placed!.barTop + 2)
        await body.locator('.plugin-row').last().locator('button').first().tap()
        const scrollAfter = await arrangeScroll(page)
        expect(scrollAfter).toEqual(scrollBefore)
        await page.screenshot({ path: `/opt/cursor/artifacts/after-plugins-${viewport.width}x${viewport.height}.png` })
        await context.close()
      }
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 90000)

  it('drags the loop end from 18px either side of the right handle', async () => {
    const port = 4279
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('[data-loop-region="arrange"]').waitFor()
      await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { sampleRate: number; snap: boolean }; setLoop: (on: boolean, start?: number, end?: number) => void; toggle: (key: string) => void } }
        }).__cueharbor.store
        if (store.project.snap) store.toggle('snap')
        store.setLoop(true, 0, Math.round(store.project.sampleRate * 0.55))
      })
      await page.waitForTimeout(100)

      async function dragSide(offset: number) {
        return page.evaluate((side) => {
          const store = (window as unknown as { __cueharbor: { store: { project: { loopEndSample: number } } } }).__cueharbor.store
          const face = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"] .loop-grip-face') as HTMLElement | null
          const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement | null
          if (!face || !host) throw new Error('loop end missing')
          const box = face.getBoundingClientRect()
          const x = side < 0 ? box.left + side : box.right + side
          const y = box.top + box.height / 2
          const hit = document.elementFromPoint(x, y)
          const edge = hit?.closest('[data-loop-edge]')?.getAttribute('data-loop-edge') ?? ''
          const before = store.project.loopEndSample
          const fire = (type: string, clientX: number) => {
            host.dispatchEvent(new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX,
              clientY: y,
              pointerId: 7,
              pointerType: 'touch',
              isPrimary: true,
              buttons: type === 'pointerup' ? 0 : 1,
            }))
          }
          fire('pointerdown', x)
          fire('pointermove', x + 70)
          fire('pointerup', x + 70)
          const grip = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"]') as HTMLElement
          const gripBox = grip.getBoundingClientRect()
          const view = (host.parentElement?.closest('.timeline-scroll') ?? host).getBoundingClientRect()
          return {
            edge,
            before,
            after: store.project.loopEndSample,
            x,
            faceLeft: box.left,
            faceRight: box.right,
            gripLeft: gripBox.left,
            gripRight: gripBox.right,
            gripWidth: gripBox.width,
            gripHeight: gripBox.height,
            viewRight: view.right,
            clipped: gripBox.right > view.right + 1,
          }
        }, offset)
      }

      const left = await dragSide(-18)
      expect(left.edge, `left hit ${left.x}`).toBe('end')
      expect(left.gripWidth).toBeGreaterThanOrEqual(44)
      expect(left.gripHeight).toBeGreaterThanOrEqual(40)
      expect(left.clipped).toBe(false)
      expect(left.gripLeft).toBeLessThanOrEqual(left.faceLeft - 18)
      expect(left.after).not.toBe(left.before)

      await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { sampleRate: number }; setLoop: (on: boolean, start?: number, end?: number) => void } }
        }).__cueharbor.store
        store.setLoop(true, 0, Math.round(store.project.sampleRate * 0.55))
      })
      await page.waitForTimeout(50)
      const right = await dragSide(18)
      expect(right.edge, `right hit ${right.x}`).toBe('end')
      expect(right.gripRight).toBeGreaterThanOrEqual(right.faceRight + 18)
      expect(right.clipped).toBe(false)
      expect(right.after).not.toBe(right.before)
      await context.close()
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 60000)
})
