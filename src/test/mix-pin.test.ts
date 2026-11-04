import { mkdirSync, readFileSync } from 'node:fs'
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

const layouts = [
  { name: 'phone', width: 390, height: 844, shell: 'shell phone studio' },
  { name: 'cover', width: 476, height: 752, shell: 'shell phone studio' },
  { name: 'fold', width: 880, height: 1000, shell: 'shell fold studio' },
  { name: 'desk', width: 1440, height: 900, shell: 'shell studio' },
] as const

const counts = [1, 4, 12] as const
const places = ['start', 'middle', 'end'] as const

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

function storeWith(count: number) {
  const store = new ProjectStore()
  writeLayout(store.project.id, { strip: 84, column: 70, mixer: 'columns' })
  const ids = store.project.tracks.map((track) => track.id)
  if (count < ids.length) {
    for (const id of ids.slice(count)) store.removeTrack(id)
  } else {
    for (let i = ids.length; i < count; i++) store.addTrack('audio')
  }
  return store
}

function markup(store: ProjectStore, width: number, height: number, shell: string) {
  const html = withWindow(width, height, () => renderToStaticMarkup(createElement(MixerView, { store, engine })))
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: #101614; width: ${width}px; height: ${height}px; overflow: hidden; }
    ${css}
  </style></head><body>
    <div class="${shell}" style="width:${width}px;height:${height}px">
      <div class="main-pane" style="height:${height}px">${html}</div>
    </div>
  </body></html>`
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }

function overlaps(a: Box, b: Box) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return width > 1 && height > 1
}

async function readLayout(page: Page, place: (typeof places)[number]) {
  return page.evaluate((where) => {
    const mixer = document.querySelector('.mixer') as HTMLElement
    const bay = document.querySelector('.mixer-bay') as HTMLElement
    const master = document.querySelector('.strip.master') as HTMLElement
    const divider = document.querySelector('.mix-divider') as HTMLElement
    const max = Math.max(0, mixer.scrollWidth - mixer.clientWidth)
    mixer.scrollLeft = where === 'start' ? 0 : where === 'end' ? max : max / 2
    const clip = (node: HTMLElement) => {
      const box = node.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }
    }
    const paint = (box: { left: number; right: number; top: number; bottom: number }, limit: { left: number; right: number; top: number; bottom: number }) => {
      const left = Math.max(box.left, limit.left)
      const right = Math.min(box.right, limit.right)
      const top = Math.max(box.top, limit.top)
      const bottom = Math.min(box.bottom, limit.bottom)
      return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
    }
    const port = clip(mixer)
    const channels = [...document.querySelectorAll<HTMLElement>('.mixer > .strip')].map((strip) => {
      const box = clip(strip)
      const col = (strip.querySelector('.strip-col') as HTMLElement | null) ?? strip
      return { name: (strip.querySelector('h3')?.textContent || '').trim(), box, painted: paint(box, port), col: col.getBoundingClientRect().width }
    })
    const masterBox = clip(master)
    const masterCol = ((master.querySelector('.strip-col') as HTMLElement | null) ?? master).getBoundingClientRect().width
    const notes = [...master.querySelectorAll<HTMLElement>('.strip-note')].map((note) => {
      const style = getComputedStyle(note)
      const match = style.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
      const rgb = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
      return {
        text: (note.textContent || '').trim(),
        rgb,
        alpha: match?.[4] == null ? 1 : Number(match[4]),
        opacity: Number(style.opacity),
        scrollWidth: note.scrollWidth,
        clientWidth: note.clientWidth,
      }
    })
    const bg = getComputedStyle(master).backgroundColor
    const bgMatch = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
    return {
      channels,
      master: masterBox,
      masterCol,
      divider: clip(divider),
      port,
      bay: clip(bay),
      scrollLeft: mixer.scrollLeft,
      max,
      background: bg,
      backgroundAlpha: bgMatch?.[4] == null ? 1 : Number(bgMatch[4]),
      notes,
    }
  }, place)
}

describe('pinned master strip', () => {
  it('keeps strip rectangles apart on phone, cover, fold, and desk', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch({ headless: true })
    try {
      for (const layout of layouts) {
        const page = await browser.newPage({ viewport: { width: layout.width, height: layout.height } })
        for (const count of counts) {
          await page.setContent(markup(storeWith(count), layout.width, layout.height, layout.shell), { waitUntil: 'load' })
          for (const place of places) {
            const report = await readLayout(page, place)
            const where = `${layout.name} ${count} tracks ${place}`
            expect(report.channels, where).toHaveLength(count)
            expect(report.master.width, where).toBeGreaterThan(40)
            expect(report.port.height, where).toBeGreaterThan(120)
            expect(report.master.left, where).toBeGreaterThanOrEqual(report.port.right - 1)
            expect(report.divider.width, where).toBeGreaterThanOrEqual(2)
            expect(report.divider.left, where).toBeGreaterThanOrEqual(report.port.right - 1)
            expect(report.divider.right, where).toBeLessThanOrEqual(report.master.left + 1)
            expect(report.divider.height, where).toBeGreaterThan(80)
            expect(report.backgroundAlpha, where).toBe(1)
            expect(report.master.right, where).toBeLessThanOrEqual(report.bay.right + 1)
            const channelWidth = report.channels[0]?.box.width ?? report.master.width
            expect(Math.abs(report.master.width - channelWidth), where).toBeLessThanOrEqual(1)
            expect(Math.abs(report.masterCol - report.channels[0].col), where).toBeLessThanOrEqual(1)
            for (let i = 0; i < report.channels.length; i++) {
              for (let j = i + 1; j < report.channels.length; j++) {
                expect(overlaps(report.channels[i].box, report.channels[j].box), `${where} ${report.channels[i].name}`).toBe(false)
              }
            }
            // Painted boxes are clipped to the scrollport. Master sits beside that port,
            // so a strip scrolling past the end cannot draw on top of Master.
            const visible = report.channels.filter((strip) => strip.painted.width > 1 && strip.painted.height > 1)
            const painted = [...visible.map((strip) => strip.painted), report.master]
            const names = [...visible.map((strip) => strip.name), 'Master']
            for (let i = 0; i < painted.length; i++) {
              for (let j = i + 1; j < painted.length; j++) {
                expect(overlaps(painted[i], painted[j]), `${where} ${names[i]} / ${names[j]}`).toBe(false)
              }
            }
            expect(report.notes.map((note) => note.text), where).toEqual(['Arrives', 'Leaves'])
            for (const note of report.notes) {
              const average = (note.rgb[0] + note.rgb[1] + note.rgb[2]) / 3
              expect(average, `${where} ${note.text}`).toBeGreaterThan(200)
              expect(note.alpha, note.text).toBe(1)
              expect(note.opacity, note.text).toBe(1)
              expect(note.scrollWidth, `${where} ${note.text}`).toBeLessThanOrEqual(note.clientWidth + 1)
            }
            const shot = count === 12 || (layout.name === 'phone' && place === 'start')
            if (shot) await page.screenshot({ path: `/opt/cursor/artifacts/mix-pin-${layout.name}-${count}-${place}.png` })
          }
        }
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 120000)
})
