import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 880, height: 1000 },
  { width: 1440, height: 900 },
]

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

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, kind: 'mouse' | 'touch') {
  if (kind === 'mouse') {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    return
  }
  const client = await page.context().newCDPSession(page)
  const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }]
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) })
  for (let step = 1; step <= 8; step++) {
    const x = from.x + ((to.x - from.x) * step) / 8
    const y = from.y + ((to.y - from.y) * step) / 8
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) })
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
}

describe('loop handles, whole-number drags, and smooth waveforms', () => {
  const port = 5193
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

  it('drags both loop handles with pointer and touch, including a 1-beat end', async () => {
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport, hasTouch: true })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('[data-loop-region="arrange"]').waitFor()
      await page.waitForTimeout(600)
      for (const kind of ['mouse', 'touch'] as const) {
        for (const edge of ['end', 'start'] as const) {
          await page.evaluate(() => {
            const store = window.__cueharbor.store
            const beat = Math.round(store.project.sampleRate * 0.5)
            store.setLoop(true, beat * 4, beat * 16)
          })
          await page.waitForTimeout(80)
          const box = await page.locator(`[data-loop-region="arrange"] [data-loop-edge="${edge}"]`).boundingBox()
          expect(box, `${edge} ${viewport.width}`).toBeTruthy()
          expect(box!.width).toBeGreaterThanOrEqual(44)
          expect(box!.height).toBeGreaterThanOrEqual(28)
          const before = await page.evaluate((which) => {
            const project = window.__cueharbor.store.project
            return which === 'end' ? project.loopEndSample : project.loopStartSample
          }, edge)
          const from = { x: box!.x + Math.min(box!.width / 2, 18), y: box!.y + box!.height / 2 }
          const to = { x: from.x + 90, y: from.y }
          await drag(page, from, to, kind)
          const after = await page.evaluate((which) => window.__cueharbor.store.project[which === 'end' ? 'loopEndSample' : 'loopStartSample'], edge)
          expect(after, `${kind} ${edge} ${viewport.width}x${viewport.height}`).not.toBe(before)
        }
      }
      await page.evaluate(() => {
        const store = window.__cueharbor.store
        const beat = Math.round(store.project.sampleRate * 0.5)
        store.setLoop(true, beat * 2, beat * 3)
      })
      await page.waitForTimeout(100)
      const end = await page.locator('[data-loop-region="arrange"] [data-loop-edge="end"]').boundingBox()
      expect(end!.width).toBeGreaterThanOrEqual(44)
      const beforeEnd = await page.evaluate(() => window.__cueharbor.store.project.loopEndSample)
      await drag(page, { x: end!.x + end!.width / 2, y: end!.y + end!.height / 2 }, { x: end!.x + end!.width / 2 + 80, y: end!.y + end!.height / 2 }, 'touch')
      const afterEnd = await page.evaluate(() => window.__cueharbor.store.project.loopEndSample)
      expect(afterEnd, `1-beat end ${viewport.width}`).toBeGreaterThan(beforeEnd)
      const order = await page.evaluate(() => {
        const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement
        const grips = {
          start: document.querySelector('[data-loop-edge="start"]')!.getBoundingClientRect(),
          end: document.querySelector('[data-loop-edge="end"]')!.getBoundingClientRect(),
        }
        const x = (grips.start.right + grips.end.left) / 2
        const y = (grips.end.top + grips.end.bottom) / 2
        const hit = document.elementFromPoint(grips.end.left + 6, y)
        return {
          mode: host.dataset.loopHit,
          edge: hit?.closest('[data-loop-edge]')?.getAttribute('data-loop-edge') ?? '',
          touch: getComputedStyle(document.querySelector('[data-loop-edge="end"]')!).touchAction,
          x,
        }
      })
      expect(order.touch).toBe('none')
      expect(['end', 'start']).toContain(order.edge)
      await page.screenshot({ path: `/opt/cursor/artifacts/after-loop-${viewport.width}x${viewport.height}.png` })
      await page.close()
    }
  }, 120000)

  it('soft-locks tempo onto whole numbers and lets a pan knob leave center', async () => {
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport, hasTouch: true })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('.tempo-tap').waitFor()
      const tempo = await page.locator('.tempo-tap').boundingBox()
      const before = await page.evaluate(() => window.__cueharbor.store.project.tempo)
      await drag(
        page,
        { x: tempo!.x + tempo!.width / 2, y: tempo!.y + tempo!.height / 2 },
        { x: tempo!.x + tempo!.width / 2, y: Math.min(tempo!.y + tempo!.height / 2 + 50, viewport.height - 12) },
        'touch',
      )
      const bpm = await page.evaluate(() => window.__cueharbor.store.project.tempo)
      expect(bpm, `tempo ${viewport.width}`).not.toBe(before)
      expect(Number.isInteger(bpm), `tempo ${bpm}`).toBe(true)
      await page.evaluate(() => window.__cueharbor.store.setView('mix'))
      await page.locator('.pan-knob').first().waitFor()
      const knob = await page.locator('.pan-knob').first().boundingBox()
      await drag(
        page,
        { x: knob!.x + knob!.width / 2, y: knob!.y + knob!.height / 2 },
        { x: knob!.x + knob!.width / 2 + 60, y: knob!.y + knob!.height / 2 },
        viewport.width < 500 ? 'touch' : 'mouse',
      )
      const pan = await page.evaluate(() => window.__cueharbor.store.project.tracks[0].pan)
      expect(pan, `pan ${pan} at ${viewport.width}`).not.toBe(0)
      expect([-1, 1].includes(pan), `pan ${pan} at ${viewport.width}`).toBe(false)
      expect(Math.abs(pan)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: `/opt/cursor/artifacts/after-integer-${viewport.width}x${viewport.height}.png` })
      await page.close()
    }
  }, 90000)

  it('paints arrange waveforms with the shared renderer at three sizes', async () => {
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport, hasTouch: true })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('.timeline-scroll').waitFor()
      await page.waitForTimeout(800)
      await page.evaluate(() => {
        const store = window.__cueharbor.store
        store.setView('arrange')
        const track = store.project.tracks.find((item: { type: string }) => item.type === 'audio')
        if (!track) throw new Error('no audio track')
        const rate = store.project.sampleRate
        const data = new Float32Array(rate * 4)
        for (let i = 0; i < data.length; i++) {
          const env = 0.25 + 0.75 * Math.abs(Math.sin(i / 1800))
          data[i] = Math.sin(i / 9) * env
        }
        store.addAsset({ id: 'wave_demo', name: 'Wave', sampleRate: rate, channels: [data] })
        store.addAudioClip(track.id, {
          id: 'wave_clip',
          name: 'Wave',
          bufferId: 'wave_demo',
          startSample: 0,
          offsetSamples: 0,
          durationSamples: rate * 4,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          gain: 1,
          source: 'local',
        })
      })
      await page.locator('.timeline-scroll').hover()
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, 40)
      await page.keyboard.up('Control')
      const canvas = page.locator('.clip-wave canvas').first()
      await canvas.waitFor({ state: 'attached', timeout: 8000 })
      await canvas.scrollIntoViewIfNeeded()
      await page.waitForTimeout(250)
      const drawn = await canvas.evaluate((node) => {
        const view = node as HTMLCanvasElement
        const ctx = view.getContext('2d')
        if (!ctx) return { shared: view.dataset.waveformDraw, ink: 0, gaps: 0 }
        const row = Math.floor(view.height / 2)
        const data = ctx.getImageData(0, Math.max(0, row - 4), view.width, 8).data
        let ink = 0
        let gap = 0
        let run = 0
        for (let x = 0; x < view.width; x++) {
          let lit = false
          for (let y = 0; y < 8; y++) {
            const i = (y * view.width + x) * 4
            if (data[i + 3] > 20 && (data[i] > 20 || data[i + 1] > 20)) lit = true
          }
          if (lit) {
            ink += 1
            run = 0
          } else if (ink > 8) {
            run += 1
            if (run === 1) gap += 1
          }
        }
        return { shared: view.dataset.waveformDraw, ink, gaps: gap }
      })
      expect(drawn.shared).toBe('shared')
      expect(drawn.ink).toBeGreaterThan(20)
      await canvas.screenshot({ path: `/opt/cursor/artifacts/after-wave-${viewport.width}x${viewport.height}.png` })
      await page.close()
    }
  }, 90000)
})

declare global {
  interface Window {
    __cueharbor: {
      store: {
        project: {
          sampleRate: number
          tempo: number
          loopStartSample: number
          loopEndSample: number
          tracks: { id: string; type: string; pan: number; volume: number }[]
          masterVolume: number
        }
        setLoop: (on: boolean, start?: number, end?: number) => void
        setView: (view: string) => void
        updateTrack: (id: string, patch: { pan?: number; volume?: number }) => void
        undo: () => void
        redo: () => void
        addAsset: (asset: { id: string; name: string; sampleRate: number; channels: Float32Array[] }) => void
        addAudioClip: (trackId: string, clip: Record<string, unknown>) => void
      }
      engine: {
        unlock: () => void
        resume: () => Promise<void>
        strips: Map<string, { pan: { pan: { value: number } }; fader: { gain: { value: number } } }>
      }
    }
  }
}
