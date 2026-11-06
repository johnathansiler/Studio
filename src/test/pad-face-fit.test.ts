import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { PadsPanel } from '../ui/PadsPanel'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = [
  'src/styles.css',
  'src/ui/premium.css',
  'src/ui/pluginStage.css',
  'src/ui/buttonTiers.css',
  'src/ui/pluginPages.css',
  'src/ui/presetControls.css',
  'src/ui/pads.css',
].map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')

const engine = {
  unlock() {},
  resume: async () => {},
  status: 'stopped',
  positionSamples: 0,
  sampleRate: 48000,
  subscribe: () => () => {},
  setPadRoute() {},
  setBeatPump() {},
  setRepeatWatch() {},
} as unknown as AudioEngine

const VIEWPORTS = [
  { name: '360x844', width: 360, height: 844 },
  { name: '390x844', width: 390, height: 844 },
  { name: '412x844', width: 412, height: 844 },
  { name: '673x841', width: 673, height: 841 },
  { name: '1440x900', width: 1440, height: 900 },
]

const TAKE = ['Record', 'Overdub', 'Replace', 'Stop', 'Play', 'Play start', 'Erase', 'Arm pad', 'Count in', 'Metronome', 'Trim', 'Auto chop', 'More']

describe('beat machine face fits the phone', () => {
  it('keeps the sampler row and the take transport on screen', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const html = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {} }))
    expect(html).not.toContain('Zoom out')
    expect(html).not.toContain('Zoom to Start')
    expect(html).not.toContain('>Reset<')
    const padsPage = html.slice(html.indexOf('data-plugin-page="pads"'), html.indexOf('data-plugin-page="sound"'))
    expect(padsPage).not.toContain('Snap to zero')
    expect(html).toContain('data-pad-snap="sound"')
    const browser = await chromium.launch()
    const rows: unknown[] = []
    try {
      for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
        await page.setContent(`<!doctype html><html><head><style>
          html, body { margin: 0; background: #1a1a1a; height: 100%; }
          ${css}
          .stage { width: ${viewport.width}px; height: ${viewport.height}px; }
        </style></head><body><div class="stage shell phone" data-plugin="pads"><div class="workspace"><div class="dock-slot">${html}</div></div></div></body></html>`, { waitUntil: 'load' })
        const report = await page.evaluate(() => {
          const box = (sel: string) => {
            const node = document.querySelector(sel) as HTMLElement | null
            if (!node) return null
            const rect = node.getBoundingClientRect()
            return { y: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height), w: Math.round(rect.width) }
          }
          const radius = (sel: string) => {
            const node = document.querySelector(sel) as HTMLElement | null
            return node ? getComputedStyle(node).borderTopLeftRadius : ''
          }
          document.querySelectorAll('.mpc-pad').forEach((node) => node.classList.add('lit'))
          const overlaps = (pad: DOMRect, row?: DOMRect) => {
            if (!row || row.width < 1) return false
            const width = Math.min(pad.right, row.right) - Math.max(pad.left, row.left)
            const height = Math.min(pad.bottom, row.bottom) - Math.max(pad.top, row.top)
            return width > 1 && height > 1
          }
          const buttons = [...document.querySelectorAll('[data-beat-transport] .hw-key')].map((node) => {
            const rect = node.getBoundingClientRect()
            return {
              text: (node.getAttribute('aria-label') || node.textContent || '').trim(),
              y: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            }
          })
          const targets = [...document.querySelectorAll('.hw-key, .mpc-pad, .hw-slider input')].map((node) => node.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0)
          const pads = [...document.querySelectorAll('.mpc-pad')].map((node) => node.getBoundingClientRect())
          const banks = document.querySelector('.mpc-banks')?.getBoundingClientRect()
          const repeat = document.querySelector('.note-repeat-row')?.getBoundingClientRect()
          const mpc = document.querySelector('.mpc') as HTMLElement | null
          return {
            viewH: window.innerHeight,
            transport: box('[data-beat-transport]'),
            lip: box('.hw-lip'),
            wave: box('.pad-screen-wave'),
            buttons,
            short: targets.filter((rect) => rect.width < 40 || rect.height < 40).length,
            padHits: pads.filter((pad) => overlaps(pad, banks) || overlaps(pad, repeat)).length,
            keyRadius: radius('.pad-actions .pad-key'),
            bankRadius: radius('.mpc-banks .hw-key'),
            ledRadius: radius('.pad-led-face'),
            ledH: Math.round(document.querySelector('.pad-led-face')?.getBoundingClientRect().height ?? 0),
            keyH: Math.round(document.querySelector('.pad-actions .pad-key')?.getBoundingClientRect().height ?? 0),
            moreW: Math.round(document.querySelector('.pad-more')?.getBoundingClientRect().width ?? 0),
            touch: getComputedStyle(document.querySelector('.pad-screen-wave') as Element).touchAction,
            tools: document.querySelector('.pad-screen-tools') != null,
            waveText: (document.querySelector('.pad-screen-wave')?.textContent || '').replace(/\s+/g, ' ').trim(),
            scrollWidth: document.documentElement.scrollWidth,
            mpcScroll: mpc ? mpc.scrollHeight - mpc.clientHeight : 0,
            transportHidden: document.querySelector('[data-beat-transport]')?.closest('[hidden]') != null,
          }
        })
        if (viewport.name === '390x844') {
          await page.screenshot({ path: '/opt/cursor/artifacts/beat-pads-390x844-after.png' })
        }
        rows.push({ viewport: viewport.name, transport: report.transport, lip: report.lip, buttons: report.buttons })
        expect(report.tools, viewport.name).toBe(false)
        expect(report.waveText, viewport.name).not.toMatch(/Zoom|Snap to zero|Pinch to zoom/)
        expect(report.touch, viewport.name).toBe('none')
        expect(report.transportHidden, viewport.name).toBe(false)
        expect(report.short, viewport.name).toBe(0)
        expect(report.padHits, viewport.name).toBe(0)
        expect(report.scrollWidth, viewport.name).toBeLessThanOrEqual(viewport.width + 1)
        expect(report.keyRadius, viewport.name).toBe('5px')
        expect(report.bankRadius, viewport.name).toBe('5px')
        expect(Number.parseFloat(report.ledRadius), viewport.name).toBeGreaterThanOrEqual(13)
        expect(report.ledH, viewport.name).toBeLessThan(report.keyH - 8)
        expect(report.keyH, viewport.name).toBeGreaterThanOrEqual(40)
        expect(report.moreW, viewport.name).toBeGreaterThanOrEqual(40)
        expect(report.moreW, viewport.name).toBeLessThanOrEqual(48)
        expect(report.lip, viewport.name).toBeTruthy()
        expect(report.transport, viewport.name).toBeTruthy()
        expect(report.lip!.y, viewport.name).toBeGreaterThan(report.transport!.y)
        expect(report.lip!.bottom, viewport.name).toBeLessThanOrEqual(viewport.height + 1)
        expect(report.transport!.bottom, viewport.name).toBeLessThanOrEqual(viewport.height + 1)
        expect(report.mpcScroll, viewport.name).toBeLessThanOrEqual(1)
        for (const word of TAKE) {
          const hit = report.buttons.find((button) => button.text === word)
          expect(hit, `${viewport.name} ${word}`).toBeTruthy()
          expect(hit!.h, `${viewport.name} ${word}`).toBeGreaterThanOrEqual(40)
          expect(hit!.w, `${viewport.name} ${word}`).toBeGreaterThanOrEqual(40)
          expect(hit!.y, `${viewport.name} ${word}`).toBeGreaterThanOrEqual(0)
          expect(hit!.bottom, `${viewport.name} ${word}`).toBeLessThanOrEqual(viewport.height + 1)
        }
        await page.close()
      }
    } finally {
      await browser.close()
    }
    writeFileSync('/opt/cursor/artifacts/beat-pads-y.json', JSON.stringify(rows, null, 2))
  }, 30000)
})

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

