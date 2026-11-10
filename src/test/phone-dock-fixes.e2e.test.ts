import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { describe, expect, it } from 'vitest'

const PHONES = [
  { name: '390x844', width: 390, height: 844 },
  { name: '476x752', width: 476, height: 752 },
  { name: '844x390', width: 844, height: 390 },
] as const

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      if ((await fetch(url)).ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

function clearDock(barTop: number, sheetBottom: number) {
  expect(sheetBottom).toBeLessThanOrEqual(barTop + 2)
}

describe('phone dock fixes', () => {
  it('opens the right sheets and keeps loop handles on the beat', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4318
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      for (const viewport of PHONES) {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 })
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().click()
        await page.locator('.timeline-scroll').waitFor()
        await page.locator('[data-phone-context="arrange"]').waitFor()

        await page.evaluate(() => {
          const store = (window as unknown as {
            __cueharbor: { store: { project: { tracks: { id: string; type: string }[] }; addMidiClip: (id: string, beat: number) => void } }
          }).__cueharbor.store
          const keys = store.project.tracks.find((track) => track.type === 'midi')
          if (!keys) throw new Error('no midi track')
          store.addMidiClip(keys.id, 0)
        })
        await page.locator('[data-phone-context="clip"]').waitFor()
        await page.getByRole('textbox', { name: 'Vocal name' }).click()
        await page.locator('[data-phone-context="track"]').waitFor()
        const trackRow = await page.evaluate(() => {
          const row = document.querySelector('.phone-context')
          return {
            kind: row?.getAttribute('data-phone-context'),
            words: [...(row?.querySelectorAll('button') ?? [])].map((button) => (button.textContent || '').trim()),
            clip: (window as unknown as { __cueharbor: { store: { selectedMidiClipId: string | null } } }).__cueharbor.store.selectedMidiClipId,
          }
        })
        expect(trackRow.kind, viewport.name).toBe('track')
        expect(trackRow.clip, viewport.name).toBeNull()
        expect(trackRow.words, viewport.name).toEqual(expect.arrayContaining(['Mute', 'Solo']))

        await page.evaluate(() => {
          const store = (window as unknown as {
            __cueharbor: { store: { project: { sampleRate: number }; setRecord: (patch: { loop: boolean }) => void; setLoop: (on: boolean, start?: number, end?: number) => void } }
          }).__cueharbor.store
          const end = store.project.sampleRate * 8
          store.setLoop(true, store.project.sampleRate * 2, end)
          store.setRecord({ loop: true })
        })
        await page.waitForTimeout(40)
        const scrolled = await page.evaluate(async () => {
          const scroller = document.querySelector('.timeline-scroll') as HTMLElement
          const before = [...document.querySelectorAll('[data-loop-region="arrange"] .loop-grip-face')].map((node) => Math.round(node.getBoundingClientRect().left))
          scroller.scrollLeft = Math.min(160, Math.max(48, scroller.scrollWidth - scroller.clientWidth))
          await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
          const inner = document.querySelector('.timeline-inner') as HTMLElement
          const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement
          const project = (window as unknown as { __cueharbor: { store: { project: { tempo: number; sampleRate: number; loopStartSample: number; loopEndSample: number } } } }).__cueharbor.store.project
          const px = Number(inner.dataset.px)
          const beatPx = (60 / project.tempo) * px
          const origin = inner.getBoundingClientRect().left
          const start = host.querySelector('[data-loop-edge="start"] .loop-grip-face')!.getBoundingClientRect()
          const end = host.querySelector('[data-loop-edge="end"] .loop-grip-face')!.getBoundingClientRect()
          const region = host.querySelector('.song-loop')!.getBoundingClientRect()
          const startBeat = project.loopStartSample / project.sampleRate / (60 / project.tempo)
          const endBeat = project.loopEndSample / project.sampleRate / (60 / project.tempo)
          const grip = host.querySelector('[data-loop-edge="start"]') as HTMLElement
          const strip = document.querySelector('[data-playhead-strip]')!.getBoundingClientRect()
          const hit = document.elementFromPoint(strip.left + strip.width * 0.4, strip.top + strip.height / 2)
          const after = [...host.querySelectorAll('.loop-grip-face')].map((node) => Math.round(node.getBoundingClientRect().left))
          return {
            before,
            after,
            scroll: scroller.scrollLeft,
            start: Math.abs(start.left - (origin + startBeat * beatPx)),
            end: Math.abs(end.right - (origin + endBeat * beatPx)),
            region: Math.abs(region.left - (origin + startBeat * beatPx)),
            hit: grip.getBoundingClientRect().width,
            gripBottom: grip.getBoundingClientRect().bottom,
            stripTop: strip.top,
            stripHit: Boolean(hit?.closest('[data-loop-edge], .loop-grip')),
          }
        })
        expect(scrolled.scroll, viewport.name).toBeGreaterThan(20)
        expect(scrolled.after.join(','), viewport.name).not.toBe(scrolled.before.join(','))
        expect(scrolled.start, viewport.name).toBeLessThan(1.5)
        expect(scrolled.end, viewport.name).toBeLessThan(1.5)
        expect(scrolled.region, viewport.name).toBeLessThan(1.5)
        expect(scrolled.hit, viewport.name).toBeGreaterThanOrEqual(44)
        expect(scrolled.gripBottom, viewport.name).toBeLessThanOrEqual(scrolled.stripTop + 1)
        expect(scrolled.stripHit, viewport.name).toBe(false)
        await page.screenshot({ path: `/opt/cursor/artifacts/phone-fix-loop-${viewport.name}.png` })

        await page.locator('.tool-slot').getByRole('button', { name: 'Browse', exact: true }).click()
        const browserSheet = page.locator('[data-playlist-browser="open"]')
        await browserSheet.waitFor()
        for (const section of ['Sounds', 'Instruments', 'Loops', 'Patterns'] as const) {
          await page.locator('.phone-context').getByRole('button', { name: section, exact: true }).click()
          await page.locator(`[data-browser-title="${section.toLowerCase()}"]`).waitFor()
          const title = await page.locator('[data-browser-title]').innerText()
          expect(title, viewport.name).toBe(section)
          expect(await browserSheet.getByRole('button', { name: 'Project', exact: true }).count(), viewport.name).toBe(0)
        }
        const browserBox = await browserSheet.boundingBox()
        const bar = await page.locator('.tool-slot').boundingBox()
        expect(browserBox, viewport.name).toBeTruthy()
        expect(bar, viewport.name).toBeTruthy()
        clearDock(bar!.y, browserBox!.y + browserBox!.height)
        await page.screenshot({ path: `/opt/cursor/artifacts/phone-fix-patterns-${viewport.name}.png` })
        await page.locator('.tool-slot').getByRole('button', { name: 'Browse', exact: true }).click()

        await page.getByRole('button', { name: /^Mix/ }).first().click()
        await page.locator('.mixer').first().waitFor()
        await page.locator('[data-phone-action="more"]').click()
        const more = page.locator('#phone-transport-more')
        await more.waitFor()
        const moreWords = await more.locator('button').allTextContents()
        expect(moreWords.join(' '), viewport.name).toMatch(/Loop/)
        expect(moreWords.join(' '), viewport.name).toMatch(/Metronome/)
        expect(moreWords.join(' '), viewport.name).toMatch(/Count/)
        expect(await more.locator('h4, h2, strong').first().innerText()).toBe('More')
        const close = more.getByRole('button', { name: 'Close', exact: true })
        expect(await close.innerText()).not.toMatch(/Close/)
        const moreBox = await more.boundingBox()
        const mixBar = await page.locator('.tool-slot').boundingBox()
        clearDock(mixBar!.y, moreBox!.y + moreBox!.height)
        expect(await page.locator('.mix-panel').isVisible(), viewport.name).toBe(false)
        await page.screenshot({ path: `/opt/cursor/artifacts/phone-fix-more-${viewport.name}.png` })
        await close.click()
        await more.waitFor({ state: 'detached' })

        await page.locator('.strip .strip-name').first().click({ delay: 560 })
        const channel = page.locator('.mix-panel')
        await channel.waitFor()
        const channelTitle = (await channel.locator('h4').innerText()).trim()
        expect(channelTitle, viewport.name).not.toBe('More')
        expect(channelTitle.length, viewport.name).toBeGreaterThan(0)
        const channelBox = await channel.boundingBox()
        const channelBar = await page.locator('.tool-slot').boundingBox()
        expect(channelBox!.y + channelBox!.height, viewport.name).toBeLessThanOrEqual(channelBar!.y + 2)
        await page.screenshot({ path: `/opt/cursor/artifacts/phone-fix-channel-${viewport.name}.png` })
        await channel.locator('.sheet-close').click()

        await page.getByRole('button', { name: /^Menu/ }).click()
        await page.locator('#shell-menu').waitFor()
        await page.locator('[data-phone-action="open"]').click()
        const projects = page.locator('#project-sheet')
        await projects.waitFor()
        expect(await projects.getByRole('button', { name: 'Close', exact: true }).innerText()).not.toMatch(/Close/)
        expect(await projects.getByRole('button', { name: 'Close', exact: true }).locator('svg').count()).toBe(1)
        const projectsBack = page.locator('.modal-back', { has: projects })
        const projectsBox = await projectsBack.boundingBox()
        const openBar = await page.locator('.tool-slot').boundingBox()
        clearDock(openBar!.y, projectsBox!.y + projectsBox!.height)
        await page.screenshot({ path: `/opt/cursor/artifacts/phone-fix-projects-${viewport.name}.png` })
        await projects.getByRole('button', { name: 'Close', exact: true }).click()

        await page.getByRole('button', { name: /^Menu/ }).click()
        await page.locator('[data-phone-action="export"]').click()
        const exported = page.locator('#export-sheet')
        await exported.waitFor()
        expect(await exported.getByRole('button', { name: 'Close', exact: true }).innerText()).not.toMatch(/Close/)
        const exportBack = page.locator('.modal-back', { has: exported })
        const exportBox = await exportBack.boundingBox()
        const exportBar = await page.locator('.tool-slot').boundingBox()
        clearDock(exportBar!.y, exportBox!.y + exportBox!.height)
        await page.screenshot({ path: `/opt/cursor/artifacts/phone-fix-export-${viewport.name}.png` })
        await exported.getByRole('button', { name: 'Close', exact: true }).click()
        await context.close()
      }

      const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const deskPage = await desk.newPage()
      await deskPage.goto(url, { waitUntil: 'domcontentloaded' })
      await deskPage.getByRole('button', { name: /^Arrange/ }).first().click()
      await deskPage.locator('.timeline-scroll').waitFor()
      if (await deskPage.locator('[data-playlist-browser="open"]').count() === 0) {
        await deskPage.locator('.arrange-panels').getByRole('button', { name: /^Browser/ }).click()
      }
      await deskPage.locator('.playlist-browser').getByRole('button', { name: 'Project', exact: true }).click()
      await deskPage.locator('.anchored-menu').getByRole('button', { name: 'Patterns', exact: true }).waitFor()
      expect(await deskPage.locator('[data-browser-title]').count()).toBe(0)
      await deskPage.keyboard.press('Escape')
      await deskPage.getByRole('button', { name: /^Mix/ }).first().click()
      await deskPage.locator('.mix-toolbar summary').click()
      await deskPage.locator('.mix-panel').waitFor()
      expect(await deskPage.locator('#phone-transport-more').count()).toBe(0)
      await deskPage.screenshot({ path: '/opt/cursor/artifacts/phone-fix-desk-mix.png' })
      await desk.close()

      const fold = await browser.newContext({ viewport: { width: 880, height: 1000 } })
      const foldPage = await fold.newPage()
      await foldPage.goto(url, { waitUntil: 'domcontentloaded' })
      await foldPage.getByRole('button', { name: /^Arrange/ }).first().click()
      if (await foldPage.locator('[data-playlist-browser="open"]').count() === 0) {
        await foldPage.locator('.arrange-panels').getByRole('button', { name: /^Browser/ }).click()
      }
      await foldPage.locator('.playlist-browser').getByRole('button', { name: 'Project', exact: true }).waitFor()
      expect(await foldPage.locator('[data-browser-title]').count()).toBe(0)
      expect(await foldPage.locator('.tool-slot [data-phone-action="more"]').count()).toBe(0)
      await foldPage.screenshot({ path: '/opt/cursor/artifacts/phone-fix-fold-arrange.png' })
      await fold.close()
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 180000)
})
