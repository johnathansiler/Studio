import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { LIBRARY_TEST_ADDITIONS_PATH, libraryTestObjectUrl } from './libraryRoute'

const catalog = {
  version: 1,
  generated_at: '2026-11-25T00:00:00Z',
  count: 4,
  pending: '',
  entries: [
    { key: 'Loops/sub.wav', size: 200, format: 'wav', pack: 'Bass', type: 'loop', category: 'bass', instrument: 'bass', genre: ['trap'], bpm: 90, bpm_source: 'label', bpm_alt: null, musical_key: 'A minor', root: 'A', note: null, chord: null, mood: [], tags: ['bass'], license: 'private', search: 'sub bass loop trap' },
    { key: 'Loops/warm.wav', size: 200, format: 'wav', pack: 'Bass', type: 'loop', category: 'bass', instrument: 'bass', genre: ['pop'], bpm: 120, bpm_source: 'label', bpm_alt: null, musical_key: 'C major', root: 'C', note: null, chord: null, mood: [], tags: ['bass'], license: 'private', search: 'warm bass loop' },
    { key: 'Loops/piano.wav', size: 200, format: 'wav', pack: 'Keys', type: 'loop', category: 'piano', instrument: 'piano', genre: ['lo-fi'], bpm: 100, bpm_source: 'label', bpm_alt: null, musical_key: 'C major', root: 'C', note: null, chord: null, mood: [], tags: ['piano'], license: 'private', search: 'piano loop' },
    { key: 'Loops/drums.wav', size: 200, format: 'wav', pack: 'Drums', type: 'loop', category: 'drums', instrument: 'drums', genre: ['trap'], bpm: 140, bpm_source: 'label', bpm_alt: null, musical_key: '', root: '', note: null, chord: null, mood: [], tags: ['drums'], license: 'private', search: 'drum loop trap' },
  ],
}
const gzip = gzipSync(Buffer.from(JSON.stringify(catalog)))

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 25000) {
    if (child.exitCode != null) throw new Error(detail || 'server exited')
    try {
      if ((await fetch(url)).ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'server did not start')
}

async function installLibrary(page: Page, origin: string) {
  await page.route('**/*', async (route) => {
    const target = route.request().url()
    if (target.includes('/api/library/sign')) {
      const body = route.request().postDataJSON() as { keys?: string[] }
      const urls = (body.keys ?? []).map((key) => ({ key, url: libraryTestObjectUrl(origin, key) }))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, expiresIn: 900, urls }) })
      return
    }
    if (target.includes('/api/library')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true }) })
      return
    }
    if (target.includes(LIBRARY_TEST_ADDITIONS_PATH)) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    if (target.includes('/library-test/catalog')) {
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: gzip })
      return
    }
    await route.continue()
  })
}

async function bassFit(page: Page) {
  return page.evaluate(() => {
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const hits = (a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }) =>
      a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
    const pads = [...document.querySelectorAll('.bass-pad')].map(box)
    const shift = document.querySelector('.bass-key-shift')
    const keys = document.querySelector('.bass-keys')
    const tone = document.querySelector('.bass-tone')
    const play = document.querySelector('.bass-play')
    const sample = document.querySelector('.bass-sample')
    const shiftBox = shift ? box(shift) : null
    const keysBox = keys ? box(keys) : null
    const toneBox = tone instanceof HTMLElement ? box(tone) : null
    const playBox = play instanceof HTMLElement ? box(play) : null
    const sampleBox = sample ? box(sample) : null
    const padHit = pads.filter((pad) => (shiftBox && hits(pad, shiftBox)) || (keysBox && hits(pad, keysBox)))
    const toneClip = tone instanceof HTMLElement ? Math.max(0, tone.scrollHeight - tone.clientHeight) : 0
    const playClip = play instanceof HTMLElement ? Math.max(0, play.scrollHeight - play.clientHeight) : 0
    const short = [...document.querySelectorAll('.bass-pad, .bass-key-shift button, .bass-keys button, .bass808-tabs button')]
      .map((node) => box(node).height)
      .filter((height) => height > 0 && height < 39.5)
    return {
      tab: document.querySelector('.bass808')?.getAttribute('data-tab') ?? '',
      padHit: padHit.length,
      toneClip,
      playClip,
      short: short.length,
      sampleTop: sampleBox?.top ?? -1,
      toneBottom: toneBox?.bottom ?? -1,
      playBottom: playBox?.bottom ?? -1,
      keysBottom: keysBox?.bottom ?? -1,
    }
  })
}

