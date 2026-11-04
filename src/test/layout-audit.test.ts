import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = '/opt/cursor/artifacts'

const viewports = [
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
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(detail || 'process exited')
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 404) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'server did not start')
}

type Hit = {
  label: string
  width: number
  height: number
  overflow: boolean
  covered: boolean
  cover: string
}

async function auditControls(page: Page, scope: string) {
  return page.evaluate((rootSelector) => {
    const roots = [...document.querySelectorAll(rootSelector)]
    const nodes = roots.flatMap((root) => [...root.querySelectorAll('button, summary, a, input[type="button"]')]) as HTMLElement[]
    const hits: Hit[] = []
    for (const node of nodes) {
      if (node.closest('.guide-scrim, .browser-scrim, .song-scrim, .piano-body, .step-grid, .rack-steps, .play-keys')) continue
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
      const full = node.getBoundingClientRect()
      let box = { left: full.left, top: full.top, right: full.right, bottom: full.bottom, width: full.width, height: full.height }
      let parent = node.parentElement
      while (parent && parent !== document.documentElement) {
        const parentStyle = getComputedStyle(parent)
        const clip = `${parentStyle.overflow}${parentStyle.overflowX}${parentStyle.overflowY}`
        if (/auto|hidden|scroll|clip/.test(clip)) {
          const frame = parent.getBoundingClientRect()
          const left = Math.max(box.left, frame.left)
          const top = Math.max(box.top, frame.top)
          const right = Math.min(box.right, frame.right)
          const bottom = Math.min(box.bottom, frame.bottom)
          box = { left, top, right, bottom, width: right - left, height: bottom - top }
        }
        parent = parent.parentElement
      }
      if (box.width < 8 || box.height < 8) continue
      if (box.bottom < 0 || box.top > window.innerHeight || box.right < 0 || box.left > window.innerWidth) continue
      const label = (node.getAttribute('aria-label') || node.innerText || node.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
      const overflow = node.scrollWidth > node.clientWidth + 2 || node.scrollHeight > node.clientHeight + 2
      const point = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 18))
      const covered = !!point && point !== node && !node.contains(point)
      const cover = covered ? ((point as HTMLElement).innerText || point.getAttribute('aria-label') || point.className || point.tagName).toString().replace(/\s+/g, ' ').trim().slice(0, 60) : ''
      const small = box.width < 40 && box.height < 40
      if (overflow || covered || small) hits.push({
        label,
        width: Math.round(box.width),
        height: Math.round(box.height),
        overflow,
        covered,
        cover,
      })
    }
    return hits
  }, scope)
}

