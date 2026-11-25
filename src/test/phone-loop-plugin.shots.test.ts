import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { buildFastRows } from '../library/fastBrowse'
import type { LibraryEntry } from '../library/types'
import { FastShelf } from '../ui/MyLibrary'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = ['src/styles.css', 'src/ui/sound-browser.css', 'src/ui/screenOverlay.css', 'src/ui/pluginStage.css', 'src/ui/bass808.css', 'src/ui/bottomSheet.css']
  .map((file) => readFileSync(resolve(root, file), 'utf8'))
  .join('\n')

function entry(patch: Partial<LibraryEntry> & Pick<LibraryEntry, 'key' | 'name'>): LibraryEntry {
  return {
    size: 10, format: 'wav', pack: '', type: 'loop', category: 'bass', instrument: '',
    genre: ['trap'], bpm: 90, bpmAlt: null, musicalKey: 'A minor', root: '', note: '', mood: [], tags: [], license: 'private',
    ...patch,
  }
}

const loops = [
  entry({ key: 'Loops/bass.wav', name: 'Sub Bass', category: 'bass', genre: ['trap'], musicalKey: 'A minor', bpm: 90 }),
  entry({ key: 'Loops/piano.wav', name: 'Piano Chords', category: 'piano', genre: ['lo-fi'], musicalKey: 'C major', bpm: 100 }),
  entry({ key: 'Loops/drums.wav', name: 'Trap Drums', category: 'drums', genre: ['trap'], musicalKey: '', bpm: 140 }),
]

const noop = () => undefined