describe('pad waveform gestures', () => {
  it('pinches, pans, and double-taps the waveform with pointer events', async () => {
    const port = 4300 + Math.floor(Math.random() * 200)
    const url = `http://127.0.0.1:${port}/src/test/pad-gesture.harness.html`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch()
    try {
      await waitForServer(`http://127.0.0.1:${port}/src/test/pad-gesture.harness.html`, child)
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      const wave = page.locator('.pad-screen-wave')
      await wave.waitFor()
      const read = () => page.evaluate(() => {
        const node = document.querySelector('.pad-screen-wave') as HTMLElement
        return { start: Number(node.dataset.viewStart), end: Number(node.dataset.viewEnd) }
      })
      const span = async () => {
        const view = await read()
        return view.end - view.start
      }
      expect(await span()).toBeCloseTo(1, 2)

      const box = (await wave.boundingBox())!
      const cy = box.y + box.height / 2
      const cx = box.x + box.width / 2
      await page.evaluate(({ x, y }) => {
        const el = document.querySelector('.pad-screen-wave') as HTMLElement
        const send = (type: string, id: number, clientX: number, clientY: number) => {
          el.dispatchEvent(new PointerEvent(type, {
            pointerId: id,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
            pointerType: 'touch',
            isPrimary: id === 1,
          }))
        }
        send('pointerdown', 1, x - 20, y)
        send('pointermove', 1, x + 70, y)
        send('pointerup', 1, x + 70, y)
      }, { x: cx, y: cy })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await span()).toBeCloseTo(1, 2)

      await page.evaluate(({ x, y }) => {
        const el = document.querySelector('.pad-screen-wave') as HTMLElement
        const send = (type: string, id: number, clientX: number, clientY: number) => {
          el.dispatchEvent(new PointerEvent(type, {
            pointerId: id,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
            pointerType: 'touch',
            isPrimary: id === 1,
          }))
        }
        send('pointerdown', 1, x - 24, y)
        send('pointerdown', 2, x + 24, y)
        send('pointermove', 1, x - 78, y)
        send('pointermove', 2, x + 78, y)
        send('pointerup', 1, x - 78, y)
        send('pointerup', 2, x + 78, y)
      }, { x: cx, y: cy })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const zoomed = await read()
      expect(zoomed.end - zoomed.start).toBeLessThan(0.7)
      expect(zoomed.start).toBeGreaterThan(0.05)
      expect(zoomed.end).toBeLessThan(0.95)

      const beforePan = await read()
      await page.evaluate(({ x, y }) => {
        const el = document.querySelector('.pad-screen-wave') as HTMLElement
        const send = (type: string, id: number, clientX: number, clientY: number) => {
          el.dispatchEvent(new PointerEvent(type, {
            pointerId: id,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
            pointerType: 'touch',
            isPrimary: true,
          }))
        }
        send('pointerdown', 3, x, y)
        send('pointermove', 3, x + 80, y)
        send('pointerup', 3, x + 80, y)
      }, { x: cx, y: cy })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const panned = await read()
      expect(Math.abs(panned.start - beforePan.start)).toBeGreaterThan(0.01)
      expect(panned.end - panned.start).toBeCloseTo(beforePan.end - beforePan.start, 2)

      await page.evaluate(() => {
        const el = document.querySelector('.pad-screen-wave') as HTMLElement
        const marker = el.querySelector('[data-trim="start"]') as HTMLElement
        const send = (type: string, clientX: number, clientY: number) => {
          marker.dispatchEvent(new PointerEvent(type, {
            pointerId: 4,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
            pointerType: 'touch',
            isPrimary: true,
          }))
        }
        const spot = marker.getBoundingClientRect()
        send('pointerdown', spot.left + 8, spot.top + 8)
        send('pointermove', spot.left + 48, spot.top + 8)
        send('pointerup', spot.left + 48, spot.top + 8)
      })
      const trimmed = await page.evaluate(() => (window as unknown as { __trim?: number[] }).__trim)
      expect(trimmed?.[0]).toBeGreaterThan(0)
      const afterTrim = await read()
      expect(afterTrim.start).toBeCloseTo(panned.start, 2)

      await page.evaluate(({ x, y }) => {
        const el = document.querySelector('.pad-screen-wave') as HTMLElement
        const send = (type: string, clientX: number) => {
          el.dispatchEvent(new PointerEvent(type, {
            pointerId: 5,
            clientX,
            clientY: y,
            bubbles: true,
            cancelable: true,
            pointerType: 'touch',
            isPrimary: true,
          }))
        }
        send('pointerdown', x)
        send('pointerup', x)
        send('pointerdown', x + 2)
        send('pointerup', x + 2)
      }, { x: cx, y: cy })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await span()).toBeCloseTo(1, 2)

      await page.evaluate(({ x, y }) => {
        const el = document.querySelector('.pad-screen-wave') as HTMLElement
        el.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true }))
      }, { x: cx, y: cy })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await span()).toBeLessThan(0.9)
      const wheeled = await read()
      await page.evaluate(({ x, y }) => {
        const el = document.querySelector('.pad-screen-wave') as HTMLElement
        el.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY: 180, bubbles: true, cancelable: true }))
        el.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaX: 80, shiftKey: true, bubbles: true, cancelable: true }))
      }, { x: cx, y: cy })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const shifted = await read()
      expect(Math.abs(shifted.start - wheeled.start)).toBeGreaterThan(0.01)
      await wave.dblclick({ position: { x: box.width / 2, y: box.height / 2 } })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await span()).toBeCloseTo(1, 2)
    } finally {
      child.kill('SIGTERM')
      await browser.close()
    }
  }, 40000)
})
