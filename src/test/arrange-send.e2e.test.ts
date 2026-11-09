import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const artifacts = '/opt/cursor/artifacts'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

function beatOf(page: Page, name: string) {
  return page.evaluate((label) => {
    const clips = (window as unknown as {
      __cueharbor: { store: { project: { tracks: { midiClips: { name: string; startBeat: number }[] }[] } } }
    }).__cueharbor.store.project.tracks.flatMap((track) => track.midiClips)
    return clips.find((clip) => clip.name === label)?.startBeat ?? null
  }, name)
}

describe('To Arrange clip tap', () => {
  it('opens the step sequencer from one click on the clip To Arrange just placed', async () => {
    mkdirSync(artifacts, { recursive: true })
    const port = 5192
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' })
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()

      await page.getByRole('button', { name: 'Add Track' }).click()
      await page.getByRole('button', { name: /^Step Sequencer\./ }).click()
      await page.locator('[data-step-sequencer="open"]').waitFor()

      const closeHit = await page.evaluate(() => {
        const button = document.querySelector('.step-close') as HTMLElement
        const box = button.getBoundingClientRect()
        const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return {
          height: box.height,
          width: box.width,
          close: !!target?.closest('.step-close'),
          rack: !!target?.closest('.rack-bar'),
          className: target instanceof Element ? target.className.toString().slice(0, 80) : '',
        }
      })
      expect(closeHit.height, JSON.stringify(closeHit)).toBeGreaterThanOrEqual(40)
      expect(closeHit.width, JSON.stringify(closeHit)).toBeGreaterThanOrEqual(40)
      expect(closeHit.close, JSON.stringify(closeHit)).toBe(true)
      expect(closeHit.rack, JSON.stringify(closeHit)).toBe(false)

      const arrange = page.getByRole('button', { name: /^To Arrange/ })
      await arrange.scrollIntoViewIfNeeded()
      await arrange.click()
      await page.locator('.step-close').click()
      await page.locator('[data-step-sequencer="open"]').waitFor({ state: 'detached' })

      const clip = page.locator('.clip[data-midi="1"]', { hasText: 'Pattern 1' })
      await clip.waitFor()
      await page.screenshot({ path: `${artifacts}/to-arrange-clip-1440x900.png` })
      await clip.click()
      await page.locator('[data-step-sequencer="open"]').waitFor()
      expect(await page.locator('[data-editor="piano"]').count()).toBe(0)
      await page.screenshot({ path: `${artifacts}/to-arrange-opened-1440x900.png` })
      await page.locator('.step-close').click()
      await page.locator('[data-step-sequencer="open"]').waitFor({ state: 'detached' })

      const beforeDrag = await beatOf(page, 'Pattern 1')
      const box = await clip.boundingBox()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(box!.x + box!.width / 2 + 120, box!.y + box!.height / 2, { steps: 8 })
      await page.mouse.up()
      expect(await page.locator('[data-step-sequencer="open"]').count()).toBe(0)
      const dragged = await beatOf(page, 'Pattern 1')
      expect(dragged).not.toBeNull()
      expect(dragged!).toBeGreaterThan(beforeDrag ?? 0)

      const scrolled = await page.evaluate(async () => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { tracks: { midiClips: { id: string; name: string; startBeat: number }[] }[] } } }
        }).__cueharbor.store
        const found = store.project.tracks.flatMap((track) => track.midiClips).find((item) => item.name === 'Pattern 1')
        const node = document.querySelector(`[data-clip="${found?.id}"]`) as HTMLElement
        const rect = node.getBoundingClientRect()
        const x = rect.left + Math.min(rect.width / 2, 80)
        const y = rect.top + rect.height / 2
        const point = (type: string, clientX: number, clientY: number, target: EventTarget) => {
          target.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            pointerId: 7,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
          }))
        }
        const start = found?.startBeat ?? null
        point('pointerdown', x, y, node)
        point('pointermove', x, y + 56, window)
        await new Promise((resolve) => requestAnimationFrame(resolve))
        point('pointerup', x, y + 56, window)
        const after = store.project.tracks.flatMap((track) => track.midiClips).find((item) => item.name === 'Pattern 1')?.startBeat ?? null
        return { start, after, open: !!document.querySelector('[data-step-sequencer="open"]') }
      })
      expect(scrolled.open).toBe(false)
      expect(scrolled.after).toBe(scrolled.start)

      const music = page.locator('.clip', { hasText: 'Soft Piano' }).first()
      if (await music.count()) {
        await music.click()
        expect(await page.locator('[data-step-sequencer="open"]').count()).toBe(0)
        expect(await page.locator('[data-editor="piano"]').count()).toBe(0)
      }
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 120000)
})
