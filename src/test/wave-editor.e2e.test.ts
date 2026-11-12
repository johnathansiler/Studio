import { spawn, type ChildProcess } from 'node:child_process'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'

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

describe('wave editor', () => {
  it('opens from a double-tap on an audio clip and stays inside a narrow phone', async () => {
    const port = 4591
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await waitForServer(url, child)
      const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({
        headless: true,
        executablePath: '/usr/bin/google-chrome',
      }))
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await page.waitForFunction(() => Boolean((window as unknown as { __cueharbor?: { store?: { project?: { tracks?: unknown[] } } } }).__cueharbor?.store?.project?.tracks?.length))
        await page.waitForTimeout(600)
        const clipId = await page.evaluate(() => {
          const store = (window as unknown as {
            __cueharbor: {
              store: {
                project: { sampleRate: number; tracks: { id: string; type: string }[] }
                buffers: Map<string, { id: string; name: string; sampleRate: number; channels: Float32Array[] }>
                addAudioClip: (trackId: string, clip: Record<string, unknown>) => void
              }
            }
          }).__cueharbor.store
          const track = store.project.tracks.find((item) => item.type === 'audio')!
          const rate = store.project.sampleRate
          const length = rate * 4
          const left = new Float32Array(length)
          const right = new Float32Array(length)
          for (let index = 0; index < length; index++) {
            const beat = (index % Math.floor(rate / 2)) / (rate / 2)
            const env = Math.exp(-beat * 6)
            const tone = Math.sin(2 * Math.PI * 196 * index / rate) * env * 0.45
            left[index] = Math.max(-1, Math.min(1, tone + (beat < 0.04 ? (Math.random() - 0.5) * 0.15 : 0)))
            right[index] = left[index] * 0.72
          }
          store.buffers.set('wave_buf', { id: 'wave_buf', name: 'Take', sampleRate: rate, channels: [left, right] })
          store.addAudioClip(track.id, {
            id: 'wave_clip',
            name: 'Take',
            bufferId: 'wave_buf',
            startSample: 0,
            offsetSamples: 0,
            durationSamples: length,
            fadeInSamples: Math.round(rate * 0.03),
            fadeOutSamples: Math.round(rate * 0.08),
            gain: 0.9,
            source: 'local',
          })
          return 'wave_clip'
        })
        const clip = page.locator(`[data-clip="${clipId}"]`)
        await clip.waitFor()
        const opened = await page.evaluate(async () => {
          const el = document.querySelector('[data-clip]:not([data-midi]):not([data-pattern])') as HTMLElement | null
          if (!el) return false
          const rect = el.getBoundingClientRect()
          const x = rect.left + Math.min(36, Math.max(8, rect.width / 5))
          const y = rect.top + rect.height / 2
          const fire = (type: string) => {
            el.dispatchEvent(new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: x,
              clientY: y,
              pointerType: 'touch',
              pointerId: 1,
              isPrimary: true,
              width: 1,
              height: 1,
              pressure: 0.5,
            }))
          }
          fire('pointerdown')
          fire('pointerup')
          await new Promise((resolve) => setTimeout(resolve, 40))
          fire('pointerdown')
          fire('pointerup')
          return true
        })
        expect(opened).toBe(true)
        await page.locator('[data-editor="wave"]').waitFor({ timeout: 4000 })
        await page.setViewportSize({ width: 360, height: 740 })
        const fit = await page.locator('[data-editor="wave"]').evaluate((node) => {
          const editor = node as HTMLElement
          const tooWide = [...editor.querySelectorAll<HTMLElement>('*')].filter((child) => {
            const rect = child.getBoundingClientRect()
            return rect.width > 8 && rect.right > window.innerWidth + 1
          }).map((child) => child.getAttribute('aria-label') || child.textContent || child.className)
          return {
            scroll: editor.scrollWidth,
            client: editor.clientWidth,
            window: window.innerWidth,
            tooWide: tooWide.slice(0, 6),
          }
        })
        expect(fit.client).toBeLessThanOrEqual(360)
        expect(fit.scroll).toBeLessThanOrEqual(fit.client + 1)
        expect(fit.tooWide).toEqual([])
        await page.locator('[data-editor="wave"] .wave-done').click()
        await page.locator('[data-editor="wave"]').waitFor({ state: 'detached' })
        await page.setViewportSize({ width: 1280, height: 800 })
        await clip.dblclick()
        await page.locator('[data-editor="wave"]').waitFor()
      } finally {
        await browser.close()
      }
    } finally {
      child.kill('SIGTERM')
    }
  }, 90000)
})
