import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { formFactor } from '../ui/form'
import { ScalerPanel } from '../ui/ScalerPanel'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const layoutCss = [
  'src/styles.css',
  'src/ui/premium.css',
  'src/ui/buttonTiers.css',
  'src/ui/screenOverlay.css',
  'src/ui/presetControls.css',
  'src/ui/generate.css',
  'src/ui/scaler.css',
].map((file) => readFileSync(resolve(repoRoot, file), 'utf8')).join('\n')

const VIEWPORTS = [
  { name: 'phone-390x844', width: 390, height: 844 },
  { name: 'fold-476x752', width: 476, height: 752 },
  { name: 'fold-880x1000', width: 880, height: 1000 },
  { name: 'computer-1440x900', width: 1440, height: 900 },
  { name: 'phone-land-844x390', width: 844, height: 390 },
]

const engine = {
  unlock() {},
  stopPreview() {},
  auditionScaler() {},
  currentTimelineSample() { return 0 },
  status: 'stopped',
  sampleRate: 48000,
} as unknown as AudioEngine

function panel(page: 'play' | 'key' | 'voice' | 'sound' | 'write') {
  const store = new ProjectStore(createEmptyProject())
  const id = store.project.tracks.find((track) => track.type === 'midi')!.id
  store.insertScaler(id, page)
  return renderToStaticMarkup(createElement(ScalerPanel, { store, engine, trackId: id }))
}

