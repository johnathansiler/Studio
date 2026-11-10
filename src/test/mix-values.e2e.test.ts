import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dbFromGain, dbPixels, panPixels } from '../model/mixLaw'

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

async function drag(page: Page, selector: string, dx: number, dy: number, shift = false) {
  await page.evaluate(({ selector, dx, dy, shift }) => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) throw new Error(`missing ${selector}`)
    const box = el.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    const fire = (type: string, clientX: number, clientY: number) => {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        clientX,
        clientY,
        shiftKey: shift,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
      }))
    }
    fire('pointerdown', x, y)
    const steps = 6
    for (let step = 1; step <= steps; step += 1) {
      fire('pointermove', x + (dx * step) / steps, y + (dy * step) / steps)
    }
    fire('pointerup', x + dx, y + dy)
  }, { selector, dx, dy, shift })
}

describe('continuous pan and mixer level', () => {
  const port = 5196
  const url = `http://127.0.0.1:${port}`
  let child: ChildProcess
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(url, child)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    await page.evaluate(() => window.__cueharbor.store.setView('mix'))
    await page.locator('.mixer > .strip .pan-knob').first().waitFor()
    await page.evaluate(() => {
      const cue = window.__cueharbor
      const track = cue.store.project.tracks[0]
      cue.store.updateTrack(track.id, { pan: 0, volume: 1 })
      cue.engine.unlock()
    })
    await page.waitForTimeout(80)
  }, 40000)

  afterAll(async () => {
    await browser?.close()
    child?.kill('SIGTERM')
  })

  it('drags pan to -37.5 and +12, shows them, and the engine follows', async () => {
    const knob = '.mixer > .strip .pan-knob'
    await drag(page, knob, panPixels(-37.5, true), 0, true)
    await page.waitForTimeout(40)
    const left = await page.evaluate(async () => {
      const cue = window.__cueharbor
      await cue.engine.resume()
      await new Promise((resolve) => setTimeout(resolve, 60))
      const track = cue.store.project.tracks[0]
      const strip = cue.engine.strips.get(track.id)
      const knobEl = document.querySelector('.mixer > .strip .pan-knob') as HTMLElement
      return {
        stored: track.pan,
        shown: knobEl.getAttribute('aria-valuetext'),
        text: document.querySelector('.strip-pan')?.getAttribute('data-pan-text'),
        engine: strip?.pan.pan.value ?? null,
        width: knobEl.getBoundingClientRect().width,
        height: knobEl.getBoundingClientRect().height,
      }
    })
    expect(left.stored).toBeCloseTo(-0.375, 4)
    expect(left.shown).toBe('Left 37.5')
    expect(left.text).toBe('Left 37.5')
    expect(left.engine).toBeCloseTo(-0.375, 2)
    expect(left.width).toBeGreaterThanOrEqual(40)
    expect(left.height).toBeGreaterThanOrEqual(40)

    await page.evaluate(() => window.__cueharbor.store.updateTrack(window.__cueharbor.store.project.tracks[0].id, { pan: 0 }))
    await drag(page, knob, panPixels(12), 0, false)
    await page.waitForTimeout(40)
    const right = await page.evaluate(async () => {
      const cue = window.__cueharbor
      await new Promise((resolve) => setTimeout(resolve, 60))
      const track = cue.store.project.tracks[0]
      const strip = cue.engine.strips.get(track.id)
      return {
        stored: track.pan,
        shown: (document.querySelector('.mixer > .strip .pan-knob') as HTMLElement).getAttribute('aria-valuetext'),
        engine: strip?.pan.pan.value ?? null,
      }
    })
    expect(right.stored).toBeCloseTo(0.12, 4)
    expect(right.shown).toBe('Right 12')
    expect(right.engine).toBeCloseTo(0.12, 2)

    await page.evaluate(() => window.__cueharbor.store.undo())
    const undone = await page.evaluate(() => window.__cueharbor.store.project.tracks[0].pan)
    expect(undone).toBeCloseTo(0, 4)
    await page.evaluate(() => window.__cueharbor.store.redo())
    const redone = await page.evaluate(() => window.__cueharbor.store.project.tracks[0].pan)
    expect(redone).toBeCloseTo(0.12, 4)
  }, 30000)

  it('drags the fader to -6.3 dB and +1.7 dB and the engine gain follows', async () => {
    await page.evaluate(() => window.__cueharbor.store.updateTrack(window.__cueharbor.store.project.tracks[0].id, { volume: 1 }))
    const fader = '.mixer > .strip .volume-row .touch-slider'
    await drag(page, fader, 0, dbPixels(6.3), false)
    await page.waitForTimeout(40)
    const down = await page.evaluate(async () => {
      const cue = window.__cueharbor
      await new Promise((resolve) => setTimeout(resolve, 60))
      const track = cue.store.project.tracks[0]
      const strip = cue.engine.strips.get(track.id)
      return {
        stored: track.volume,
        shown: (document.querySelector('.mixer > .strip .fader-db') as HTMLElement).textContent,
        engine: strip?.fader.gain.value ?? null,
      }
    })
    expect(dbFromGain(down.stored)).toBeCloseTo(-6.3, 4)
    expect((down.shown || '').replace(/\s+/g, ' ').trim()).toContain('-6.3 dB')
    expect(dbFromGain(down.engine ?? 0)).toBeCloseTo(-6.3, 1)

    await page.evaluate(() => window.__cueharbor.store.updateTrack(window.__cueharbor.store.project.tracks[0].id, { volume: 1 }))
    await drag(page, fader, 0, -dbPixels(1.7), false)
    await page.waitForTimeout(40)
    const up = await page.evaluate(async () => {
      const cue = window.__cueharbor
      await new Promise((resolve) => setTimeout(resolve, 60))
      const track = cue.store.project.tracks[0]
      const strip = cue.engine.strips.get(track.id)
      const master = document.querySelector('.strip.master .fader-db') as HTMLElement
      return {
        stored: track.volume,
        shown: (document.querySelector('.mixer > .strip .fader-db') as HTMLElement).textContent,
        engine: strip?.fader.gain.value ?? null,
        master: (master?.textContent || '').replace(/\s+/g, ' ').trim(),
      }
    })
    expect(dbFromGain(up.stored)).toBeCloseTo(1.7, 4)
    expect((up.shown || '').replace(/\s+/g, ' ').trim()).toContain('1.7 dB')
    expect(dbFromGain(up.engine ?? 0)).toBeCloseTo(1.7, 1)
    expect(up.master).toMatch(/dB|inf/)

    await page.evaluate(() => window.__cueharbor.store.undo())
    const undone = await page.evaluate(() => window.__cueharbor.store.project.tracks[0].volume)
    expect(dbFromGain(undone)).toBeCloseTo(0, 4)
  }, 30000)

  it('types -6.3 into the decibel field and a phone-sized drag stays fine', async () => {
    const typed = await page.evaluate(() => {
      const cue = window.__cueharbor
      const field = document.querySelector('.mixer > .strip .fader-db .db-type') as HTMLInputElement
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      proto?.set?.call(field, '-6.3')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(new Event('change', { bubbles: true }))
      return {
        label: field.getAttribute('aria-label'),
        volume: cue.store.project.tracks[0].volume,
      }
    })
    expect(typed.label).toMatch(/decibel/i)
    expect(dbFromGain(typed.volume)).toBeCloseTo(-6.3, 4)

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    await phone.goto(url, { waitUntil: 'domcontentloaded' })
    await phone.waitForTimeout(1000)
    await phone.evaluate(() => window.__cueharbor.store.setView('mix'))
    await phone.locator('.pan-knob').first().waitFor()
    await phone.evaluate((pixels) => {
      const cue = window.__cueharbor
      cue.store.updateTrack(cue.store.project.tracks[0].id, { pan: 0 })
      const el = document.querySelector('.pan-knob') as HTMLElement
      const box = el.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      const fire = (type: string, clientX: number, clientY: number) => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'touch',
          clientX,
          clientY,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
        }))
      }
      fire('pointerdown', x, y)
      fire('pointermove', x, y - 16)
      fire('pointermove', x, y - 16 - pixels)
      fire('pointerup', x, y - 16 - pixels)
    }, panPixels(12, true))
    await phone.waitForTimeout(40)
    const pan = await phone.evaluate(() => {
      const cue = window.__cueharbor
      const knob = document.querySelector('.pan-knob') as HTMLElement
      const box = knob.getBoundingClientRect()
      return { stored: cue.store.project.tracks[0].pan, shown: knob.getAttribute('aria-valuetext'), box }
    })
    expect(pan.stored).toBeCloseTo(0.12, 4)
    expect(pan.shown).toBe('Right 12')
    expect(pan.box.width).toBeGreaterThanOrEqual(40)
    expect(pan.box.height).toBeGreaterThanOrEqual(40)
    await phone.close()
  }, 30000)
})
