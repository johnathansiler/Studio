import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { describe, expect, it } from 'vitest'
import { groupLibraryInstruments } from '../library/group'
import { encodeWav } from '../model/wav'

const folder = 'Orchestral/Philharmonia Orchestra All Samples/french horn'
const catalog = {
  version: 1,
  generated_at: '2026-11-11T00:00:00Z',
  count: 4,
  pending: '',
  entries: [
    { key: `${folder}/french-horn_A3_15_piano_normal.mp3`, size: 120, format: 'mp3', pack: 'Philharmonia Orchestra All Samples', type: 'multisample note', category: 'brass', instrument: 'french horn', genre: [], bpm: null, musical_key: '', root: 'A', note: 'A3', mood: [], tags: [], license: 'private', search: 'french horn a3 piano normal' },
    { key: `${folder}/french-horn_C4_15_forte_normal.mp3`, size: 140, format: 'mp3', pack: 'Philharmonia Orchestra All Samples', type: 'multisample note', category: 'brass', instrument: 'french horn', genre: [], bpm: null, musical_key: '', root: 'C', note: 'C4', mood: [], tags: [], license: 'private', search: 'french horn c4 forte normal' },
    { key: `${folder}/french-horn_C4_1_piano_staccato.mp3`, size: 80, format: 'mp3', pack: 'Philharmonia Orchestra All Samples', type: 'multisample note', category: 'brass', instrument: 'french horn', genre: [], bpm: null, musical_key: '', root: 'C', note: 'C4', mood: [], tags: [], license: 'private', search: 'french horn c4 staccato' },
    { key: 'Drums/kick.wav', size: 90, format: 'wav', pack: 'Kit', type: 'one-shot', category: 'kick', instrument: 'kick', genre: [], bpm: null, musical_key: '', root: 'C', note: 'C1', mood: [], tags: [], license: 'private', search: 'kick drum' },
  ],
}

const instruments = groupLibraryInstruments(catalog.entries.map((entry) => ({
  key: entry.key,
  size: entry.size,
  pack: entry.pack,
  type: entry.type,
  category: entry.category,
  note: entry.note,
  root: entry.root,
})))
const horn = instruments.find((item) => item.name === 'French Horn - Normal')
const staccato = instruments.find((item) => item.name === 'French Horn - Staccato')
if (!horn || !staccato) throw new Error('fixture did not group')

const gzip = gzipSync(Buffer.from(JSON.stringify(catalog)))
const wav = Buffer.from(encodeWav([Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 8) * 0.2)], 48000))

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

async function routeLibrary(route: Route, url: string) {
  const target = route.request().url()
  if (target.includes('/api/library/instruments/') && target.endsWith('/notes')) {
    const body = route.request().postDataJSON() as { keys?: string[]; notes?: number[] }
    const keys = body.keys?.length
      ? body.keys
      : (horn?.layers ?? []).filter((layer) => (body.notes ?? []).includes(layer.midi)).map((layer) => layer.key)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ expiresIn: 900, urls: keys.slice(0, 24).map((key) => ({ key, url: `${url}/library-test/audio.wav` })) }),
    })
    return
  }
  const one = target.match(/\/api\/library\/instruments\/(lib_[a-z0-9]+)/)
  if (one && route.request().method() === 'GET') {
    const found = instruments.find((item) => item.id === one[1])
    await route.fulfill({ status: found ? 200 : 404, contentType: 'application/json', body: JSON.stringify(found ?? { error: 'missing' }) })
    return
  }
  if (target.includes('/api/library/instruments')) {
    const summaries = instruments.map(({ layers: _layers, ...summary }) => summary)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ total: summaries.length, offset: 0, limit: 200, instruments: summaries }),
    })
    return
  }
  if (target.includes('/api/library/sign') || target.includes('/api/library')) {
    if (target.includes('/sign')) {
      const body = route.request().postDataJSON() as { keys?: string[] }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: true,
          expiresIn: 900,
          urls: (body.keys ?? ['catalog/catalog.json.gz']).map((key) => ({
            key,
            url: key.endsWith('.gz') ? `${url}/library-test/catalog.json.gz` : `${url}/library-test/audio.wav`,
          })),
        }),
      })
      return
    }
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
}

async function openLibrary(page: Page) {
  await page.getByRole('button', { name: /^Arrange/ }).first().waitFor()
  await page.getByRole('button', { name: 'Browse', exact: true }).click()
  const browserPane = page.locator('[data-playlist-browser="open"]')
  await browserPane.getByRole('button', { name: 'My Library', exact: true }).click()
  await page.getByLabel('Library passphrase').fill('harbor-key')
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await page.getByLabel('Search my library').waitFor()
  return browserPane
}

describe('grouped library instruments on a phone', () => {
  it('lists one row per instrument and loads it across the sampler', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4473
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
      await page.route('**/*', (route) => routeLibrary(route, url))
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      const browserPane = await openLibrary(page)
      await page.locator('.my-library').getByRole('button', { name: 'Instruments', exact: true }).click()
      await expect.poll(async () => page.locator('[data-library-instrument]').count()).toBe(2)
      await expect.poll(async () => page.locator('[data-library-key]').count()).toBe(0)
      await expect.poll(async () => page.getByRole('button', { name: 'Play French Horn - Normal' }).count()).toBe(1)
      await expect.poll(async () => page.getByRole('button', { name: 'Play French Horn - Staccato' }).count()).toBe(1)
      await expect.poll(async () => page.getByText('french-horn_A3').count()).toBe(0)
      await expect.poll(async () => page.getByText('french-horn_C4').count()).toBe(0)
      await page.locator('[data-library-instrument]').first().evaluate((el) => el.scrollIntoView({ block: 'center' }))
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/library-instruments-browse-390.png' })
      await browserPane.getByRole('button', { name: 'Load French Horn - Normal' }).click()
      const face = page.locator('[data-sampler="face"]')
      await face.waitFor()
      await expect.poll(async () => face.innerText()).toContain('French Horn - Normal')
      await expect.poll(async () => face.innerText()).toContain('zones')
      await face.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/library-instruments-sampler-390.png' })
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 60000)
})
