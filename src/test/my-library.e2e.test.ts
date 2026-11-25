import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { encodeWav } from '../model/wav'
import { LIBRARY_TEST_ADDITIONS_PATH, libraryTestObjectUrl } from './libraryRoute'

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
    {
      key: 'Guitar/riff_F#m_100.wav',
      size: 200,
      format: 'wav',
      pack: 'Dusty Keys',
      type: 'loop',
      category: 'guitar',
      instrument: 'electric guitar',
      genre: ['lo-fi'],
      bpm: 100,
      bpm_source: 'label',
      bpm_alt: null,
      musical_key: null,
      root: null,
      note: null,
      chord: null,
      mood: [],
      tags: ['riff'],
      license: 'private',
      search: 'guitar riff loop',
    },
    {
      key: 'audio/bass/Sub_120_C.wav',
      size: 200,
      format: 'wav',
      pack: 'Uploads',
      type: 'loop',
      category: 'bass',
      instrument: 'bass',
      genre: [],
      bpm: 120,
      bpm_source: 'label',
      bpm_alt: null,
      musical_key: 'C major',
      root: 'C',
      note: null,
      chord: null,
      mood: [],
      tags: ['upload', 'loop'],
      license: 'upload',
      search: 'bass loop 120 c major upload',
    },
    {
      key: 'audio/bass/Sub_80_Am.wav',
      size: 200,
      format: 'wav',
      pack: 'Uploads',
      type: 'loop',
      category: 'bass',
      instrument: 'bass',
      genre: [],
      bpm: 80,
      bpm_source: 'label',
      bpm_alt: null,
      musical_key: 'A minor',
      root: 'A',
      note: null,
      chord: null,
      mood: [],
      tags: ['upload', 'loop'],
      license: 'upload',
      search: 'bass loop 80 a minor upload',
    },
    {
      key: 'Pads/warm_A_minor.wav',
      size: 200,
      format: 'wav',
      pack: 'Vocal Pads',
      type: 'loop',
      category: 'pad',
      instrument: 'synth pad',
      genre: ['ambient'],
      bpm: 90,
      bpm_source: 'label',
      bpm_alt: null,
      musical_key: '',
      root: null,
      note: null,
      chord: null,
      mood: [],
      tags: ['warm'],
      license: 'private',
      search: 'warm pad loop',
    },
  ],
}

const gzip = gzipSync(Buffer.from(JSON.stringify(catalog)))
const wav = Buffer.from(encodeWav([Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 8) * 0.4)], 48000))

