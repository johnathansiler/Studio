import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { chromium, type Browser } from 'playwright'
import { describe, expect, it } from 'vitest'
import { encodeWav } from '../model/wav'

const catalog = {
  version: 1,
  generated_at: '2026-11-11T00:00:00Z',
  count: 4,
  pending: '',
  entries: [
    {
      key: 'Drums/139_Trap_Click_C.wav',
      size: 200,
      format: 'wav',
      pack: 'Trap Drums',
      type: 'one-shot',
      category: 'kick',
      instrument: '808 bass',
      genre: ['trap'],
      bpm: 140,
      bpm_source: 'label',
      bpm_alt: null,
      musical_key: 'C',
      root: 'C',
      note: 'C2',
      chord: null,
      mood: ['gritty'],
      tags: ['drum machine'],
      license: 'private',
      search: 'trap 808 click c one shot kick drum',
    },
    {
      key: 'Bass/C_sharp.wav',
      size: 200,
      format: 'wav',
      pack: 'Finger Bass',
      type: 'one-shot',
      category: 'bass',
      instrument: 'electric bass',
      genre: [],
      bpm: null,
      bpm_source: null,
      bpm_alt: null,
      musical_key: null,
      root: 'C#',
      note: 'C#2',
      chord: null,
      mood: [],
      tags: [],
      license: 'private',
      search: 'bass electric c# one shot',
    },
    {
      key: 'Choir/vocal_pad.wav',
      size: 200,
      format: 'wav',
      pack: 'Vocal Pads',
      type: 'loop',
      category: 'choir',
      instrument: 'choir',
      genre: ['lo-fi'],
      bpm: 100,
      bpm_source: 'label',
      bpm_alt: null,
      musical_key: 'A minor',
      root: 'A',
      note: null,
      chord: null,
      mood: ['ethereal'],
      tags: ['pad'],
      license: 'private',
      search: 'choir pad loop vocal ethereal',
    },
    {
      key: 'FX/vinyl_crackle.wav',
      size: 200,
      format: 'wav',
      pack: 'Special Sauce',
      type: 'sfx',
      category: 'fx',
      instrument: 'vinyl crackle',
      genre: [],
      bpm: null,
      bpm_source: null,
      bpm_alt: null,
      musical_key: null,
      root: null,
      note: null,
      chord: null,
      mood: ['vintage'],
      tags: ['vinyl', 'crackle'],
      license: 'private',
      search: 'vinyl crackle texture sfx vintage',
    },
  ],
}

const gzip = gzipSync(Buffer.from(JSON.stringify(catalog)))
const wav = Buffer.from(encodeWav([Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 8) * 0.4)], 48000))

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

