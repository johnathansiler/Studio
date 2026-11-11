import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844, phoneSheet: true, shot: true },
  { name: '476x752', width: 476, height: 752, phoneSheet: true, shot: false },
  { name: '844x390', width: 844, height: 390, phoneSheet: true, shot: true },
  { name: '880x1000', width: 880, height: 1000, phoneSheet: false, shot: false },
  { name: '1440x900', width: 1440, height: 900, phoneSheet: false, shot: false },
] as const

const SELECT_LABELS = ['Select', 'Draw', 'Split', 'Trim', 'Zoom', 'Box', 'Erase', 'Scroll']
const PHONE_TOOL_LABELS = ['Scroll']
const SNAP_LABELS = ['On', 'Bar', '1/2', '1/4', '1/8', '1/16', '1/32', '1/4T', '1/8T', '1/16T']

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

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number }

function overlaps(a: Box | null, b: Box | null) {
  if (!a || !b) return false
  return a.x < b.right - 0.5 && a.right > b.x + 0.5 && a.y < b.bottom - 0.5 && a.bottom > b.y + 0.5
}

async function readTray(page: Page, sheetSelector: string, sourceSelector: string) {
  return page.evaluate(({ sheetSelector, sourceSelector }) => {
    const boxOf = (el: Element | null) => {
      if (!(el instanceof HTMLElement)) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    }
    const sheet = document.querySelector(sheetSelector)
    const body = sheet?.querySelector('.choice-tray-body') ?? null
    const well = sheet?.querySelector('.choice-tray-well') ?? null
    const bodyStyle = body instanceof HTMLElement ? getComputedStyle(body) : null
    const wellStyle = well instanceof HTMLElement ? getComputedStyle(well) : null
    const sheetStyle = sheet instanceof HTMLElement ? getComputedStyle(sheet) : null
    const chips = [...(sheet?.querySelectorAll('.choice-chip') ?? [])].map((chip) => {
      const face = chip.querySelector('.choice-chip-face')
      const faceStyle = face instanceof HTMLElement ? getComputedStyle(face) : null
      return {
        label: (face?.textContent || '').trim(),
        pressed: chip.getAttribute('aria-pressed') === 'true',
        hit: boxOf(chip),
        face: boxOf(face),
        faceBg: faceStyle?.backgroundColor ?? '',
      }
    })
    const rows: number[] = []
    for (const chip of chips) {
      const top = chip.hit?.y ?? 0
      if (!rows.some((row) => Math.abs(row - top) < 12)) rows.push(top)
    }
    return {
      sheet: boxOf(sheet),
      source: boxOf(document.querySelector(sourceSelector)),
      tabs: boxOf(document.querySelector('.views')),
      transport: boxOf(document.querySelector('.transport')),
      bar: boxOf(document.querySelector('.tool-slot')),
      classes: sheet?.className ?? '',
      wellClass: well?.className ?? '',
      position: sheetStyle?.position ?? '',
      inset: `${sheetStyle?.boxShadow ?? ''} ${wellStyle?.boxShadow ?? ''}`,
      rows: rows.length,
      cols: well?.getAttribute('data-tray-cols') ?? '',
      value: (sheet?.querySelector('.choice-tray-value')?.textContent || '').trim(),
      close: boxOf(sheet?.querySelector('.choice-tray-close') ?? null),
      closeLabel: sheet?.querySelector('.choice-tray-close')?.getAttribute('aria-label') ?? '',
      closeText: (sheet?.querySelector('.choice-tray-close')?.textContent || '').trim(),
      closeChrome: (() => {
        const close = sheet?.querySelector('.choice-tray-close')
        if (!(close instanceof HTMLElement)) return null
        const style = getComputedStyle(close)
        const glyph = close.querySelector('svg')
        const mark = glyph instanceof Element ? glyph.getBoundingClientRect() : null
        return {
          bg: style.backgroundColor,
          shadow: style.boxShadow,
          border: style.borderTopWidth,
          glyph: mark ? { width: mark.width, height: mark.height } : null,
        }
      })(),
      chips,
      body: body instanceof HTMLElement ? {
        overflowY: bodyStyle?.overflowY ?? '',
        overscroll: bodyStyle?.overscrollBehaviorY ?? '',
        touch: bodyStyle?.touchAction ?? '',
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
      } : null,
      timeline: (document.querySelector('.timeline-scroll') as HTMLElement | null)?.scrollTop ?? 0,
    }
  }, { sheetSelector, sourceSelector })
}

