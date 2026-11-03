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
    expect(css).toContain('.mpc-keyboard')
    expect(css).toContain('min-height: 44px')
    expect(css).toContain('background-color: var(--accent)')
    expect(css).toContain('color: var(--accent-ink)')
    expect(css).toContain('text-transform: none')
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
  await page.getByRole('textbox', { name: 'Keys name' }).waitFor()
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

        await page.getByRole('textbox', { name: 'Keys name' }).click()
        await page.locator('[data-keyboard-dock="open"]').waitFor()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await noKeyboard(page)

        await page.getByRole('button', { name: 'Add track' }).click()
        await page.getByRole('button', { name: /^Drums\b/ }).click()
        await page.getByRole('button', { name: 'Add Drums track' }).click()
        await page.locator('[data-pads="plugin"]').waitFor()
        expect(await page.locator('[data-keyboard-dock="open"]').count()).toBe(0)
        await page.getByRole('button', { name: 'Close Beat Machine. The track keeps the instrument.' }).click()
        await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })

        await page.getByRole('textbox', { name: 'Beat Machine 1 name' }).click()
        await page.locator('[data-pads="plugin"]').waitFor()
        expect(await page.locator('[data-keyboard-dock="open"]').count()).toBe(0)

        const keyboard = page.locator('[data-beat-keyboard]')
        const box = await keyboard.boundingBox()
        expect(box).toBeTruthy()
        expect(box!.width).toBeGreaterThanOrEqual(40)
        expect(box!.height).toBeGreaterThanOrEqual(40)
        const paint = await keyboard.evaluate((node) => {
          const style = getComputedStyle(node)
          return { text: node.textContent, background: style.backgroundColor, color: style.color }
        })
        expect(paint.text).toBe('Keyboard')
        expect(paint.background).toBe('rgb(115, 196, 143)')
        expect(paint.color).toBe('rgb(16, 33, 23)')

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
            const node = document.querySelector('.head.is-selected .mini-meter i') as HTMLElement | null
            const match = /scaleX\(([^)]+)\)/.exec(node?.style.transform || '')
            const level = match ? Number(match[1]) : 0
            if (level > (host.__peak ?? 0)) host.__peak = level
          }, 30)
          window.setTimeout(() => window.clearInterval(timer), 2500)
        })
        await page.locator('.keyboard-dock [data-pitch="36"]').click()
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
