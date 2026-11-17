import { spawn, type ChildProcess } from 'node:child_process'
import { chromium } from 'playwright'
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

describe('collab screen removed from the studio', () => {
  it('has no Collab tab or Host / Join screen, and Ideas still opens', async () => {
    const port = 4394
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
      const labels = await page.locator('.views button').evaluateAll((nodes) => nodes.map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()))
      expect(labels).toEqual(['Menu', 'Arrange', 'Mix'])
      expect(await page.getByRole('button', { name: /^Collab/ }).count()).toBe(0)
      expect(await page.getByRole('button', { name: /Host a Collab/ }).count()).toBe(0)
      expect(await page.getByRole('button', { name: /Join a Collab/ }).count()).toBe(0)
      expect(await page.locator('[data-collab-panel="open"]').count()).toBe(0)
      await page.getByRole('button', { name: 'Ideas', exact: true }).click()
      await page.locator('[data-unstuck="open"]').waitFor()
      expect(await page.locator('.phone-tabs').isVisible()).toBe(true)
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 60000)
})
