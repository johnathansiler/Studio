import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '476x752', width: 476, height: 752 },
  { name: '880x1000', width: 880, height: 1000 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '844x390', width: 844, height: 390 },
]

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

async function dragLoopEnd(page: Page) {
  return page.evaluate(() => {
    const store = (window as unknown as { __cueharbor: { store: { project: { loopEndSample: number } } } }).__cueharbor.store
    const grip = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"]') as HTMLElement | null
    const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement | null
    if (!grip || !host) throw new Error('loop end missing')
    const scroller = host.parentElement?.closest('.timeline-scroll') as HTMLElement | null
    if (scroller) {
      const faceNow = grip.querySelector('.loop-grip-face')?.getBoundingClientRect()
      const viewNow = scroller.getBoundingClientRect()
      if (faceNow && faceNow.left > viewNow.right - 36) scroller.scrollLeft += faceNow.left - viewNow.right + 48
    }
    const box = grip.getBoundingClientRect()
    const view = (scroller ?? host).getBoundingClientRect()
    const y = box.top + box.height / 2
    const x = Math.min(box.right - 6, view.right - 6)
    const before = store.project.loopEndSample
    const hit = document.elementFromPoint(x, y)
    const fire = (type: string, clientX: number) => {
      grip.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY: y,
        pointerId: 4,
        pointerType: 'touch',
        isPrimary: true,
        buttons: type === 'pointerup' ? 0 : 1,
      }))
    }
    fire('pointerdown', x)
    fire('pointermove', x - 30)
    fire('pointermove', x - 80)
    fire('pointerup', x - 80)
    return {
      before,
      after: store.project.loopEndSample,
      width: box.width,
      height: box.height,
      right: box.right,
      viewRight: view.right,
      left: box.left,
      edge: hit?.closest('[data-loop-edge]')?.getAttribute('data-loop-edge') ?? '',
      touch: getComputedStyle(grip).touchAction,
      z: Number(getComputedStyle(grip).zIndex) || 0,
    }
  })
}

