import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { encodeWav } from '../model/wav'
import { NOTE_SURFACES } from '../harbor/surfaces'

const catalogText = readFileSync(new URL('./fixtures/instrument-library.json', import.meta.url), 'utf8')
const wav = Buffer.from(encodeWav([Float32Array.from({ length: 64 }, (_, i) => Math.sin(i / 3) * 0.2)], 48000))

const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '880x1000', width: 880, height: 1000 },
  { name: '1440x900', width: 1440, height: 900 },
] as const

const PLAY = ['Yamaha Upright Piano', 'Meatbass', 'Vsco2 Ce Strings'] as const

async function waitForServer(url: string, child: ChildProcess) {
  const started = Date.now()
  let detail = ''
  child.stdout?.on('data', (chunk) => { detail += String(chunk) })
  child.stderr?.on('data', (chunk) => { detail += String(chunk) })
  while (Date.now() - started < 25000) {
    if (child.exitCode != null) throw new Error(detail || 'vite exited')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(detail || 'vite did not start')
}

const pageErrors: string[] = []

async function showBrowser(page: Page) {
  const arrange = page.getByRole('button', { name: /^Arrange/ }).first()
  if (await arrange.count()) await arrange.click().catch(() => undefined)
  await page.waitForFunction(() => {
    const open = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Browse' || button.getAttribute('aria-label') === 'Browse') as HTMLButtonElement | undefined
    if (!document.querySelector('[data-playlist-browser="open"]')) open?.click()
    const browser = document.querySelector('[data-playlist-browser="open"]')
    const labels = [...(browser?.querySelectorAll('.browser-tabs button') ?? [])].map((button) => button.textContent?.trim())
    return labels.includes('My Library') && labels.includes('Patterns') && labels.includes('Clips') && !labels.includes('Instruments')
  }, undefined, { timeout: 20000 })
}

describe('library instruments on every note surface', () => {
  it('plays a piano, a bass, and strings from each surface at three sizes', async () => {
    const port = 4198
    const url = `http://127.0.0.1:${port}`
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    try {
      await waitForServer(url, child)
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage()
        page.on('pageerror', (error) => pageErrors.push(error.message))
        await page.route('**/*instrument-library*', async (route) => {
          const target = route.request().url()
          if (target.includes('/tree/')) {
            const folder = decodeURIComponent(target.split('/tree/')[1]?.split('?')[0] ?? 'instrument')
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify([
                { type: 'file', path: `${folder}/C3.wav` },
                { type: 'file', path: `${folder}/G3.wav` },
                { type: 'file', path: `${folder}/C4.wav` },
              ]),
            })
            return
          }
          if (target.endsWith('/catalog.json')) {
            await route.fulfill({ status: 200, contentType: 'application/json', body: catalogText })
            return
          }
          await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav })
        })
        for (const viewport of VIEWPORTS) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height })
          await page.goto(url, { waitUntil: 'domcontentloaded' })
          await showBrowser(page)
          expect(await page.locator('[data-harbor]').count()).toBe(0)
          for (const name of PLAY) {
            await page.evaluate(async (wanted) => {
              // A direct import() here is rewritten for Vitest SSR and throws in the page.
              const loadModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
              const load = await loadModule('/src/harbor/load.ts')
              const player = await loadModule('/src/harbor/player.ts')
              const license = await loadModule('/src/harbor/license.ts')
              const programMod = await loadModule('/src/harbor/program.ts')
              const hook = (window as unknown as {
                __cueharbor: {
                  engine: {
                    holdLibraryAudio?: (trackId: string, samples: { id: string; sampleRate: number; channels: Float32Array[] }[]) => void
                    auditionLibrary?: (trackId: string, pitch?: number, velocity?: number) => Promise<void>
                  }
                  store: {
                    addTracks: (input: { kind: string; count: number; instrument: string; input: string; channels: number; armed: boolean }) => string[]
                    setLibrary: (trackId: string, program: unknown) => void
                  }
                }
              }).__cueharbor
              const catalog = await load.loadHarborCatalog(fetch)
              const item = catalog.instruments.find((entry: { name: string }) => entry.name === wanted)
              if (!item) throw new Error('missing ' + wanted)
              const built = await load.prepareCatalogInstrument(item)
              if (!built) throw new Error('no program ' + wanted)
              const target = hook.store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })[0]
              if (!target) throw new Error('no track')
              await player.installHarborInstrument({
                id: `harbor:${item.id}`,
                name: item.name,
                family: item.family,
                license: item.license,
                label: license.licenseLabel(item.license),
                source: item.source ?? '',
                articulations: programMod.articulationsIn(built),
                zones: [],
                program: built,
              }, target, {
                setLibrary: (id: string, program: unknown) => hook.store.setLibrary(id, program),
                holdLibraryAudio: hook.engine.holdLibraryAudio?.bind(hook.engine),
                auditionLibrary: hook.engine.auditionLibrary?.bind(hook.engine),
              })
            }, name)
            await page.waitForFunction((wanted) => {
              const hook = (window as unknown as { __cueharbor?: { store: { project: { tracks: { instrument?: string; library?: { name?: string } }[] } } } }).__cueharbor
              return hook?.store.project.tracks.some((track) => track.instrument === 'library' && track.library?.name === wanted)
            }, name, { timeout: 20000 })
          }
          const key = page.locator('.kit-keys .white').first()
          if (await key.count()) await key.evaluate((element) => (element as HTMLButtonElement).click()).catch(() => undefined)
          const heard = await page.evaluate((surfaces) => {
            const hook = (window as unknown as { __cueharbor?: { engine: { voiceNote: (surface: string, trackId: string, pitch: number, velocity: number, when?: number) => boolean }; store: { project: { tracks: { id: string; instrument?: string }[] } } } }).__cueharbor
            if (!hook) return []
            const track = hook.store.project.tracks.find((item) => item.instrument === 'library')
            if (!track) return []
            const played: string[] = []
            for (const surface of surfaces) {
              const ok = hook.engine.voiceNote(surface, track.id, 60, 0.8, surface === 'arrange' || surface === 'pads' ? 0 : undefined)
              if (ok) played.push(surface)
            }
            return played
          }, [...NOTE_SURFACES])
          expect(heard, viewport.name).toEqual([...NOTE_SURFACES])
          const box = await page.locator('[data-playlist-browser="open"]').boundingBox()
          expect(box, viewport.name).toBeTruthy()
          expect((box?.x ?? 0) + (box?.width ?? 0), viewport.name).toBeLessThanOrEqual(viewport.width + 1)
          await page.screenshot({ path: `/opt/cursor/artifacts/harbor-${viewport.name}.png` })
        }
      } finally {
        await browser.close()
      }
    } finally {
      child.kill('SIGTERM')
    }
  }, 120000)
})
