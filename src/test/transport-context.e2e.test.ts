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
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      if ((await fetch(url)).ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function arrange(page: Page) {
  await page.goto('http://127.0.0.1:4627', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^Arrange/ }).first().click()
  await page.locator('.timeline-scroll').waitFor()
}

describe('loop, count-in, and contextual delete', () => {
  it('puts Loop and Count-in on the phone arrange row and keeps Delete off the tempo row', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '4627', '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer('http://127.0.0.1:4627', child)
      browser = await chromium.launch({ headless: true })
      const phone = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 1,
      })
      const page = await phone.newPage()
      await arrange(page)
      await page.locator('[data-phone-context="arrange"]').waitFor()

      const idle = await page.evaluate(() => {
        const row = document.querySelector('[data-phone-context="arrange"]') as HTMLElement
        const buttons = [...row.querySelectorAll('button, .bpm-readout')] as HTMLElement[]
        const extras = row.querySelector('.transport-extras')
        const labels = [...document.querySelectorAll('.phone-context button, .transport button, .transport-extras button')].map((node) => `${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`)
        return {
          actions: buttons.map((button) => button.getAttribute('data-phone-action') || button.getAttribute('aria-label') || ''),
          count: row.querySelector('[data-count-state]')?.getAttribute('data-count-state'),
          metroIcon: Boolean(row.querySelector('[data-phone-action="metronome"] svg')),
          loopIcon: Boolean(row.querySelector('[data-phone-action="loop"] svg')),
          deleteInExtras: Boolean(extras?.querySelector('[data-phone-action="delete"], #transport-delete')),
          click: labels.some((label) => /\bClick\b/.test(label)),
          legacy: labels.some((label) => label.includes('1-2')),
          boxes: buttons.map((button) => {
            const rect = button.getBoundingClientRect()
            return { name: button.getAttribute('aria-label') || '', width: rect.width, height: rect.height, right: rect.right }
          }),
        }
      })
      expect(idle.actions).toEqual(expect.arrayContaining(['undo', 'redo', 'snap', 'setup', 'metronome', 'loop', 'count-in']))
      expect(idle.actions.some((action) => action === 'delete' || action.startsWith('Delete'))).toBe(false)
      expect(idle.count).toBe('1 bar')
      expect(idle.metroIcon).toBe(true)
      expect(idle.loopIcon).toBe(true)
      expect(idle.deleteInExtras).toBe(false)
      expect(idle.click).toBe(false)
      expect(idle.legacy).toBe(false)
      for (const box of idle.boxes) {
        expect(box.height, box.name).toBeGreaterThanOrEqual(44)
        expect(box.width, box.name).toBeGreaterThanOrEqual(40)
        expect(box.right, box.name).toBeLessThanOrEqual(390 + 1)
      }
      await page.screenshot({ path: '/opt/cursor/artifacts/phone-390x844-arrange.png', fullPage: true })

      await page.locator('[data-phone-action="count-in"]').click()
      await expect.poll(async () => page.locator('[data-count-state]').getAttribute('data-count-state')).toBe('2 bars')
      await page.locator('[data-phone-action="count-in"]').click()
      await expect.poll(async () => page.locator('[data-count-state]').getAttribute('data-count-state')).toBe('Off')
      await page.locator('[data-phone-action="count-in"]').click()
      await expect.poll(async () => page.locator('[data-count-state]').getAttribute('data-count-state')).toBe('1 bar')
      const countPressed = await page.locator('[data-phone-action="count-in"]').getAttribute('aria-pressed')
      expect(countPressed).toBe('true')

      await page.locator('[data-phone-action="loop"]').click()
      await expect.poll(async () => page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { loopEnabled: boolean } } } }).__cueharbor.store.project.loopEnabled)).toBe(true)
      expect(await page.locator('[data-phone-action="loop"]').getAttribute('aria-pressed')).toBe('true')

      await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { tracks: { id: string; type: string }[] }; addMidiClip: (id: string, beat: number) => void } }
        }).__cueharbor.store
        const keys = store.project.tracks.find((track) => track.type === 'midi')
        if (!keys) throw new Error('no midi track')
        store.addMidiClip(keys.id, 0)
      })
      const clipDelete = page.locator('[data-phone-context="arrange"] [data-phone-action="delete"]')
      await clipDelete.waitFor()
      expect(await page.locator('.transport-extras [data-phone-action="delete"], .transport-extras #transport-delete').count()).toBe(0)
      const clipBox = await clipDelete.boundingBox()
      expect(clipBox!.height).toBeGreaterThanOrEqual(44)
      expect(clipBox!.width).toBeGreaterThan(32)
      await page.screenshot({ path: '/opt/cursor/artifacts/phone-390x844-delete.png', fullPage: true })
      await clipDelete.click()
      await expect.poll(async () => page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { selectedMidiClipId: string | null } } }).__cueharbor.store
        return store.selectedMidiClipId
      })).toBeNull()
      await expect.poll(async () => page.locator('[data-phone-action="delete"]').count()).toBe(0)

      await page.locator('[data-track-name="Vocal"] .track-meter-row').click()
      const trackDelete = page.locator('[data-phone-context="arrange"] [data-phone-action="delete"]')
      await trackDelete.waitFor()
      await trackDelete.click()
      const confirm = page.getByRole('dialog', { name: /Delete track/ })
      await confirm.waitFor()
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
      await confirm.waitFor({ state: 'detached' })
      expect(await page.locator('[data-track-name="Vocal"]').count()).toBe(1)
      await phone.close()

      const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const deskPage = await desk.newPage()
      await arrange(deskPage)
      await deskPage.locator('#transport-loop').waitFor()
      const deskState = await deskPage.evaluate(() => {
        const loop = document.querySelector('#transport-loop')
        const extras = document.querySelector('.transport-extras')
        const contextual = document.querySelector('#contextual-delete')
        const words = [...document.querySelectorAll('.t-word')].map((node) => (node.textContent || '').trim())
        return {
          loop: loop?.textContent?.trim(),
          pressed: loop?.getAttribute('aria-pressed'),
          words,
          deleteInExtras: Boolean(extras?.querySelector('#transport-delete')),
          deleteInContext: Boolean(contextual?.querySelector('#transport-delete')),
          count: document.querySelector('#transport-count .t-state')?.textContent?.trim(),
        }
      })
      expect(deskState.loop).toBe('Loop')
      expect(deskState.words).toContain('Metronome')
      expect(deskState.words).toContain('Count-in')
      expect(deskState.words).not.toContain('Click')
      expect(deskState.words).not.toContain('1-2')
      expect(deskState.count).toBe('1 bar')
      expect(deskState.deleteInExtras).toBe(false)
      expect(deskState.deleteInContext).toBe(true)
      await deskPage.locator('#transport-loop').click()
      await expect.poll(async () => deskPage.locator('#transport-loop').getAttribute('aria-pressed')).toBe('true')
      await deskPage.locator('#transport-count').click()
      await expect.poll(async () => deskPage.locator('#transport-count .t-state').innerText()).toBe('2 bars')
      await deskPage.screenshot({ path: '/opt/cursor/artifacts/desktop-1440-transport.png', fullPage: true })
      await deskPage.locator('#transport-delete').click()
      const deskConfirm = deskPage.getByRole('dialog', { name: /Delete track/ })
      await deskConfirm.waitFor()
      await deskConfirm.getByRole('button', { name: 'Cancel', exact: true }).click()
      await desk.close()
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 180000)
})