describe('layout audit across the five viewports', () => {
  it('keeps chrome readable, at least 40px, and uncovered', async () => {
    mkdirSync(artifacts, { recursive: true })
    const port = 4407
    const url = `http://127.0.0.1:${port}`
    const web = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({
      headless: true,
      executablePath: '/usr/bin/google-chrome',
    }))
    try {
      await waitForServer(url, web)
      const page = await browser.newPage()
      const problems: string[] = []
      for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await page.screenshot({ path: `${artifacts}/layout-after-arrange-${viewport.name}.png` })
        const arrange = await auditControls(page, '.topbar, .transport, .tool-slot, .arrange-add, .pl-head')
        for (const hit of arrange) problems.push(`${viewport.name} arrange ${hit.label} ${hit.width}x${hit.height} overflow=${hit.overflow} covered=${hit.covered} ${hit.cover}`)

        await page.getByRole('button', { name: /^Mix/ }).first().click()
        await page.locator('.mixer').first().waitFor()
        await page.screenshot({ path: `${artifacts}/layout-after-mix-${viewport.name}.png` })
        const mix = await auditControls(page, '.topbar, .transport, .strip-foot')
        for (const hit of mix) problems.push(`${viewport.name} mix ${hit.label} ${hit.width}x${hit.height} overflow=${hit.overflow} covered=${hit.covered} ${hit.cover}`)

        const more = page.locator('.mixer > .strip summary.more-open').first()
        if (await more.count()) {
          await more.click()
          await page.locator('.mix-panel').first().waitFor()
          const panel = await page.evaluate(() => {
            const node = document.querySelector('.mix-panel') as HTMLElement
            const box = node.getBoundingClientRect()
            const tabs = document.querySelector('.views')!.getBoundingClientRect()
            const sample = document.elementFromPoint(window.innerWidth / 2, tabs.bottom + 24)
            const add = document.querySelector('.mixer .add-track-btn')
            const addBox = add?.getBoundingClientRect()
            const addHit = addBox ? document.elementFromPoint(addBox.left + addBox.width / 2, addBox.top + addBox.height / 2) : null
            return {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              tabBottom: tabs.bottom,
              vw: window.innerWidth,
              vh: window.innerHeight,
              inside: !!sample && (sample === node || node.contains(sample)),
              addCovered: !!addHit && (addHit === node || node.contains(addHit)),
            }
          })
          if (panel.left > 1 || panel.right < panel.vw - 1 || panel.bottom < panel.vh - 1) {
            problems.push(`${viewport.name} mix more does not fill the screen`)
          }
          if (panel.top < panel.tabBottom - 2) problems.push(`${viewport.name} mix more covers the tabs`)
          if (!panel.inside) problems.push(`${viewport.name} mix more is not the top layer`)
          await page.screenshot({ path: `${artifacts}/layout-after-mix-more-${viewport.name}.png` })
          await page.keyboard.press('Escape').catch(() => undefined)
        }

        await page.getByRole('button', { name: /^Arrange/ }).first().click()
        const menu = page.getByRole('button', { name: /^Menu/ }).nth(1)
        if (await menu.count()) {
          await menu.click()
          await page.locator('#transport-menu, .transport-drawer').first().waitFor()
          const sheet = await page.evaluate(() => {
            const node = document.querySelector('#transport-menu, .transport-drawer') as HTMLElement
            const box = node.getBoundingClientRect()
            const tabs = document.querySelector('.views')!.getBoundingClientRect()
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, tabBottom: tabs.bottom, vw: window.innerWidth, vh: window.innerHeight }
          })
          if (sheet.left > 1 || sheet.right < sheet.vw - 1 || Math.abs(sheet.top - sheet.tabBottom) > 4) {
            problems.push(`${viewport.name} transport menu is not under the tabs`)
          }
          await page.screenshot({ path: `${artifacts}/layout-after-transport-menu-${viewport.name}.png` })
          const song = page.locator('#transport-menu button, .transport-drawer button').filter({ hasText: /^Song/ }).first()
          if (await song.count()) {
            await song.click()
            await page.locator('[aria-label="Song"]').first().waitFor()
            const menuStill = await page.locator('#transport-menu:visible, .transport-drawer[data-open="true"]').count()
            if (menuStill > 0) problems.push(`${viewport.name} song left the transport menu open`)
            const scrim = await page.evaluate(() => {
              const node = document.querySelector('.song-scrim') as HTMLElement | null
              if (!node) return null
              const box = node.getBoundingClientRect()
              const menu = document.querySelector('.menu-btn')!.getBoundingClientRect()
              const hit = document.elementFromPoint(menu.left + menu.width / 2, menu.top + menu.height / 2)
              return { top: box.top, blocksMenu: !!hit && (hit === node || node.contains(hit)) }
            })
            if (scrim?.blocksMenu) problems.push(`${viewport.name} song scrim blocks the top bar`)
            await page.screenshot({ path: `${artifacts}/layout-after-song-${viewport.name}.png` })
          }
        }
      }
      expect(problems, problems.join('\n')).toEqual([])
    } finally {
      await browser.close()
      web.kill('SIGTERM')
    }
  }, 120000)
})