describe('my library on a phone', () => {
  it('searches, filters, and loads a private sound onto a pad', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4471
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
      await page.route('**/*', async (route) => {
        const target = route.request().url()
        if (target.includes('/api/library/sign')) {
          const header = route.request().headers()['x-library-key']
          if (header !== 'harbor-key') {
            await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'That passphrase does not unlock the library.' }) })
            return
          }
          const body = route.request().postDataJSON() as { keys?: string[] }
          const urls = (body.keys ?? []).map((key) => ({
            key,
            url: key.endsWith('.gz') ? `${url}/library-test/catalog.json.gz` : `${url}/library-test/audio.wav`,
          }))
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, expiresIn: 900, urls }) })
          return
        }
        if (target.includes('/api/library')) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true }) })
          return
        }
        if (target.includes('/library-test/catalog')) {
          await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: gzip })
          return
        }
        if (target.includes('/library-test/audio')) {
          await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav })
          return
        }
        await route.continue()
      })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      await page.getByRole('button', { name: 'Browse', exact: true }).click()
      const browserPane = page.locator('[data-playlist-browser="open"]')
      await browserPane.getByRole('button', { name: 'My Library', exact: true }).click()
      await page.getByLabel('Library passphrase').fill('harbor-key')
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.getByLabel('Search my library').waitFor()
      await page.getByRole('button', { name: 'Play 139 Trap Click C' }).click()
      const kept = page.locator('[data-browse-id="sound:Drums/139_Trap_Click_C.wav"].is-kept')
      await kept.waitFor()
      await page.getByRole('button', { name: 'Favorite 139 Trap Click C' }).click()
      await page.getByRole('button', { name: 'Unfavorite 139 Trap Click C' }).waitFor()
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      await page.getByRole('button', { name: 'Recent', exact: true }).waitFor()
      await page.screenshot({ path: '/opt/cursor/artifacts/browse_favorites_phone_390.png' })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Browse', exact: true }).click()
      await page.locator('[data-playlist-browser="open"]').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Browse', exact: true }).click()
      await page.locator('[data-playlist-browser="open"]').waitFor()
      await kept.waitFor()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
      if (await page.locator('[data-playlist-browser="open"]').count() === 0) {
        await page.getByRole('button', { name: 'Browse', exact: true }).click()
      }
      await kept.waitFor()
      await page.getByRole('button', { name: 'Unfavorite 139 Trap Click C' }).waitFor()
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      await page.getByRole('button', { name: 'Favorites', exact: true }).click()
      await page.keyboard.press('Escape')
      await page.locator('[data-library-key="Drums/139_Trap_Click_C.wav"]').waitFor()
      await page.getByRole('button', { name: 'Unfavorite 139 Trap Click C' }).click()
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      await page.getByRole('button', { name: 'Favorites', exact: true }).click()
      await page.keyboard.press('Escape')
      await page.getByLabel('Search my library').fill('trap 808 C')
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor()
      await page.evaluate(() => document.fonts.ready)
      await page.waitForFunction(() => {
        const menu = document.querySelector('.library-filter-sheet')
        const facets = document.querySelectorAll('.library-filter-grid > button[data-facet]')
        return !!menu && menu.getBoundingClientRect().width > 200 && facets.length === 8 && facets[0].getBoundingClientRect().height >= 40
      })
      const grid = await page.evaluate(() => {
        const box = (node: Element) => node.getBoundingClientRect()
        const facets = [...document.querySelectorAll('.library-filter-grid > button[data-facet]')]
        const options = [...document.querySelectorAll('.library-filter-grid > button[data-value]')]
        const lock = document.querySelector('.library-lock-btn')
        const widths = (nodes: Element[]) => nodes.map((node) => Math.round(box(node).width))
        const heights = (nodes: Element[]) => nodes.map((node) => Math.round(box(node).height))
        const clipped = (node: Element) => node.scrollWidth > node.clientWidth + 1
        const facetBoxes = facets.map(box)
        return {
          facetWidths: widths(facets),
          facetHeights: heights(facets),
          columns: new Set(facetBoxes.map((item) => Math.round(item.left))).size,
          optionWidths: widths(options),
          optionHeights: heights(options),
          lockHeight: lock ? Math.round(box(lock).height) : 0,
          lockInsideGrid: !!lock?.closest('.library-filter-grid'),
          quick: [...document.querySelectorAll('.library-quick')].map((node) => ({ t: node.textContent?.trim() ?? '', w: Math.round(box(node).width), h: Math.round(box(node).height) })),
          clipped: [...facets, ...options].some(clipped),
        }
      })
      expect(grid.quick.map((item) => item.t)).toEqual(['Recent', 'Favorites'])
      expect(grid.quick[0].w).toBe(grid.quick[1].w)
      expect(Math.min(...grid.quick.map((item) => item.h))).toBeGreaterThanOrEqual(40)
      expect(grid.facetWidths).toHaveLength(8)
      expect(grid.columns).toBe(4)
      expect(new Set(grid.facetWidths).size).toBe(1)
      expect(Math.min(...grid.facetHeights)).toBeGreaterThanOrEqual(40)
      expect(grid.optionWidths.length).toBeGreaterThan(1)
      expect(new Set(grid.optionWidths).size).toBe(1)
      expect(grid.optionWidths[0]).toBe(grid.facetWidths[0])
      expect(Math.min(...grid.optionHeights)).toBeGreaterThanOrEqual(40)
      expect(grid.lockHeight).toBeGreaterThanOrEqual(40)
      expect(grid.lockInsideGrid).toBe(false)
      expect(grid.clipped).toBe(false)
      await page.getByRole('button', { name: 'One-shot', exact: true }).click()
      await page.getByRole('button', { name: 'Genre', exact: true }).click()
      await page.getByRole('button', { name: 'Trap', exact: true }).click()
      await expect.poll(async () => page.locator('[data-library-key="Drums/139_Trap_Click_C.wav"]').count()).toBe(1)
      await expect.poll(async () => page.locator('[data-library-key="Bass/C_sharp.wav"]').count()).toBe(0)
      const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)
      expect(await overflow()).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/my-library-search-390.png' })
      await page.setViewportSize({ width: 360, height: 740 })
      await page.locator('[data-library-key="Drums/139_Trap_Click_C.wav"]').scrollIntoViewIfNeeded()
      expect(await overflow()).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/my-library-search-360.png' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.keyboard.press('Escape')
      await page.locator('.library-filter-sheet').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Load 139 Trap Click C' }).click()
      const pads = page.locator('[data-pads="plugin"]')
      await pads.waitFor()
      await expect.poll(async () => pads.locator('[data-pad="0"]').getAttribute('title')).toContain('139 Trap Click C')
      await page.screenshot({ path: '/opt/cursor/artifacts/my-library-pad-390.png' })
      expect(await overflow()).toBe(true)
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 60000)
})
