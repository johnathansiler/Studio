import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const SHOTS = [
  { width: 390, height: 844 },
  { width: 476, height: 752 },
  { width: 880, height: 1000 },
  { width: 844, height: 390 },
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
      const response = await fetch(url)
      if (response.ok || response.status === 404) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function openSequencer(page: Page) {
  await page.waitForFunction(() => {
    const store = (window as unknown as { __cueharbor?: { store?: { project: { id: string; tracks: { name: string }[] }; stepTrackId: string | null } } }).__cueharbor?.store
    if (!store) return false
    const slot = (window as unknown as { __launchSlot?: { id: string; at: number } }).__launchSlot
    const now = Date.now()
    if (!slot || slot.id !== store.project.id) {
      ;(window as unknown as { __launchSlot?: { id: string; at: number } }).__launchSlot = { id: store.project.id, at: now }
      return false
    }
    const names = store.project.tracks.map((track) => track.name).join('|')
    return now - slot.at > 600 && names === 'Vocal|Music|Keys' && !store.stepTrackId
  })
  await page.evaluate(() => {
    const store = (window as unknown as { __cueharbor: { store: { addQuickTrack: (choice: string) => string | null; openSteps: (id: string) => void } } }).__cueharbor.store
    const id = store.addQuickTrack('steps')
    if (id) store.openSteps(id)
  })
  await page.locator('[data-step-sequencer="open"] .rack-step').first().waitFor()
}

async function shot(page: Page, name: string) {
  mkdirSync('/opt/cursor/artifacts', { recursive: true })
  await page.screenshot({ path: `/opt/cursor/artifacts/${name}.png` })
}

describe('step sequencer rack', () => {
  it('scrolls every row and step, generates a role-aware pattern, plays through the meters, and keeps the edit', async () => {
    const port = 4471
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true })
    try {
      await waitForServer(url, child)
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await openSequencer(page)

      const chrome = await page.evaluate(() => {
        const box = (selector: string) => {
          const el = document.querySelector(selector) as HTMLElement | null
          if (!el) return null
          const rect = el.getBoundingClientRect()
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height, width: rect.width }
        }
        return {
          close: box('.step-close'),
          play: box('.plugin-transport button[aria-label="Play"]'),
          stop: box('.plugin-transport button[aria-label="Stop"]'),
          record: box('.plugin-transport button[aria-label="Record"]'),
          smart: box('[data-smart-pattern]'),
        }
      })
      for (const [name, rect] of Object.entries(chrome)) {
        expect(rect, name).toBeTruthy()
        expect(rect!.height, name).toBeGreaterThanOrEqual(40)
        expect(rect!.top, name).toBeGreaterThanOrEqual(0)
        expect(rect!.bottom, name).toBeLessThanOrEqual(844 + 1)
        expect(rect!.right, name).toBeLessThanOrEqual(390 + 1)
      }

      await page.locator('.rack-lengths').getByRole('button', { name: /^32\./ }).click()
      const wide = await page.evaluate(() => {
        const scroller = document.querySelector('[data-rack-scroll]') as HTMLElement
        const steps = [...document.querySelectorAll('.rack-row[data-channel="Kick"] .rack-step')]
        const tops = new Set(steps.map((el) => Math.round(el.getBoundingClientRect().top)))
        scroller.scrollLeft = scroller.scrollWidth
        const port = scroller.getBoundingClientRect()
        const last = steps[steps.length - 1].getBoundingClientRect()
        const name = document.querySelector('.rack-row[data-channel="Kick"] .rack-name')!.getBoundingClientRect()
        return {
          count: steps.length,
          tops: tops.size,
          scrolls: scroller.scrollWidth > scroller.clientWidth + 8,
          lastIn: last.right <= port.right + 2 && last.left < port.right,
          nameIn: name.left >= port.left - 2 && name.right > port.left + 8,
          height: steps[0].getBoundingClientRect().height,
          width: steps[0].getBoundingClientRect().width,
        }
      })
      expect(wide.count).toBe(32)
      expect(wide.tops).toBe(1)
      expect(wide.scrolls).toBe(true)
      expect(wide.lastIn).toBe(true)
      expect(wide.nameIn).toBe(true)
      expect(wide.height).toBeGreaterThanOrEqual(40)
      expect(wide.width).toBeGreaterThanOrEqual(40)

      await page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { addPatternChannel: (choice: { name: string; kind: string; note: number; color: string }) => string | null } } }).__cueharbor.store
        for (let index = 0; index < 16; index += 1) {
          store.addPatternChannel({ name: `Extra ${index}`, kind: 'perc', note: 56, color: '#c58be0' })
        }
      })
      await page.locator('.rack-row[data-channel="Extra 15"]').waitFor()
      const down = await page.evaluate(() => {
        const scroller = document.querySelector('[data-rack-scroll]') as HTMLElement
        const canScroll = scroller.scrollHeight > scroller.clientHeight + 8
        scroller.scrollTop = scroller.scrollHeight
        const port = scroller.getBoundingClientRect()
        const row = document.querySelector('.rack-row[data-channel="Extra 15"]') as HTMLElement
        const box = row.getBoundingClientRect()
        const name = row.querySelector('.rack-name')!.getBoundingClientRect()
        const steps = [...row.querySelectorAll('.rack-step')]
        return {
          canScroll,
          inView: box.top < port.bottom - 4 && box.bottom > port.top + 4,
          nameIn: name.left >= port.left - 2,
          count: steps.length,
          tops: new Set(steps.map((el) => Math.round(el.getBoundingClientRect().top))).size,
        }
      })
      expect(down.canScroll).toBe(true)
      expect(down.inView).toBe(true)
      expect(down.nameIn).toBe(true)
      expect(down.count).toBe(32)
      expect(down.tops).toBe(1)

      const step = page.locator('.rack-row[data-channel="Kick"] .rack-step[data-index="1"]')
      await step.scrollIntoViewIfNeeded()
      const beforePressed = await step.getAttribute('aria-pressed')
      await page.evaluate(() => {
        const scroller = document.querySelector('[data-rack-scroll]') as HTMLElement
        const button = document.querySelector('.rack-row[data-channel="Kick"] .rack-step[data-index="1"]') as HTMLElement
        const rect = button.getBoundingClientRect()
        const downEvent = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 3, clientX: rect.left + 8, clientY: rect.top + 8 })
        button.dispatchEvent(downEvent)
        scroller.scrollLeft += 48
        const upEvent = new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 3, clientX: rect.left + 40, clientY: rect.top + 12 })
        button.dispatchEvent(upEvent)
      })
      expect(await step.getAttribute('aria-pressed')).toBe(beforePressed)

      await page.locator('.rack-lengths').getByRole('button', { name: /^16\./ }).click()
      await page.getByRole('button', { name: /Smart Pattern/ }).click()
      const masks = async () => page.evaluate(() => {
        return [...document.querySelectorAll('.rack-row[data-channel]')].map((row) => {
          const on = [...row.querySelectorAll('.rack-step')].map((el) => (el.classList.contains('on') ? '1' : '0')).join('')
          return `${row.getAttribute('data-channel')}:${on}`
        }).join('|')
      })
      const first = await masks()
      await page.getByRole('button', { name: /Smart Pattern/ }).click()
      const second = await masks()
      expect(second).not.toEqual(first)

      await page.addStyleTag({ content: '.select-hint-host{display:none !important}' })
      for (const viewport of SHOTS) {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(200)
        const fitted = await page.evaluate(() => {
          const button = (label: string) => document.querySelector(`.plugin-transport button[aria-label="${label}"]`) as HTMLButtonElement
          const visible = (el: HTMLElement) => {
            const box = el.getBoundingClientRect()
            const hidden = el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('disabled') || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none'
            return {
              ok: !hidden && box.height >= 40 && box.width >= 40 && box.top >= -1 && box.bottom <= window.innerHeight + 1 && box.left >= -1 && box.right <= window.innerWidth + 1,
              name: el.getAttribute('aria-label'),
            }
          }
          const close = document.querySelector('.step-close')!.getBoundingClientRect()
          const play = visible(button('Play'))
          const stop = visible(button('Stop'))
          const record = visible(button('Record'))
          const steps = [...document.querySelectorAll('.rack-row[data-channel="Kick"] .rack-step')]
          const tops = new Set(steps.map((el) => Math.round(el.getBoundingClientRect().top)))
          return {
            close: close.top >= 0 && close.bottom <= window.innerHeight + 1 && close.height >= 40,
            play: play.ok && play.name === 'Play',
            stop: stop.ok && stop.name === 'Stop',
            record: record.ok && record.name === 'Record',
            oneRow: tops.size === 1,
            steps: steps.length,
          }
        })
        expect(fitted.close, `${viewport.width}x${viewport.height}`).toBe(true)
        expect(fitted.play, `${viewport.width}x${viewport.height}`).toBe(true)
        expect(fitted.stop, `${viewport.width}x${viewport.height}`).toBe(true)
        expect(fitted.record, `${viewport.width}x${viewport.height}`).toBe(true)
        expect(fitted.oneRow, `${viewport.width}x${viewport.height}`).toBe(true)
        expect(fitted.steps, `${viewport.width}x${viewport.height}`).toBe(16)
        await shot(page, `sequencer-${viewport.width}x${viewport.height}`)
      }

      await page.setViewportSize({ width: 1280, height: 800 })
      const programmed = page.locator('.rack-row[data-channel="Kick"] .rack-step[data-index="1"]')
      if (await programmed.getAttribute('aria-pressed') !== 'true') await programmed.click()
      expect(await programmed.getAttribute('aria-pressed')).toBe('true')
      await page.locator('.plugin-transport').getByRole('button', { name: 'Play' }).click()
      await page.waitForFunction(() => {
        const hook = (window as unknown as {
          __cueharbor?: { engine: { levels: () => { master: number; tracks: Record<string, number> } }; store: { project: { tracks: { id: string; name: string }[] } } }
          __seqRack?: { track: number; master: number }
        })
        const live = hook.__cueharbor
        const track = live?.store.project.tracks.find((item) => item.name.startsWith('Step Sequencer'))
        if (!live || !track) return false
        const levels = live.engine.levels()
        const proof = hook.__seqRack ?? { track: 0, master: 0 }
        proof.track = Math.max(proof.track, levels.tracks[track.id] || 0)
        proof.master = Math.max(proof.master, levels.master || 0)
        hook.__seqRack = proof
        return proof.track > 0.01 && proof.master > 0.01
      }, undefined, { timeout: 12000 })

      await page.locator('.plugin-transport').getByRole('button', { name: 'Stop' }).click()
      const loaded = await page.evaluate(() => {
        const hook = (window as unknown as {
          __cueharbor: {
            engine: { ctx: AudioContext | null; levels: () => { master: number; tracks: Record<string, number> } }
            store: {
              project: { sampleRate: number; tracks: { id: string; name: string }[] }
              addAsset: (asset: { id: string; name: string; sampleRate: number; channels: Float32Array[] }) => void
              addPatternChannel: (choice: { name: string; kind: string; note: number; color: string; sampleId: string }) => string | null
              activePattern: () => { channels: { id: string; name: string; kind: string; sampleId: string | null; cells: { on: boolean }[] }[] } | null
              setChannel: (id: string, patch: { mute: boolean }) => void
              selectRackChannel: (id: string) => void
              smartRandomDrums: (seed?: number) => void
              buffers: { get: (id: string) => { channels: Float32Array[] } | undefined }
            }
          }
        }).__cueharbor
        const store = hook.store
        const rate = store.project.sampleRate
        const data = new Float32Array(Math.round(rate / 8))
        for (let index = 0; index < data.length; index += 1) data[index] = Math.sin((2 * Math.PI * 180 * index) / rate) * 0.85
        store.addAsset({ id: 'lib_loaded', name: 'Loaded Kick', sampleRate: rate, channels: [data] })
        const id = store.addPatternChannel({ name: 'Loaded Kick', kind: 'note', note: 36, color: '#ef6b6b', sampleId: 'lib_loaded' })
        const pattern = store.activePattern()
        if (!id || !pattern) return { ok: false, starts: 0, track: 0, master: 0 }
        for (const channel of pattern.channels) {
          if (channel.id !== id) store.setChannel(channel.id, { mute: true })
        }
        store.selectRackChannel(id)
        store.smartRandomDrums(4)
        const row = store.activePattern()?.channels.find((channel) => channel.id === id)
        const ctx = hook.engine.ctx
        const pageWindow = window as unknown as { __bufferStarts?: number }
        pageWindow.__bufferStarts = 0
        if (ctx) {
          const original = ctx.createBufferSource.bind(ctx)
          ctx.createBufferSource = () => {
            pageWindow.__bufferStarts = (pageWindow.__bufferStarts ?? 0) + 1
            return original()
          }
        }
        return {
          ok: true,
          sampleId: row?.sampleId ?? '',
          kind: row?.kind ?? '',
          on0: !!row?.cells[0]?.on,
          on4: !!row?.cells[4]?.on,
          buffered: (store.buffers.get('lib_loaded')?.channels[0]?.length ?? 0) > 0,
          ctx: !!ctx,
        }
      })
      expect(loaded.ok).toBe(true)
      expect(loaded.sampleId).toBe('lib_loaded')
      expect(loaded.kind).toBe('note')
      expect(loaded.on0).toBe(true)
      expect(loaded.on4).toBe(false)
      expect(loaded.buffered).toBe(true)
      expect(loaded.ctx).toBe(true)
      await page.locator('.plugin-transport').getByRole('button', { name: 'Play' }).click()
      await page.waitForFunction(() => {
        const hook = (window as unknown as {
          __cueharbor?: { engine: { levels: () => { master: number; tracks: Record<string, number> } }; store: { project: { tracks: { id: string; name: string }[] } } }
          __loadedProof?: { track: number; master: number }
        })
        const live = hook.__cueharbor
        const track = live?.store.project.tracks.find((item) => item.name.startsWith('Step Sequencer'))
        if (!live || !track) return false
        const levels = live.engine.levels()
        const proof = hook.__loadedProof ?? { track: 0, master: 0 }
        proof.track = Math.max(proof.track, levels.tracks[track.id] || 0)
        proof.master = Math.max(proof.master, levels.master || 0)
        hook.__loadedProof = proof
        return proof.track > 0.01 && proof.master > 0.01
      }, undefined, { timeout: 8000 })
      const starts = await page.evaluate(() => (window as unknown as { __bufferStarts?: number }).__bufferStarts ?? 0)
      expect(starts).toBeGreaterThan(0)

      await page.waitForTimeout(900)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await page.waitForFunction(() => {
        const store = (window as unknown as { __cueharbor?: { store?: { project?: { tracks?: { name: string; plugins: { pluginId: string; steps?: { patterns: { channels: { name: string; cells: { on: boolean }[] }[] }[] } }[] }[] } } } }).__cueharbor?.store
        return Boolean(store?.project?.tracks?.some((track) => track.name.startsWith('Step Sequencer')))
      }, undefined, { timeout: 8000 })
      const kept = await page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { project: { tracks: { name: string; plugins: { pluginId: string; steps?: { patterns: { steps: number; channels: { name: string; cells: { on: boolean }[] }[] }[] } }[] }[] } } } }).__cueharbor.store
        const track = store.project.tracks.find((item) => item.name.startsWith('Step Sequencer'))
        const pattern = track?.plugins.find((plugin) => plugin.pluginId === 'steps')?.steps?.patterns[0]
        const kick = pattern?.channels.find((channel) => channel.name === 'Kick')
        return { on: kick?.cells[1].on ?? false, steps: pattern?.steps ?? 0 }
      })
      expect(kept.on).toBe(true)
      expect(kept.steps).toBe(16)
    } finally {
      child.kill('SIGTERM')
      await browser.close()
    }
  }, 120000)
})
