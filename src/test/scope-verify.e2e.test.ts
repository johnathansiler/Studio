import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const artifacts = '/opt/cursor/artifacts'

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function tempoOf(page: Page) {
  return page.evaluate(() => {
    const store = (window as unknown as { __cueharbor: { store: { project: { tempo: number } } } }).__cueharbor.store
    return store.project.tempo
  })
}

async function noSideScroll(page: Page, selector: string) {
  const box = await page.locator(selector).evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      scroll: node.scrollWidth,
      client: node.clientWidth,
      overflowX: style.overflowX,
    }
  })
  expect(box.scroll).toBeLessThanOrEqual(box.client + 2)
}

describe('scoped arrange changes', () => {
  it('keeps menu actions, sheets, tempo drag, more fit, waveform, and sequencer routing', async () => {
    mkdirSync(artifacts, { recursive: true })
    const port = 5188
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' })
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()

      const menuViewports = [
        { width: 390, height: 844 },
        { width: 476, height: 752 },
        { width: 880, height: 1000 },
        { width: 844, height: 390 },
        { width: 1440, height: 900 },
      ]
      for (const size of menuViewports) {
        await page.setViewportSize(size)
        await page.getByRole('button', { name: /^Menu/ }).click()
        const menu = page.locator('#shell-menu')
        await menu.waitFor()
        const close = page.locator('[data-screen-overlay] > .overlay-close')
        const closeBox = await close.boundingBox()
        expect(closeBox!.width).toBeGreaterThanOrEqual(44)
        expect(closeBox!.height).toBeGreaterThanOrEqual(44)
        const actions = await menu.locator('[data-menu-action]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-action')))
        for (const action of ['new', 'open', 'save', 'export', 'box', 'erase', 'pan', 'signature', 'shortcuts', 'latency']) {
          expect(actions, `${size.width}x${size.height}`).toContain(action)
        }
        const fit = await menu.evaluate((node) => {
          const buttons = [...node.querySelectorAll('button, select, .menu-sig')]
          const heights = buttons.map((button) => button.getBoundingClientRect().height)
          const smalls = [...node.querySelectorAll('small')].map((small) => {
            const box = small.getBoundingClientRect()
            return box.width * box.height
          })
          return {
            scroll: node.scrollWidth,
            client: node.clientWidth,
            heights,
            smalls,
            canScroll: node.scrollHeight > node.clientHeight + 4,
          }
        })
        expect(fit.scroll).toBeLessThanOrEqual(fit.client + 2)
        expect(Math.min(...fit.heights)).toBeGreaterThanOrEqual(40)
        expect(Math.max(...fit.smalls)).toBeLessThanOrEqual(4)
        const shortcuts = menu.locator('[data-menu-action="shortcuts"]')
        await shortcuts.scrollIntoViewIfNeeded()
        expect(await shortcuts.isVisible()).toBe(true)
        if (size.width === 390 && size.height === 844) {
          await page.screenshot({ path: `${artifacts}/main-menu-390x844.png` })
          const scrollName = await menu.getByRole('button', { name: /^Scroll/ }).getAttribute('aria-label')
          expect(scrollName).toMatch(/not the mixer pan/i)
          await menu.getByRole('button', { name: /^Scroll/ }).click()
          await menu.waitFor({ state: 'detached' })
          const tool = await page.evaluate(() => (window as unknown as { __cueharbor: { store: { tool: string } } }).__cueharbor.store.tool)
          expect(tool).toBe('pan')
        } else {
          await close.click()
          await menu.waitFor({ state: 'detached' })
        }
      }

      await page.setViewportSize({ width: 390, height: 844 })
      await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { sampleRate: number }; setLoop: (enabled: boolean, start?: number, end?: number) => void } }
        }).__cueharbor.store
        store.setLoop(true, 0, store.project.sampleRate * 120)
      })
      await page.waitForFunction(() => {
        const grip = document.querySelector('[data-loop-edge="end"]')
        const scroll = document.querySelector('.timeline-scroll')
        if (!grip || !scroll) return false
        const contentRight = scroll.getBoundingClientRect().left + scroll.clientLeft + scroll.clientWidth
        return contentRight - grip.getBoundingClientRect().right < 8
      })
      const loopHit = await page.evaluate(() => {
        const grip = document.querySelector('[data-loop-edge="end"]') as HTMLElement | null
        const scroll = document.querySelector('.timeline-scroll') as HTMLElement | null
        const face = grip?.querySelector('.loop-grip-face') as HTMLElement | null
        if (!grip || !scroll || !face) return null
        const g = grip.getBoundingClientRect()
        const s = scroll.getBoundingClientRect()
        const f = face.getBoundingClientRect()
        const visible = Math.min(g.right, s.right) - Math.max(g.left, s.left)
        const y = f.top + f.height / 2
        const inner = document.elementFromPoint(f.left - 24, y)
        const edgeX = Math.min(s.right, window.innerWidth) - 3
        const edge = document.elementFromPoint(edgeX, y)
        const host = grip.closest('.loop-host')?.getBoundingClientRect()
        return {
          visible,
          faceWidth: f.width,
          gripWidth: g.width,
          grip: { left: g.left, right: g.right, top: g.top },
          face: { left: f.left, right: f.right },
          scroll: { left: s.left, right: s.right },
          host: host ? { left: host.left, right: host.right } : null,
          edgeX,
          y,
          innerIsEnd: !!inner?.closest('[data-loop-edge="end"]'),
          edgeIsEnd: !!edge?.closest('[data-loop-edge="end"]'),
          edgeTag: edge ? `${edge.tagName}.${edge.className}` : 'none',
          startStolen: !!inner?.closest('[data-loop-edge="start"]'),
        }
      })
      expect(loopHit).toBeTruthy()
      expect(loopHit!.faceWidth).toBeGreaterThanOrEqual(10)
      expect(loopHit!.faceWidth).toBeLessThanOrEqual(14)
      expect(loopHit!.visible).toBeGreaterThanOrEqual(44)
      expect(loopHit!.innerIsEnd).toBe(true)
      expect(loopHit!.edgeIsEnd).toBe(true)
      expect(loopHit!.startStolen).toBe(false)
      const beforeLoop = await page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { loopEndSample: number } } } }).__cueharbor.store.project.loopEndSample)
      const endGrip = page.locator('[data-loop-edge="end"]')
      const endBox = await endGrip.boundingBox()
      await page.mouse.move(endBox!.x + 8, endBox!.y + endBox!.height / 2)
      await page.mouse.down()
      await page.mouse.move(endBox!.x + 8 - 48, endBox!.y + endBox!.height / 2, { steps: 4 })
      await page.mouse.up()
      const shorter = await page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { loopEndSample: number } } } }).__cueharbor.store.project.loopEndSample)
      expect(shorter).toBeLessThan(beforeLoop)

      const vocal = page.locator('.head', { has: page.getByRole('textbox', { name: 'Vocal name' }) })
      await vocal.locator('.track-more').click()
      await page.locator('#track-options').waitFor()
      expect(await page.locator('[data-track-action="keys"]').count()).toBe(0)
      expect(await page.locator('#track-options').getByRole('button', { name: /^Close$/ }).boundingBox()).toBeTruthy()
      const closeBox = await page.locator('#track-options .overlay-close').boundingBox()
      expect(closeBox!.width).toBeGreaterThanOrEqual(44)
      expect(closeBox!.height).toBeGreaterThanOrEqual(44)
      await page.locator('#track-options .overlay-close').click()

      const keys = page.locator('.head', { has: page.getByRole('textbox', { name: 'Keys name' }) })
      await keys.locator('.track-more').click()
      await page.locator('#track-options').waitFor()
      expect(await page.locator('[data-track-action="drums"]').innerText()).toContain('Beat Machine')
      expect(await page.locator('#track-options').getByText('Open Beat Machine', { exact: true }).count()).toBe(0)
      await page.locator('[data-track-action="solo-safe"]').click()
      await page.locator('[data-track-action="automation"]').click()
      await page.locator('[data-track-action="arm"]').click()
      await page.locator('[data-track-action="volume"]').fill('0.4')
      const flags = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { tracks: { name: string; soloSafe?: boolean; armed?: boolean; volume: number }[] }; openLanes: Record<string, boolean> } }
        }).__cueharbor.store
        const track = store.project.tracks.find((item) => item.name === 'Keys')!
        return { solo: !!track.soloSafe, armed: !!track.armed, volume: track.volume, lane: Object.values(store.openLanes).some(Boolean) }
      })
      expect(flags.solo).toBe(true)
      expect(flags.armed).toBe(true)
      expect(flags.volume).toBeCloseTo(0.4, 2)
      expect(flags.lane).toBe(true)
      await page.screenshot({ path: `${artifacts}/track-menu-390x844.png` })
      await page.locator('[data-track-action="keys"]').click()
      await page.locator('.perform-pop').waitFor({ timeout: 8000 })
      await page.locator('.perform-pop .overlay-close').click()
      await page.locator('.perform-pop').waitFor({ state: 'detached' })

      await page.setViewportSize({ width: 1440, height: 900 })
      await keys.locator('.track-more').click()
      await page.locator('#track-options').waitFor()
      await page.screenshot({ path: `${artifacts}/track-menu-1440x900.png` })
      const record = page.getByRole('button', { name: /^Record/ }).first()
      expect(await record.isVisible()).toBe(true)
      await page.locator('#track-options .overlay-close').click()

      await page.setViewportSize({ width: 390, height: 844 })
      await page.evaluate(() => {
        const hook = (window as unknown as {
          __cueharbor: {
            store: {
              project: { sampleRate: number; tracks: { id: string; name: string; type: string }[] }
              addAsset: (asset: { id: string; name: string; sampleRate: number; channels: Float32Array[] }) => void
              addAudioClip: (trackId: string, clip: { id: string; name: string; bufferId: string; startSample: number; offsetSamples: number; durationSamples: number; fadeInSamples: number; fadeOutSamples: number; gain: number; source: string }) => void
            }
          }
        }).__cueharbor.store
        const vocalTrack = hook.project.tracks.find((track) => track.name === 'Vocal')!
        const rate = hook.project.sampleRate
        const samples = new Float32Array(rate)
        for (let index = 0; index < samples.length; index += 1) {
          samples[index] = Math.sin((index / rate) * Math.PI * 2 * 180) * 0.35
          if (index % 4000 < 30) samples[index] = index % 8000 < 4000 ? 0.95 : -0.95
        }
        hook.addAsset({ id: 'wave-proof', name: 'Loop', sampleRate: rate, channels: [samples] })
        hook.addAudioClip(vocalTrack.id, {
          id: 'wave-clip',
          name: 'Loop',
          bufferId: 'wave-proof',
          startSample: 0,
          offsetSamples: 0,
          durationSamples: samples.length,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          gain: 1,
          source: 'local',
        })
      })
      await page.locator('[data-clip="wave-clip"] canvas').waitFor()
      await page.screenshot({ path: `${artifacts}/waveform-390x844.png` })

      await page.getByRole('button', { name: /^More/ }).first().click()
      await page.locator('#transport-menu').waitFor()
      await noSideScroll(page, '#transport-menu')
      await page.screenshot({ path: `${artifacts}/more-menu-390x844.png` })
      await page.keyboard.press('Escape')

      for (const size of [
        { width: 476, height: 752 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(size)
        await page.getByRole('button', { name: /^More/ }).first().click()
        await page.locator('#transport-menu').waitFor()
        await noSideScroll(page, '#transport-menu')
        await page.keyboard.press('Escape')
      }

      await page.setViewportSize({ width: 390, height: 844 })
      const before = await tempoOf(page)
      const dragTempo = (dy: number) => page.evaluate((delta) => {
        const node = document.querySelector('.tempo-tap') as HTMLElement
        const rect = node.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        const point = (type: string, clientY: number) => {
          const event = new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY,
            pointerId: 1,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
          })
          if (type === 'pointerdown') node.dispatchEvent(event)
          else window.dispatchEvent(event)
        }
        point('pointerdown', y)
        point('pointermove', y - delta)
        point('pointerup', y - delta)
      }, dy)
      await dragTempo(80)
      const raised = await tempoOf(page)
      expect(raised).toBeGreaterThan(before)
      await dragTempo(-80)
      const lowered = await tempoOf(page)
      expect(lowered).toBeLessThan(raised)
      const small = await tempoOf(page)
      await dragTempo(3)
      expect(await tempoOf(page)).toBeCloseTo(small, 1)

      await page.getByRole('button', { name: /^Setup/ }).first().click()
      await page.locator('#arrange-setup[data-bottom-sheet="open"]').waitFor()
      expect(await page.getByRole('button', { name: /^Record/ }).first().isVisible()).toBe(true)
      await page.getByRole('button', { name: /^Tool:/ }).click()
      await page.locator('#tool-choices').waitFor()
      expect(await page.locator('#arrange-setup').count()).toBe(0)
      await page.locator('#tool-choices').getByRole('button', { name: /^Draw/ }).click()
      await page.locator('.snap-inline').click()
      await page.locator('#snap-choices').waitFor()
      await page.getByRole('button', { name: '1/8', exact: true }).click()
      const division = await page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { snapDivision?: string } } } }).__cueharbor.store.project.snapDivision)
      expect(division).toBe('1/8')
      await page.keyboard.press('Escape')

      const placed = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { addQuickTrack: (choice: string) => string | null; closeSteps: () => void; setTool: (tool: string) => void; placePattern: (beat: number, trackId?: string) => void; project: { patternClips?: { id: string; trackId?: string; startBeat: number }[] } } }
        }).__cueharbor.store
        const id = store.addQuickTrack('steps')
        store.closeSteps()
        store.setTool('select')
        if (id) store.placePattern(0, id)
        const clip = store.project.patternClips?.find((item) => item.trackId === id)
        return { trackId: id, clipId: clip?.id ?? null, start: clip?.startBeat ?? null }
      })
      expect(placed.trackId).toBeTruthy()
      expect(placed.clipId).toBeTruthy()
      const patternClip = page.locator(`[data-clip="${placed.clipId}"][data-pattern="1"]`)
      await patternClip.waitFor()
      await patternClip.click()
      await page.locator('[data-step-sequencer="open"]').waitFor()
      expect(await page.locator('[data-editor="piano"]').count()).toBe(0)
      await page.locator('.step-close').click()
      await page.locator('[data-step-sequencer="open"]').waitFor({ state: 'detached' })
      const box = await patternClip.boundingBox()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2, { steps: 6 })
      await page.mouse.up()
      expect(await page.locator('[data-step-sequencer="open"]').count()).toBe(0)
      const dragged = await page.evaluate((id) => {
        const store = (window as unknown as { __cueharbor: { store: { project: { patternClips?: { id: string; startBeat: number }[] } } } }).__cueharbor.store
        return store.project.patternClips?.find((item) => item.id === id)?.startBeat ?? null
      }, placed.clipId)
      expect(dragged).not.toBeNull()
      expect(dragged).toBeGreaterThan(placed.start ?? 0)
      const scrolled = await page.evaluate(async (id) => {
        const store = (window as unknown as { __cueharbor: { store: { project: { patternClips?: { id: string; startBeat: number }[] } } } }).__cueharbor.store
        const before = store.project.patternClips?.find((item) => item.id === id)?.startBeat ?? null
        const node = document.querySelector(`[data-clip="${id}"]`) as HTMLElement
        const rect = node.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        const point = (type: string, clientX: number, clientY: number, target: EventTarget) => {
          target.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            pointerId: 7,
            pointerType: 'touch',
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
          }))
        }
        point('pointerdown', x, y, node)
        point('pointermove', x, y + 48, window)
        await new Promise((resolve) => requestAnimationFrame(resolve))
        point('pointerup', x, y + 48, window)
        const after = store.project.patternClips?.find((item) => item.id === id)?.startBeat ?? null
        return { before, after, open: !!document.querySelector('[data-step-sequencer="open"]') }
      }, placed.clipId)
      expect(scrolled.open).toBe(false)
      expect(scrolled.after).toBe(scrolled.before)
      const made = placed.trackId
      await page.locator('[data-step-sequencer="open"]').waitFor({ state: 'detached' })
      await page.getByRole('textbox', { name: 'Step Sequencer 1 name' }).click()
      await page.locator('[data-step-sequencer="open"]').waitFor()
      expect(await page.locator('[data-editor="piano"]').count()).toBe(0)
      await page.locator('.step-close').click()
      await page.locator('[data-step-sequencer="open"]').waitFor({ state: 'detached' })
      const report = await page.evaluate((id) => {
        const store = (window as unknown as {
          __cueharbor: { store: { removeTrack: (trackId: string) => void; project: { stepsAdopted?: boolean; tracks: { id: string; name: string; plugins: { pluginId: string }[] }[] }; loadProject: (project: unknown, buffers: Map<string, unknown>) => void; buffers: Map<string, unknown> } }
        }).__cueharbor.store
        const named = store.project.tracks.find((track) => track.name.startsWith('Step Sequencer'))
        const target = store.project.tracks.find((track) => track.id === id) ?? named
        const steps = () => store.project.tracks.filter((track) => track.plugins.some((plugin) => plugin.pluginId === 'steps') || track.name.startsWith('Step Sequencer'))
        if (!target && steps().length === 0) return { missing: true, id, afterRemove: [] as string[], adopted: false, copied: false, afterLoad: [] as string[] }
        for (const track of [...steps()]) store.removeTrack(track.id)
        const afterRemove = store.project.tracks.map((track) => track.name)
        const adopted = !!store.project.stepsAdopted
        const copy = JSON.parse(JSON.stringify(store.project)) as { stepsAdopted?: boolean }
        store.loadProject(copy, store.buffers)
        return { missing: false, id, afterRemove, adopted, copied: !!copy.stepsAdopted, afterLoad: store.project.tracks.map((track) => track.name) }
      }, made)
      expect(report.missing, JSON.stringify(report)).toBe(false)
      expect(report.afterRemove.some((name) => name.startsWith('Step Sequencer')), JSON.stringify(report)).toBe(false)
      expect(report.adopted).toBe(true)
      expect(report.copied).toBe(true)
      expect(report.afterLoad!.some((name) => name.startsWith('Step Sequencer'))).toBe(false)
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 180000)
})