describe('built app on a phone', () => {
  it('fits the bass plugin and the loop filter at 384 and 884', async () => {
    expect(existsSync('dist/index.html'), 'run npm run build before this screenshot test').toBe(true)
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 8791
    const origin = `http://127.0.0.1:${port}`
    const child = spawn('node', ['--experimental-strip-types', 'server/index.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const browser = await chromium.launch()
    try {
      await waitForServer(origin, child)
      for (const width of [384, 884]) {
        const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: true })
        await installLibrary(page, origin)
        await page.goto(origin, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
        await page.getByRole('button', { name: 'Add Track', exact: true }).click()
        await page.getByRole('button', { name: '808 Bass. Trap and drill slides.', exact: true }).click()
        await page.locator('[data-bass808="open"]').waitFor()
        await page.getByRole('tab', { name: 'Tone', exact: true }).click()
        await page.locator('.bass-sample').waitFor()
        const tone = await bassFit(page)
        expect(tone.toneClip, `tone clips at ${width}`).toBe(0)
        expect(tone.sampleTop, `shot row inside tone at ${width}`).toBeLessThanOrEqual(tone.toneBottom + 1)
        await page.screenshot({ path: `/opt/cursor/artifacts/bass-tone-${width}.png` })
        await page.getByRole('tab', { name: 'Play', exact: true }).click()
        await page.locator('.bass-pad').first().waitFor()
        const play = await bassFit(page)
        expect(play.padHit, `pads overlap the keys at ${width}`).toBe(0)
        expect(play.playClip, `play clips at ${width}`).toBe(0)
        expect(play.short, `controls under 40px at ${width}`).toBe(0)
        expect(play.keysBottom, `keys inside the play pane at ${width}`).toBeLessThanOrEqual(play.playBottom + 1)
        await page.screenshot({ path: `/opt/cursor/artifacts/bass-play-${width}.png` })
        await page.locator('.bass-close').click()
        await page.locator('[data-bass808="open"]').waitFor({ state: 'hidden' })
        await page.locator('[data-track-name="808 Bass 1"]').click()
        await page.locator('[data-bass808="open"]').waitFor()
        await page.screenshot({ path: `/opt/cursor/artifacts/bass-reopen-${width}.png` })
        await page.locator('.bass-close').click()

        await page.getByRole('button', { name: 'Browse', exact: true }).click()
        await page.locator('[data-playlist-browser="open"]').waitFor()
        await page.getByLabel('Library passphrase').fill('harbor-key')
        await page.getByRole('button', { name: 'Unlock', exact: true }).click()
        await page.getByLabel('Search my library').waitFor()
        await page.locator('[data-lane="loops"]').click()
        await page.locator('[data-loop-chip="bass"]').click()
        await page.getByRole('button', { name: 'Filter', exact: true }).click()
        await page.getByRole('button', { name: 'Near tempo', exact: true }).click()
        await page.locator('.loop-filter-sheet').waitFor({ state: 'hidden' })
        await page.locator('[data-library-key="Loops/warm.wav"]').waitFor()
        const calm = await page.evaluate(() => {
          const row = document.querySelector('[data-library-key="Loops/warm.wav"]')!.getBoundingClientRect()
          const jump = [...document.querySelectorAll('.fast-jump button')].map((node) => node.getBoundingClientRect().width)
          return {
            clears: document.querySelectorAll('.loop-clear, .library-clear-all').length,
            libraryBar: document.querySelectorAll('.library-active-bar').length,
            summaries: document.querySelectorAll('.loop-active').length,
            rowTop: row.top,
            rowBottom: row.bottom,
            height: window.innerHeight,
            jump,
          }
        })
        expect(calm.libraryBar, `duplicate filter chips at ${width}`).toBe(0)
        expect(calm.summaries, `one filter summary at ${width}`).toBe(1)
        expect(calm.clears, `one clear at ${width}`).toBe(1)
        expect(calm.rowTop, `loop row on screen at ${width}`).toBeGreaterThan(0)
        expect(calm.rowBottom, `loop row on screen at ${width}`).toBeLessThan(calm.height)
        expect(calm.jump.every((item) => item >= 40), `jump targets at ${width}`).toBe(true)
        await page.screenshot({ path: `/opt/cursor/artifacts/loop-filter-${width}.png` })
        await page.close()
      }
    } finally {
      await browser.close()
      child.kill('SIGTERM')
    }
  }, 120000)
})
