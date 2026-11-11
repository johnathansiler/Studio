import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const PHONES = [
  { width: 390, height: 844, label: '390x844' },
  { width: 476, height: 752, label: '476x752' },
  { width: 844, height: 390, label: '844x390' },
]

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      if ((await fetch(url)).ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

function ignore(line: string) {
  return /favicon|Download the React DevTools|\[vite\]|was not used in the bundle|onnxruntime|huggingface|net::ERR_|Failed to load resource/i.test(line)
}

function watch(page: Page) {
  const errors: string[] = []
  const warnings: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    const text = message.text()
    if (ignore(text)) return
    if (message.type() === 'error') errors.push(text)
    else if (message.type() === 'warning') warnings.push(text)
  })
  return { errors, warnings }
}

async function screen(page: Page, name: RegExp) {
  const button = page.getByRole('button', { name }).first()
  if (await button.count()) await button.click()
}

describe('stability across phone viewports', () => {
  it('loads every main screen without console errors and survives transport spam', async () => {
    const port = 4477
    const url = `http://127.0.0.1:${port}`
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser: Browser = await chromium.launch({ headless: true })
    const problems: string[] = []
    try {
      await waitForServer(url, web)
      for (const viewport of PHONES) {
        const page = await browser.newPage({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: true,
          isMobile: true,
          deviceScaleFactor: 1,
        })
        const seen = watch(page)
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor({ timeout: 20000 })
        await screen(page, /^Mix/)
        await screen(page, /^Collab/)
        await screen(page, /^Arrange/)
        const dock = await page.evaluate(() => {
          const tabs = ['menu', 'browse', 'tools'].map((id) => {
            const node = document.querySelector(`[data-phone-tab="${id}"]`)
            const box = node?.getBoundingClientRect()
            return {
              id,
              width: box?.width ?? 0,
              height: box?.height ?? 0,
              visible: !!node && (box?.width ?? 0) > 0 && (box?.height ?? 0) > 0,
            }
          })
          return {
            tabs,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }
        })
        for (const tab of dock.tabs) {
          expect(tab.visible, `${viewport.label} ${tab.id}`).toBe(true)
          expect(tab.height, `${viewport.label} ${tab.id}`).toBeGreaterThanOrEqual(40)
          expect(tab.width, `${viewport.label} ${tab.id}`).toBeGreaterThanOrEqual(40)
        }
        expect(dock.overflow, viewport.label).toBeLessThanOrEqual(1)
        const spam = await page.evaluate(async () => {
          const hook = (window as unknown as {
            __cueharbor?: {
              engine: {
                play: (sample: number) => Promise<void>
                stop: () => void
                seek: (sample: number) => void
                status: string
                positionSamples: number
                stability?: () => { sources: number; playing: boolean }
              }
            }
          }).__cueharbor
          if (!hook) return { ok: false, reason: 'no engine' }
          const engine = hook.engine
          try {
            for (let i = 0; i < 12; i++) {
              const pending = engine.play(i * 1000)
              engine.seek((i + 1) * 1500)
              engine.stop()
              await pending
            }
            await engine.play(0)
            for (let tempo = 0; tempo < 6; tempo++) engine.seek(tempo * 4000)
            await new Promise((resolve) => setTimeout(resolve, 80))
            engine.stop()
            const load = engine.stability?.()
            return { ok: true, status: engine.status, sources: load?.sources ?? -1, playing: load?.playing ?? engine.status !== 'stopped' }
          } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) }
          }
        })
        expect(spam.ok, `${viewport.label} ${spam.reason ?? ''}`).toBe(true)
        expect(spam.status).toBe('stopped')
        expect(spam.playing).toBe(false)
        problems.push(...seen.errors.map((line) => `${viewport.label}: ${line}`))
        await page.close()
      }
      expect(problems).toEqual([])
    } finally {
      await browser.close()
      web.kill('SIGTERM')
    }
  }, 90000)
})
