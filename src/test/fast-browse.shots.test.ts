import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { buildFastRows } from '../library/fastBrowse'
import type { LibraryEntry } from '../library/types'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { FastShelf } from '../ui/MyLibrary'
import { PadsPanel } from '../ui/PadsPanel'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = ['src/styles.css', 'src/ui/premium.css', 'src/ui/sound-browser.css', 'src/ui/pads.css']
  .map((file) => readFileSync(resolve(root, file), 'utf8'))
  .join('\n')

function entry(patch: Partial<LibraryEntry> & Pick<LibraryEntry, 'key' | 'name'>): LibraryEntry {
  return {
    size: 10,
    format: 'wav',
    pack: 'Kit',
    type: 'one-shot',
    category: '',
    instrument: '',
    genre: [],
    bpm: null,
    bpmAlt: null,
    musicalKey: '',
    root: '',
    note: '',
    mood: [],
    tags: [],
    license: 'private',
    ...patch,
  }
}

const drums: LibraryEntry[] = [
  entry({ key: 'Drums/kick.wav', name: 'Acoustic Kick', category: 'kick' }),
  entry({ key: 'Drums/kick2.wav', name: 'Punch Kick', category: 'kick' }),
  entry({ key: 'Drums/808.wav', name: '808 Bass', category: '808' }),
  entry({ key: 'Drums/snare.wav', name: 'Tight Snare', category: 'snare' }),
  entry({ key: 'Drums/clap.wav', name: 'Room Clap', category: 'clap' }),
  entry({ key: 'Drums/ch.wav', name: 'Closed Hat', category: 'hat' }),
  entry({ key: 'Drums/oh.wav', name: 'Open Hat', category: 'hat-open' }),
  entry({ key: 'Drums/crash.wav', name: 'Crash', category: 'crash' }),
  entry({ key: 'Drums/ride.wav', name: 'Ride', category: 'ride' }),
  entry({ key: 'Drums/tom.wav', name: 'Floor Tom', category: 'tom' }),
  entry({ key: 'Drums/cow.wav', name: 'Cowbell', category: 'perc' }),
  entry({ key: 'Drums/rim.wav', name: 'Rimshot', category: 'rim' }),
  entry({ key: 'Drums/shaker.wav', name: 'Shaker', category: 'shaker' }),
  entry({ key: 'Drums/riser.wav', name: 'Riser', category: 'fx' }),
]

const loops: LibraryEntry[] = [
  entry({ key: 'Loops/drums.wav', name: 'Trap Drum Loop', type: 'loop', category: 'drums', genre: ['trap'], bpm: 140 }),
  entry({ key: 'Loops/bass.wav', name: 'Sub Bass', type: 'loop', category: 'bass', musicalKey: 'A minor', bpm: 90, genre: ['trap'] }),
  entry({ key: 'Loops/piano.wav', name: 'Piano Chords', type: 'loop', category: 'piano', musicalKey: 'C major', bpm: 100, genre: ['lo-fi'] }),
  entry({ key: 'Loops/guitar.wav', name: 'Guitar Riff', type: 'loop', category: 'guitar', bpm: 110 }),
  entry({ key: 'Loops/synth.wav', name: 'Synth Pluck', type: 'loop', category: 'synth', bpm: 124, genre: ['house'] }),
  entry({ key: 'Loops/pad.wav', name: 'Warm Pad', type: 'loop', category: 'pad', bpm: 80 }),
  entry({ key: 'Loops/lead.wav', name: 'Lead Melody', type: 'loop', category: 'lead', musicalKey: 'A minor', bpm: 120 }),
  entry({ key: 'Loops/strings.wav', name: 'String Section', type: 'loop', category: 'strings', bpm: 72 }),
  entry({ key: 'Loops/brass.wav', name: 'Brass Stab', type: 'loop', category: 'brass', bpm: 98 }),
  entry({ key: 'Loops/vocal.wav', name: 'Vocal Chop', type: 'loop', category: 'vocal', bpm: 120, genre: ['rnb'] }),
  entry({ key: 'Loops/fx.wav', name: 'Noise Riser', type: 'loop', category: 'fx', bpm: 128 }),
]

const noop = () => undefined

