import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { writeLayout } from '../model/layoutWidth'
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
  const html = withWindow(width, height, () => renderToStaticMarkup(createElement(MixerView, { store, engine, onTune: () => undefined })))
  const pane = Math.max(280, height - 80)
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: #101614; width: ${width}px; height: ${height}px; }
    ${css}
  </style></head><body>
    <div class="${shell}" style="width:${width}px;height:${height}px">
      <div class="main-pane" style="height:${pane}px">${html}</div>
    </div>
  </body></html>`
}

const WORDS = ['Mute', 'Solo', 'More', 'Close', 'Off', 'Read', 'Touch', 'Latch', 'Inserts', 'Pan', 'Phase', 'Arm', 'Safe', 'Tune', 'Level', 'Master', 'Cue', 'Output', 'Group', 'Link', 'Send', 'Before', 'After', 'Remove', 'Faders', 'Mutes', 'Solos', 'Edits', 'Arrives', 'Leaves']

async function readStrips(page: Page) {
  return page.evaluate((words) => {
    return [...document.querySelectorAll<HTMLElement>('.mixer > .strip')].map((strip) => {
      const box = strip.getBoundingClientRect()
      const fader = strip.querySelector('.volume-row .touch-slider') as HTMLElement
      const faderBox = fader.getBoundingClientRect()
      const racks = [...strip.querySelectorAll<HTMLElement>('.strip-secondary')].map((rack) => {
        const style = getComputedStyle(rack)
        return {
          zone: rack.dataset.zone || '',
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          wrap: style.flexWrap,
          direction: style.flexDirection,
          shown: rack.dataset.shown || '',
          drawer: rack.dataset.drawer || '',
          scroll: rack.scrollHeight > rack.clientHeight + 1,
        }
      })
      const controls = [...strip.querySelectorAll<HTMLElement>('button, summary')].filter((node) => {
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }).map((node) => {
        const rect = node.getBoundingClientRect()
        const word = (node.innerText || '').replace(/\s+/g, ' ').trim()
        return {
          word,
          width: rect.width,
          height: rect.height,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          across: rect.left >= box.left - 1 && rect.right <= box.right + 1,
          full: words.some((item) => word === item || word.startsWith(`${item} `) || word.includes(item)),
        }
      })
      return {
        name: (strip.querySelector('h3')?.textContent || '').trim(),
        master: strip.classList.contains('master'),
        width: box.width,
        height: box.height,
        faderHeight: faderBox.height,
        faderWidth: faderBox.width,
        ratio: faderBox.height / box.height,
        vertical: fader.classList.contains('vertical'),
        more: false,
        racks,
        controls,
      }
    })
  }, WORDS)
}

async function scrollTools(page: Page) {
  await page.evaluate(() => {
    for (const details of document.querySelectorAll<HTMLDetailsElement>('details.mix-more')) details.open = true
    for (const panel of document.querySelectorAll<HTMLElement>('.mix-panel')) panel.scrollTop = panel.scrollHeight
  })
  return readStrips(page)
}

describe('mixer fader stays full size', () => {
  it('matches with every secondary control shown at widths 200, 280, 360, and 600', async () => {
    const widths = [200, 280, 360, 600]
    const browser = await chromium.launch({ headless: true })
    const rowHeights: number[] = []
    try {
      for (const width of widths) {
        const store = new ProjectStore()
        writeLayout(store.project.id, { strip: 84, column: 70, mixer: 'rows' })
        const page = await browser.newPage({ viewport: { width, height: 900 } })
        await page.setContent(markup(store, width, 900, width >= 600 ? 'shell studio' : 'shell phone'), { waitUntil: 'load' })
        const strips = await readStrips(page)
        const where = `columns from saved rows ${width}`
        expect(strips.length, where).toBeGreaterThan(1)
        const channel = strips.find((strip) => !strip.master)!
        expect(strips.every((strip) => strip.more), where).toBe(false)
        expect(await page.locator('.mix-toolbar .mix-more').count(), where).toBe(1)
        const labels = channel.controls.map((control) => control.word)
        for (const word of ['Mute', 'Solo']) {
          expect(labels, `${where} ${word}`).toContain(word)
        }
        expect(labels, where).not.toContain('More')
        expect(labels, where).not.toContain('Inserts')
        expect(labels, where).not.toContain('Pan')
        const heights = strips.map((strip) => strip.faderHeight)
        expect(Math.max(...heights) - Math.min(...heights), where).toBeLessThanOrEqual(1)
        expect(heights[0], where).toBeGreaterThanOrEqual(48)
        for (const strip of strips) {
          expect(strip.vertical, strip.name).toBe(true)
          expect(strip.faderHeight, strip.name).toBeGreaterThanOrEqual(48)
          for (const control of strip.controls) {
            expect(control.width, `${where} ${strip.name} ${control.word}`).toBeGreaterThanOrEqual(40)
            expect(control.height, `${where} ${strip.name} ${control.word}`).toBeGreaterThanOrEqual(40)
            expect(control.scrollWidth, `${where} ${strip.name} ${control.word}`).toBeLessThanOrEqual(control.clientWidth + 1)
            expect(control.scrollHeight, `${where} ${strip.name} ${control.word}`).toBeLessThanOrEqual(control.clientHeight + 1)
            expect(control.across, `${where} ${strip.name} ${control.word}`).toBe(true)
            expect(control.full, `${where} ${strip.name} ${control.word}`).toBe(true)
          }
        }
        const scrolled = await scrollTools(page)
        const scrolledHeights = scrolled.map((strip) => strip.faderHeight)
        expect(Math.max(...scrolledHeights) - Math.min(...heights), where).toBeLessThanOrEqual(1)
        expect(Math.max(...heights) - Math.min(...scrolledHeights), where).toBeLessThanOrEqual(1)
        rowHeights.push(heights[0])
        await page.close()
      }
      expect(rowHeights.every((height) => height >= 48)).toBe(true)

      for (const width of widths) {
        const store = new ProjectStore()
        writeLayout(store.project.id, { strip: 84, column: 70, mixer: 'columns' })
        const page = await browser.newPage({ viewport: { width, height: 900 } })
        await page.setContent(markup(store, width, 900, 'shell phone'), { waitUntil: 'load' })
        const strips = await readStrips(page)
        const where = `columns viewport ${width}`
        const heights = strips.map((strip) => strip.faderHeight)
        const widthsOfFader = strips.map((strip) => strip.faderWidth)
        expect(Math.max(...heights) - Math.min(...heights), where).toBeLessThanOrEqual(1)
        expect(Math.max(...widthsOfFader) - Math.min(...widthsOfFader), where).toBeLessThanOrEqual(1)
        for (const strip of strips) {
          expect(strip.more, strip.name).toBe(false)
          expect(strip.ratio, strip.name).toBeGreaterThanOrEqual(0.5)
          expect(strip.vertical, strip.name).toBe(true)
          expect(strip.faderHeight, strip.name).toBeGreaterThanOrEqual(48)
        }
        const channel = strips.find((strip) => !strip.master)!
        expect(channel.controls.map((control) => control.word), where).toEqual(expect.arrayContaining(['Mute', 'Solo']))
        expect(channel.controls.map((control) => control.word), where).not.toContain('More')
        const scrolled = await scrollTools(page)
        expect(Math.abs(scrolled[0].faderHeight - heights[0]), where).toBeLessThanOrEqual(1)
        expect(Math.abs(scrolled[0].faderWidth - widthsOfFader[0]), where).toBeLessThanOrEqual(1)
        await page.close()
      }

      const narrow = [
        { width: 900, height: 900, shell: 'shell studio', strip: 200 },
        { width: 900, height: 900, shell: 'shell studio', strip: 84 },
        { width: 900, height: 800, shell: 'shell phone', strip: 42 },
      ]
      for (const item of narrow) {
        const store = new ProjectStore()
        writeLayout(store.project.id, { strip: item.strip, column: 70, mixer: 'columns' })
        const page = await browser.newPage({ viewport: { width: item.width, height: item.height } })
        await page.setContent(markup(store, item.width, item.height, item.shell), { waitUntil: 'load' })
        const strips = await readStrips(page)
        const where = `columns strip ${item.strip}`
        const heights = strips.map((strip) => strip.faderHeight)
        expect(Math.max(...heights) - Math.min(...heights), where).toBeLessThanOrEqual(1)
        for (const strip of strips) {
          expect(strip.ratio, `${where} ${strip.name}`).toBeGreaterThanOrEqual(0.5)
          expect(strip.more, strip.name).toBe(false)
          const tools = strip.racks.find((rack) => rack.zone === 'tools')
          if (tools) {
            expect(tools.direction, strip.name).toBe('column')
            expect(['auto', 'scroll'], strip.name).toContain(tools.overflowY)
          }
          for (const control of strip.controls) {
            expect(control.width, `${where} ${strip.name} ${control.word}`).toBeGreaterThanOrEqual(40)
            expect(control.height, `${where} ${strip.name} ${control.word}`).toBeGreaterThanOrEqual(40)
            expect(control.scrollWidth, `${where} ${strip.name} ${control.word}`).toBeLessThanOrEqual(control.clientWidth + 1)
            expect(control.across, `${where} ${strip.name} ${control.word}`).toBe(true)
          }
        }
        await page.close()
      }
    } finally {
      await browser.close()
    }
  })
})
