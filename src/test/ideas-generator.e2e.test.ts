import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

const ARTIFACTS = '/opt/cursor/artifacts'

async function launch() {
  try {
    return await chromium.launch({ headless: true })
  } catch {
    return chromium.launch({ headless: true, channel: 'chrome' })
  }
}

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

async function shoot(page: Page, width: number) {
  await page.setViewportSize({ width, height: width < 500 ? 832 : 1104 })
  await page.goto('http://127.0.0.1:4473/?generate=1', { waitUntil: 'domcontentloaded' })
  await page.locator('[data-parts="open"]').waitFor({ timeout: 20000 })
  await page.locator('[data-unstuck="open"]').screenshot({ path: `${ARTIFACTS}/ideas-generator-${width}.png` })
  await page.locator('.parts-commit').scrollIntoViewIfNeeded()
  await page.locator('[data-unstuck="open"]').screenshot({ path: `${ARTIFACTS}/ideas-generator-parts-${width}.png` })
  await page.getByRole('button', { name: 'Add to project' }).click()
  await page.getByRole('button', { name: 'Ideas', exact: true }).click()
  await page.locator('[data-unstuck="open"]').waitFor({ state: 'detached' })
  await page.evaluate(() => {
    const store = (window as unknown as {
      __cueharbor: {
        store: {
          project: { tracks: { id: string; name: string; midiClips: { id: string }[] }[] }
          selectClip: (trackId: string, clipId: string, midi: boolean, openSheet: boolean) => void
          closeScaler: () => void
          closePads: () => void
          setView: (view: string) => void
        }
      }
    }).__cueharbor.store
    store.closeScaler()
    store.closePads()
    store.setView('arrange')
    const melody = store.project.tracks.find((track) => track.name === 'Melody')
    const clip = melody?.midiClips[0]
    if (melody && clip) store.selectClip(melody.id, clip.id, true, false)
    const lane = document.querySelector('.timeline-scroll') as HTMLElement | null
    const heads = document.querySelector('.arrange .heads') as HTMLElement | null
    if (lane) lane.scrollTop = lane.scrollHeight
    if (heads) heads.scrollTop = heads.scrollHeight
  })
  await page.getByRole('button', { name: /^Arrange/ }).first().click()
  await page.screenshot({ path: `${ARTIFACTS}/ideas-arrange-${width}.png` })
  const vary = page.locator('[data-variation="make"]')
  await vary.waitFor()
  await vary.click()
  await vary.click()
  await vary.click()
  await page.evaluate(() => {
    for (let step = 0; step < 5; step++) window.dispatchEvent(new CustomEvent('cueharbor-zoom', { detail: 0.55 }))
    const lane = document.querySelector('.timeline-scroll') as HTMLElement | null
    const heads = document.querySelector('.arrange .heads') as HTMLElement | null
    if (lane) {
      lane.scrollTop = lane.scrollHeight
      lane.scrollLeft = 0
    }
    if (heads) heads.scrollTop = heads.scrollHeight
  })
  await page.screenshot({ path: `${ARTIFACTS}/ideas-variations-${width}.png` })
  const names = await page.evaluate(() => {
    const store = (window as unknown as {
      __cueharbor: { store: { project: { tracks: { name: string; midiClips: { name: string }[] }[] } } }
    }).__cueharbor.store
    return store.project.tracks.find((track) => track.name === 'Melody')?.midiClips.map((clip) => clip.name) ?? []
  })
  expect(names.some((name) => name.includes('(var 1)'))).toBe(true)
  expect(names.some((name) => name.includes('(var 3)'))).toBe(true)
  await page.locator('[data-variation="dock"]').waitFor()
}

describe('ideas generator screenshots', () => {
  it('captures the generator, the clips, and a row of variations at phone and Fold widths', async () => {
    mkdirSync(ARTIFACTS, { recursive: true })
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', '4473', '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer('http://127.0.0.1:4473/', child)
      browser = await launch()
      const context = await browser.newContext({
        viewport: { width: 384, height: 832 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 1,
      })
      const page = await context.newPage()
      await shoot(page, 384)
      await shoot(page, 884)
      await context.close()
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 120000)
})