function library(mode: 'drum' | 'loop', withLanes = true) {
  const model = buildFastRows({
    entries: mode === 'drum' ? drums : loops,
    mode,
    category: '',
    sub: '',
    genre: '',
    sort: 'name',
    collapsed: new Set(),
    favoriteKeys: mode === 'drum' ? ['Drums/snare.wav'] : ['Loops/bass.wav'],
    recentKeys: mode === 'drum' ? ['Drums/kick.wav'] : ['Loops/drums.wav'],
  })
  const shelf = renderToStaticMarkup(createElement(FastShelf, {
    mode,
    model,
    category: '',
    sub: '',
    genre: '',
    sort: 'name',
    nearTempo: mode === 'loop',
    inKey: mode === 'loop',
    compatible: false,
    songKey: 'Am',
    stuck: mode === 'drum' ? 'Kick' : 'Drums',
    tempoCenter: 120,
    onCategory: noop,
    onSub: noop,
    onGenre: noop,
    onSort: noop,
    onNearTempo: noop,
    onTempo: noop,
    onInKey: noop,
    onCompatible: noop,
    onJump: noop,
    onStep: noop,
    onToggleStuck: noop,
  }))
  const list = model.rows.slice(0, 16).map((item) => {
    if (item.kind === 'head') return `<button type="button" class="fast-section"><strong>${item.label}</strong><span>${item.count}</span></button>`
    const meta = mode === 'drum' ? 'One-shot' : `${item.entry?.bpm ?? ''} bpm`
    const actions = mode === 'drum'
      ? `<button type="button" class="sound-add">Pad</button><button type="button" class="sound-add">Track</button>`
      : `<button type="button" class="sound-add">Track</button>`
    return `<div class="sound-row"><button type="button" class="sound-copy"><strong>${item.label}</strong><span class="sound-meta">${meta}</span></button>${actions}</div>`
  }).join('')
  const jump = model.jump.map((item) => `<button type="button" aria-label="Jump to ${item.label}">${item.short}</button>`).join('')
  const lanes = !withLanes ? '' : ['Loops', 'Drums', 'Instruments', 'One-shots', 'SFX', 'Favorites'].map((label) => {
    const id = label === 'One-shots' ? 'oneshots' : label === 'Favorites' ? 'favorites' : label.toLowerCase()
    const on = (mode === 'drum' && id === 'drums') || (mode === 'loop' && id === 'loops') ? ' on' : ''
    return `<button type="button" data-lane="${id}" class="${on.trim()}" aria-pressed="${on ? 'true' : 'false'}">${label}</button>`
  }).join('')
  return `<div class="sound-panel my-library" data-fast-browse="${mode}"><div class="library-sticky"><div class="sound-filters"><input aria-label="Search" placeholder="Search" /></div><div class="library-lanes" role="group" aria-label="Library">${lanes}</div>${shelf}</div><div class="sound-list"><div class="fast-list"><div style="margin-right:34px">${list}</div><div class="fast-jump">${jump}</div></div></div></div>`
}

describe('fast browse screenshots', () => {
  it('fits the drum shelves, loop shelves, and pad browser at 384 and 884', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const engine = {
      unlock() {},
      resume: async () => {},
      status: 'stopped',
      positionSamples: 0,
      sampleRate: 48000,
      subscribe: () => () => {},
      setPadRoute() {},
      setBeatPump() {},
      setRepeatWatch() {},
    } as unknown as AudioEngine
    const pads = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {} }))
    const padBrowser = pads.replace(/<\/div>\s*$/, `<div class="pad-sample-browser" data-pad-browser="open" style="animation:none"><div class="pad-browser-bar"><strong>Browser</strong><button type="button">Close</button></div>${library('drum', false)}</div></div>`)
    const app = await chromium.launch()
    try {
      for (const width of [384, 884]) {
        const height = width === 384 ? 844 : 1104
        const page = await app.newPage({ viewport: { width, height } })
        const paint = async (body: string, name: string) => {
          await page.setContent(`<!doctype html><html><head><style>
            html, body { margin: 0; background: #101614; color: #f4f4f4; }
            ${css}
            .stage { width: ${width}px; height: ${height}px; overflow: auto; }
            .playlist-browser.bottom-sheet { height: 100%; display: flex; flex-direction: column; background: #141c18; }
          </style></head><body><div class="shell phone stage">${body}</div></body></html>`, { waitUntil: 'load' })
          const fit = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)
          expect(fit, name).toBe(true)
          await page.screenshot({ path: `/opt/cursor/artifacts/${name}-${width}.png` })
        }
        await paint(`<aside class="playlist-browser bottom-sheet"><div class="bottom-sheet-body">${library('drum')}</div></aside>`, 'library-drums')
        expect(await page.locator('[data-drum-chip="snare"]').count()).toBe(1)
        expect(await page.locator('[data-drum-chip="kick"]').count()).toBe(1)
        expect(await page.locator('[data-lane="drums"].on').count()).toBe(1)
        expect(await page.locator('[data-lane="loops"]').count()).toBe(1)
        await paint(`<aside class="playlist-browser bottom-sheet"><div class="bottom-sheet-body">${library('loop')}</div></aside>`, 'library-loops')
        expect(await page.locator('[data-loop-chip="bass"]').count()).toBe(1)
        expect(await page.getByRole('button', { name: 'Near tempo' }).count()).toBe(1)
        await paint(`<div style="height:100%">${padBrowser}</div>`, 'pad-browser')
        expect(await page.locator('[data-pad-browser="open"]').count()).toBe(1)
        expect(await page.getByRole('button', { name: 'Browser', exact: true }).count()).toBeGreaterThan(0)
        await page.close()
      }
    } finally {
      await app.close()
    }
  }, 30000)
})
