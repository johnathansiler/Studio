import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { editorForGesture } from '../model/editorOpen'
import { KEYBOARD_KEY, writeKeyboardEnabled } from '../model/keyboardPlay'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { PadsPanel } from '../ui/PadsPanel'

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

describe('beat machine keyboard opening', () => {
  it('stays closed on launch, including a saved toggle and a restored selection', () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
      removeItem: (key: string) => { memory.delete(key) },
      clear() { memory.clear() },
      key: () => null,
      length: 0,
    }
    const previous = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    writeKeyboardEnabled(true)
    try {
      expect(memory.get(KEYBOARD_KEY)).toBe('on')
      const store = new ProjectStore(createEmptyProject())
      expect(store.keyboardMidi).toBe(false)
      const midi = store.project.tracks.find((track) => track.type === 'midi')!
      store.selectTrack(midi.id)
      expect(store.keyboardMidi).toBe(false)
      store.loadProject(store.project, new Map())
      store.selectTrack(midi.id)
      expect(store.keyboardMidi).toBe(false)
      expect(editorForGesture('select-track', 'midi', store.track(midi.id))).toBe('keyboard')
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous })
    }
  })

  it('opens the Beat Machine from the track, and returns to it when the keyboard closes', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    expect(store.padsTrackId).toBe(id)
    store.closePads()
    expect(editorForGesture('select-track', 'midi', store.track(id))).toBe('pads')
    store.showPads(id)
    expect(store.padsTrackId).toBe(id)
    store.showPads(id)
    expect(store.padsTrackId).toBe(id)
    store.openKeyboardForPads(id)
    expect(store.selectedTrackId).toBe(id)
    expect(store.keyboardMidi).toBe(true)
    expect(store.padsTrackId).toBeNull()
    store.setKeyboardMidi(false)
    expect(store.keyboardMidi).toBe(false)
    expect(store.padsTrackId).toBe(id)

    store.openKeyboardForPads(id)
    store.clearKeyboardReturn()
    store.setKeyboardMidi(false)
    expect(store.padsTrackId).toBeNull()

    const html = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {} }))
    expect(html).toContain('data-beat-keyboard=')
    expect(html).toContain('>Keyboard<')
    expect(html).toContain('mpc-keyboard')
    const css = readFileSync(new URL('../ui/pads.css', import.meta.url), 'utf8')
    const rule = css.slice(css.indexOf('.mpc-keyboard,'), css.indexOf('.mpc-pad-tools'))
    expect(rule).toContain('.mpc-keyboard')
    expect(rule).toContain('height: 40px')
    expect(rule).toContain('width: auto')
    expect(rule).toContain('border-radius: 999px')
    expect(rule).toContain('background-color: #3a3a3a')
    expect(rule).not.toContain('var(--accent)')
    expect(rule).toContain('text-transform: none')
  })
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

async function noKeyboard(page: Page) {
  await page.locator('[data-track-name="Keys"]').waitFor()
  await page.waitForTimeout(400)
  expect(await page.locator('[data-keyboard-dock="open"]').count()).toBe(0)
}

describe('beat machine keyboard in the app', () => {
  it('loads closed, opens pads from the track, and plays a pad through the mixer', async () => {
    const port = 4197
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true })
    try {
      await waitForServer(url, child)
      for (const viewport of [
        { width: 390, height: 844, phone: true },
        { width: 1280, height: 800, phone: false },
      ]) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
        await context.addInitScript(() => {
          localStorage.setItem('cueharbor-keyboard', 'on')
        })
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await noKeyboard(page)

        await page.locator('[data-track-name="Keys"] .track-meter-row').click()
        await page.locator('[data-keyboard-dock="open"]').waitFor()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await noKeyboard(page)

        await page.getByRole('button', { name: 'Add Track' }).click()
        await page.getByRole('button', { name: /Beat Machine\. Pads/ }).click()
        await page.locator('[data-pads="plugin"]').waitFor()
        expect(await page.locator('[data-keyboard-dock="open"]').count()).toBe(0)
        await page.getByRole('button', { name: 'Close Beat Machine. The track keeps the instrument.' }).click()
        await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })

        await page.locator('[data-track-name="Beat Machine 1"] .track-meter-row').click()
        await page.locator('[data-pads="plugin"]').waitFor()
        expect(await page.locator('[data-keyboard-dock="open"]').count()).toBe(0)

        const keyboard = page.locator('[data-beat-keyboard]')
        const box = await keyboard.boundingBox()
        expect(box).toBeTruthy()
        expect(box!.width).toBeGreaterThanOrEqual(40)
        expect(box!.width).toBeLessThan(160)
        expect(Math.round(box!.height)).toBe(40)
        const paint = await keyboard.evaluate((node) => {
          const style = getComputedStyle(node)
          return { text: node.textContent, background: style.backgroundColor, color: style.color }
        })
        expect(paint.text).toBe('Keyboard')
        expect(paint.background).toBe('rgb(20, 28, 24)')
        expect(paint.color).toBe('rgb(197, 210, 201)')

        await keyboard.click()
        await page.locator('[data-keyboard-dock="open"]').waitFor()
        await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })
        if (viewport.phone) {
          await page.waitForFunction(() => {
            const shell = document.querySelector('.shell')
            return shell?.classList.contains('keys-landscape') || document.fullscreenElement != null
          })
        } else {
          expect(await page.locator('.shell.keys-landscape').count()).toBe(0)
        }

        await page.evaluate(() => {
          const host = window as unknown as { __peak?: number }
          host.__peak = 0
          const timer = window.setInterval(() => {
            const head = document.querySelector('.head.is-selected')
            const id = head?.getAttribute('data-track') || ''
            const node = head?.querySelector('.mini-meter i') as HTMLElement | null
            const match = /scaleX\(([^)]+)\)/.exec(node?.style.transform || '')
            const shown = match ? Number(match[1]) : 0
            const raw = id ? ((window as unknown as { __cueharbor?: { engine: { levels: () => { tracks: Record<string, number> } } } }).__cueharbor?.engine.levels().tracks[id] ?? 0) : 0
            const level = Math.max(shown, Math.min(1, raw * 3.2))
            if (level > (host.__peak ?? 0)) host.__peak = level
          }, 16)
          window.setTimeout(() => window.clearInterval(timer), 15000)
        })
        await page.locator('.keyboard-dock [data-pitch="36"]').click({ delay: 250 })
        await page.waitForFunction(() => ((window as unknown as { __peak?: number }).__peak ?? 0) > 0.02)

        await page.locator('.keyboard-close').click()
        await page.locator('[data-keyboard-dock="open"]').waitFor({ state: 'detached' })
        await page.locator('[data-pads="plugin"]').waitFor()
        await context.close()
      }
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 120000)
})
