import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
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

async function expectCollabFills(page: Page) {
  const box = await page.evaluate(() => {
    const shell = document.querySelector('.shell')!.getBoundingClientRect()
    const pane = document.querySelector('[data-collab-panel="open"]')!.getBoundingClientRect()
    const header = document.querySelector('header.topbar')!.getBoundingClientRect()
    const lower = document.querySelector('.collab-lower')
    const lowerBox = lower?.getBoundingClientRect()
    const panel = document.querySelector('.collab-lower .panel, .collab-lower .version-panel')
    const panelBox = panel?.getBoundingClientRect()
    return {
      transport: document.querySelectorAll('.transport').length,
      paneTop: pane.top,
      headerBottom: header.bottom,
      paneBottom: pane.bottom,
      shellBottom: shell.bottom,
      paneWidth: pane.width,
      shellWidth: shell.width,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      lowerBottom: lowerBox?.bottom ?? null,
      panelBottom: panelBox?.bottom ?? null,
    }
  })
  expect(box.transport).toBe(0)
  expect(box.paneTop).toBeLessThanOrEqual(box.headerBottom + 2)
  expect(box.shellBottom - box.paneBottom).toBeLessThan(8)
  expect(Math.abs(box.shellWidth - box.paneWidth)).toBeLessThan(8)
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1)
  if (box.lowerBottom != null && box.panelBottom != null) {
    expect(box.lowerBottom - box.panelBottom).toBeLessThan(8)
  }
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
      mkdirSync('/opt/cursor/artifacts', { recursive: true })
      const stale = await browser.newContext({ viewport: { width: 390, height: 844 } })
      await stale.addInitScript(() => {
        const identity = {
          participantId: 'old-person',
          name: 'Old Host',
          role: 'host',
          code: 'ZZ99ZZ',
          camOn: true,
          micId: '',
          outId: '',
          musicOn: true,
          jamEnabled: false,
          jamDelayMs: 40,
          monitorMode: 'opus',
          transportMode: 'arrangement',
        }
        localStorage.setItem('cueharbor-identity', JSON.stringify(identity))
        sessionStorage.setItem('cueharbor-identity', JSON.stringify(identity))
        sessionStorage.setItem('cueharbor-resume:ZZ99ZZ', 'old-person')
      })
      const stalePage = await stale.newPage()
      stalePage.on('dialog', () => { throw new Error('plain load opened a dialog') })
      await stalePage.goto(url, { waitUntil: 'domcontentloaded' })
      await openCollab(stalePage)
      await stalePage.getByRole('button', { name: /Host a Collab/ }).waitFor()
      await stalePage.getByRole('button', { name: /Join a Collab/ }).waitFor()
      expect(await stalePage.getByRole('button', { name: /^Mic/ }).count()).toBe(0)
      expect(await stalePage.locator('[data-collab-phase="room"]').count()).toBe(0)
      expect(await stalePage.getByText('ZZ99ZZ').count()).toBe(0)
      expect(await stalePage.getByText(/Could not rejoin|Reconnecting/).count()).toBe(0)
      await stale.close()

      for (const viewport of [
        { width: 390, height: 844 },
        { width: 412, height: 915 },
        { width: 1280, height: 800 },
      ]) {
        const context = await browser.newContext({ viewport })
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await openCollab(page)
        const pane = page.locator('[data-collab-panel="open"]')
        await pane.getByRole('button', { name: /Host a Collab/ }).waitFor()
        await pane.getByRole('button', { name: /Join a Collab/ }).waitFor()
        const hostButton = await pane.getByRole('button', { name: /Host a Collab/ }).boundingBox()
        expect(hostButton?.height).toBeGreaterThanOrEqual(40)
        expect(await pane.getByRole('button', { name: /^Mic/ }).count()).toBe(0)
        expect(await pane.getByRole('button', { name: 'Copy Link' }).count()).toBe(0)
        expect(await pane.getByRole('button', { name: 'Leave', exact: true }).count()).toBe(0)
        expect(await pane.getByRole('button', { name: /^Hide/ }).count()).toBe(0)
        expect(await pane.locator('[data-tab]').count()).toBe(0)
        expect(await page.locator('.transport').count()).toBe(0)
        await expectCollabFills(page)
        if (viewport.width < 500) {
          await page.screenshot({ path: `/opt/cursor/artifacts/collab_start_${viewport.width}x${viewport.height}.png` })
        }
        await pane.getByRole('button', { name: /Host a Collab/ }).click()
        await pane.locator('[data-collab-phase="room"]').waitFor()
        await pane.getByRole('button', { name: /^Mic/ }).first().waitFor()
        await pane.getByRole('button', { name: /^Cam/ }).first().waitFor()
        const copy = pane.getByRole('button', { name: 'Copy Link' })
        await copy.waitFor()
        const box = await copy.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(40)
        await pane.getByRole('button', { name: 'Leave', exact: true }).waitFor()
        await pane.getByText(/Connection: (Good|OK|Poor)\./).first().waitFor()
        const pills = pane.locator('.call-pills button')
        expect(await pills.count()).toBe(5)
        const pillBoxes: Array<{ x: number; y: number; width: number; height: number } | null> = []
        for (let index = 0; index < 5; index += 1) pillBoxes.push(await pills.nth(index).boundingBox())
        const pillTops = pillBoxes.map((box) => Math.round(box?.y || 0))
        expect(Math.max(...pillTops) - Math.min(...pillTops)).toBeLessThan(2)
        for (const pill of pillBoxes) {
          expect(pill?.height).toBeGreaterThanOrEqual(40)
          expect(pill?.height).toBeLessThan(42)
          expect(pill?.width).toBeGreaterThanOrEqual(40)
        }
        if (viewport.width <= 520) {
          const row = await pane.locator('.call-pills').boundingBox()
          const last = pillBoxes[pillBoxes.length - 1]
          expect((row?.y || 0) + (row?.height || 0)).toBeLessThan((pillBoxes[0]?.y || 0) + 56)
          expect((last?.x || 0) + (last?.width || 0)).toBeLessThanOrEqual(viewport.width + 1)
        }
        await pane.getByRole('button', { name: 'People', exact: true }).waitFor()
        await pane.getByRole('button', { name: 'Chat', exact: true }).waitFor()
        await pane.getByRole('button', { name: 'Versions', exact: true }).waitFor()
        await expectCollabFills(page)
        const peopleBox = await pane.locator('.collab-lower .people-panel').boundingBox()
        expect(peopleBox?.height).toBeGreaterThan(80)
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
        const setupClose = pane.locator('[data-screen-overlay] .overlay-close')
        if (await setupClose.count()) await setupClose.first().click()
        await pane.getByRole('button', { name: 'Leave', exact: true }).click()
        await pane.getByRole('button', { name: /Host a Collab/ }).waitFor()
        await pane.getByRole('button', { name: /Join a Collab/ }).waitFor()
        expect(await pane.getByRole('button', { name: /^Mic/ }).count()).toBe(0)
        expect(await pane.locator('[data-tab]').count()).toBe(0)
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
      await host.getByRole('button', { name: /Host a Collab/ }).click()
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
      guest.on('dialog', () => { throw new Error('invite link opened a dialog') })
      await guest.goto(link, { waitUntil: 'domcontentloaded' })
      await guest.locator('[data-collab-panel="open"]').waitFor()
      await guest.locator('.panel').getByText('Host Harper · Host').waitFor({ timeout: 15000 })
      await host.locator('.panel').getByText('Guest Riley', { exact: true }).waitFor({ timeout: 15000 })
      await guest.locator('.session-head .connection-detail').waitFor()
      const detail = await guest.locator('.person .connection-detail').first().innerText()
      expect(detail).toMatch(/Connection: (Good|OK|Poor)\./)
      expect(await guest.locator('.collab-split').count()).toBe(0)
      expect(await host.locator('.collab-split .panel').count()).toBe(2)
      expect(await guest.locator('#join-session').count()).toBe(0)
      expect(await guest.getByRole('button', { name: /Join a Collab/ }).count()).toBe(0)
      expect(await guest.getByRole('dialog').count()).toBe(0)
      await guest.waitForFunction(() => !/[?&](session|invite|role)=/.test(location.search))
      expect(guest.url()).not.toMatch(/[?&](session|invite|role)=/)
      await expectCollabFills(guest)
      await guest.screenshot({ path: '/opt/cursor/artifacts/collab_joined_390x844.png' })

      const wideGuestContext = await browser.newContext({
        viewport: { width: 412, height: 915 },
        permissions: ['microphone', 'camera'],
      })
      await wideGuestContext.addInitScript(() => localStorage.setItem('cueharbor-name', 'Guest Quinn'))
      const wideGuest = await wideGuestContext.newPage()
      wideGuest.on('dialog', () => { throw new Error('invite link opened a dialog') })
      await wideGuest.goto(link, { waitUntil: 'domcontentloaded' })
      await wideGuest.locator('.panel').getByText('Host Harper · Host').waitFor({ timeout: 15000 })
      await wideGuest.waitForFunction(() => !/[?&](session|invite|role)=/.test(location.search))
      expect(wideGuest.url()).not.toMatch(/[?&](session|invite|role)=/)
      await expectCollabFills(wideGuest)
      await wideGuest.screenshot({ path: '/opt/cursor/artifacts/collab_joined_412x915.png' })

      await guest.reload({ waitUntil: 'domcontentloaded' })
      await guest.getByRole('button', { name: /Host a Collab/ }).waitFor()
      await guest.getByRole('button', { name: /Join a Collab/ }).waitFor()
      expect(await guest.getByRole('button', { name: /^Mic/ }).count()).toBe(0)
      expect(guest.url()).not.toMatch(/[?&]session=/)

      await host.getByRole('button', { name: 'Leave', exact: true }).click()
      await host.getByRole('button', { name: /Host a Collab/ }).waitFor()
      await host.getByRole('button', { name: /Join a Collab/ }).waitFor()
      expect(await host.getByRole('button', { name: /^Mic/ }).count()).toBe(0)
      await hostContext.close()
      await guestContext.close()
      await wideGuestContext.close()
    } finally {
      await browser?.close()
      for (const child of [signal, web]) {
        if (!child.pid) continue
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
      }
    }
  }, 180000)
})
