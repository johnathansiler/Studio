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
const css = ['src/styles.css', 'src/ui/premium.css', 'src/ui/kit/kit.css', 'src/ui/automation.css', 'src/ui/remoteFixes.css']
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

const WORDS = ['Mute', 'Solo', 'Off', 'Read', 'Touch', 'Latch', 'Inserts', 'Pan', 'Arm', 'Safe', 'Tune', 'More', 'Level', 'Master', 'Cue']

async function readStrips(page: Page) {
  return page.evaluate((words) => {
    return [...document.querySelectorAll<HTMLElement>('.mixer > .strip')].map((strip) => {
      const box = strip.getBoundingClientRect()
      const fader = strip.querySelector('.volume-row') as HTMLElement
      const faderBox = fader.getBoundingClientRect()
      const racks = [...strip.querySelectorAll<HTMLElement>('.strip-secondary')].map((rack) => {
        const style = getComputedStyle(rack)
        return {
          zone: rack.dataset.zone || '',
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          wrap: style.flexWrap,
          shown: rack.dataset.shown || '',
          drawer: rack.dataset.drawer || '',
        }
      })
      const controls = [...strip.querySelectorAll<HTMLElement>('button, summary.more-open')].filter((node) => {
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
          inside: rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
          full: words.some((item) => word === item || word.startsWith(`${item} `) || word.includes(item)),
        }
      })
      const drawer = strip.querySelector('.more-drawer') as HTMLElement | null
      const drawerStyle = drawer ? getComputedStyle(drawer) : null
      return {
        name: (strip.querySelector('h3')?.textContent || '').trim(),
        master: strip.classList.contains('master'),
        width: box.width,
        height: box.height,
        ratio: faderBox.height / box.height,
        vertical: fader.querySelector('.touch-slider')?.classList.contains('vertical') ?? false,
        racks,
        controls,
        drawerPosition: drawerStyle?.position ?? '',
        drawerHidden: !drawer || drawer.getClientRects().length === 0,
      }
    }).map((strip) => strip)
  }, WORDS)
}

async function openFirstDrawer(page: Page) {
  return page.evaluate(() => {
    const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
    const strip = document.querySelector('.mixer > .strip') as HTMLElement
    const summary = strip.querySelector('summary.more-open') as HTMLElement | null
    if (!summary) return { opened: false, overlap: false, position: '', words: [] as string[], short: false }
    summary.click()
    const details = summary.closest('details') as HTMLDetailsElement | null
    if (details) details.open = true
    const drawer = strip.querySelector('.more-drawer') as HTMLElement
    const fader = strip.querySelector('.volume-row') as HTMLElement
    const style = getComputedStyle(drawer)
    const buttons = [...drawer.querySelectorAll<HTMLElement>('button')].map((button) => ({
      word: (button.innerText || '').replace(/\s+/g, ' ').trim(),
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
      scrollWidth: button.scrollWidth,
      clientWidth: button.clientWidth,
      scrollHeight: button.scrollHeight,
      clientHeight: button.clientHeight,
    }))
    return {
      opened: drawer.getClientRects().length > 0,
      overlap: overlaps(drawer.getBoundingClientRect(), fader.getBoundingClientRect()),
      position: style.position,
      words: buttons.map((button) => button.word),
      short: buttons.some((button) => button.width < 40 || button.height < 40 || button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1),
    }
  })
}

describe('adaptive mixer secondary controls', () => {
  it('wraps at 200, 280, 360, and 600 without clipping columns, rows, or the master', async () => {
    const cases = [
      { width: 600, height: 900, shell: 'shell studio', strip: 84, mixer: 'rows' as const },
      { width: 360, height: 900, shell: 'shell phone', strip: 84, mixer: 'rows' as const },
      { width: 280, height: 900, shell: 'shell phone', strip: 84, mixer: 'rows' as const },
      { width: 200, height: 900, shell: 'shell phone', strip: 84, mixer: 'rows' as const },
      { width: 900, height: 900, shell: 'shell studio', strip: 200, mixer: 'columns' as const },
      { width: 900, height: 900, shell: 'shell studio', strip: 84, mixer: 'columns' as const },
      { width: 900, height: 800, shell: 'shell phone', strip: 42, mixer: 'columns' as const },
    ]
    const browser = await chromium.launch({ headless: true })
    try {
      for (const item of cases) {
        const store = new ProjectStore()
        writeLayout(store.project.id, { strip: item.strip, column: 70, mixer: item.mixer })
        const page = await browser.newPage({ viewport: { width: item.width, height: item.height } })
        await page.setContent(markup(store, item.width, item.height, item.shell), { waitUntil: 'load' })
        const strips = await readStrips(page)
        const where = `${item.mixer} ${item.width} strip ${item.strip}`
        expect(strips.length, where).toBeGreaterThan(1)
        const channel = strips.find((strip) => !strip.master)!
        const master = strips.find((strip) => strip.master)!
        for (const strip of [channel, master]) {
          expect(strip.ratio, `${where} ${strip.name}`).toBeGreaterThanOrEqual(0.5)
          expect(strip.racks.length, strip.name).toBeGreaterThan(0)
          for (const rack of strip.racks) {
            expect(rack.overflowX, `${strip.name} ${rack.zone}`).not.toBe('hidden')
            expect(rack.overflowY, `${strip.name} ${rack.zone}`).not.toBe('hidden')
            expect(rack.wrap, rack.zone).toBe('wrap')
          }
          for (const control of strip.controls) {
            expect(control.width, `${where} ${strip.name} ${control.word}`).toBeGreaterThanOrEqual(40)
            expect(control.height, `${where} ${strip.name} ${control.word}`).toBeGreaterThanOrEqual(40)
            expect(control.scrollWidth, `${where} ${strip.name} ${control.word}`).toBeLessThanOrEqual(control.clientWidth + 1)
            expect(control.scrollHeight, `${where} ${strip.name} ${control.word}`).toBeLessThanOrEqual(control.clientHeight + 1)
            expect(control.inside, `${where} ${strip.name} ${control.word}`).toBe(true)
            expect(control.full, `${where} ${strip.name} ${control.word}`).toBe(true)
          }
          if (strip.drawerPosition) expect(['static', 'relative'], `${strip.name} drawer`).toContain(strip.drawerPosition)
        }
        const labels = channel.controls.map((control) => control.word)
        expect(labels, where).toContain('Mute')
        expect(labels, where).toContain('Solo')
        expect(labels.some((label) => ['Off', 'Read', 'Touch', 'Latch'].includes(label)), where).toBe(true)
        if (item.mixer === 'rows' && item.width >= 600) expect(channel.racks.some((rack) => rack.drawer.length > 0), where).toBe(false)
        if (item.mixer === 'rows' && item.width <= 280) expect(channel.racks.some((rack) => rack.zone === 'tools' && rack.drawer.includes('tune')), where).toBe(true)
        if (item.mixer === 'columns' && item.strip <= 84) expect(channel.racks.some((rack) => rack.zone === 'tools' && rack.drawer.includes('tune')), where).toBe(true)
        const opened = await openFirstDrawer(page)
        if (channel.racks.some((rack) => rack.drawer.length > 0)) {
          expect(opened.opened, where).toBe(true)
          expect(opened.overlap, where).toBe(false)
          expect(['static', 'relative'], where).toContain(opened.position)
          expect(opened.short, where).toBe(false)
          expect(opened.words.length, where).toBeGreaterThan(0)
        }
        await page.close()
      }
    } finally {
      await browser.close()
    }
  })
})
