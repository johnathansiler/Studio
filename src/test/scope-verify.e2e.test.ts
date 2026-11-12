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
        await page.waitForFunction(() => {
          const node = document.querySelector('#shell-menu')?.closest('.anchored-menu')
          return !!node && node.getAttribute('data-menu-size') !== 'pending'
        })
        const close = page.locator('.anchored-menu:has(#shell-menu) > .overlay-close')
        const docked = page.locator('.anchored-menu:has(#shell-menu)[data-menu-size="dock"]')
        const sheet = (await close.count()) > 0
        if (sheet) {
          const closeBox = await close.boundingBox()
          expect(closeBox!.width, `${size.width}x${size.height}`).toBeGreaterThanOrEqual(44)
          expect(closeBox!.height, `${size.width}x${size.height}`).toBeGreaterThanOrEqual(44)
        } else {
          await docked.waitFor()
          const box = await docked.boundingBox()
          const tabs = await page.locator('.views').boundingBox()
          expect(box, `${size.width}x${size.height}`).toBeTruthy()
          expect(box!.x, `${size.width}x${size.height}`).toBeGreaterThanOrEqual(-1)
          expect(box!.y, `${size.width}x${size.height}`).toBeGreaterThanOrEqual((tabs?.y ?? 0) + (tabs?.height ?? 0) - 1)
          expect(box!.x + box!.width, `${size.width}x${size.height}`).toBeLessThanOrEqual(size.width + 2)
          expect(box!.y + box!.height, `${size.width}x${size.height}`).toBeLessThanOrEqual(size.height + 2)
        }
        const actions = await menu.locator('[data-menu-action]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-action')))
        const phoneMenu = size.width <= 520 || size.height <= 520
        for (const action of ['box', 'erase', 'pan', 'signature']) {
          expect(actions, `${size.width}x${size.height} ${action}`).not.toContain(action)
        }
        for (const action of ['new', 'open', 'save', 'export']) {
          if (phoneMenu) expect(actions, `${size.width}x${size.height} ${action}`).not.toContain(action)
          else expect(actions, `${size.width}x${size.height} ${action}`).toContain(action)
        }
        for (const action of ['shortcuts', 'latency']) {
          expect(actions, `${size.width}x${size.height}`).toContain(action)
        }
        const fit = await menu.evaluate((node) => {
          const rows = [...node.querySelectorAll('.menu-row')]
          const controls = [...node.querySelectorAll('button.menu-row, label.menu-row, .menu-setting select')]
          const heights = controls.map((control) => control.getBoundingClientRect().height)
          const hints = [...node.querySelectorAll('.menu-row small')].map((small) => {
            const box = small.getBoundingClientRect()
            const style = getComputedStyle(small)
            return {
              width: box.width,
              height: box.height,
              clipped: style.position === 'absolute' || style.visibility === 'hidden',
            }
          })
          const group = node.querySelector('.menu-group')
          const groupStyle = group ? getComputedStyle(group) : null
          const heading = node.querySelector('.menu-heading')
          const headingStyle = heading ? getComputedStyle(heading) : null
          return {
            scroll: node.scrollWidth,
            client: node.clientWidth,
            heights,
            hints,
            radii: rows.map((row) => getComputedStyle(row).borderRadius),
            images: rows.map((row) => getComputedStyle(row).backgroundImage),
            widths: rows.map((row) => row.getBoundingClientRect().width),
            groupBorder: groupStyle ? parseFloat(groupStyle.borderTopWidth) : 1,
            groupRadius: groupStyle ? groupStyle.borderRadius : '12px',
            groupBg: groupStyle ? groupStyle.backgroundColor : 'rgb(0, 0, 0)',
            headingCase: headingStyle ? headingStyle.textTransform : '',
            headingSize: headingStyle ? parseFloat(headingStyle.fontSize) : 99,
          }
        })
        expect(fit.scroll, `${size.width}x${size.height}`).toBeLessThanOrEqual(fit.client + 2)
        expect(Math.min(...fit.heights), `${size.width}x${size.height}`).toBeGreaterThanOrEqual(44)
        expect(Math.max(...fit.heights), `${size.width}x${size.height}`).toBeLessThanOrEqual(120)
        expect(fit.hints.length).toBeGreaterThan(0)
        for (const hint of fit.hints) {
          expect(hint.height).toBeGreaterThan(8)
          expect(hint.width).toBeGreaterThan(24)
          expect(hint.clipped).toBe(false)
        }
        expect(Math.min(...fit.widths)).toBeGreaterThanOrEqual(fit.client - 1)
        for (const radius of fit.radii) expect(parseFloat(radius)).toBe(0)
        for (const image of fit.images) expect(image).toBe('none')
        expect(fit.groupBorder).toBe(0)
        expect(parseFloat(fit.groupRadius)).toBe(0)
        expect(fit.groupBg).toMatch(/rgba\(0,\s*0,\s*0,\s*0\)|transparent/)
        expect(fit.headingCase).toBe('uppercase')
        expect(fit.headingSize).toBeLessThanOrEqual(12)
        const arrangeRadius = await page.getByRole('button', { name: /^Arrange/ }).first().evaluate((node) => getComputedStyle(node).borderRadius)
        expect(parseFloat(arrangeRadius)).toBe(12)
        if (sheet) {
          const closeRadius = await close.evaluate((node) => parseFloat(getComputedStyle(node).borderRadius))
          expect(closeRadius).toBe(12)
        }
        const shortcuts = menu.locator('[data-menu-action="shortcuts"]')
        await shortcuts.scrollIntoViewIfNeeded()
        expect(await shortcuts.isVisible()).toBe(true)
        if (size.width === 390 && size.height === 844) {
          await page.screenshot({ path: `${artifacts}/main-menu-390x844.png` })
          await page.locator('[data-screen-overlay] > .overlay-close').click()
          await menu.waitFor({ state: 'detached' })
          await page.getByRole('button', { name: 'Tools', exact: true }).click()
          const scroll = page.locator('#tool-choices').getByRole('button', { name: /^Scroll/ })
          await scroll.waitFor()
          expect(await scroll.getAttribute('aria-label')).toMatch(/not the mixer pan/i)
          await scroll.click()
          await page.locator('#tool-choices').waitFor({ state: 'detached' })
          const tool = await page.evaluate(() => (window as unknown as { __cueharbor: { store: { tool: string } } }).__cueharbor.store.tool)
          expect(tool).toBe('pan')
          await page.getByRole('button', { name: 'Tools', exact: true }).click()
          const again = page.locator('#tool-choices').getByRole('button', { name: /^Scroll/ })
          expect(await again.getAttribute('aria-pressed')).toBe('true')
          await page.locator('#tool-choices').getByRole('button', { name: 'Close', exact: true }).click()
          await page.locator('#tool-choices').waitFor({ state: 'detached' })
        } else if (size.width === 1440) {
          await menu.locator('[data-menu-action="latency"] select').selectOption('playback')
          await page.waitForFunction(() => document.querySelector('[data-menu-action="latency"] .menu-value')?.textContent?.includes('Playback'))
          await menu.locator('[data-menu-action="latency"] select').selectOption('interactive')
          await page.waitForFunction(() => document.querySelector('[data-menu-action="latency"] .menu-value')?.textContent?.includes('Lowest'))
          await menu.locator('[data-menu-action="shortcuts"]').click()
          const help = page.getByRole('dialog', { name: 'Shortcuts' })
          await help.waitFor()
          await help.getByRole('button', { name: 'Close' }).click()
          await menu.waitFor({ state: 'detached' })
          await page.getByRole('button', { name: /^Setup/ }).first().click()
          await page.locator('#arrange-setup').getByRole('tab', { name: 'Time' }).click()
          const time = page.locator('.song-meters')
          await time.waitFor()
          await time.getByRole('button', { name: '3/4', exact: true }).click()
          await page.waitForFunction(() => {
            const sig = (window as unknown as { __cueharbor: { store: { project: { timeSignature: { numerator: number, denominator: number } } } } }).__cueharbor.store.project.timeSignature
            return sig.numerator === 3 && sig.denominator === 4
          })
          await time.getByRole('button', { name: '4/4', exact: true }).click()
          await page.locator('#arrange-setup').getByRole('button', { name: 'Close', exact: true }).click()
        } else {
          if (sheet) await close.click()
          else await page.keyboard.press('Escape')
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
      // A long loop keeps its end cap on the beat, off the right of the phone, until the timeline scrolls there.
      const longLoop = await page.waitForFunction(() => {
        const host = document.querySelector('[data-loop-region="arrange"]') as HTMLElement | null
        const face = host?.querySelector('[data-loop-edge="end"] .loop-grip-face') as HTMLElement | null
        const scroll = document.querySelector('.timeline-scroll') as HTMLElement | null
        const inner = document.querySelector('.timeline-inner') as HTMLElement | null
        if (!host || !face || !scroll || !inner) return null
        if (host.dataset.parkEnd !== 'track') return null
        const project = (window as unknown as { __cueharbor: { store: { project: { sampleRate: number; loopEndSample: number } } } }).__cueharbor.store.project
        const expectEnd = inner.getBoundingClientRect().left + (project.loopEndSample / project.sampleRate) * Number(inner.dataset.px)
        const faceRight = face.getBoundingClientRect().right
        const viewRight = scroll.getBoundingClientRect().left + scroll.clientLeft + scroll.clientWidth
        if (Math.abs(faceRight - expectEnd) > 1.5) return null
        if (expectEnd < viewRight + 1000) return null
        return { expectEnd, faceRight, viewRight, past: viewRight - faceRight }
      })
      const offscreen = await longLoop.jsonValue()
      expect(offscreen).toBeTruthy()
      expect(offscreen!.faceRight).toBeGreaterThan(offscreen!.viewRight)
      expect(offscreen!.past).toBeLessThan(-1000)
      await page.evaluate(() => {
        const scroller = document.querySelector('.timeline-scroll') as HTMLElement
        const grip = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"]') as HTMLElement
        const hitRight = parseFloat(grip.style.left) + (parseFloat(grip.style.width) || grip.offsetWidth)
        scroller.scrollLeft = Math.max(0, hitRight - scroller.clientWidth + 2)
      })
      await page.waitForFunction(() => {
        const grip = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"]')
        const scroll = document.querySelector('.timeline-scroll')
        if (!grip || !scroll) return false
        const g = grip.getBoundingClientRect()
        const s = scroll.getBoundingClientRect()
        return Math.min(g.right, s.right) - Math.max(g.left, s.left) >= 44
      })
      const loopHit = await page.evaluate(() => {
        const grip = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"]') as HTMLElement | null
        const scroll = document.querySelector('.timeline-scroll') as HTMLElement | null
        const face = grip?.querySelector('.loop-grip-face') as HTMLElement | null
        const host = grip?.closest('.loop-host') as HTMLElement | null
        const inner = document.querySelector('.timeline-inner') as HTMLElement | null
        if (!grip || !scroll || !face || !host || !inner) return null
        const g = grip.getBoundingClientRect()
        const s = scroll.getBoundingClientRect()
        const f = face.getBoundingClientRect()
        const visible = Math.min(g.right, s.right) - Math.max(g.left, s.left)
        const y = f.top + f.height / 2
        const onFace = document.elementFromPoint(f.left + f.width / 2, y)
        const beside = document.elementFromPoint(f.left - 24, y)
        const edgeX = Math.min(s.right, window.innerWidth) - 3
        const edge = document.elementFromPoint(edgeX, y)
        const project = (window as unknown as { __cueharbor: { store: { project: { sampleRate: number; loopEndSample: number } } } }).__cueharbor.store.project
        const expectEnd = inner.getBoundingClientRect().left + (project.loopEndSample / project.sampleRate) * Number(inner.dataset.px)
        const hostBox = host.getBoundingClientRect()
        return {
          visible,
          faceWidth: f.width,
          gripWidth: g.width,
          grip: { left: g.left, right: g.right, top: g.top },
          face: { left: f.left, right: f.right },
          scroll: { left: s.left, right: s.right },
          host: { left: hostBox.left, right: hostBox.right },
          onBeat: Math.abs(f.right - expectEnd),
          parkEnd: host.dataset.parkEnd ?? '',
          edgeX,
          y,
          innerIsEnd: !!onFace?.closest('[data-loop-edge="end"]'),
          edgeIsEnd: !!edge?.closest('[data-loop-edge="end"]'),
          edgeTag: edge ? `${edge.tagName}.${edge.className}` : 'none',
          startStolen: !!beside?.closest('[data-loop-edge="start"]'),
        }
      })
      expect(loopHit).toBeTruthy()
      expect(loopHit!.parkEnd).toBe('track')
      expect(loopHit!.onBeat).toBeLessThan(1.5)
      expect(loopHit!.faceWidth).toBeGreaterThanOrEqual(10)
      expect(loopHit!.faceWidth).toBeLessThanOrEqual(14)
      expect(loopHit!.gripWidth).toBeGreaterThanOrEqual(44)
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
      await page.evaluate(() => {
        const scroller = document.querySelector('.timeline-scroll') as HTMLElement | null
        if (scroller) scroller.scrollLeft = 0
      })

      const vocal = page.locator('[data-track-name="Vocal"]')
      await vocal.locator('.track-more').click()
      await page.locator('#track-options').waitFor()
      expect(await page.locator('[data-track-action="keys"]').count()).toBe(0)
      expect(await page.locator('#track-options').getByRole('button', { name: /^Close$/ }).boundingBox()).toBeTruthy()
      const closeBox = await page.locator('#track-options .overlay-close').boundingBox()
      expect(closeBox!.width).toBeGreaterThanOrEqual(44)
      expect(closeBox!.height).toBeGreaterThanOrEqual(44)
      await page.locator('#track-options .overlay-close').click()

      const keys = page.locator('[data-track-name="Keys"]')
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

      expect(await page.locator('.transport .t-btn.menu, #transport-menu').count()).toBe(0)
      await noSideScroll(page, '.transport .t-main')
      await page.screenshot({ path: `${artifacts}/transport-row-390x844.png` })

      for (const size of [
        { width: 476, height: 752 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(size)
        expect(await page.locator('.transport .t-btn.menu, #transport-menu').count()).toBe(0)
        await noSideScroll(page, '.transport .t-main')
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

      // Scroll is the current tool, so an empty-lane click pans instead of clearing the clip.
      // The clip row hides Setup until the selection is cleared.
      await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: { store: { project: { tracks: { id: string; name: string }[] }; selectClip: (trackId: string, clipId: string | null, midi?: boolean, openSheet?: boolean) => void } }
        }).__cueharbor.store
        const track = store.project.tracks.find((item) => item.name === 'Music') ?? store.project.tracks[0]
        store.selectClip(track.id, null, false, false)
      })
      await page.locator('.phone-context[data-phone-context="arrange"]').waitFor()
      await page.getByRole('button', { name: /^Setup/ }).first().click()
      await page.locator('#arrange-setup[data-bottom-sheet="open"]').waitFor()
      expect(await page.getByRole('button', { name: /^Record/ }).first().isVisible()).toBe(true)
      await page.getByRole('button', { name: 'Tools', exact: true }).click()
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
      await page.locator('[data-track-name="Step Sequencer 1"] .track-meter-row').click()
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