async function addPill(page: Page) {
  return page.evaluate(() => {
    const add = document.querySelector('.library-add-row .library-add-btn')
    const dock = document.querySelector('.phone-dock-slot, .studio-dock')
    if (!(add instanceof HTMLElement)) return null
    const box = add.getBoundingClientRect()
    const dockBox = dock instanceof HTMLElement ? dock.getBoundingClientRect() : null
    const overlaps = !!dockBox && box.bottom > dockBox.top + 0.5 && box.top < dockBox.bottom - 0.5 && box.right > dockBox.left && box.left < dockBox.right
    return { height: box.height, width: box.width, overlaps }
  })
}

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
        if (target.includes('/api/library/upload-sign')) {
          const header = route.request().headers()['x-library-key']
          if (header !== 'harbor-key') {
            await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'That passphrase does not unlock the library.' }) })
            return
          }
          const body = route.request().postDataJSON() as { keys?: { key: string; size: number }[] }
          const urls = (body.keys ?? []).map((item) => ({ key: item.key, url: `${url}/library-test/upload`, exists: false }))
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, expiresIn: 900, urls }) })
          return
        }
        if (target.includes('/api/library/catalog-append')) {
          const header = route.request().headers()['x-library-key']
          if (header !== 'harbor-key') {
            await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'That passphrase does not unlock the library.' }) })
            return
          }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, added: 1, skipped: 0, version: 2, count: 7 }) })
          return
        }
        if (target.includes('/library-test/upload') && route.request().method() === 'PUT') {
          await route.fulfill({ status: 200, body: '' })
          return
        }
        if (target.includes('/api/library/sign')) {
          const header = route.request().headers()['x-library-key']
          if (header !== 'harbor-key') {
            await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'That passphrase does not unlock the library.' }) })
            return
          }
          const body = route.request().postDataJSON() as { keys?: string[] }
          const urls = (body.keys ?? []).map((key) => ({ key, url: libraryTestObjectUrl(url, key) }))
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, expiresIn: 900, urls }) })
          return
        }
        if (target.includes('/api/library')) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true }) })
          return
        }
        if (target.includes(LIBRARY_TEST_ADDITIONS_PATH)) {
          await route.fulfill({ status: 404, contentType: 'application/json', body: '' })
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
      const additionsMissing = page.waitForResponse((res) => res.url().includes(LIBRARY_TEST_ADDITIONS_PATH))
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      expect((await additionsMissing).status()).toBe(404)
      await page.getByLabel('Search my library').waitFor()
      const addSounds = page.getByRole('button', { name: 'Add sounds', exact: true })
      await addSounds.waitFor()
      const addBox = await addSounds.boundingBox()
      expect(addBox && addBox.height >= 40 && addBox.width >= 40 && addBox.width < 180).toBe(true)
      const pill = await addPill(page)
      expect(pill && pill.height >= 40 && !pill.overlaps).toBe(true)
      await addSounds.click()
      await page.getByLabel('Sound category').fill('bass')
      await page.getByLabel('Sound BPM').fill('96')
      await page.getByLabel('Sound key').fill('A minor')
      expect(await page.getByLabel('WAV files').getAttribute('accept')).toContain('wav')
      await page.getByLabel('WAV files').setInputFiles({ name: 'Finger.wav', mimeType: 'audio/wav', buffer: wav })
      const putDone = page.waitForRequest((req) => req.method() === 'PUT' && req.url().includes('/library-test/upload'))
      const appendDone = page.waitForRequest((req) => req.url().includes('/api/library/catalog-append') && req.method() === 'POST')
      await page.getByRole('button', { name: 'Upload', exact: true }).click()
      const put = await putDone
      const append = await appendDone
      expect(Buffer.from(put.postDataBuffer()!).equals(wav)).toBe(true)
      const appended = append.postDataJSON() as { entries: { key: string; category: string; bit_depth?: number; bpm: number }[] }
      expect(appended.entries[0].key).toBe('audio/bass/Finger.wav')
      expect(appended.entries[0].category).toBe('bass')
      expect(appended.entries[0].bpm).toBe(96)
      expect(appended.entries[0].bit_depth).toBe(16)
      expect(append.headers()['x-library-key']).toBe('harbor-key')
      await page.getByLabel('Search my library').waitFor()
      await addSounds.click()
      await page.getByLabel('Sound category').waitFor({ state: 'hidden' })
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
      await page.locator('.library-filter-sheet').getByRole('button', { name: 'Favorites', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor({ state: 'hidden' })
      await page.locator('[data-library-key="Drums/139_Trap_Click_C.wav"]').waitFor()
      await page.screenshot({ path: '/opt/cursor/artifacts/browse_favorites_star_phone_390.png' })
      await page.getByRole('button', { name: 'Unfavorite 139 Trap Click C' }).click()
      await page.getByRole('button', { name: /^Filter/ }).click()
      await page.locator('.library-filter-sheet').getByRole('button', { name: 'Favorites', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor({ state: 'hidden' })
      await page.getByLabel('Search my library').fill('trap 808 C')
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor()
      await page.evaluate(() => document.fonts.ready)
      await page.waitForFunction(() => {
        const menu = document.querySelector('.library-filter-sheet')
        const facets = document.querySelectorAll('.library-filter-chips > button[data-facet]')
        const list = document.querySelectorAll('.library-filter-list > button')
        return !!menu && menu.getBoundingClientRect().width > 200 && facets.length === 7 && list.length > 1 && (list[0] as HTMLElement).getBoundingClientRect().height >= 40
      })
      const grid = await page.evaluate(() => {
        const box = (node: Element) => node.getBoundingClientRect()
        const facets = [...document.querySelectorAll('.library-filter-chips > button[data-facet]')]
        const options = [...document.querySelectorAll('.library-filter-list > button')]
        const lock = document.querySelector('.library-lock-btn')
        const search = document.querySelector('.library-sticky') as HTMLElement | null
        const row = document.querySelector('.my-library .sound-row') as HTMLElement | null
        const clipped = (node: Element) => node.scrollWidth > node.clientWidth + 1
        return {
          labels: facets.map((node) => node.textContent?.trim() ?? ''),
          facetHeights: facets.map((node) => Math.round(box(node).height)),
          optionHeights: options.map((node) => Math.round(box(node).height)),
          lockHeight: lock ? Math.round(box(lock).height) : 0,
          lockInsideList: !!lock?.closest('.library-filter-list, .library-filter-chips'),
          quick: [...document.querySelectorAll('.library-quick')].map((node) => ({ t: node.textContent?.trim() ?? '', w: Math.round(box(node).width), h: Math.round(box(node).height) })),
          clipped: facets.some(clipped),
          sticky: search ? getComputedStyle(search).position : '',
          rowHeight: row ? getComputedStyle(row).height : '',
          rowGap: row ? getComputedStyle(row).marginBottom : '',
        }
      })
      expect(grid.labels).toEqual(['Type', 'Instrument', 'Key', 'BPM', 'Genre', 'Mood', 'Pack'])
      expect(grid.quick.map((item) => item.t)).toEqual(['Recent', 'Favorites'])
      expect(Math.min(...grid.quick.map((item) => item.h))).toBeGreaterThanOrEqual(40)
      expect(Math.min(...grid.facetHeights)).toBeGreaterThanOrEqual(40)
      expect(Math.min(...grid.optionHeights)).toBeGreaterThanOrEqual(40)
      expect(grid.lockHeight).toBeGreaterThanOrEqual(40)
      expect(grid.lockInsideList).toBe(false)
      expect(grid.clipped).toBe(false)
      expect(grid.sticky).toBe('sticky')
      expect(grid.rowHeight).toBe('64px')
      expect(grid.rowGap).toBe('6px')
      await page.locator('.library-filter-sheet').getByRole('button', { name: 'One-shots', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: /^Filter/ }).click()
      await page.getByRole('button', { name: 'Genre', exact: true }).click()
      await page.getByRole('button', { name: 'Trap', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor({ state: 'hidden' })
      await expect.poll(async () => page.locator('[data-library-key="Drums/139_Trap_Click_C.wav"]').count()).toBe(1)
      await expect.poll(async () => page.locator('[data-library-key="Bass/C_sharp.wav"]').count()).toBe(0)
      const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)
      expect(await overflow()).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/my-library-search-390.png' })
      await page.setViewportSize({ width: 344, height: 844 })
      await page.locator('[data-library-key="Drums/139_Trap_Click_C.wav"]').scrollIntoViewIfNeeded()
      expect(await overflow()).toBe(true)
      await page.getByRole('button', { name: 'Clear all', exact: true }).click()
      await page.getByLabel('Search my library').fill('')
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor()
      await page.screenshot({ path: '/opt/cursor/artifacts/filter_chips_phone.png' })
      await page.getByRole('button', { name: 'Key', exact: true }).click()
      await page.getByRole('button', { name: 'Project key', exact: false }).waitFor()
      expect(await page.getByRole('button', { name: 'Project key' }).isEnabled()).toBe(true)
      await page.getByRole('button', { name: 'C major', exact: true }).waitFor()
      expect(await overflow()).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/key_picker_phone.png' })
      const majorKeys = page.locator('.library-key-grid').first()
      const keyScroll = await majorKeys.evaluate((el) => ({ scroll: el.scrollWidth > el.clientWidth + 1, button: (el.querySelector('button') as HTMLElement | null)?.getBoundingClientRect().width ?? 0 }))
      expect(keyScroll.scroll).toBe(true)
      expect(keyScroll.button).toBeGreaterThanOrEqual(44)
      await majorKeys.evaluate((el) => { el.scrollLeft = el.scrollWidth })
      const bMajor = await page.getByRole('button', { name: 'B major', exact: true }).boundingBox()
      expect(bMajor && bMajor.x >= -1 && bMajor.x + bMajor.width <= 345).toBe(true)
      await page.getByRole('button', { name: 'F# minor', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor({ state: 'hidden' })
      await expect.poll(async () => page.locator('[data-library-key="Guitar/riff_F#m_100.wav"]').count()).toBe(1)
      await expect.poll(async () => page.locator('[data-library-key="Pads/warm_A_minor.wav"]').count()).toBe(0)
      await expect.poll(async () => page.locator('[data-sound-key="F#m"]').count()).toBe(1)
      await page.screenshot({ path: '/opt/cursor/artifacts/key_results_phone.png' })
      await page.getByRole('button', { name: 'Clear all', exact: true }).click()
      await page.setViewportSize({ width: 768, height: 1024 })
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      await page.getByRole('button', { name: 'Key', exact: true }).click()
      await page.getByRole('button', { name: 'Also relative', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor()
      expect(await overflow()).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/key_picker_fold.png' })
      await page.getByRole('button', { name: 'C major', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor({ state: 'hidden' })
      await expect.poll(async () => page.locator('[data-sound-key="Am"]').count()).toBeGreaterThan(0)
      await expect.poll(async () => page.locator('[data-library-key="Guitar/riff_F#m_100.wav"]').count()).toBe(0)
      await page.screenshot({ path: '/opt/cursor/artifacts/key_results_fold.png' })
      await page.getByRole('button', { name: 'Clear all', exact: true }).click()
      await page.getByLabel('Search my library').fill('')
      await page.locator('[data-lane="oneshots"]').click()
      await page.locator('[data-drum-chip="bass"]').waitFor()
      expect(await page.locator('[data-drum-chip="bass"]').innerText()).toMatch(/Bass/)
      await page.locator('[data-lane="drums"]').click()
      await expect.poll(async () => page.locator('[data-drum-chip="bass"]').count()).toBe(0)
      await expect.poll(async () => page.locator('[data-library-key="Bass/C_sharp.wav"]').count()).toBe(0)
      await page.locator('[data-lane="drums"]').click()
      await page.locator('[data-lane="loops"]').click()
      await page.locator('[data-loop-chip="bass"]').waitFor()
      expect(await page.locator('[data-loop-chip="bass"]').innerText()).toMatch(/Bass\s+2/)
      await page.locator('[data-loop-chip="bass"]').click()
      await page.getByRole('button', { name: 'Near tempo', exact: true }).click()
      await page.getByRole('button', { name: 'In C', exact: true }).click()
      await expect.poll(async () => page.locator('[data-library-key="audio/bass/Sub_120_C.wav"]').count()).toBe(1)
      await expect.poll(async () => page.locator('[data-library-key="audio/bass/Sub_80_Am.wav"]').count()).toBe(0)
      await page.locator('[data-loop-chip="all"]').click()
      await page.getByRole('button', { name: 'Clear all', exact: true }).click()
      await page.setViewportSize({ width: 384, height: 844 })
      const phonePill = await addPill(page)
      expect(phonePill && phonePill.height >= 40 && phonePill.width >= 40 && phonePill.width < 180 && !phonePill.overlaps).toBe(true)
      await page.getByRole('button', { name: 'Add sounds', exact: true }).click()
      const formClear = await page.evaluate(() => {
        const form = document.querySelector('.library-add-form')
        const dock = document.querySelector('.phone-dock-slot, .studio-dock')
        if (!(form instanceof HTMLElement)) return null
        const box = form.getBoundingClientRect()
        const dockBox = dock instanceof HTMLElement ? dock.getBoundingClientRect() : null
        const overlaps = !!dockBox && box.bottom > dockBox.top + 0.5 && box.top < dockBox.bottom - 0.5 && box.right > dockBox.left && box.left < dockBox.right
        return { overlaps, height: box.height }
      })
      expect(formClear && !formClear.overlaps).toBe(true)
      await page.getByRole('button', { name: 'Add sounds', exact: true }).click()
      await page.getByLabel('Sound category').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      await page.getByRole('button', { name: 'Type', exact: true }).click()
      await page.locator('.library-filter-sheet').getByRole('button', { name: 'Loops', exact: true }).click()
      await page.locator('.library-filter-sheet').waitFor({ state: 'hidden' })
      await expect.poll(async () => page.locator('.sound-row[data-content-type="loop"]').count()).toBeGreaterThan(0)
      await expect.poll(async () => page.locator('.sound-row[data-content-type="one-shot"]').count()).toBe(0)
      await expect.poll(async () => page.locator('.sound-row[data-content-type="sfx"]').count()).toBe(0)
      await expect.poll(async () => page.locator('[data-lane="loops"].on').innerText()).toContain('Loops')
      const chipSeen = await page.locator('[data-lane="loops"].on').evaluate((node) => {
        const box = node.getBoundingClientRect()
        const sheet = document.querySelector('[data-playlist-browser="open"]')?.getBoundingClientRect()
        return box.height >= 40 && box.top >= (sheet?.top ?? 0) && box.bottom <= window.innerHeight
      })
      expect(chipSeen).toBe(true)
      await page.evaluate(() => {
        const list = document.querySelector('.sound-list')
        let el: HTMLElement | null = list instanceof HTMLElement ? list : null
        while (el) {
          const overflow = getComputedStyle(el).overflowY
          if (overflow === 'auto' || overflow === 'scroll') {
            el.scrollTop = el.scrollHeight
            break
          }
          el = el.parentElement
        }
      })
      await expect.poll(async () => page.locator('[data-sound-bpm="100"]').count()).toBeGreaterThan(0)
      await page.screenshot({ path: '/opt/cursor/artifacts/loops_list_384.png' })
      await page.getByRole('button', { name: /^Filter/ }).click()
      await page.getByRole('button', { name: 'Type', exact: true }).click()
      await page.locator('[data-content-type="loop"][aria-pressed="true"]').waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/loops_filter_384.png' })
      await page.setViewportSize({ width: 884, height: 1104 })
      await page.locator('.playlist-browser.bottom-sheet').waitFor()
      await page.locator('[data-content-type="loop"][aria-pressed="true"]').waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: '/opt/cursor/artifacts/loops_filter_884.png' })
      await page.keyboard.press('Escape')
      await page.locator('.library-filter-sheet').waitFor({ state: 'hidden' })
      const widePill = await addPill(page)
      expect(widePill && widePill.height >= 40 && widePill.width >= 40 && widePill.width < 180 && !widePill.overlaps).toBe(true)
      await page.locator('[data-lane="loops"].on').click()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByLabel('Search my library').fill('trap 808 C')
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
  }, 90000)
})