describe('phone mix sheet and loop end', () => {
  it('keeps the mix sheet compact, opens a beat machine insert, and drags the loop end', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4194
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('[data-loop-region="arrange"]').waitFor()
      const loop = await dragLoopEnd(page)
      expect(loop.width).toBeGreaterThanOrEqual(44)
      expect(loop.height).toBeGreaterThanOrEqual(16)
      expect(loop.height).toBeLessThanOrEqual(28)
      expect(loop.edge).toBe('end')
      expect(loop.touch).toBe('none')
      expect(loop.z).toBeGreaterThanOrEqual(8)
      expect(Math.min(loop.right, loop.viewRight) - loop.left).toBeGreaterThanOrEqual(44)
      expect(loop.right).toBeLessThanOrEqual(loop.viewRight + 2)
      expect(loop.after).not.toBe(loop.before)

      await page.getByRole('button', { name: /^Mix/ }).first().click()
      await page.locator('details.mix-more').waitFor({ state: 'attached' })
      const cells = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: {
            store: {
              project: { tracks: { id: string; type: string; plugins: { pluginId: string; steps?: { patterns: { channels: { cells: { on: boolean }[] }[] }[] } }[] }[] }
              addPlugin: (id: string, pluginId: string) => void
              closePads: () => void
              openSteps: (id: string) => void
              selectTrack: (id: string) => void
            }
          }
        }).__cueharbor.store
        const track = store.project.tracks.find((item) => item.type === 'midi')
        if (!track) throw new Error('no midi track')
        store.addPlugin(track.id, 'steps')
        store.addPlugin(track.id, 'pads')
        store.closePads()
        store.openSteps(track.id)
        store.selectTrack(track.id)
        const plugin = track.plugins.find((item) => item.pluginId === 'steps')
        const pattern = plugin?.steps?.patterns[0]
        return JSON.stringify(pattern?.channels.map((channel) => channel.cells.map((cell) => cell.on)) ?? [])
      })
      await page.locator('details.mix-more').waitFor({ state: 'attached' })
      await page.evaluate(() => {
        const details = document.querySelector('details.mix-more') as HTMLDetailsElement | null
        if (!details) throw new Error('mix more missing')
        details.open = true
      })
      const panel = page.locator('.mix-panel')
      await panel.waitFor()
      await panel.getByRole('tab', { name: 'Channel' }).waitFor()
      await panel.getByRole('tab', { name: 'Inserts' }).waitFor()
      await panel.getByRole('tab', { name: 'Sends' }).waitFor()
      await panel.getByRole('tab', { name: 'Routing' }).waitFor()
      const fit = await page.evaluate(() => {
        const node = document.querySelector('.mix-panel') as HTMLElement
        const box = node.getBoundingClientRect()
        const phase = [...node.querySelectorAll('button')].find((button) => (button.textContent || '').includes('Phase'))
        const phaseBox = phase?.getBoundingClientRect()
        const back = document.querySelector('.mix-back') as HTMLElement
        const prose = [...node.querySelectorAll('p')].map((item) => item.textContent || '').join(' ')
        return {
          width: box.width,
          height: box.height,
          top: box.top,
          vw: window.innerWidth,
          vh: window.innerHeight,
          phase: phaseBox?.width ?? 0,
          back: getComputedStyle(back).pointerEvents,
          prose,
        }
      })
      expect(fit.width).toBeLessThan(fit.vw - 16)
      expect(fit.height).toBeLessThan(fit.vh * 0.7)
      expect(fit.phase).toBeGreaterThanOrEqual(40)
      expect(fit.phase).toBeLessThan(fit.width - 24)
      expect(fit.back).toBe('auto')
      expect(fit.prose).not.toMatch(/Place this channel|Off ignores lanes|Where this channel goes/)
      await page.screenshot({ path: '/opt/cursor/artifacts/mix-phone-390x844.png' })

      await panel.getByRole('tab', { name: 'Inserts' }).click()
      const insert = panel.locator('.inserts button', { hasText: 'Beat Machine' })
      await insert.waitFor()
      const receives = await insert.evaluate((button) => {
        const box = button.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return !!hit && (hit === button || button.contains(hit))
      })
      expect(receives).toBe(true)
      await insert.click()
      await page.locator('[data-pads="plugin"]').waitFor()
      const after = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: {
            store: {
              padsTrackId: string | null
              project: { tracks: { type: string; plugins: { pluginId: string; steps?: { patterns: { channels: { cells: { on: boolean }[] }[] }[] } }[] }[] }
            }
          }
        }).__cueharbor.store
        const track = store.project.tracks.find((item) => item.type === 'midi')
        const plugin = track?.plugins.find((item) => item.pluginId === 'steps')
        return {
          open: !!store.padsTrackId,
          cells: JSON.stringify(plugin?.steps?.patterns[0]?.channels.map((channel) => channel.cells.map((cell) => cell.on)) ?? []),
        }
      })
      expect(after.open).toBe(true)
      expect(after.cells).toBe(cells)

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.evaluate(() => {
          const store = (window as unknown as { __cueharbor: { store: { closePads: () => void; setView: (view: string) => void } } }).__cueharbor.store
          store.closePads()
          store.setView('mix')
        })
        await page.locator('.mixer').waitFor()
        const summary = page.locator('.mix-toolbar summary')
        if ((await page.locator('details.mix-more').getAttribute('open')) == null) {
          const box = await summary.boundingBox()
          if (box && box.width >= 20 && box.height >= 20) await summary.click()
          else {
            const name = page.locator('.strip .strip-name').first()
            await name.click({ delay: 560 })
            if ((await page.locator('details.mix-more').getAttribute('open')) == null) {
              await page.evaluate(() => {
                const details = document.querySelector('details.mix-more') as HTMLDetailsElement | null
                if (details) details.open = true
              })
            }
          }
        }
        await page.locator('.mix-panel').waitFor()
        await page.screenshot({ path: `/opt/cursor/artifacts/mix-sheet-${viewport.name}.png` })
        if ((await page.locator('details.mix-more').getAttribute('open')) != null) await page.locator('.mix-panel .overlay-close').click()
      }
      await context.close()
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 90000)
})