function assertTray(name: string, tray: Awaited<ReturnType<typeof readTray>>, labels: string[], browserHeight: number | null) {
  expect(tray.classes, name).toContain('choice-tray')
  expect(tray.wellClass, name).toContain('choice-tray-well')
  expect(tray.wellClass, name).toContain('btn-tray')
  expect(tray.position, name).not.toBe('fixed')
  expect(tray.inset, name).toContain('inset')
  expect(tray.rows, name).toBe(labels.length <= 2 ? 1 : 2)
  expect(Number(tray.cols), name).toBeGreaterThanOrEqual(Math.ceil(labels.length / 2))
  expect(tray.closeLabel, name).toBe('Close')
  expect(tray.closeText, name).toBe('')
  expect(tray.close!.width, name).toBeGreaterThanOrEqual(40)
  expect(tray.close!.height, name).toBeGreaterThanOrEqual(40)
  expect(tray.closeChrome?.bg, `${name} close face`).toBe('rgba(0, 0, 0, 0)')
  expect(tray.closeChrome?.shadow, `${name} close face`).toBe('none')
  expect(tray.closeChrome?.border, `${name} close face`).toBe('0px')
  expect(tray.closeChrome?.glyph!.width, `${name} close mark`).toBeLessThanOrEqual(16)
  expect(tray.closeChrome?.glyph!.height, `${name} close mark`).toBeLessThanOrEqual(16)
  expect(tray.closeChrome?.glyph!.width, `${name} close mark`).toBeLessThan(tray.close!.width - 16)
  expect(tray.body!.overflowY, name).toBe('auto')
  expect(tray.body!.overscroll, name).toBe('contain')
  expect(tray.body!.touch, name).toContain('pan-y')
  expect(tray.sheet, name).toBeTruthy()
  expect(tray.tabs, name).toBeTruthy()
  expect(tray.transport, name).toBeTruthy()
  expect(tray.bar, name).toBeTruthy()
  expect(tray.source, name).toBeTruthy()
  expect(overlaps(tray.sheet, tray.tabs), `${name} tabs`).toBe(false)
  expect(overlaps(tray.sheet, tray.transport), `${name} transport`).toBe(false)
  expect(overlaps(tray.sheet, tray.source), `${name} source`).toBe(false)
  expect(overlaps(tray.sheet, tray.bar), `${name} bar`).toBe(false)
  expect(tray.sheet!.y, name).toBeGreaterThanOrEqual(tray.transport!.bottom - 1)
  expect(tray.sheet!.y, name).toBeGreaterThanOrEqual(tray.tabs!.bottom - 1)
  expect(tray.sheet!.bottom, name).toBeLessThanOrEqual(tray.bar!.y + 1)
  expect(tray.source!.bottom, name).toBeLessThanOrEqual((tray.bar!.bottom) + 1)
  expect(tray.sheet!.height, name).toBeLessThan(320)
  if (browserHeight != null) expect(tray.sheet!.height, `${name} vs browser ${browserHeight}`).toBeLessThanOrEqual(browserHeight + 8)
  expect(tray.chips.map((chip) => chip.label), name).toEqual(labels)
  const pressed = tray.chips.filter((chip) => chip.pressed)
  if (pressed.length > 0) {
    expect(pressed.some((chip) => chip.label === tray.value), name).toBe(true)
    const idle = tray.chips.find((chip) => !chip.pressed)
    if (idle) expect(pressed[0]!.faceBg, name).not.toBe(idle.faceBg)
  } else {
    expect(tray.chips.length, name).toBeGreaterThan(0)
  }
  for (const chip of tray.chips) {
    expect(chip.hit!.width, `${name} ${chip.label}`).toBeGreaterThanOrEqual(40)
    expect(chip.hit!.height, `${name} ${chip.label}`).toBeGreaterThanOrEqual(40)
    expect(chip.face!.height, `${name} ${chip.label} face`).toBeLessThan(chip.hit!.height - 4)
    expect(chip.face!.height, `${name} ${chip.label} face`).toBeLessThanOrEqual(32)
  }
}

