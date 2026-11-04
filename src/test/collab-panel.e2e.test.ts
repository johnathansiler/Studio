import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
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

async function openCollab(page: Page) {
  await page.getByRole('button', { name: /Arrange/ }).first().waitFor()
  const first = (await page.locator('.views button').first().innerText()).replace(/\s+/g, ' ').trim()
  expect(first.startsWith('Collab')).toBe(true)
  await page.getByRole('button', { name: /^Collab/ }).click()
  await page.locator('[data-collab-panel="open"]').waitFor()
}

describe('collab session panel', () => {
  it('puts Collab first, hides advanced controls, and auto-joins a copied link', async () => {
    const port = 4193
    const url = `http://127.0.0.1:${port}`
    const signal = spawn('npx', ['tsx', 'server/index.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '8787', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let browser: Browser | null = null
    try {
      await Promise.all([waitForServer('http://127.0.0.1:8787/api/usage', signal), waitForServer(url, web)])
      browser = await chromium.launch({
        headless: true,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
      })
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 1280, height: 800 },
      ]) {
        const context = await browser.newContext({ viewport })
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await openCollab(page)
        const pane = page.locator('[data-collab-panel="open"]')
        await pane.getByRole('button', { name: /^Mic/ }).first().waitFor()
        await pane.getByRole('button', { name: /^Cam/ }).first().waitFor()
        const copy = pane.getByRole('button', { name: 'Copy Link' })
        await copy.waitFor()
        const box = await copy.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(40)
        await pane.getByRole('button', { name: 'Leave', exact: true }).waitFor()
        await pane.locator('[data-tab="people"]').waitFor()
        await pane.locator('[data-tab="chat"]').waitFor()
        await pane.locator('[data-tab="versions"]').waitFor()
        for (const name of ['Hear myself', 'Fix delay', 'Opus', 'Ping', 'Jam', 'Calibrate']) {
          expect(await pane.getByRole('button', { name, exact: true }).count()).toBe(0)
        }
        expect(await pane.getByRole('combobox', { name: 'Camera' }).count()).toBe(0)
        expect(await pane.locator('.settings-stats').count()).toBe(0)
        await page.getByRole('button', { name: /Call setup/ }).click()
        await pane.getByRole('button', { name: 'Hear myself', exact: true }).waitFor()
        await pane.getByRole('button', { name: 'Fix delay', exact: true }).waitFor()
        await pane.getByText('Sends your sound into the session.').waitFor()
        await pane.getByText('Play the click near your mic so recordings line up.').waitFor()
        await pane.getByRole('combobox', { name: 'Camera' }).waitFor()
        await pane.getByRole('combobox', { name: 'Mic' }).waitFor()
        await pane.getByRole('combobox', { name: 'Output' }).waitFor()
        for (const name of ['Opus', 'Ping', 'Jam', 'Calibrate', 'Play together', 'Check connection']) {
          expect(await pane.getByRole('button', { name, exact: true }).count()).toBe(0)
        }
        await context.close()
      }

      const hostContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        permissions: ['clipboard-read', 'clipboard-write', 'microphone', 'camera'],
      })
      await hostContext.addInitScript(() => localStorage.setItem('cueharbor-name', 'Host Harper'))
      const host = await hostContext.newPage()
      await host.goto(url, { waitUntil: 'domcontentloaded' })
      await openCollab(host)
      await host.getByRole('button', { name: 'Copy Link' }).click()
      await host.getByText('Link copied').waitFor({ timeout: 15000 })
      const link = await host.evaluate(() => navigator.clipboard.readText())
      expect(link).toMatch(/session=[A-Z0-9]+/)

      const guestContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        permissions: ['microphone', 'camera'],
      })
      await guestContext.addInitScript(() => localStorage.setItem('cueharbor-name', 'Guest Riley'))
      const guest = await guestContext.newPage()
      await guest.goto(link, { waitUntil: 'domcontentloaded' })
      await guest.locator('[data-collab-panel="open"]').waitFor()
      await guest.locator('.panel').getByText('Host Harper · Host').waitFor({ timeout: 15000 })
      await host.locator('.panel').getByText('Guest Riley', { exact: true }).waitFor({ timeout: 15000 })
      expect(await guest.locator('#join-session').count()).toBe(0)
      await hostContext.close()
      await guestContext.close()
    } finally {
      await browser?.close()
      for (const child of [signal, web]) {
        if (!child.pid) continue
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
      }
    }
  }, 120000)
})
