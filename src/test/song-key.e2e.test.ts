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
  count: 2,
  pending: '',
  entries: [
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
      musical_key: '',
      root: null,
      note: null,
      chord: null,
      mood: [],
      tags: ['riff'],
      license: 'private',
      search: 'guitar riff',
    },
    {
      key: 'Drums/kick.wav',
      size: 200,
      format: 'wav',
      pack: 'Trap Drums',
      type: 'one-shot',
      category: 'kick',
      instrument: 'kick',
      genre: [],
      bpm: null,
      musical_key: '',
      tags: [],
      license: 'private',
      search: 'kick',
    },
  ],
}

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

async function shots(page: Page, name: string) {
  await page.setViewportSize({ width: 384, height: 844 })
  await page.screenshot({ path: `/opt/cursor/artifacts/${name}_384.png` })
  await page.setViewportSize({ width: 884, height: 1104 })
  await page.screenshot({ path: `/opt/cursor/artifacts/${name}_884.png` })
  await page.setViewportSize({ width: 384, height: 844 })
}

describe('song key from Detect', () => {
  it('keeps the filter as a filter, sets the song key from Detect, and asks on the next loop', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const port = 4475
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let browser: Browser | null = null
    try {
      await waitForServer(url, child)
      browser = await chromium.launch({
        headless: true,
        executablePath: '/usr/bin/google-chrome',
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      const page = await browser.newPage({ viewport: { width: 384, height: 844 }, hasTouch: true, isMobile: true })
      await page.route('**/*', async (route) => {
        const target = route.request().url()
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
      await page.waitForFunction(() => Boolean((window as unknown as { __cueharbor?: { store?: { project?: { tempo?: number } } } }).__cueharbor?.store))
      const seeded = await page.evaluate(() => {
        const store = (window as unknown as {
          __cueharbor: {
            store: {
              project: { tempo: number; sampleRate: number; tracks: { id: string; name: string; type: string }[]; scale?: { keySet?: boolean; root?: number } }
              addAsset: (asset: { id: string; name: string; sampleRate: number; channels: Float32Array[] }) => void
              addAudioClip: (trackId: string, clip: Record<string, unknown>) => void
              rememberClipHearing: (trackId: string, clipId: string, hearing: Record<string, unknown>) => void
              scaleState: () => { keySet?: boolean; root: number; scale: string }
            }
          }
        }).__cueharbor.store
        const track = store.project.tracks.find((item) => item.type === 'audio' && item.name === 'Music')!
        const rate = store.project.sampleRate
        store.addAsset({ id: 'detect-buf', name: 'Detected loop', sampleRate: rate, channels: [new Float32Array(rate)] })
        store.addAudioClip(track.id, {
          id: 'detect-clip',
          name: 'Detected loop',
          bufferId: 'detect-buf',
          startSample: 0,
          offsetSamples: 0,
          durationSamples: rate,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          gain: 1,
          source: 'import',
          stretch: { sourceSamples: rate, semitones: 0, cents: 0, mode: 'pro', followTempo: true, sourceBpm: store.project.tempo, markers: [] },
        })
        store.rememberClipHearing(track.id, 'detect-clip', {
          key: 'A minor',
          root: 9,
          scale: 'aeolian',
          confidence: 0.86,
          alt: 'C major',
          altRoot: 0,
          altScale: 'ionian',
          altConfidence: 0.62,
          clearKey: true,
          bpm: 96,
          bpmConfidence: 0.4,
          cents: 0,
        })
        return { tempo: store.project.tempo, root: store.scaleState().root, keySet: store.scaleState().keySet === true }
      })
      expect(seeded.keySet).toBe(false)
      await page.getByRole('button', { name: 'Set song key to A minor' }).waitFor()
      const hearing = page.locator('[data-clip-hearing]')
      await expect.poll(async () => hearing.innerText()).toContain('Scale: natural minor')
      expect(await hearing.innerText()).not.toMatch(/tempo/i)
      expect(await page.locator('[data-hearing-bpm]').count()).toBe(0)
      await shots(page, 'song_key_detect')

      await page.getByRole('button', { name: 'Browse', exact: true }).click()
      await page.locator('[data-playlist-browser="open"]').waitFor()
      await page.getByRole('button', { name: 'My Library', exact: true }).click()
      await page.getByLabel('Library passphrase').fill('harbor-key')
      await page.getByRole('button', { name: 'Unlock', exact: true }).click()
      await page.getByLabel('Search my library').waitFor()
      await page.getByRole('button', { name: /^Filter/ }).click()
      await page.getByRole('button', { name: 'Key', exact: true }).click()
      await page.getByRole('button', { name: 'F# minor', exact: true }).click()
      const filtered = await page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { project: { tempo: number }; scaleState: () => { keySet?: boolean; root: number; scale: string } } } }).__cueharbor.store
        const scale = store.scaleState()
        return { tempo: store.project.tempo, root: scale.root, scale: scale.scale, keySet: scale.keySet === true }
      })
      expect(filtered).toEqual({ tempo: seeded.tempo, root: 0, scale: 'ionian', keySet: false })
      await page.getByRole('button', { name: 'Clear all', exact: true }).click()
      await page.getByRole('button', { name: 'Browse', exact: true }).click()
      await page.locator('[data-playlist-browser="open"]').waitFor({ state: 'hidden' })

      await page.getByRole('button', { name: 'Set song key to A minor' }).click()
      await expect.poll(async () => page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { project: { tempo: number }; scaleState: () => { root: number; scale: string; keySet?: boolean } } } }).__cueharbor.store
        const scale = store.scaleState()
        return { tempo: store.project.tempo, root: scale.root, scale: scale.scale, keySet: scale.keySet === true }
      })).toEqual({ tempo: seeded.tempo, root: 9, scale: 'aeolian', keySet: true })
      await page.locator('[data-song-key="Am"]').first().waitFor()
      await shots(page, 'song_key_set')

      await page.getByRole('button', { name: 'Browse', exact: true }).click()
      await page.locator('[data-playlist-browser="open"]').waitFor()
      await page.getByLabel('Search my library').fill('riff')
      await page.getByRole('button', { name: 'Load riff F#m 100' }).evaluate((node) => (node as HTMLButtonElement).click())
      await page.locator('[data-key-shift-prompt]').waitFor()
      await page.getByRole('button', { name: 'Browse', exact: true }).click()
      await page.locator('[data-playlist-browser="open"]').waitFor({ state: 'hidden' })
      await page.evaluate(() => (window as unknown as { __cueharbor: { store: { dismissSmartTempo: () => void } } }).__cueharbor.store.dismissSmartTempo())
      await expect.poll(async () => page.locator('[data-key-shift-prompt]').innerText()).toContain('Change this loop to the song key (A minor)?')
      expect(await page.evaluate(() => (window as unknown as { __cueharbor: { store: { project: { tempo: number } } } }).__cueharbor.store.project.tempo)).toBe(seeded.tempo)
      await shots(page, 'song_key_prompt')

      await page.locator('[data-key-shift="keep"]').click()
      await page.locator('[data-key-shift-prompt]').waitFor({ state: 'hidden' })
      await page.locator('[data-shift-to-song]').waitFor()
      expect(await page.locator('[data-shift-to-song]').innerText()).toContain('Shift to song key (A minor)')
      const kept = await page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { project: { tempo: number; tracks: Array<{ clips: Array<{ loopKey?: string; stretch?: { semitones?: number } }> }> } } } }).__cueharbor.store
        const clips = store.project.tracks.flatMap((track) => track.clips)
        const loop = clips.find((clip) => clip.loopKey === 'F# minor')
        return { tempo: store.project.tempo, semitones: loop?.stretch?.semitones ?? 0 }
      })
      expect(kept).toEqual({ tempo: seeded.tempo, semitones: 0 })
      await shots(page, 'song_key_shift')

      await page.locator('[data-shift-to-song]').click()
      await page.locator('[data-key-revert]').waitFor()
      expect(await page.locator('[data-key-revert]').innerText()).toContain('Revert to original')
      const shifted = await page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { project: { tempo: number; tracks: Array<{ clips: Array<{ loopKey?: string; stretch?: { semitones?: number } }> }> } } } }).__cueharbor.store
        const loop = store.project.tracks.flatMap((track) => track.clips).find((clip) => clip.loopKey === 'F# minor')
        return { tempo: store.project.tempo, semitones: loop?.stretch?.semitones ?? 0 }
      })
      expect(shifted.tempo).toBe(seeded.tempo)
      expect(shifted.semitones).not.toBe(0)
      await shots(page, 'song_key_revert')

      await page.locator('[data-key-revert]').click()
      await expect.poll(async () => page.evaluate(() => {
        const store = (window as unknown as { __cueharbor: { store: { project: { tempo: number; tracks: Array<{ clips: Array<{ loopKey?: string; stretch?: { semitones?: number } }> }> } } } }).__cueharbor.store
        const loop = store.project.tracks.flatMap((track) => track.clips).find((clip) => clip.loopKey === 'F# minor')
        return { tempo: store.project.tempo, semitones: loop?.stretch?.semitones ?? 0 }
      })).toEqual({ tempo: seeded.tempo, semitones: 0 })
    } finally {
      await browser?.close()
      child.kill('SIGTERM')
    }
  }, 120000)
})