async function assertChipsReachable(page: Page, sheetSelector: string, name: string) {
  const result = await page.evaluate((selector) => {
    const sheet = document.querySelector(selector)
    const body = sheet?.querySelector('.choice-tray-body')
    if (!(sheet instanceof HTMLElement) || !(body instanceof HTMLElement)) return { ok: false, problems: ['missing'], client: 0, scroll: 0 }
    const problems: string[] = []
    for (const chip of sheet.querySelectorAll('.choice-chip')) {
      chip.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const hit = chip.getBoundingClientRect()
      const port = body.getBoundingClientRect()
      const label = chip.querySelector('.choice-chip-face')?.textContent?.trim() || 'chip'
      if (hit.width < 40 || hit.height < 40) problems.push(`${label} hit`)
      if (hit.top < port.top - 1 || hit.bottom > port.bottom + 1 || hit.left < port.left - 1 || hit.right > port.right + 1) {
        problems.push(`${label} ${Math.round(hit.top)}-${Math.round(hit.bottom)} outside ${Math.round(port.top)}-${Math.round(port.bottom)}`)
      }
    }
    return { ok: problems.length === 0, problems, client: body.clientHeight, scroll: body.scrollHeight }
  }, sheetSelector)
  expect(result.problems, name).toEqual([])
  if (result.scroll > result.client + 4) expect(result.client, `${name} scrollport`).toBeGreaterThanOrEqual(44)
}

