import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { STRIP_DEFAULT, STRIP_HALF, writeLayout } from '../model/layoutWidth'
import { ProjectStore } from '../state/store'
import { MixerView } from '../ui/MixerView'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = ['src/styles.css', 'src/ui/premium.css', 'src/ui/kit/kit.css', 'src/ui/automation.css', 'src/ui/remoteFixes.css', 'src/ui/mixer.css']
  .map((file) => readFileSync(resolve(root, file), 'utf8'))
  .join('\n')

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  levels: () => ({ master: 0, input: 0, talk: 0, tracks: {} }),
  masterReading: () => null,
  mixMeters: () => ({ cpu: 0, lufs: -70, truePeak: -70 }),
} as unknown as AudioEngine

function withWindow<T>(width: number, height: number, draw: () => T): T {
  const previous = globalThis.window
  globalThis.window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window & typeof globalThis
  try {
    return draw()
  } finally {
    if (previous) globalThis.window = previous
    else delete (globalThis as { window?: Window }).window
  }
}

function markup(store: ProjectStore, width: number, height: number, shell: string) {
  const html = withWindow(width, height, () => renderToStaticMarkup(createElement(MixerView, { store, engine })))
  const pane = Math.max(280, height - 120)
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: #101614; width: ${width}px; height: ${height}px; }
    ${css}
  </style></head><body>
    <div class="${shell}" style="width:${width}px;height:${height}px">
      <div class="main-pane" style="height:${pane}px">${html}</div>
    </div>
  </body></html>`
}

async function measure(width: number, height: number, shell: string, layout: { strip: number; mixer: 'columns' | 'rows' }, shot?: string) {
  const store = new ProjectStore()
  writeLayout(store.project.id, { strip: layout.strip, column: 70, mixer: layout.mixer })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.setContent(markup(store, width, height, shell), { waitUntil: 'load' })
    const report = await page.evaluate(() => {
      const mixer = document.querySelector('.mixer') as HTMLElement
      const host = mixer.getBoundingClientRect()
      const strips = [...document.querySelectorAll<HTMLElement>('.mixer > .strip')]
      return {
        layout: (document.querySelector('.mixer-view') as HTMLElement).dataset.layout,
        panelMode: (document.querySelector('.mix-panel .mode-full')?.textContent || '').trim(),
        hostHeight: host.height,
        strips: strips.map((strip) => {
          const box = strip.getBoundingClientRect()
          const fader = strip.querySelector('.volume-row .touch-slider') as HTMLElement
          const faderBox = fader.getBoundingClientRect()
          const thumb = fader.querySelector('b') as HTMLElement
          const thumbBox = thumb.getBoundingClientRect()
          const db = (strip.querySelector('.fader-db')?.textContent || '').trim()
          const mode = (strip.querySelector('.strip-auto .mode-full')?.textContent || '').trim()
          const tune = strip.querySelector('.tune-btn') as HTMLElement | null
          const tuneBox = tune?.getBoundingClientRect()
          return {
            name: (strip.querySelector('h3')?.textContent || '').trim(),
            stripHeight: box.height,
            stripWidth: box.width,
            faderHeight: faderBox.height,
            faderWidth: faderBox.width,
            faderTop: faderBox.top,
            faderBottom: faderBox.bottom,
            thumbWidth: thumbBox.width,
            thumbHeight: thumbBox.height,
            vertical: fader.classList.contains('vertical'),
            db,
            mode,
            tuneInside: !tuneBox || tuneBox.height < 1 || (tuneBox.left >= box.left - 1 && tuneBox.right <= box.right + 1 && tuneBox.height >= 40),
            ratio: faderBox.height / box.height,
          }
        }),
      }
    })
    if (shot) {
      mkdirSync('/opt/cursor/artifacts', { recursive: true })
      await page.screenshot({ path: `/opt/cursor/artifacts/${shot}.png`, fullPage: true })
    }
    await page.close()
    return report
  } finally {
    await browser.close()
  }
}

describe('dominant volume fader', () => {
  it('gives columns, narrow, desktop, and master a fader at least half the strip', async () => {
    const cases = [
      { width: 412, height: 915, shell: 'shell phone', strip: STRIP_DEFAULT, mixer: 'columns' as const, shot: 'fader-columns-412' },
      { width: 412, height: 915, shell: 'shell phone', strip: STRIP_HALF, mixer: 'columns' as const, shot: 'fader-narrow-412' },
      { width: 1280, height: 800, shell: 'shell studio', strip: STRIP_DEFAULT, mixer: 'columns' as const, shot: 'fader-desktop' },
      { width: 768, height: 900, shell: 'shell fold', strip: STRIP_DEFAULT, mixer: 'columns' as const, shot: 'fader-fold' },
    ]
    for (const item of cases) {
      const report = await measure(item.width, item.height, item.shell, item, item.shot)
      expect(report.layout).toBe('columns')
      expect(report.panelMode).toBe('Read')
      expect(report.strips.length).toBeGreaterThan(1)
      for (const strip of report.strips) {
        expect(strip.ratio, `${item.shell} ${strip.name}`).toBeGreaterThanOrEqual(0.5)
        expect(strip.vertical, strip.name).toBe(true)
        expect(strip.thumbHeight, strip.name).toBeGreaterThanOrEqual(44)
        expect(strip.db, strip.name).toMatch(/dB|inf/)
        expect(strip.mode, strip.name).toBe('')
        expect(strip.faderTop, strip.name).toBeGreaterThanOrEqual(0)
        expect(strip.faderBottom, strip.name).toBeLessThanOrEqual(item.height + 1)
      }
    }
  }, 20000)

  it('keeps phone width on vertical columns even when rows was saved', async () => {
    const report = await measure(412, 915, 'shell phone', { strip: STRIP_HALF, mixer: 'rows' }, 'fader-columns-phone')
    expect(report.layout).toBe('columns')
    const channels = report.strips.filter((strip) => strip.name !== 'Master')
    expect(channels.length).toBeGreaterThanOrEqual(3)
    for (const strip of report.strips) {
      expect(strip.ratio, strip.name).toBeGreaterThanOrEqual(0.5)
      expect(strip.vertical, strip.name).toBe(true)
      expect(strip.faderHeight, strip.name).toBeGreaterThanOrEqual(48)
      expect(strip.db, strip.name).toMatch(/dB|inf/)
      expect(strip.tuneInside, strip.name).toBe(true)
    }
  }, 20000)
})
