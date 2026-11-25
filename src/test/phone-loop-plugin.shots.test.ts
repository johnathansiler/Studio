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
        const paint = await page.evaluate(() => {
          const color = (node: Element | null) => node ? getComputedStyle(node).backgroundColor : ''
          const pad = document.querySelector('.bass-pad')
          const root = document.querySelector('.bass-pad.root')
          const white = document.querySelector('.bass-keys button:not(.black)')
          const black = document.querySelector('.bass-keys button.black')
          const selected = document.querySelector('.bass808-tabs button[aria-selected="true"]')
          const idle = document.querySelector('.bass808-tabs button[aria-selected="false"]')
          pad?.classList.add('on')
          white?.classList.add('on')
          black?.classList.add('on')
          const pressed = { pad: color(pad), white: color(white), black: color(black) }
          pad?.classList.remove('on')
          white?.classList.remove('on')
          black?.classList.remove('on')
          const duplicate = [...document.querySelectorAll('#transport-duplicate')].filter((node) => {
            const box = node.getBoundingClientRect()
            return box.width > 0 && box.height > 0
          })
          return {
            pad: color(pad),
            rootBorder: root ? getComputedStyle(root).borderTopColor : '',
            white: color(white),
            black: color(black),
            pressed,
            selected: color(selected),
            idle: color(idle),
            duplicate: duplicate.length,
          }
        })
        const clear = (value: string) => value === 'transparent' || value === 'rgba(0, 0, 0, 0)'
        expect(clear(paint.pad), `pad fill at ${width}`).toBe(false)
        expect(clear(paint.white), `white key at ${width}`).toBe(false)
        expect(clear(paint.black), `black key at ${width}`).toBe(false)
        expect(clear(paint.pressed.pad), `pressed pad at ${width}`).toBe(false)
        expect(clear(paint.pressed.white), `pressed white key at ${width}`).toBe(false)
        expect(clear(paint.pressed.black), `pressed black key at ${width}`).toBe(false)
        expect(paint.pressed.pad, `pressed pad changes at ${width}`).not.toBe(paint.pad)
        expect(clear(paint.rootBorder), `root outline at ${width}`).toBe(false)
        expect(clear(paint.selected), `selected tab at ${width}`).toBe(false)
        expect(clear(paint.idle), `quiet tab at ${width}`).toBe(true)
        expect(paint.duplicate, `no full-width Duplicate while the plugin is open at ${width}`).toBe(0)
        await page.screenshot({ path: `/opt/cursor/artifacts/bass-play-${width}.png` })
        await page.locator('.bass-close').click()
        await page.locator('[data-bass808="open"]').waitFor({ state: 'hidden' })
        await page.locator('[data-track-name="Keys"]').click()
        await page.locator('[data-keyboard-dock="open"]').waitFor()
        await page.locator('[data-track-name="808 Bass 1"]').click()
        await page.locator('[data-bass808="open"]').waitFor()
        await page.locator('[data-keyboard-dock="open"]').waitFor({ state: 'detached' })
        await page.getByRole('tab', { name: 'Tone', exact: true }).click()
        const room = await page.evaluate(() => {
          const plugin = document.querySelector('[data-bass808="open"]') as HTMLElement
          const tone = document.querySelector('.bass-tone') as HTMLElement
          const slot = document.querySelector('.tool-slot') as HTMLElement
          const sample = document.querySelector('.bass-sample') as HTMLElement
          const knobs = document.querySelector('.bass-knobs') as HTMLElement
          const pluginBox = plugin.getBoundingClientRect()
          const sampleBox = sample.getBoundingClientRect()
          const knobBox = knobs.getBoundingClientRect()
          const slotBox = slot.getBoundingClientRect()
          return {
            dock: document.querySelectorAll('[data-keyboard-dock="open"]').length,
            height: pluginBox.height,
            pluginBottom: pluginBox.bottom,
            slotTop: slotBox.top,
            toneClip: tone.scrollHeight - tone.clientHeight,
            sampleTop: sampleBox.top,
            sampleBottom: sampleBox.bottom,
            pluginTop: pluginBox.top,
            knobHeight: knobBox.height,
            knobBottom: knobBox.bottom,
          }
        })
        expect(room.dock, `keyboard dock closed at ${width}`).toBe(0)
        expect(room.height, `808 keeps its height at ${width}`).toBeGreaterThan(400)
        expect(room.pluginBottom, `808 reaches the dock at ${width}`).toBeGreaterThanOrEqual(room.slotTop - 4)
        expect(room.toneClip, `tone clips after the dock closes at ${width}`).toBe(0)
        expect(room.knobHeight, `knobs visible at ${width}`).toBeGreaterThan(20)
        expect(room.knobBottom, `knobs inside the plugin at ${width}`).toBeLessThanOrEqual(room.pluginBottom + 1)
        expect(room.sampleTop, `808 shot inside the plugin at ${width}`).toBeGreaterThanOrEqual(room.pluginTop)
        expect(room.sampleBottom, `808 shot inside the plugin at ${width}`).toBeLessThanOrEqual(room.pluginBottom + 1)
        await page.screenshot({ path: `/opt/cursor/artifacts/bass-reopen-${width}.png` })
        await page.locator('.bass-close').click()
        await page.locator('[data-bass808="open"]').waitFor({ state: 'hidden' })

        const faces = [
          { kind: 'scaler', selector: '[data-scaler="plugin"]' },
          { kind: 'rack', selector: '.rack.inst-panel' },
          { kind: 'pads', selector: '[data-pads="plugin"]' },
          { kind: 'steps', selector: '[data-step-sequencer="open"]' },
          { kind: 'patch', selector: '.patch-sheet' },
        ] as const
        for (const face of faces) {
          await page.evaluate((kind) => {
            const store = (window as unknown as {
              __cueharbor: {
                store: {
                  project: { tracks: { id: string; type: string }[] }
                  setTrackInstrument: (id: string, instrument: string) => void
                  showScaler: (id: string) => void
                  showRack: (id: string) => void
                  showPads: (id: string) => void
                  showPatch: (id: string) => void
                  addQuickTrack: (choice: string) => string | null
                  openSteps: (id: string) => void
                  closeSteps: () => void
                  closePads: () => void
                  closeBass: () => void
                  closeScaler: () => void
                  openRack: (id: string) => void
                  openPatch: (id: string) => void
                  rackTrackId: string | null
                  patchTrackId: string | null
                }
              }
            }).__cueharbor.store
            store.closeSteps()
            store.closePads()
            store.closeBass()
            store.closeScaler()
            if (store.rackTrackId) store.openRack(store.rackTrackId)
            if (store.patchTrackId) store.openPatch(store.patchTrackId)
            const id = store.project.tracks.find((track) => track.type === 'midi')?.id
            if (!id) throw new Error('no midi track')
            if (kind === 'scaler') {
              store.setTrackInstrument(id, 'scaler')
              store.showScaler(id)
            } else if (kind === 'rack') {
              store.setTrackInstrument(id, 'sampler')
              store.showRack(id)
            } else if (kind === 'pads') {
              store.showPads(id)
            } else if (kind === 'steps') {
              const stepId = store.addQuickTrack('steps')
              if (!stepId) throw new Error('no step track')
              store.openSteps(stepId)
            } else {
              store.setTrackInstrument(id, 'synth')
              store.showPatch(id)
            }
          }, face.kind)
          await page.locator(face.selector).waitFor()
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))))
          const hit = await page.evaluate(() => {
            function target(selector: string) {
              const node = document.querySelector(selector)
              if (!(node instanceof HTMLElement)) return { found: false, hit: '' }
              const box = node.getBoundingClientRect()
              const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
              const own = top instanceof Node && (top === node || node.contains(top))
              return {
                found: true,
                own,
                hit: top instanceof Element ? `${top.tagName}.${top.className}` : '',
                width: box.width,
                height: box.height,
              }
            }
            return {
              play: target('.transport .t-btn.play'),
              loop: target('[data-loop-region="arrange"] [data-loop-edge="start"]'),
            }
          })
          expect(hit.play.found, `${face.kind} play button at ${width}`).toBe(true)
          expect(hit.play.own, `${face.kind} play receives the tap at ${width} (${hit.play.hit})`).toBe(true)
          expect(hit.loop.found, `${face.kind} loop grip at ${width}`).toBe(true)
          expect(hit.loop.height, `${face.kind} loop grip height at ${width}`).toBeGreaterThan(8)
          expect(hit.loop.own, `${face.kind} loop grip receives the tap at ${width} (${hit.loop.hit})`).toBe(true)
          if (face.kind === 'scaler' || face.kind === 'rack') {
            await page.screenshot({ path: `/opt/cursor/artifacts/${face.kind}-clear-${width}.png` })
          }
        }
        await page.evaluate(() => {
          const store = (window as unknown as {
            __cueharbor: {
              store: {
                closeSteps: () => void
                closePads: () => void
                closeBass: () => void
                closeScaler: () => void
                openRack: (id: string) => void
                openPatch: (id: string) => void
                rackTrackId: string | null
                patchTrackId: string | null
              }
            }
          }).__cueharbor.store
          store.closeSteps()
          store.closePads()
          store.closeBass()
          store.closeScaler()
          if (store.rackTrackId) store.openRack(store.rackTrackId)
          if (store.patchTrackId) store.openPatch(store.patchTrackId)
        })

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