describe('phone loop filter and plugin clearance', () => {
  it('keeps the first matching loop visible after two filters, at 384 and 884', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const model = buildFastRows({
      entries: loops.filter((item) => item.category === 'bass' && item.genre.includes('trap')),
      mode: 'loop', category: 'bass', sub: '', genre: 'trap', sort: 'name',
      collapsed: new Set(), favoriteKeys: [], recentKeys: [],
    })
    const shelf = renderToStaticMarkup(createElement(FastShelf, {
      mode: 'loop', model, category: 'bass', sub: '', genre: 'trap', sort: 'name',
      nearTempo: true, inKey: true, compatible: false, songKey: 'Am', stuck: '', tempoCenter: 90,
      onCategory: noop, onSub: noop, onGenre: noop, onSort: noop, onNearTempo: noop, onTempo: noop,
      onInKey: noop, onCompatible: noop, onJump: noop, onStep: noop, onToggleStuck: noop,
    }))
    const row = `<div class="sound-row" data-library-key="Loops/bass.wav"><button type="button" class="sound-copy"><strong>Sub Bass</strong><span class="sound-meta">Loop · 90 bpm</span></button></div>`
    const browser = await chromium.launch()
    try {
      for (const width of [384, 884]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } })
        await page.setContent(`<!doctype html><html><head><style>
          html, body { margin: 0; background: #101614; color: #f4f4f4; }
          ${css}
          .stage { width: ${width}px; height: 800px; display: flex; flex-direction: column; }
          .transport { height: 56px; flex: none; }
          .playlist-browser.bottom-sheet { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
          .bottom-sheet-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
          .my-library { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
          .library-sticky { flex: none; }
          .sound-list { flex: 1 1 auto; min-height: 148px; overflow: auto; }
        </style></head><body>
          <div class="shell phone stage">
            <div class="transport"><button type="button" class="t-btn play" aria-label="Play">Play</button></div>
            <aside class="playlist-browser bottom-sheet" data-playlist-browser="open">
              <div class="bottom-sheet-body">
                <div class="sound-panel my-library">
                  <div class="library-sticky">${shelf}</div>
                  <div class="sound-list" aria-label="Library sounds">${row}</div>
                </div>
              </div>
            </aside>
          </div>
        </body></html>`, { waitUntil: 'load' })
        const fit = await page.evaluate(() => {
          const loop = document.querySelector('[data-library-key="Loops/bass.wav"]') as HTMLElement
          const box = loop.getBoundingClientRect()
          const sheet = document.querySelector('.loop-filter-sheet')
          const sheetBox = sheet instanceof HTMLElement && !sheet.hidden && sheet.getClientRects().length ? sheet.getBoundingClientRect() : null
          const covered = !!sheetBox && box.top < sheetBox.bottom - 1 && box.bottom > sheetBox.top + 1
          const transport = document.querySelector('.transport')!.getBoundingClientRect()
          return {
            visible: box.height >= 40 && box.top >= transport.bottom - 1 && box.bottom <= window.innerHeight + 1 && box.width > 40,
            covered,
            sheet: !!sheet,
          }
        })
        expect(fit.sheet, `filter sheet stays closed at ${width}`).toBe(false)
        expect(fit.covered, `row covered at ${width}`).toBe(false)
        expect(fit.visible, `row visible at ${width}`).toBe(true)
        await page.screenshot({ path: `/opt/cursor/artifacts/loop-filter-${width}.png` })
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 30000)

  it('leaves the transport and the ruler clear while the bass plugin is open', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch()
    try {
      for (const width of [384, 884]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } })
        let clicks = 0
        await page.exposeFunction('mark', () => { clicks += 1 })
        await page.setContent(`<!doctype html><html><head><style>
          html, body { margin: 0; background: #101614; color: #f4f4f4; height: 800px; }
          ${css}
          .stage { height: 800px; display: flex; flex-direction: column; }
          .transport { height: 56px; flex: none; display: flex; align-items: center; padding: 0 8px; }
          .workspace { position: relative; flex: 1 1 auto; min-height: 0; }
          .arrange { --ruler-stack: 64px; --map-h: 0px; --ruler-h: 22px; --playhead-strip: 42px; }
          .ruler { height: 22px; position: relative; }
          .playhead-strip { height: 42px; }
          .loop-grip { width: 44px; height: 40px; }
        </style></head><body>
          <div class="shell phone stage" data-plugin="bass" style="--plugin-clear-top: 120px; --plugin-dock-top: 64px; --phone-chrome-bottom: 0px; --ruler-stack: 64px">
            <div class="transport"><button type="button" class="t-btn play" aria-label="Play" onclick="mark()">Play</button></div>
            <div class="workspace">
              <div class="main-pane"><div class="arrange">
                <div class="ruler" data-ruler="open"><button type="button" class="loop-grip" aria-label="Loop start" onclick="mark()">Loop</button></div>
                <div class="playhead-strip" data-playhead-strip role="slider" aria-label="Playhead"></div>
              </div></div>
              <div class="dock-slot"><div class="bass808" data-bass808="open" data-screen-overlay role="dialog" aria-label="808 Bass">
                <header class="bass808-bar"><h2>808 Bass</h2><button type="button" class="piano-roll-btn" aria-label="Piano Roll">Keys</button></header>
              </div></div>
            </div>
          </div>
        </body></html>`, { waitUntil: 'load' })
        const hit = await page.evaluate(() => {
          const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
          const play = box('[aria-label="Play"]')
          const ruler = box('[data-ruler]')
          const head = box('[data-playhead-strip]')
          const plugin = box('[data-bass808]')
          const at = (rect: DOMRect) => document.elementFromPoint(rect.left + 8, rect.top + Math.min(16, rect.height / 2))
          const playEl = at(play)
          const rulerEl = at(ruler)
          return {
            play: playEl?.getAttribute('aria-label') ?? playEl?.closest('button')?.getAttribute('aria-label') ?? '',
            ruler: !!rulerEl?.closest('[data-ruler], .loop-grip'),
            pluginTop: plugin.top,
            rulerBottom: ruler.bottom,
            headBottom: head.bottom,
            playTop: play.top,
          }
        })
        expect(hit.play, `play clickable at ${width}`).toBe('Play')
        expect(hit.ruler, `ruler clickable at ${width}`).toBe(true)
        expect(hit.pluginTop, `plugin below ruler at ${width}`).toBeGreaterThanOrEqual(hit.headBottom - 1)
        expect(hit.playTop, `play above plugin at ${width}`).toBeLessThan(hit.pluginTop)
        await page.getByRole('button', { name: 'Play', exact: true }).click()
        await page.getByRole('button', { name: 'Loop start', exact: true }).click()
        expect(clicks).toBe(2)
        clicks = 0
        await page.screenshot({ path: `/opt/cursor/artifacts/bass-plugin-${width}.png` })
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 30000)
})
