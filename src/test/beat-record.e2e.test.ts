import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 25000) {
    if (child.exitCode != null) throw new Error(detail || 'process exited')
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 404) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'server did not start')
}

async function stopVisible(page: Page) {
  const box = await page.evaluate(() => {
    const button = document.querySelector('[data-plugin-transport="open"] [aria-label="Stop"]') as HTMLElement | null
    if (!button) return null
    const rect = button.getBoundingClientRect()
    const style = getComputedStyle(button)
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const hit = document.elementFromPoint(cx, cy) as HTMLElement | null
    return {
      y: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      width: rect.width,
      hidden: button.closest('[hidden]') != null || style.display === 'none' || style.visibility === 'hidden',
      pressed: document.querySelector('[data-plugin-transport="open"] [aria-label="Record"]')?.getAttribute('aria-pressed'),
      hit: hit === button || !!hit?.closest('[aria-label="Stop"]'),
    }
  })
  expect(box).toBeTruthy()
  expect(box!.hidden).toBe(false)
  expect(box!.height).toBeGreaterThanOrEqual(40)
  expect(box!.width).toBeGreaterThanOrEqual(40)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.bottom).toBeLessThanOrEqual(845)
  expect(box!.hit).toBe(true)
  expect(box!.pressed).toBe('true')
}

describe('beat machine record on a phone', () => {
  it('plays pads, keeps Stop on every view, and writes a MIDI clip', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4400 + Math.floor(Math.random() * 300)
    const url = `http://127.0.0.1:${port}`
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true })
    try {
      await waitForServer(url, web)
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await page.getByRole('button', { name: 'Add Track' }).click()
      await page.getByRole('button', { name: /Beat Machine\. Pads/ }).click()
      await page.locator('[data-pads="plugin"]').waitFor()
      await page.getByRole('button', { name: /Close Beat Machine/ }).click()
      await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })
      await page.locator('[data-beat-machine]').first().click()
      await page.locator('[data-pads="plugin"]').waitFor()

      await page.locator('[data-plugin-transport="open"] [aria-label="Record"]').click()
      await page.waitForFunction(() => {
        const engine = (window as unknown as { __cueharbor?: { engine: { status: string } } }).__cueharbor?.engine
        return engine?.status === 'recording' || engine?.status === 'counting-in'
      })
      const pads = page.locator('.mpc-pad')
      await pads.nth(0).tap()
      await pads.nth(1).tap()
      await page.waitForFunction(() => {
        const engine = (window as unknown as {
          __cueharbor?: { engine: { heardPads: unknown[]; ctx: { state: string } | null } }
        }).__cueharbor?.engine
        return !!engine && engine.heardPads.length >= 2 && engine.ctx?.state === 'running'
      })
      await page.screenshot({ path: '/opt/cursor/artifacts/beat-record-390x844.png' })
      await stopVisible(page)

      await page.locator('[data-plugin-tab="sound"]').click()
      await stopVisible(page)
      await page.locator('[data-plugin-tab="pattern"]').click()
      await stopVisible(page)
      await page.locator('[data-plugin-tab="pads"]').click()
      await page.getByRole('button', { name: 'Keyboard' }).click()
      await page.locator('[data-keyboard-dock="open"]').waitFor()
      await stopVisible(page)
      await page.screenshot({ path: '/opt/cursor/artifacts/beat-record-keyboard-390x844.png' })
      await page.waitForFunction(() => (window as unknown as { __cueharbor?: { engine: { status: string } } }).__cueharbor?.engine.status === 'recording')
      await new Promise((resolve) => setTimeout(resolve, 1600))

      await page.locator('[data-plugin-transport="open"] [aria-label="Stop"]').click()
      await page.waitForFunction(() => {
        const hook = (window as unknown as {
          __cueharbor?: { engine: { status: string }; store: { padRecord: unknown } }
        }).__cueharbor
        return hook?.engine.status === 'stopped' && !hook.store.padRecord
      })
      await page.locator('.keyboard-close').click()
      await page.getByRole('button', { name: /Close Beat Machine/ }).click()
      await page.locator('[data-pads="plugin"]').waitFor({ state: 'detached' })

      const clip = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor?: { store: { project: { tracks: { name: string; instrument?: string; midiClips: { name: string; notes: { pitch: number }[] }[] }[] } } }
        }).__cueharbor?.store
        const track = store?.project.tracks.find((item) => item.instrument === 'pads')
        const take = track?.midiClips.find((item) => item.notes.length)
        return {
          name: track?.name ?? '',
          pitches: take?.notes.map((note) => note.pitch) ?? [],
          clips: track?.midiClips.length ?? 0,
        }
      })
      expect(clip.pitches.length).toBeGreaterThanOrEqual(2)
      expect(clip.pitches).toEqual(expect.arrayContaining([36, 38]))
      await page.screenshot({ path: '/opt/cursor/artifacts/beat-clip-390x844.png' })
      await page.close()
    } finally {
      web.kill('SIGTERM')
      await browser.close()
    }
  }, 90000)
})
