import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844, kind: 'portrait' },
  { name: '476x752', width: 476, height: 752, kind: 'portrait' },
  { name: '880x1000', width: 880, height: 1000, kind: 'wide' },
  { name: '844x390', width: 844, height: 390, kind: 'land' },
  { name: '1440x900', width: 1440, height: 900, kind: 'wide' },
] as const

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 25000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 404) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(selector) as HTMLElement | null
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const ruler = document.querySelector('.arrange .timeline-scroll .ruler') as HTMLElement | null
    const strip = document.querySelector('[data-playhead-strip]') as HTMLElement | null
    const lane = document.querySelector('.timeline-scroll .lane') as HTMLElement | null
    const gap = document.querySelector('.arrange .ruler-gap') as HTMLElement | null
    const grip = document.querySelector('[data-loop-region="arrange"] [data-loop-edge="end"]') as HTMLElement | null
    const face = grip?.querySelector('.loop-grip-face') as HTMLElement | null
    const heads = document.querySelector('.arrange .heads') as HTMLElement | null
    const laneScroll = document.querySelector('.timeline-scroll') as HTMLElement | null
    const add = document.querySelector('.track-add') as HTMLElement | null
    const addBtn = document.querySelector('.track-add .add-track-btn') as HTMLElement | null
    const slot = document.querySelector('.tool-slot') as HTMLElement | null
    const slotBox = slot?.getBoundingClientRect()
    const barButtons = slot
      ? [...slot.querySelectorAll<HTMLElement>('button')].filter((button) => {
          const rect = button.getBoundingClientRect()
          return rect.width > 8 && rect.height > 8 && getComputedStyle(button).display !== 'none'
        }).map((button) => {
          const rect = button.getBoundingClientRect()
          return {
            label: (button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/g, ' ').trim(),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            clipped: slotBox ? (button.closest('.phone-context')
              ? rect.top < slotBox.top - 1 || rect.bottom > slotBox.bottom + 1
              : rect.left < slotBox.left - 1 || rect.right > slotBox.right + 1 || rect.bottom > slotBox.bottom + 1) : false,
          }
        })
      : []
    const controls = [...document.querySelectorAll<HTMLElement>('.arrange .track-controls')].map((row) => {
      const buttons = [...row.querySelectorAll<HTMLElement>('button')]
      const tops = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))
      const rowBox = row.getBoundingClientRect()
      const wrapped = buttons.some((button) => {
        const rect = button.getBoundingClientRect()
        return rect.right > rowBox.right + 1 || rect.height < 39
      })
      return { tops: tops.size, wrapped, width: rowBox.width }
    })
    const overlaps: string[] = []
    for (const head of document.querySelectorAll<HTMLElement>('.arrange .head')) {
      const name = head.querySelector('input.name') as HTMLElement | null
      const meter = head.querySelector('.mini-meter') as HTMLElement | null
      const buttons = [...head.querySelectorAll<HTMLElement>('button')]
      if (name) {
        const nameBox = name.getBoundingClientRect()
        for (const button of buttons) {
          const rect = button.getBoundingClientRect()
          const hit = nameBox.left < rect.right - 1 && nameBox.right > rect.left + 1 && nameBox.top < rect.bottom - 1 && nameBox.bottom > rect.top + 1
          if (hit) overlaps.push((name as HTMLInputElement).value)
        }
      }
      if (meter) {
        const meterBox = meter.getBoundingClientRect()
        for (const button of buttons) {
          const rect = button.getBoundingClientRect()
          const hit = meterBox.left < rect.right - 1 && meterBox.right > rect.left + 1 && meterBox.top < rect.bottom - 1 && meterBox.bottom > rect.top + 1
          if (hit) overlaps.push(`meter ${(name as HTMLInputElement | null)?.value || ''}`)
        }
      }
    }
    return {
      ruler: ruler ? ruler.getBoundingClientRect().height : 0,
      strip: strip ? strip.getBoundingClientRect().height : 0,
      stripTop: strip ? strip.getBoundingClientRect().top : 0,
      rulerBottom: ruler ? ruler.getBoundingClientRect().bottom : 0,
      laneTop: lane ? lane.getBoundingClientRect().top : 0,
      gap: gap ? gap.getBoundingClientRect().height : 0,
      gripHit: grip ? grip.getBoundingClientRect().height : 0,
      gripWidth: grip ? grip.getBoundingClientRect().width : 0,
      gripBottom: grip ? grip.getBoundingClientRect().bottom : 0,
      face: face ? face.getBoundingClientRect().height : 0,
      headWidth: heads ? heads.getBoundingClientRect().width : 0,
      addWidth: addBtn ? addBtn.getBoundingClientRect().width : 0,
      headRight: heads ? heads.getBoundingClientRect().right : 0,
      laneLeft: laneScroll ? laneScroll.getBoundingClientRect().left : 0,
      laneWidth: laneScroll ? laneScroll.getBoundingClientRect().width : 0,
      addHeight: add ? add.getBoundingClientRect().height : 0,
      addBtnHeight: addBtn ? addBtn.getBoundingClientRect().height : 0,
      topMenu: !!document.querySelector('.topbar .menu-btn'),
      topName: !!document.querySelector('.topbar .project-name'),
      topUndo: !!document.querySelector('.topbar [data-history="undo"]'),
      topIdeas: !!document.querySelector('.topbar .unstuck-btn'),
      addUndo: !!document.querySelector('.arrange-add [data-history="undo"]'),
      addRedo: !!document.querySelector('.arrange-add [data-history="redo"]'),
      bulb: document.querySelector('.transport .ideas-bulb')?.getAttribute('aria-label') ?? '',
      addOrder: [...document.querySelectorAll('.arrange-add .add-track-btn, .arrange-add [data-history], .arrange-add .ideas-bulb')].map((node) => {
        const rect = node.getBoundingClientRect()
        return { label: (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim(), left: rect.left }
      }),
      tabsTop: document.querySelector('.views')?.getBoundingClientRect().top ?? 99,
      tabsBottom: document.querySelector('.views')?.getBoundingClientRect().bottom ?? 0,
      transportTop: document.querySelector('.transport')?.getBoundingClientRect().top ?? 0,
      transportBottom: document.querySelector('.transport')?.getBoundingClientRect().bottom ?? 0,
      rulerTop: ruler ? ruler.getBoundingClientRect().top : 0,
      viewfinder: !!document.querySelector('[data-viewfinder]'),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      pluginsInBar: barButtons.some((button) => button.label.startsWith('Plugins')),
      transportClick: [...document.querySelectorAll('.transport .t-word')].some((node) => (node.textContent || '').trim() === 'Click'),
      metroButtons: document.querySelectorAll('[data-phone-action="metronome"], #transport-click').length,
      barButtons,
      controls,
      overlaps,
      head: box('.arrange .heads'),
    }
  })
}

