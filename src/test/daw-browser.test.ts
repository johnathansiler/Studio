import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser } from 'playwright'
import { describe, expect, it } from 'vitest'

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

async function boot() {
  const port = 4173 + Math.floor(Math.random() * 400)
  const url = `http://127.0.0.1:${port}`
  const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForServer(url, child)
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.goto(url)
  await page.locator('[data-track]').first().waitFor({ timeout: 15000 })
  await page.locator('body').click()
  return { child, browser, page, url }
}

function stop(child: ChildProcess, browser: Browser | null) {
  child.kill('SIGTERM')
  void browser?.close()
}

describe('live signal in the browser', () => {
  it('routes a live note through the selected track and the master fader', async () => {
    const { child, browser, page } = await boot()
    try {
      const heard = await page.evaluate(async () => {
        const hook = (window as unknown as {
          __cueharbor?: {
            engine: {
              resume: () => Promise<unknown>
              playThrough: (id: string, pitch: number, velocity: number) => void
              releaseThrough: (id: string, pitch: number) => void
              levels: () => { master: number; tracks: Record<string, number> }
              followTrack: (id: string | null) => void
            }
            store: {
              project: { tracks: { id: string; type: string; name: string }[] }
              selectTrack: (id: string) => void
              updateTrack: (id: string, patch: { mute?: boolean; volume?: number; solo?: boolean }) => void
              setMasterVolume: (value: number) => void
              setTrackInstrument: (id: string, instrument: string) => void
            }
          }
        }).__cueharbor
        if (!hook) return { error: 'missing engine' }
        const midi = hook.store.project.tracks.find((track) => track.type === 'midi')
        if (!midi) return { error: 'missing midi track' }
        hook.store.selectTrack(midi.id)
        await hook.engine.resume()
        hook.engine.followTrack(midi.id)
        const read = async () => {
          hook.engine.playThrough(midi.id, 60, 0.95)
          let track = 0
          let master = 0
          for (let i = 0; i < 12; i++) {
            await new Promise((resolve) => setTimeout(resolve, 40))
            const levels = hook.engine.levels()
            track = Math.max(track, levels.tracks[midi.id] || 0)
            master = Math.max(master, levels.master || 0)
          }
          hook.engine.releaseThrough(midi.id, 60)
          return { track, master }
        }
        const open = await read()
        hook.store.updateTrack(midi.id, { mute: true })
        const muted = await read()
        hook.store.updateTrack(midi.id, { mute: false, volume: 1 })
        hook.store.setMasterVolume(0)
        const masterDown = await read()
        hook.store.setMasterVolume(0.9)
        hook.store.updateTrack(midi.id, { volume: 0.05 })
        const quiet = await read()
        return { id: midi.id, open, muted, masterDown, quiet }
      })
      expect(heard).not.toHaveProperty('error')
      const result = heard as {
        open: { track: number; master: number }
        muted: { track: number; master: number }
        masterDown: { track: number; master: number }
        quiet: { track: number; master: number }
      }
      expect(result.open.track).toBeGreaterThan(0.01)
      expect(result.open.master).toBeGreaterThan(0.01)
      expect(result.muted.master).toBeLessThan(result.open.master * 0.25)
      expect(result.masterDown.master).toBeLessThan(result.open.master * 0.25)
      expect(result.quiet.master).toBeLessThan(result.open.master * 0.7)
    } finally {
      stop(child, browser)
    }
  }, 40000)

  it('latches Note Repeat and steps the rate while it stays on', async () => {
    const { child, browser, page } = await boot()
    try {
      await page.evaluate(() => {
        const hook = (window as unknown as {
          __cueharbor?: {
            store: {
              project: { tracks: { id: string; type: string }[] }
              selectTrack: (id: string) => void
              setTrackInstrument: (id: string, instrument: string) => void
              openPads: (id: string) => void
            }
          }
        }).__cueharbor
        const midi = hook?.store.project.tracks.find((track) => track.type === 'midi')
        if (!midi || !hook) return
        hook.store.selectTrack(midi.id)
        hook.store.setTrackInstrument(midi.id, 'pads')
      })
      const hold = page.locator('.note-repeat-hold')
      const next = page.getByRole('button', { name: 'Next rate' })
      const previous = page.getByRole('button', { name: 'Previous rate' })
      await hold.waitFor()
      const box = await hold.boundingBox()
      const nextBox = await next.boundingBox()
      expect(box && box.width).toBeGreaterThanOrEqual(40)
      expect(box && box.height).toBeGreaterThanOrEqual(40)
      expect(nextBox && nextBox.width).toBeGreaterThanOrEqual(40)
      expect(nextBox && nextBox.height).toBeGreaterThanOrEqual(40)
      const rateText = async () => (await page.locator('.note-repeat-rate strong').innerText()).trim()
      expect(await rateText()).toBe('1/16')
      await hold.click()
      expect(await hold.getAttribute('aria-pressed')).toBe('true')
      const pad = page.locator('.mpc-pad').first()
      await pad.dispatchEvent('pointerdown', { pointerId: 8, pointerType: 'touch', isPrimary: false })
      await next.dispatchEvent('pointerdown', { pointerId: 9, pointerType: 'touch', isPrimary: false })
      await next.dispatchEvent('pointerup', { pointerId: 9, pointerType: 'touch' })
      expect(await rateText()).toBe('1/16T')
      expect(await hold.getAttribute('aria-pressed')).toBe('true')
      await previous.dispatchEvent('pointerdown', { pointerId: 10, pointerType: 'touch', isPrimary: false })
      await previous.dispatchEvent('pointerup', { pointerId: 10, pointerType: 'touch' })
      expect(await rateText()).toBe('1/16')
      expect(await hold.getAttribute('aria-pressed')).toBe('true')
      await hold.click()
      expect(await hold.getAttribute('aria-pressed')).toBe('false')
      await pad.dispatchEvent('pointerup', { pointerId: 8, pointerType: 'touch' })
    } finally {
      stop(child, browser)
    }
  }, 40000)
})
