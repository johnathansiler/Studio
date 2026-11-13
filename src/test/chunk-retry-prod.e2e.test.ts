import { spawn, type ChildProcess } from 'node:child_process'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const port = 4391
const url = `http://127.0.0.1:${port}`

function run(command: string, args: string[]) {
  const child = spawn(command, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  return { child, text: () => detail }
}

async function waitForServer(child: ChildProcess, text: () => string) {
  const started = Date.now()
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(text() || 'preview exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(text() || 'preview did not start')
}

describe('production retry after a swallowed preload', () => {
  let preview: ChildProcess
  beforeAll(async () => {
    const built = run('npx', ['vite', 'build'])
    const code = await new Promise<number | null>((resolve) => built.child.on('exit', resolve))
    if (code !== 0) throw new Error(built.text() || 'vite build failed')
    const started = run('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'])
    preview = started.child
    await waitForServer(preview, started.text)
  }, 120000)
  afterAll(() => { preview?.kill('SIGTERM') })

  it('reloads nothing, then Retry fetches the Mix chunk again', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.addInitScript(() => {
      sessionStorage.setItem('cueharbor-chunk-reload', '1')
    })
    let block = true
    const hits: string[] = []
    await page.route('**/*MixerView*', async (route) => {
      const requestUrl = route.request().url()
      if (!requestUrl.includes('.js')) {
        await route.continue()
        return
      }
      hits.push(requestUrl)
      if (block) await route.abort('failed')
      else await route.continue()
    })
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      expect(await page.evaluate(() => sessionStorage.getItem('cueharbor-chunk-reload'))).toBe('1')
      await page.getByRole('button', { name: /^Mix/ }).first().click()
      const retry = page.getByRole('button', { name: 'Retry' })
      await retry.waitFor()
      const alive = await page.evaluate(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0)
      expect(alive).toBe(true)
      const before = hits.length
      expect(before).toBeGreaterThan(0)
      block = false
      await retry.click({ force: true })
      await page.locator('.mixer-console').waitFor()
      expect(hits.length).toBeGreaterThan(before)
      expect(hits.some((hit) => hit.includes('cueharbor-retry'))).toBe(true)
      expect(await page.evaluate(() => location.href)).toBe(`${url}/`)
    } finally {
      await browser.close()
    }
  }, 60000)
})
