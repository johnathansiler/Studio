import { spawn, type ChildProcess } from 'node:child_process'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const port = 4377
const url = `http://127.0.0.1:${port}`

async function waitForServer(child: ChildProcess) {
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

describe('a blocked view chunk', () => {
  let child: ChildProcess
  beforeAll(async () => {
    child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(child)
  }, 30000)
  afterAll(() => { child?.kill('SIGTERM') })

  it('shows Retry without blanking the app, then recovers', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    let block = true
    await page.route('**/*MixerView*', (route) => {
      if (block) void route.abort('failed')
      else void route.continue()
    })
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await page.getByRole('button', { name: /^Mix/ }).first().click()
      const retry = page.getByRole('button', { name: 'Retry' })
      await retry.waitFor()
      const alive = await page.evaluate(() => ({
        children: document.querySelector('#root')?.childElementCount ?? 0,
        arrangeTab: !!document.querySelector('.views'),
        text: document.body.innerText.includes("Couldn't load"),
      }))
      expect(alive.children).toBeGreaterThan(0)
      expect(alive.arrangeTab).toBe(true)
      expect(alive.text).toBe(true)
      block = false
      await retry.click({ force: true })
      await page.locator('.mixer-console').waitFor()
    } finally {
      await browser.close()
    }
  }, 60000)
})