describe('select and snap choice tray', () => {
  it('lays both sheets out as one short tray at five viewports', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4366
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: viewport.phoneSheet,
          isMobile: viewport.phoneSheet,
        })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()

        let browserHeight: number | null = null
        if (viewport.phoneSheet) {
          await page.getByRole('button', { name: viewport.phoneSheet ? 'Browse' : /^Browser/ }).first().click()
          const browserSheet = page.locator('.arrange-stage > .playlist-browser.bottom-sheet')
          await browserSheet.waitFor()
          await page.waitForFunction(() => {
            const node = document.querySelector('.arrange-stage > .playlist-browser.bottom-sheet')
            if (!(node instanceof HTMLElement)) return false
            const box = node.getBoundingClientRect()
            return box.height > 80 && box.top < window.innerHeight && box.bottom > 0
          })
          browserHeight = (await browserSheet.boundingBox())!.height
          await page.getByRole('button', { name: viewport.phoneSheet ? 'Browse' : /^Browser/ }).first().click()
          await browserSheet.waitFor({ state: 'detached' })
        }

        if (viewport.phoneSheet) await page.getByRole('button', { name: 'Tools', exact: true }).click()
        else await page.getByRole('button', { name: /^Tool:/ }).click()
        await page.locator('#tool-choices[data-choice-tray="open"]').waitFor()
        const selectTray = await readTray(page, '#tool-choices', '.tool-current')
        const selectLabels = viewport.phoneSheet ? PHONE_TOOL_LABELS : SELECT_LABELS
        assertTray(`${viewport.name} select`, selectTray, selectLabels, browserHeight)
        if (viewport.phoneSheet) {
          const row = await page.locator('.phone-context [data-phone-action]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-phone-action')))
          expect(row, viewport.name).toEqual(['select', 'pencil', 'split', 'trim', 'zoom', 'box', 'erase', 'snap'])
        }
        await assertChipsReachable(page, '#tool-choices', `${viewport.name} select chips`)
        if (viewport.shot) await page.screenshot({ path: `/opt/cursor/artifacts/select_tray_${viewport.name}.png` })
        await page.locator('#tool-choices').getByRole('button', { name: 'Close', exact: true }).click()
        await page.locator('#tool-choices').waitFor({ state: 'detached' })

        await page.locator('.snap-inline').click()
        await page.locator('#snap-choices[data-choice-tray="open"]').waitFor()
        const snapTray = await readTray(page, '#snap-choices', '.snap-inline')
        assertTray(`${viewport.name} snap`, snapTray, SNAP_LABELS, browserHeight)
        await assertChipsReachable(page, '#snap-choices', `${viewport.name} snap chips`)
        if (viewport.shot) await page.screenshot({ path: `/opt/cursor/artifacts/snap_tray_${viewport.name}.png` })

        if (viewport.name === '390x844') {
          await page.locator('#snap-choices').getByRole('button', { name: '1/8', exact: true }).click()
          await page.locator('#snap-choices').waitFor({ state: 'detached' })
          const division = await page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { snapDivision?: string; snap?: boolean } } } }).__cueharbor.store.project)
          expect(division.snapDivision).toBe('1/8')
          expect(division.snap).not.toBe(false)
          await page.locator('.snap-inline').click()
          await page.locator('#snap-choices').waitFor()
          await page.locator('#snap-choices').getByRole('button', { name: /Snap On/ }).click()
          await page.locator('#snap-choices').waitFor({ state: 'detached' })
          const off = await page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { snap?: boolean } } } }).__cueharbor.store.project.snap)
          expect(off).toBe(false)
          await page.getByRole('button', { name: 'Tools', exact: true }).click()
          await page.locator('.phone-context [data-phone-action="pencil"]').click()
          expect(await page.evaluate(() => (window as unknown as { __cueharbor: { store: { tool: string } } }).__cueharbor.store.tool)).toBe('pencil')
          await page.locator('.phone-context [data-phone-action="box"]').click()
          expect(await page.evaluate(() => (window as unknown as { __cueharbor: { store: { tool: string } } }).__cueharbor.store.tool)).toBe('box')
          await page.locator('#tool-choices').getByRole('button', { name: /^Scroll/ }).click()
          await page.locator('#tool-choices').waitFor({ state: 'detached' })
          expect(await page.evaluate(() => (window as unknown as { __cueharbor: { store: { tool: string } } }).__cueharbor.store.tool)).toBe('pan')
        } else {
          await page.keyboard.press('Escape')
          await page.locator('#snap-choices').waitFor({ state: 'detached' })
        }

        if (viewport.name === '1440x900') {
          await page.getByRole('button', { name: 'Add Track', exact: true }).click()
          const menu = page.locator('.anchored-menu.add-track-menu')
          await menu.waitFor()
          const popover = await menu.evaluate((node) => {
            const style = getComputedStyle(node)
            const box = node.getBoundingClientRect()
            const hits = (selector: string) => {
              const other = document.querySelector(selector)
              if (!(other instanceof HTMLElement)) return false
              const next = other.getBoundingClientRect()
              return box.left < next.right - 1 && box.right > next.left + 1 && box.top < next.bottom - 1 && box.bottom > next.top + 1
            }
            return {
              position: style.position,
              choice: node.classList.contains('choice-tray'),
              size: node.getAttribute('data-menu-size'),
              width: box.width,
              height: box.height,
              tabs: hits('.views'),
              transport: hits('.transport'),
            }
          })
          expect(popover.position === 'fixed' || popover.position === 'absolute').toBe(true)
          expect(popover.choice).toBe(false)
          expect(popover.size === 'dock' || popover.size === 'fill').toBe(true)
          expect(popover.width).toBeLessThan(viewport.width * 0.9)
          expect(popover.height).toBeLessThan(viewport.height * 0.85)
          expect(popover.tabs).toBe(false)
          expect(popover.transport).toBe(false)
          await page.keyboard.press('Escape')
        }
        await page.close()
      }
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 120000)
})