function layoutMarkup(width: number, height: number) {
  const previous = globalThis.window
  globalThis.window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window & typeof globalThis
  try {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertScaler(id, 'play')
    const html = renderToStaticMarkup(createElement(ScalerPanel, { store, engine, trackId: id }))
    const factor = formFactor(width, height)
    const shell = ['shell', factor === 'desk' ? '' : factor, width > height ? 'land' : ''].filter(Boolean).join(' ')
    return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --view-tabs-bottom: 48px; }
.shot-bar { position: fixed; z-index: 480; top: 0; left: 0; right: 0; height: 48px; display: flex; align-items: center; padding: 0 12px; background: #17211c; color: #eef3ea; border-bottom: 1px solid #31443a; font: 700 14px/1 sans-serif; }
${layoutCss}
</style>
</head>
<body>
<div class="shot-bar">Arrange</div>
<div class="${shell}">${html}</div>
</body>
</html>`
  } finally {
    if (previous) globalThis.window = previous
    else delete (globalThis as { window?: Window }).window
  }
}

describe('scaler plugin panel', () => {
  it('docks on the track instead of opening a popup', () => {
    const html = panel('play')
    expect(html).toContain('data-scaler="plugin"')
    expect(html).toContain('aria-label="Scaler"')
    expect(html).not.toContain('role="dialog"')
    expect(html).toContain('Chord pads')
    expect(html).toContain('scaler-keys')
    expect(html).toContain('>Modulation<')
    expect(html).toContain('Progression lane')
    expect(html).toContain('Detected scales')
    expect(html).toContain('>Record<')
    expect(html).toContain('MIDI input')
    expect(html).toContain('Audio output')
    expect(html).toContain('Keys lock')
    expect(html).toContain('Maqam')
    expect(html).toContain('To track')
    expect(html).toContain('Axis')
    expect(html).toContain('Bright')
  })

  it('has key, voicing, sound, and generate inside the plugin', () => {
    expect(panel('key')).toContain('Search scales')
    expect(panel('key')).toContain('Detect')
    const voice = panel('voice')
    expect(voice).toContain('Voicing')
    expect(voice).toContain('Arpeggio')
    expect(voice).toContain('Gate')
    const sound = panel('sound')
    expect(sound).toContain('Library')
    expect(sound).toContain('Track')
    const write = panel('write')
    expect(write).toContain('aria-label="Generate"')
    expect(write).toContain('>Hear<')
    expect(write).toContain('This track')
    expect(write).not.toContain('role="dialog"')
  })

  it('highlights the selected chord and wraps the scale chips', () => {
    const css = readFileSync(new URL('../ui/scaler.css', import.meta.url), 'utf8')
    expect(css).toContain('.scaler-panel button.scaler-card.on')
    expect(css).toMatch(/\.scaler-families, \.scaler-scale-list \{[^}]*flex-wrap:\s*wrap/)
  })

  it('puts the key and scale pickers on the main layout, with the keys filling the rest', () => {
    const html = panel('play')
    const key = html.indexOf('data-key-picker')
    const scale = html.indexOf('data-scale-picker')
    const options = html.indexOf('id="scaler-options"')
    const keys = html.indexOf('data-keyboard="scaler"')
    expect(key).toBeGreaterThan(-1)
    expect(scale).toBeGreaterThan(key)
    expect(options).toBeGreaterThan(scale)
    expect(keys).toBeGreaterThan(options)
    expect(html.slice(0, options)).not.toContain('scaler-drawer')
    for (const name of ['C', 'C sharp', 'D', 'D sharp', 'E', 'F', 'F sharp', 'G', 'G sharp', 'A', 'A sharp', 'B']) {
      expect(html).toContain(`aria-label="Key ${name}"`)
    }
    expect(html).toContain('>Key<')
    expect(html).toContain('>Scale<')
    expect(html).toContain('aria-label="Scale"')
    expect(html).toContain('>Major<')
    expect(html).toContain('>Minor<')
    expect(html).toContain('aria-label="Output"')
    expect(html).toContain('>Audio output<')
    expect(html).toContain('>MIDI output<')
    expect(html).toContain('>To track<')
    expect(html).toContain('>Options<')
    expect(html).toContain('hidden=""')
    expect(html).not.toContain('scaler-scroll')
    const css = readFileSync(new URL('../ui/scaler.css', import.meta.url), 'utf8')
    expect(css).toContain('overflow: hidden !important')
    expect(css).not.toContain('.scaler-scroll')
    expect(css).toContain('.scaler-keys')
  })

  it('fits the keys, key picker, and scale picker without page scroll', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.setContent(layoutMarkup(viewport.width, viewport.height), { waitUntil: 'load' })
        const shot = `/opt/cursor/artifacts/scaler-${viewport.name}.png`
        await page.screenshot({ path: shot, fullPage: false })
        const box = await page.evaluate(() => {
          const panel = document.querySelector('.scaler-panel') as HTMLElement
          const keys = document.querySelector('.scaler-keys') as HTMLElement
          const picker = document.querySelector('[data-key-picker]') as HTMLElement
          const scale = document.querySelector('[data-scale-picker] select') as HTMLElement
          const pills = document.querySelector('[data-output]') as HTMLElement
          const head = document.querySelector('.scaler-head') as HTMLElement
          const white = document.querySelector('.scaler-white') as HTMLElement
          const black = document.querySelector('.scaler-black') as HTMLElement
          const options = document.querySelector('#scaler-options') as HTMLElement
          const findPill = (label: string) => [...pills.querySelectorAll('button')].find((button) => button.textContent === label) as HTMLElement
          const toTrack = findPill('To track')
          const audioOut = findPill('Audio output')
          const midiOut = findPill('MIDI output')
          const optionsButton = findPill('Options')
          const rect = (el: Element) => {
            const item = el.getBoundingClientRect()
            return { top: item.top, left: item.left, right: item.right, bottom: item.bottom, width: item.width, height: item.height }
          }
          return {
            panelScroll: panel.scrollHeight - panel.clientHeight,
            pageScroll: document.documentElement.scrollHeight - window.innerHeight,
            pageWide: document.documentElement.scrollWidth - window.innerWidth,
            key: rect(keys),
            head: rect(head),
            pills: rect(pills),
            scale: rect(scale),
            white: rect(white),
            black: rect(black),
            toTrack: rect(toTrack),
            audioOut: rect(audioOut),
            midiOut: rect(midiOut),
            optionsButton: rect(optionsButton),
            hidden: options.hidden,
            notes: [...picker.querySelectorAll('button')].map((button) => ({ name: button.getAttribute('aria-label'), ...rect(button) })),
          }
        })
        const where = viewport.name
        expect(box.hidden, where).toBe(true)
        expect(box.panelScroll, where).toBeLessThanOrEqual(2)
        expect(box.pageScroll, where).toBeLessThanOrEqual(2)
        expect(box.pageWide, where).toBeLessThanOrEqual(2)
        expect(box.notes, where).toHaveLength(12)
        expect(box.key.height, where).toBeGreaterThan(box.head.height)
        expect(box.key.height, where).toBeGreaterThan(box.pills.height)
        expect(box.key.height, where).toBeGreaterThan(140)
        expect(box.key.bottom, where).toBeLessThanOrEqual(viewport.height + 1)
        expect(box.key.top, where).toBeGreaterThan(40)
        expect(box.white.height, where).toBeGreaterThan(120)
        expect(box.white.width, where).toBeGreaterThanOrEqual(40)
        expect(box.black.width, where).toBeGreaterThanOrEqual(40)
        expect(box.black.height, where).toBeGreaterThanOrEqual(40)
        expect(box.scale.height, where).toBeGreaterThanOrEqual(40)
        expect(box.scale.top, where).toBeGreaterThanOrEqual(0)
        expect(box.scale.bottom, where).toBeLessThanOrEqual(viewport.height)
        expect(box.scale.left, where).toBeGreaterThanOrEqual(0)
        expect(box.scale.right, where).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.pills.top, where).toBeGreaterThanOrEqual(0)
        expect(box.pills.bottom, where).toBeLessThanOrEqual(viewport.height)
        expect(box.toTrack.left, where).toBeGreaterThanOrEqual(-1)
        expect(box.toTrack.right, where).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.toTrack.height, where).toBeGreaterThanOrEqual(40)
        expect(box.audioOut.left, where).toBeGreaterThanOrEqual(-1)
        expect(box.audioOut.right, where).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.midiOut.left, where).toBeGreaterThanOrEqual(-1)
        expect(box.midiOut.right, where).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.optionsButton.left, where).toBeGreaterThanOrEqual(-1)
        expect(box.optionsButton.right, where).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.optionsButton.height, where).toBeGreaterThanOrEqual(40)
        for (const note of box.notes) {
          expect(note.height, `${where} ${note.name}`).toBeGreaterThanOrEqual(40)
          expect(note.width, `${where} ${note.name}`).toBeGreaterThanOrEqual(36)
          expect(note.top, `${where} ${note.name}`).toBeGreaterThanOrEqual(-1)
          expect(note.bottom, `${where} ${note.name}`).toBeLessThanOrEqual(viewport.height + 1)
          expect(note.left, `${where} ${note.name}`).toBeGreaterThanOrEqual(-1)
          expect(note.right, `${where} ${note.name}`).toBeLessThanOrEqual(viewport.width + 1)
        }
      }
    } finally {
      await browser.close()
    }
  }, 30000)

  it('removes the Scales popup and the MIDI library button', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const dock = readFileSync(new URL('../ui/MidiDock.tsx', import.meta.url), 'utf8')
    const roll = readFileSync(new URL('../ui/PianoRoll.tsx', import.meta.url), 'utf8')
    expect(app).toContain('ScalerPanel')
    expect(app).not.toContain('LibraryPop')
    expect(app).not.toContain('label="Scales"')
    expect(app).not.toContain('GeneratePop')
    expect(dock).not.toContain('onLibrary')
    expect(roll).not.toContain('onLibrary')
  })
})
