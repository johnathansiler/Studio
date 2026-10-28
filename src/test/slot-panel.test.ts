import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { encodeWav } from '../model/wav'

function wavFile() {
  const channel = new Float32Array(4800)
  for (let i = 0; i < channel.length; i++) channel[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.6
  const dir = mkdtempSync(join(tmpdir(), 'slot-'))
  const path = join(dir, 'tone.wav')
  writeFileSync(path, Buffer.from(encodeWav([channel], 48000, { bits: 16 })))
  return path
}

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

async function waitForProject(page: Page) {
  await page.locator('[data-track]').first().waitFor()
  let last = ''
  let stable = 0
  const started = Date.now()
  while (Date.now() - started < 8000) {
    const id = await page.locator('[data-track]').first().getAttribute('data-track')
    if (id && id === last) {
      stable += 1
      if (stable >= 3) return
    } else stable = 0
    last = id || ''
    await page.waitForTimeout(200)
  }
}

async function openSampler(page: Page, phone: boolean) {
  await waitForProject(page)
  if (phone) await page.getByRole('button', { name: /^Mix/ }).first().click()
  const root = page.locator(phone ? '.mixer .strip' : '.head').first()
  await root.locator('.insert-add').selectOption('sampler')
  const button = root.locator('.inserts button', { hasText: 'Sampler' })
  await button.waitFor()
  await button.evaluate((el) => (el as HTMLButtonElement).click())
  await page.locator('.slot-wave').scrollIntoViewIfNeeded()
  await page.locator('.slot-wave').waitFor()
}

async function percent(page: Page, selector: string) {
  const text = await page.locator(selector).first().evaluate((el) => (el as HTMLElement).style.left)
  return Number.parseFloat(text)
}

async function dragHandle(page: Page, selector: string, yRatio: number, toRatio: number, pointerType: 'mouse' | 'touch') {
  const box = await page.locator('.slot-wave').boundingBox()
  if (!box) throw new Error('waveform missing')
  const y = box.y + box.height * yRatio
  const fromX = box.x + 8
  const toX = box.x + box.width * toRatio
  if (pointerType === 'mouse') {
    await page.mouse.move(fromX, y)
    await page.mouse.down()
    await page.mouse.move(toX, y, { steps: 8 })
    await expect.poll(() => page.locator('.slot-active').textContent()).toBe(selector.includes('loop') ? 'Loop start' : 'Start')
    await page.mouse.up()
    return
  }
  await page.evaluate(({ y, fromX, toX, selector: which }) => {
    const handle = document.querySelector(which)
    if (!handle) throw new Error('handle missing')
    const fire = (type: string, x: number) => {
      handle.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1,
      }))
    }
    fire('pointerdown', fromX)
    fire('pointermove', (fromX + toX) / 2)
    fire('pointermove', toX)
    fire('pointerup', toX)
  }, { y, fromX, toX, selector })
}

describe('loop and sample panel', () => {
  it('drags waveform handles with mouse and touch, uploads a file, and records a fake mic', async () => {
    const port = 4188
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    const file = wavFile()
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })

      const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const deskPage = await desk.newPage()
      const errors: string[] = []
      deskPage.on('pageerror', (error) => errors.push(error.message))
      await deskPage.goto(url, { waitUntil: 'domcontentloaded' })
      await openSampler(deskPage, false)
      await dragHandle(deskPage, '.slot-handle.loop', 0.78, 0.4, 'mouse')
      expect(await percent(deskPage, '.slot-handle.loop')).toBeGreaterThan(25)
      expect(await percent(deskPage, '.slot-handle.edge')).toBeLessThan(5)
      await dragHandle(deskPage, '.slot-handle.edge', 0.2, 0.18, 'mouse')
      expect(await percent(deskPage, '.slot-handle.edge')).toBeGreaterThan(10)
      expect(await percent(deskPage, '.slot-handle.loop')).toBeGreaterThan(25)
      await deskPage.locator('.slot-file').setInputFiles(file)
      await deskPage.locator('.slot-wave canvas').evaluate((canvas) => {
        const view = canvas as HTMLCanvasElement
        const data = view.getContext('2d')?.getImageData(0, 0, view.width, view.height).data
        if (!data) return 0
        let painted = 0
        for (let i = 1; i < data.length; i += 4) if (data[i] > 40) painted += 1
        return painted
      }).then((painted) => expect(painted).toBeGreaterThan(20))

      await deskPage.evaluate(() => {
        navigator.mediaDevices.getUserMedia = async () => {
          const ctx = new AudioContext()
          await ctx.resume()
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          gain.gain.value = 0.4
          const dest = ctx.createMediaStreamDestination()
          osc.frequency.value = 330
          osc.connect(gain)
          gain.connect(dest)
          osc.start()
          return dest.stream
        }
      })
      await deskPage.locator('.slot-panel').getByRole('button', { name: /^Record/ }).click()
      await deskPage.locator('.slot-status', { hasText: 'Recording' }).waitFor({ timeout: 8000 })
      await deskPage.waitForTimeout(350)
      await deskPage.locator('.slot-panel').getByRole('button', { name: /^Stop/ }).click()
      await deskPage.locator('.slot-status', { hasText: 'Recording' }).waitFor({ state: 'detached', timeout: 4000 })
      expect(errors.join('\n')).not.toMatch(/Could not open the microphone|Recording failed|InvalidStateError/)

      await deskPage.locator('.plugin-sheet').getByRole('button', { name: '×' }).click()
      const deskHead = deskPage.locator('.head').first()
      await deskHead.locator('.insert-add').selectOption('looper')
      await deskHead.locator('.inserts button', { hasText: 'Looper' }).evaluate((el) => (el as HTMLButtonElement).click())
      expect(await deskPage.locator('.slot-panel').getByRole('button', { name: /^Dub/ }).count()).toBe(1)
      await desk.close()

      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
      const phonePage = await phone.newPage()
      await phonePage.goto(url, { waitUntil: 'domcontentloaded' })
      await openSampler(phonePage, true)
      await dragHandle(phonePage, '.slot-handle.loop', 0.78, 0.45, 'touch')
      expect(await percent(phonePage, '.slot-handle.loop')).toBeGreaterThan(25)
      await dragHandle(phonePage, '.slot-handle.edge', 0.18, 0.2, 'touch')
      expect(await percent(phonePage, '.slot-handle.edge')).toBeGreaterThan(8)
      await phonePage.locator('.plugin-sheet').getByRole('button', { name: '×' }).click()
      const phoneStrip = phonePage.locator('.mixer .strip').first()
      await phoneStrip.locator('.insert-add').selectOption('looper')
      await phoneStrip.locator('.inserts button', { hasText: 'Looper' }).evaluate((el) => (el as HTMLButtonElement).click())
      expect(await phonePage.locator('.slot-panel').getByRole('button', { name: /^Dub/ }).count()).toBe(0)
      await phonePage.locator('.slot-panel').getByRole('button', { name: /^More/ }).click()
      expect(await phonePage.locator('.slot-panel').getByRole('button', { name: /^Dub/ }).count()).toBe(1)
      await phone.close()
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 60000)
})