describe('phone arrange layout', () => {
  it('fits the moved chrome, short loop, and short add bar on five viewports', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4471
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await waitForServer(url, child)
      const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({
        headless: true,
        executablePath: '/usr/bin/google-chrome',
      }))
      try {
        const page = await browser.newPage()
        for (const viewport of VIEWPORTS) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height })
          await page.goto(url, { waitUntil: 'domcontentloaded' })
          await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
          await page.locator('[data-loop-region="arrange"]').waitFor()
          const layout = await measure(page)
          await page.screenshot({ path: `/opt/cursor/artifacts/arrange-chrome-${viewport.name}.png` })
          expect(layout.gripWidth, viewport.name).toBeGreaterThanOrEqual(44)
          if (viewport.kind === 'wide') expect(layout.gripHit, viewport.name).toBeGreaterThanOrEqual(44)
          expect(layout.overlaps, viewport.name).toEqual([])
          for (const row of layout.controls) {
            expect(row.tops, viewport.name).toBe(1)
            expect(row.wrapped, viewport.name).toBe(false)
          }
          if (viewport.kind === 'portrait') {
            expect(layout.tabsTop, viewport.name).toBeLessThanOrEqual(8)
            expect(layout.transportTop, viewport.name).toBeGreaterThanOrEqual(layout.tabsBottom - 1)
            expect(layout.viewfinder, viewport.name).toBe(false)
            expect(layout.scrollWidth, viewport.name).toBeLessThanOrEqual(layout.clientWidth + 1)
            expect(layout.rulerTop, viewport.name).toBeLessThanOrEqual(layout.transportBottom + 8)
            expect(layout.ruler, viewport.name).toBeGreaterThanOrEqual(20)
            expect(layout.ruler, viewport.name).toBeLessThanOrEqual(24)
            expect(layout.strip, viewport.name).toBeGreaterThanOrEqual(28)
            expect(layout.stripTop, viewport.name).toBeGreaterThanOrEqual(layout.rulerBottom - 1)
            expect(layout.laneTop, viewport.name).toBeGreaterThanOrEqual(layout.stripTop + layout.strip - 2)
            expect(layout.gripHit, viewport.name).toBeLessThanOrEqual(layout.ruler + 1)
            expect(layout.gripBottom, viewport.name).toBeLessThanOrEqual(layout.stripTop + 1)
            expect(Math.abs(layout.gap - (layout.ruler + layout.strip)), viewport.name).toBeLessThanOrEqual(2)
            expect(layout.face, viewport.name).toBeLessThanOrEqual(layout.ruler)
            expect(layout.addBtnHeight, viewport.name).toBeGreaterThanOrEqual(40)
            expect(layout.addBtnHeight, viewport.name).toBeLessThanOrEqual(44)
            expect(layout.topMenu, viewport.name).toBe(false)
            expect(layout.topName, viewport.name).toBe(false)
            expect(layout.topUndo, viewport.name).toBe(false)
            expect(layout.topIdeas, viewport.name).toBe(false)
            expect(layout.addUndo, viewport.name).toBe(false)
            expect(layout.addRedo, viewport.name).toBe(false)
            expect(layout.bulb, viewport.name).toBe('Ideas')
            expect(layout.pluginsInBar, viewport.name).toBe(false)
            expect(Math.abs(layout.laneLeft - layout.headRight), viewport.name).toBeLessThanOrEqual(2)
            expect(layout.laneWidth, viewport.name).toBeGreaterThan(viewport.width * 0.4)
            const labels = layout.barButtons.map((button) => button.label)
            expect(labels.some((label) => label.startsWith('Menu')), viewport.name).toBe(true)
            expect(labels.some((label) => label === 'Browse'), viewport.name).toBe(true)
            expect(labels.some((label) => label === 'Tools'), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Setup')), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Snap')), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Unstuck') || label === 'Ideas'), viewport.name).toBe(false)
            expect(labels.some((label) => label.startsWith('Metronome')), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Undo')), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Redo')), viewport.name).toBe(true)
            expect(labels.some((label) => label === 'Click'), viewport.name).toBe(false)
            expect(layout.transportClick, viewport.name).toBe(false)
            expect(layout.metroButtons, viewport.name).toBe(1)
            const menu = layout.barButtons.find((button) => button.label.startsWith('Menu'))!
            const browserBtn = layout.barButtons.find((button) => button.label === 'Browse')!
            const toolsBtn = layout.barButtons.find((button) => button.label === 'Tools')!
            expect(menu.left, viewport.name).toBeLessThan(browserBtn.left)
            expect(browserBtn.left, viewport.name).toBeLessThan(toolsBtn.left)
            expect(menu.top, viewport.name).toBeGreaterThanOrEqual(browserBtn.top - 2)
            for (const button of layout.barButtons) {
              expect(button.clipped, `${viewport.name} ${button.label}`).toBe(false)
              expect(button.height, `${viewport.name} ${button.label}`).toBeGreaterThanOrEqual(40)
            }
          } else if (viewport.kind === 'land') {
            expect(layout.tabsTop, viewport.name).toBeLessThanOrEqual(8)
            expect(layout.ruler, viewport.name).toBeGreaterThanOrEqual(20)
            expect(layout.ruler, viewport.name).toBeLessThanOrEqual(24)
            expect(layout.face, viewport.name).toBeLessThanOrEqual(layout.ruler + 1)
            expect(layout.topMenu, viewport.name).toBe(false)
            expect(layout.topName, viewport.name).toBe(false)
            expect(layout.topUndo, viewport.name).toBe(false)
            expect(layout.topIdeas, viewport.name).toBe(false)
            expect(layout.addUndo, viewport.name).toBe(false)
            expect(layout.pluginsInBar, viewport.name).toBe(false)
            expect(layout.addBtnHeight, viewport.name).toBeGreaterThanOrEqual(40)
            expect(layout.strip, viewport.name).toBeGreaterThanOrEqual(28)
            expect(layout.gripHit, viewport.name).toBeLessThanOrEqual(layout.ruler + 1)
            const labels = layout.barButtons.map((button) => button.label)
            expect(labels.some((label) => label.startsWith('Menu')), viewport.name).toBe(true)
            expect(labels.some((label) => label === 'Browse'), viewport.name).toBe(true)
            expect(labels.some((label) => label === 'Tools'), viewport.name).toBe(true)
            expect(labels.some((label) => label.startsWith('Unstuck') || label === 'Ideas'), viewport.name).toBe(false)
            expect(labels.some((label) => label.startsWith('Setup')), viewport.name).toBe(true)
            expect(layout.transportClick, viewport.name).toBe(false)
            expect(layout.metroButtons, viewport.name).toBe(1)
            const menu = layout.barButtons.find((button) => button.label.startsWith('Menu'))!
            const browserBtn = layout.barButtons.find((button) => button.label === 'Browse')!
            expect(menu.left, viewport.name).toBeLessThan(browserBtn.left)
            expect(layout.bulb, viewport.name).toBe('Ideas')
          } else {
            expect(layout.ruler, viewport.name).toBeGreaterThanOrEqual(36)
            expect(layout.topMenu, viewport.name).toBe(true)
            expect(layout.topName, viewport.name).toBe(true)
            expect(layout.topUndo, viewport.name).toBe(true)
            expect(layout.topIdeas, viewport.name).toBe(false)
            expect(layout.bulb, viewport.name).toBe('Ideas')
            expect(layout.addUndo, viewport.name).toBe(false)
            expect(layout.pluginsInBar, viewport.name).toBe(true)
            expect(await page.locator('#arrange-plugins').count(), viewport.name).toBe(0)
            const pluginsToggle = page.locator('[data-arrange-plugins="toggle"]')
            await pluginsToggle.click()
            await page.locator('#arrange-plugins').waitFor()
            await pluginsToggle.click()
            await page.locator('#arrange-plugins').waitFor({ state: 'detached' })
            expect(layout.addBtnHeight, viewport.name).toBeGreaterThanOrEqual(40)
          }
        }

        async function sheetClearance(selector: string, source: string) {
          return page.evaluate(({ selector, source }) => {
            const sheet = document.querySelector(selector) as HTMLElement | null
            const tabs = document.querySelector('.views')?.getBoundingClientRect()
            const transport = document.querySelector('.transport')?.getBoundingClientRect()
            const bar = document.querySelector('.tool-slot')?.getBoundingClientRect()
            const button = [...document.querySelectorAll('button')].find((node) => (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim().startsWith(source))?.getBoundingClientRect()
            if (!sheet || !tabs) return null
            const box = sheet.getBoundingClientRect()
            const hits = (a: DOMRect, b: DOMRect) => a.top < b.bottom - 1 && a.bottom > b.top + 1 && a.left < b.right - 1 && a.right > b.left + 1
            const body = sheet.querySelector('.phone-sheet-body, .bottom-sheet-body, #shell-menu') as HTMLElement | null
            return {
              top: box.top,
              bottom: box.bottom,
              height: box.height,
              tabsBottom: tabs.bottom,
              transportBottom: transport?.bottom ?? null,
              barTop: bar?.top ?? null,
              coversTabs: hits(box, tabs),
              coversTransport: transport ? hits(box, transport) : false,
              coversBar: bar ? hits(box, bar) : false,
              coversButton: button ? hits(box, button) : false,
              buttonTop: button?.top ?? null,
              buttonBottom: button?.bottom ?? null,
              scrolls: body ? getComputedStyle(body).overflowY === 'auto' || getComputedStyle(body).overflowY === 'scroll' : false,
              close: !!sheet.querySelector('.overlay-close, .browser-close, .guide-x'),
            }
          }, { selector, source })
        }

        for (const shot of [
          { width: 390, height: 844, name: '390x844' },
          { width: 844, height: 390, name: '844x390' },
        ]) {
          await page.setViewportSize({ width: shot.width, height: shot.height })
          await page.goto(url, { waitUntil: 'domcontentloaded' })
          const arrangeTab = page.getByRole('button', { name: /^Arrange/ }).first()
          await arrangeTab.waitFor()
          const timeline = page.locator('.timeline-scroll')
          // The saved session can restore Mix after the first paint. Land on Arrange once that settles.
          await page.waitForTimeout(500)
          await arrangeTab.click()
          await timeline.waitFor()
          await page.waitForTimeout(300)
          if (!(await timeline.isVisible().catch(() => false))) {
            await arrangeTab.click()
            await timeline.waitFor()
          }
          await page.locator('[data-overview="y"]').waitFor()
          await page.screenshot({ path: `/opt/cursor/artifacts/phone-${shot.name}-arrange.png` })
          if (shot.name === '390x844') {
            const before = await page.evaluate(() => {
              const hook = (window as unknown as { __cueharbor: { store: { project: { loopStartSample: number; loopEndSample: number } } } }).__cueharbor
              const play = document.querySelector('[data-playhead="arrange"]')?.getBoundingClientRect().left ?? 0
              const strip = document.querySelector('[data-playhead-strip]')!.getBoundingClientRect()
              const hit = document.elementFromPoint(strip.left + strip.width * 0.55, strip.top + strip.height / 2)
              return {
                play,
                start: hook.store.project.loopStartSample,
                end: hook.store.project.loopEndSample,
                hitGrip: Boolean(hit?.closest('[data-loop-edge], .loop-grip')),
                context: document.querySelector('.phone-context')?.getAttribute('data-phone-context'),
              }
            })
            expect(before.hitGrip, 'playhead strip').toBe(false)
            expect(before.context).toBe('arrange')
            const metro = page.locator('[data-phone-action="metronome"]')
            const metroBefore = await metro.getAttribute('aria-pressed')
            await metro.click()
            expect(await metro.getAttribute('aria-pressed')).toBe(metroBefore === 'true' ? 'false' : 'true')
            expect(await page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { metronomeEnabled: boolean } } } }).__cueharbor.store.project.metronomeEnabled)).toBe(metroBefore !== 'true')
            await metro.click()
            expect(await metro.getAttribute('aria-pressed')).toBe(metroBefore)
            const strip = page.locator('[data-playhead-strip]')
            const stripBox = await strip.boundingBox()
            await strip.click({ position: { x: Math.round((stripBox?.width ?? 80) * 0.62), y: Math.round((stripBox?.height ?? 28) / 2) } })
            await page.waitForTimeout(80)
            const after = await page.evaluate(() => {
              const hook = (window as unknown as { __cueharbor: { store: { project: { loopStartSample: number; loopEndSample: number } } } }).__cueharbor
              return {
                play: document.querySelector('[data-playhead="arrange"]')?.getBoundingClientRect().left ?? 0,
                start: hook.store.project.loopStartSample,
                end: hook.store.project.loopEndSample,
              }
            })
            expect(after.play).not.toBe(before.play)
            expect(after.start).toBe(before.start)
            expect(after.end).toBe(before.end)
            const open = await page.evaluate(() => document.querySelector('.timeline-scroll')!.getBoundingClientRect().width)
            const thumb = await page.locator('[data-overview-thumb="y"]').boundingBox()
            if (!thumb) throw new Error('missing lane overview thumb')
            const x = thumb.x + thumb.width / 2
            await page.mouse.move(x, thumb.y + Math.max(8, thumb.height - 8))
            await page.mouse.down()
            await page.mouse.move(x, thumb.y + thumb.height + 140, { steps: 14 })
            await page.mouse.up()
            await page.waitForTimeout(80)
            const shrunk = await page.evaluate(() => {
              const arrange = document.querySelector('.arrange') as HTMLElement
              const lane = document.querySelector('.timeline-scroll')!.getBoundingClientRect()
              const head = document.querySelector('.arrange .heads')!.getBoundingClientRect()
              const row = document.querySelector('.arrange .lane')!.getBoundingClientRect()
              return {
                compact: arrange.getAttribute('data-lane-compact'),
                lane: lane.width,
                head: head.width,
                row: row.height,
              }
            })
            expect(shrunk.compact, 'lane zoom').toBe('true')
            expect(shrunk.row, 'lane height').toBeLessThan(80)
            // The header stays the narrow control column, so the lane does not
            // collapse toward 40px. Mute, Solo, Arm, and Roll plus the overview
            // bar are what remain beside it.
            expect(shrunk.lane, 'lane width').toBeGreaterThan(140)
            expect(shrunk.lane, 'lane vs open').toBeGreaterThan(open - 8)
            expect(shrunk.head, 'header stays narrow').toBeLessThan(220)
          }

          await page.getByRole('button', { name: /^Menu/ }).click()
          await page.locator('#shell-menu').waitFor()
          const menu = await sheetClearance('.anchored-menu.phone-sheet', 'Menu')
          expect(menu, shot.name).toBeTruthy()
          expect(menu!.coversTabs, shot.name).toBe(false)
          expect(menu!.coversTransport, shot.name).toBe(false)
          expect(menu!.coversButton, shot.name).toBe(false)
          expect(menu!.close, shot.name).toBe(true)
          expect(menu!.scrolls, shot.name).toBe(true)
          const menuClose = page.getByRole('dialog', { name: 'Project menu' }).getByRole('button', { name: 'Close', exact: true })
          const menuCloseBox = await menuClose.boundingBox()
          expect(menuCloseBox!.width, shot.name).toBeGreaterThanOrEqual(40)
          expect(menuCloseBox!.height, shot.name).toBeGreaterThanOrEqual(40)
          expect(await menuClose.innerText(), shot.name).not.toMatch(/Close/)
          expect(await page.getByRole('textbox', { name: 'Project name' }).count()).toBeGreaterThan(0)
          expect(await page.getByRole('button', { name: /^Undo/ }).count()).toBeGreaterThan(0)
          if (shot.name === '390x844') {
            const menuActions = await page.locator('#shell-menu [data-menu-action]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-action')))
            for (const action of ['new', 'open', 'save', 'export', 'shortcuts']) {
              expect(menuActions, action).toContain(action)
            }
            for (const action of ['box', 'erase', 'pan', 'signature', 'ideas']) {
              expect(menuActions, action).not.toContain(action)
            }
            const menuRow = await page.locator('.phone-context [data-phone-action]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-phone-action')))
            expect(menuRow).toEqual(['undo', 'redo', 'snap', 'setup', 'metronome'])
            await page.locator('#shell-menu [data-menu-action="save"]').click()
            await page.locator('.toast').filter({ hasText: /Saved|space|could not/i }).waitFor()
          }
          await page.screenshot({ path: `/opt/cursor/artifacts/phone-${shot.name}-menu.png` })
          await page.keyboard.press('Escape')

          const browser = page.locator('.arrange-stage > [data-playlist-browser="open"]')
          await page.locator('.tool-slot').getByRole('button', { name: 'Browse', exact: true }).evaluate((node) => (node as HTMLButtonElement).click())
          await browser.waitFor()
          const browserBox = await sheetClearance('.arrange-stage > [data-playlist-browser="open"]', 'Browse')
          expect(browserBox!.coversTabs, shot.name).toBe(false)
          expect(browserBox!.coversTransport, shot.name).toBe(false)
          expect(browserBox!.coversTabs, shot.name).toBe(false)
          expect(browserBox!.coversTransport, shot.name).toBe(false)
          expect(browserBox!.coversButton, shot.name).toBe(false)
          if (shot.name === '844x390') {
            // Landscape keeps a taller browser so the sound list can scroll above the dock.
            expect(browserBox!.height, shot.name).toBeGreaterThan(120)
            expect(browserBox!.bottom, shot.name).toBeLessThanOrEqual((browserBox!.barTop ?? 0) + 1)
          } else {
            expect(Math.abs(menu!.height - browserBox!.height), `${shot.name} menu vs browser`).toBeLessThanOrEqual(4)
          }
          await page.screenshot({ path: `/opt/cursor/artifacts/phone-${shot.name}-browser.png` })
          const browserClose = page.locator('.playlist-browser .sheet-close')
          const browserCloseBox = await browserClose.boundingBox()
          expect(await browserClose.getAttribute('aria-label')).toBe('Close')
          expect(browserCloseBox!.width, shot.name).toBeGreaterThanOrEqual(40)
          expect(browserCloseBox!.height, shot.name).toBeGreaterThanOrEqual(40)
          await page.locator('.tool-slot').getByRole('button', { name: 'Browse', exact: true }).click()
          await browser.waitFor({ state: 'hidden' })

          await page.locator('.tool-slot').getByRole('button', { name: 'Tools', exact: true }).click()
          const selectSheet = page.locator('#tool-choices')
          await selectSheet.waitFor()
          if (shot.name === '390x844') {
            const chips = await selectSheet.locator('.phone-face').allTextContents()
            expect(chips.map((chip) => chip.trim())).toEqual(['Select', 'Draw', 'Split', 'Trim', 'Zoom', 'Box', 'Erase', 'Scroll'])
            const toolRow = await page.locator('.phone-context [data-phone-action]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-phone-action')))
            expect(toolRow).toEqual(['undo', 'redo', 'snap', 'setup', 'metronome'])
            const toolFit = await page.locator('.phone-context [data-phone-action]').evaluateAll((nodes) => nodes.map((node) => {
              const rect = node.getBoundingClientRect()
              return {
                action: node.getAttribute('data-phone-action'),
                height: rect.height,
                clipped: rect.left < -1 || rect.right > window.innerWidth + 1,
              }
            }))
            for (const button of toolFit) {
              const action = button.action ?? 'tool'
              expect(button.height, action).toBeGreaterThanOrEqual(40)
              expect(button.clipped, action).toBe(false)
            }
            await selectSheet.getByRole('button', { name: /^Draw/ }).click()
            expect(await page.evaluate(() => (window as unknown as { __cueharbor: { store: { tool: string } } }).__cueharbor.store.tool)).toBe('pencil')
            await page.locator('.tool-slot').getByRole('button', { name: 'Tools', exact: true }).click()
            await page.locator('#tool-choices').getByRole('button', { name: /^Erase/ }).click()
            expect(await page.evaluate(() => (window as unknown as { __cueharbor: { store: { tool: string } } }).__cueharbor.store.tool)).toBe('erase')
            await page.locator('.tool-slot').getByRole('button', { name: 'Tools', exact: true }).click()
            await selectSheet.waitFor()
          }
          const selectBox = await selectSheet.boundingBox()
          expect(selectBox!.height, shot.name).toBeGreaterThanOrEqual(40)
          expect(selectBox!.height, shot.name).toBeLessThan(72)
          const selectClear = await sheetClearance('#tool-choices', 'Tools')
          expect(selectClear!.coversTabs, shot.name).toBe(false)
          expect(selectClear!.coversTransport, shot.name).toBe(false)
          expect(selectClear!.coversButton, shot.name).toBe(false)
          await page.screenshot({ path: `/opt/cursor/artifacts/phone-${shot.name}-select.png` })
          await page.locator('.tool-slot').getByRole('button', { name: 'Tools', exact: true }).click()
          await selectSheet.waitFor({ state: 'detached' })

          await page.locator('.tool-slot').getByRole('button', { name: /^Snap/ }).click()
          const snapSheet = page.locator('#snap-choices')
          await snapSheet.waitFor()
          await page.screenshot({ path: `/opt/cursor/artifacts/phone-${shot.name}-snap.png` })
          await snapSheet.getByRole('button', { name: 'Close', exact: true }).click()

          await page.getByRole('button', { name: /^Collab/ }).first().click()
          await page.locator('[data-collab-panel="open"]').waitFor()
          const collab = await page.evaluate(() => ({
            topMenu: !!document.querySelector('.topbar .menu-btn'),
            topName: !!document.querySelector('.topbar .project-name'),
            tabsTop: document.querySelector('.views')?.getBoundingClientRect().top ?? 99,
            labels: [...document.querySelectorAll('.tool-slot button')].map((node) => (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim()),
          }))
          expect(collab.topMenu, shot.name).toBe(false)
          expect(collab.topName, shot.name).toBe(false)
          expect(collab.tabsTop, shot.name).toBeLessThanOrEqual(8)
          expect(collab.labels.some((label) => label.startsWith('Menu')), shot.name).toBe(true)
          expect(collab.labels.some((label) => label === 'Browse'), shot.name).toBe(true)
          expect(collab.labels.some((label) => label === 'Tools'), shot.name).toBe(true)
          expect(collab.labels.findIndex((label) => label.startsWith('Menu'))).toBeLessThan(collab.labels.findIndex((label) => label === 'Browse'))
          await page.screenshot({ path: `/opt/cursor/artifacts/phone-${shot.name}-collab.png` })

          await page.getByRole('button', { name: /^Mix/ }).first().click()
          await page.locator('.mixer').first().waitFor()
          const mix = await page.evaluate(() => {
            const bar = document.querySelector('.tool-slot')?.getBoundingClientRect()
            const more = document.querySelector('[data-phone-action="more"]')?.getBoundingClientRect()
            return {
              topMenu: !!document.querySelector('.topbar .menu-btn'),
              topName: !!document.querySelector('.topbar .project-name'),
              topUndo: !!document.querySelector('.topbar [data-history="undo"]'),
              tabsTop: document.querySelector('.views')?.getBoundingClientRect().top ?? 99,
              labels: [...document.querySelectorAll('.tool-slot button, .tool-slot summary')].map((node) => (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim()),
              moreTop: more?.top ?? null,
              moreBottom: more?.bottom ?? null,
              moreHeight: more?.height ?? 0,
              barBottom: bar?.bottom ?? null,
            }
          })
          expect(mix.topMenu, shot.name).toBe(false)
          expect(mix.topName, shot.name).toBe(false)
          expect(mix.topUndo, shot.name).toBe(false)
          if (shot.name === '844x390') expect(mix.tabsTop, shot.name).toBeLessThanOrEqual(8)
          else {
            expect(mix.tabsTop, shot.name).toBeGreaterThanOrEqual(40)
            expect(mix.tabsTop, shot.name).toBeLessThanOrEqual(70)
          }
          expect(mix.labels.some((label) => label.startsWith('Menu')), shot.name).toBe(true)
          expect(mix.labels.some((label) => label === 'Browse'), shot.name).toBe(true)
          expect(mix.labels.some((label) => label === 'Tools'), shot.name).toBe(true)
          expect(mix.labels.some((label) => label.startsWith('Vocal')), shot.name).toBe(false)
          expect(mix.labels.findIndex((label) => label.startsWith('Menu'))).toBeLessThan(mix.labels.findIndex((label) => label === 'Browse'))
          expect(await page.locator('#transport-count').count(), shot.name).toBe(0)
          expect(mix.moreHeight, shot.name).toBeGreaterThanOrEqual(40)
          expect(mix.moreBottom, shot.name).toBeLessThanOrEqual((mix.barBottom ?? 0) + 1)
          await page.screenshot({ path: `/opt/cursor/artifacts/phone-${shot.name}-mix.png` })
          await page.getByRole('button', { name: /^Menu/ }).click()
          await page.locator('#shell-menu').waitFor()
          if (shot.name === '390x844') {
            const mixActions = await page.locator('#shell-menu [data-menu-action]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-action')))
            expect(mixActions).toContain('new')
            expect(mixActions).not.toContain('ideas')
            expect(await page.locator('.transport .ideas-bulb').count()).toBeGreaterThan(0)
          }
          const mixMenu = await sheetClearance('.anchored-menu.phone-sheet', 'Menu')
          expect(mixMenu!.coversTabs, shot.name).toBe(false)
          expect(mixMenu!.coversButton, shot.name).toBe(false)
          expect(mixMenu!.coversBar, shot.name).toBe(false)
          await page.keyboard.press('Escape')
        }

        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await page.getByRole('button', { name: /^Menu/ }).click()
        const session = page.getByRole('textbox', { name: 'Project name' })
        await session.waitFor()
        await session.fill('Harbor Night')
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: /^Menu/ }).click()
        expect(await page.getByRole('textbox', { name: 'Project name' }).inputValue()).toBe('Harbor Night')
        await page.keyboard.press('Escape')
      } finally {
        await browser.close()
      }
    } finally {
      child.kill('SIGTERM')
    }
  }, 180000)
})
