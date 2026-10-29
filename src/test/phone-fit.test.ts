import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

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

async function shot(page: Page, name: string) {
  mkdirSync('/opt/cursor/artifacts', { recursive: true })
  await page.screenshot({ path: `/opt/cursor/artifacts/${name}.png` })
}

describe('phone fit at 412x915', () => {
  it('gives the timeline, the step grid, and the mixer room to work', async () => {
    const port = 4183
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await waitForServer(url, child)
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage({ viewport: { width: 412, height: 915 } })
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        const timeline = await page.evaluate(() => {
          const lane = document.querySelector('.timeline-scroll')!.getBoundingClientRect()
          const names = [...document.querySelectorAll<HTMLInputElement>('.pl-head .name')].map((name) => ({
            value: name.value,
            width: name.getBoundingClientRect().width,
            clipped: name.scrollWidth > name.clientWidth + 2,
          }))
          return { ratio: lane.height / window.innerHeight, names }
        })
        const history = await page.evaluate(() => {
          return ['[data-history="undo"]', '[data-history="redo"]'].map((selector) => {
            const button = document.querySelector(selector) as HTMLElement
            const word = button.querySelector('.history-word') as HTMLElement
            const box = button.getBoundingClientRect()
            return {
              text: word.textContent,
              display: getComputedStyle(word).display,
              top: box.top,
              bottom: box.bottom,
              right: box.right,
            }
          })
        })
        for (const button of history) {
          expect(button.display).not.toBe('none')
          expect(button.text === 'Undo' || button.text === 'Redo').toBe(true)
          expect(button.top).toBeGreaterThanOrEqual(0)
          expect(button.bottom).toBeLessThanOrEqual(96)
          expect(button.right).toBeLessThanOrEqual(412 + 1)
        }
        const loop = await page.locator('.t-btn.loop .t-word').boundingBox()
        expect(loop).toBeTruthy()
        expect(loop!.x + loop!.width).toBeLessThanOrEqual(412 + 1)
        expect(timeline.ratio).toBeGreaterThanOrEqual(0.65)
        expect(timeline.names.map((item) => item.value)).toEqual(['Vocal', 'Music', 'Keys'])
        for (const name of timeline.names) {
          expect(name.width, name.value).toBeGreaterThan(48)
          expect(name.clipped, name.value).toBe(false)
        }
        const buttonsFit = await page.evaluate(() => {
          return [...document.querySelectorAll<HTMLElement>('.pl-head .mini, .pl-head .piano-open')].every((button) => {
            const head = button.closest('.head')!.getBoundingClientRect()
            const box = button.getBoundingClientRect()
            return box.bottom <= head.bottom + 1 && box.right <= head.right + 1
          })
        })
        expect(buttonsFit).toBe(true)
        await shot(page, 'live-arrange-412')

        await page.getByRole('button', { name: /^Beats/ }).click()
        await page.locator('.rack-step').first().waitFor()
        const grid = await page.evaluate(() => {
          const steps = [...document.querySelectorAll('.rack-row[data-channel="Kick"] .rack-step')].map((el) => el.getBoundingClientRect())
          const view = document.querySelector('.rack-scroll')?.getBoundingClientRect()
          return {
            count: steps.length,
            height: steps[0]?.height ?? 0,
            rows: new Set(steps.map((box) => Math.round(box.top))).size,
            within: steps.every((box) => box.right <= window.innerWidth + 1 && box.left >= -1),
            names: [...document.querySelectorAll<HTMLElement>('.rack-name')].map((el) => el.textContent?.trim()),
            viewHeight: view?.height ?? 0,
          }
        })
        expect(grid.count).toBe(16)
        expect(grid.height).toBeGreaterThanOrEqual(40)
        expect(grid.rows).toBe(2)
        expect(grid.within).toBe(true)
        expect(grid.names).toEqual(expect.arrayContaining(['Kick', 'Snare', 'Clap', 'Hat', 'Perc']))
        const kit = await page.evaluate(() => {
          const host = document.querySelector('.beats.channel-rack') as HTMLElement
          const names = ['Kick', 'Snare', 'Clap', 'Hat', 'Perc']
          return names.map((name) => {
            const row = document.querySelector(`.rack-row[data-channel="${name}"]`) as HTMLElement
            row.scrollIntoView({ block: 'center' })
            const steps = [...row.querySelectorAll('.rack-step')].map((el) => el.getBoundingClientRect())
            const label = row.querySelector('.rack-name') as HTMLElement
            const hostBox = host.getBoundingClientRect()
            const labelBox = label.getBoundingClientRect()
            const visibleTop = Math.max(hostBox.top, 0)
            const visibleBottom = Math.min(hostBox.bottom, window.innerHeight)
            return {
              name,
              count: steps.length,
              tops: new Set(steps.map((step) => Math.round(step.top))).size,
              height: steps[0]?.height ?? 0,
              font: parseFloat(getComputedStyle(label).fontSize),
              clipped: label.scrollWidth > label.clientWidth + 2,
              text: (label.textContent ?? '').trim(),
              inView: labelBox.bottom > visibleTop + 8 && labelBox.top < visibleBottom - 8 && steps.some((step) => step.bottom > visibleTop + 8 && step.top < visibleBottom - 8),
            }
          })
        })
        for (const row of kit) {
          expect(row.count, row.name).toBe(16)
          expect(row.tops, row.name).toBe(2)
          expect(row.height, row.name).toBeGreaterThanOrEqual(40)
          expect(row.font, row.name).toBeGreaterThanOrEqual(14)
          expect(row.clipped, row.name).toBe(false)
          expect(row.text, row.name).toBe(row.name)
          expect(row.inView, row.name).toBe(true)
        }
        await page.locator('.rack-row[data-channel="Kick"]').scrollIntoViewIfNeeded()
        await shot(page, 'live-beats-steps-412')
        await page.locator('.rack-row[data-channel="Perc"]').scrollIntoViewIfNeeded()
        await shot(page, 'live-beats-kit-412')
        const readMask = () => page.evaluate(() => {
          return [...document.querySelectorAll('.rack-row[data-channel]')].map((row) => {
            const on = [...row.querySelectorAll('.rack-step')].map((el) => (el.classList.contains('on') ? '1' : '0')).join('')
            return `${row.getAttribute('data-channel')}:${on}`
          }).join('|')
        })
        await page.getByRole('button', { name: /Random/ }).click()
        const firstRandom = await readMask()
        await page.getByRole('button', { name: /Random/ }).click()
        const secondRandom = await readMask()
        expect(secondRandom).not.toEqual(firstRandom)
        await page.locator('.rack-row[data-channel="Kick"]').scrollIntoViewIfNeeded()
        await shot(page, 'live-beats-random-412')
        await page.getByRole('button', { name: /^Kick\./ }).click()
        const beforeRow = await readMask()
        await page.getByRole('button', { name: /Random/ }).click()
        const selected = await readMask()
        expect(selected).not.toEqual(beforeRow)
        const rest = (mask: string) => mask.split('|').filter((row) => !row.startsWith('Kick:')).join('|')
        expect(rest(selected)).toEqual(rest(beforeRow))
        await page.getByRole('button', { name: /^Roll/ }).click()
        await page.locator('[data-drum-roll="open"]').waitFor()
        const roll = await page.locator('.drum-lane').count()
        expect(roll).toBeGreaterThan(0)
        await shot(page, 'live-beats-412')

        await page.getByRole('button', { name: /^Arrange/ }).first().click()
        await page.getByRole('button', { name: /^Add track$/ }).click()
        await page.getByRole('dialog', { name: 'Add track' }).waitFor()
        const sheet = await page.evaluate(() => {
          const panel = document.querySelector('.add-sheet') as HTMLElement
          const add = [...panel.querySelectorAll('button')].find((button) => (button.textContent || '').includes('Add Audio')) as HTMLElement
          const hit = document.elementFromPoint(add.getBoundingClientRect().left + 8, add.getBoundingClientRect().top + 8)
          const bg = getComputedStyle(panel).backgroundColor
          return {
            parent: panel.parentElement?.tagName,
            z: Number(getComputedStyle(panel).zIndex),
            scrim: !!document.querySelector('.guide-scrim'),
            opaque: bg.startsWith('rgb(') && !bg.endsWith(', 0)'),
            hit: hit === add || add.contains(hit),
          }
        })
        expect(sheet.parent).toBe('BODY')
        expect(sheet.z).toBeGreaterThanOrEqual(200)
        expect(sheet.scrim).toBe(true)
        expect(sheet.opaque).toBe(true)
        expect(sheet.hit).toBe(true)
        await shot(page, 'live-add-track-412')
        await page.keyboard.press('Escape')

        await page.getByRole('button', { name: /Snap grid/ }).click()
        await page.getByRole('dialog', { name: 'Snap grid' }).waitFor()
        const gridPick = await page.evaluate(() => {
          const dialog = document.querySelector('[data-picker="Snap grid"]') as HTMLElement
          const option = [...dialog.querySelectorAll('button')].find((button) => button.textContent === '1/16') as HTMLElement
          const box = option.getBoundingClientRect()
          return { height: box.height, top: dialog.compareDocumentPosition(document.body) }
        })
        expect(gridPick.height).toBeGreaterThanOrEqual(40)
        await page.getByRole('button', { name: '1/16', exact: true }).click()
        await page.getByRole('dialog', { name: 'Snap grid' }).waitFor({ state: 'detached' })
        await shot(page, 'live-grid-412')

        await page.getByRole('button', { name: /^Mix/ }).click()
        await page.locator('.mixer .strip').first().waitFor()
        await page.getByRole('button', { name: 'Columns' }).click()
        const mix = await page.evaluate(() => {
          const mixer = document.querySelector('.mixer-view .mixer') as HTMLElement
          const mute = document.querySelector('.strip button[aria-label*="Mute"]') as HTMLElement
          const safeButton = document.querySelector('.strip .solo-safe') as HTMLElement
          const arm = document.querySelector('.strip .arm-flag') as HTMLElement
          safeButton.scrollIntoView({ block: 'center' })
          const box = mute.getBoundingClientRect()
          const safeBox = safeButton.getBoundingClientRect()
          const armBox = arm.getBoundingClientRect()
          const host = mixer.getBoundingClientRect()
          const word = mute.querySelector('.mini-word') as HTMLElement
          const master = document.querySelector('.strip.master') as HTMLElement
          const strip = document.querySelector('.strip:not(.master)') as HTMLElement
          return {
            top: box.top,
            bottom: safeBox.bottom,
            word: word.textContent,
            wordShown: getComputedStyle(word).display,
            safe: safeButton.querySelector('.arm-full')?.textContent ?? 'missing',
            safeShown: getComputedStyle(safeButton.querySelector('.arm-full') as HTMLElement).display,
            safeIn: safeBox.top >= host.top - 1 && safeBox.bottom <= Math.min(host.bottom, window.innerHeight) + 1 && safeBox.height >= 40,
            armIn: armBox.top >= host.top - 1 && armBox.bottom <= Math.min(host.bottom, window.innerHeight) + 1 && armBox.height >= 40,
            masterWidth: master.getBoundingClientRect().width,
            stripWidth: strip.getBoundingClientRect().width,
            view: window.innerHeight,
          }
        })
        expect(mix.word).toBe('Mute')
        expect(mix.wordShown).not.toBe('none')
        expect(mix.safe).toBe('Safe')
        expect(mix.safeShown).not.toBe('none')
        expect(mix.safeIn).toBe(true)
        expect(mix.armIn).toBe(true)
        expect(Math.abs(mix.masterWidth - mix.stripWidth)).toBeLessThan(2)
        await shot(page, 'live-mix-412')

        const fold = await browser.newPage({ viewport: { width: 923, height: 1024 } })
        await fold.goto(url, { waitUntil: 'domcontentloaded' })
        await fold.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await shot(fold, 'live-arrange-923')
        await fold.close()
        await page.close()
      } finally {
        await browser.close()
      }
    } finally {
      child.kill('SIGTERM')
    }
  }, 60000)
})
