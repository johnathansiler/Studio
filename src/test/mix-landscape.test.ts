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
const css = [
  'src/ui/kit/kit.css',
  'src/ui/automation.css',
  'src/ui/mixer.css',
  'src/ui/remoteFixes.css',
  'src/styles.css',
  'src/ui/arrangeSpace.css',
  'src/ui/premium.css',
  'src/ui/buttonTiers.css',
].map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  levels: () => ({ master: 0.4, input: 0, talk: 0, tracks: {} }),
  masterReading: () => null,
  mixMeters: () => ({ cpu: 0, lufs: -70, truePeak: -70 }),
} as unknown as AudioEngine

const landscape = [
  { name: '844x390', width: 844, height: 390 },
  { name: '915x412', width: 915, height: 412 },
  { name: '752x476', width: 752, height: 476 },
] as const

const usual = [
  { name: '390x844', width: 390, height: 844 },
  { name: '476x752', width: 476, height: 752 },
  { name: '880x1000', width: 880, height: 1000 },
  { name: '1440x900', width: 1440, height: 900 },
] as const

function shellClass(width: number, height: number) {
  const land = width > height
  const form = land && height <= 520 ? 'phone' : width <= 520 ? 'phone' : width <= 1100 ? 'fold' : 'desk'
  return `shell studio${form === 'phone' ? ' phone' : ''}${form === 'fold' ? ' fold' : ''}${land ? ' land' : ''}`
}

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
  for (let i = ids.length; i < count; i += 1) store.addTrack('audio')
  return store
}

function markup(store: ProjectStore, width: number, height: number) {
  const html = withWindow(width, height, () => renderToStaticMarkup(createElement(MixerView, {
    store,
    engine,
    onTune: () => undefined,
  })))
  return `<!doctype html><html><head><style>
    html, body { margin: 0; height: 100%; background: #101614; }
    ${css}
  </style></head><body>
    <div class="${shellClass(width, height)}" style="width:${width}px;height:${height}px">
      <header class="topbar">
        <button type="button" class="menu-btn">Menu</button>
        <div class="brand"><div class="mark"></div></div>
        <input class="project-name" value="Night Drive" aria-label="Project name">
        <div class="views">
          <button type="button">Arrange</button>
          <button type="button" class="active">Mix</button>
        </div>
      </header>
      <div class="transport">
        <div class="t-buttons">
          <button type="button" class="t-btn">Play</button>
          <button type="button" class="t-btn">Stop</button>
        </div>
        <div class="lcd"><div class="bars">1.1.1</div><div class="tc">00:00:00:00</div></div>
      </div>
      <div class="workspace session-closed">
        <div class="main-pane"><div class="editor">${html}</div></div>
      </div>
    </div>
  </body></html>`
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number }

function paint(box: Box, limit: Box): Box {
  const left = Math.max(box.left, limit.left)
  const right = Math.min(box.right, limit.right)
  const top = Math.max(box.top, limit.top)
  const bottom = Math.min(box.bottom, limit.bottom)
  return { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

function overlaps(a: Box, b: Box) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return width > 1 && height > 1
}

async function readMixer(page: Page) {
  return page.evaluate(() => {
    const boxOf = (node: Element) => {
      const box = node.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }
    }
    const seen = (node: HTMLElement) => {
      const style = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 1 && box.height > 1
    }
    const mixer = document.querySelector('.mixer') as HTMLElement
    const bay = document.querySelector('.mixer-bay') as HTMLElement
    const master = document.querySelector('.strip.master') as HTMLElement
    const view = document.querySelector('.mixer-view') as HTMLElement
    const channels = [...document.querySelectorAll<HTMLElement>('.mixer > .strip')].map((strip) => {
      const fader = strip.querySelector('.volume-row .touch-slider') as HTMLElement
      const thumb = fader.querySelector('b') as HTMLElement
      const meter = strip.querySelector('.volume-row .meter') as HTMLElement
      const marks = [...strip.querySelectorAll<HTMLElement>('.fader-scale li')].filter(seen).map((mark) => ({
        text: (mark.textContent || '').trim(),
        box: boxOf(mark),
      }))
      const controls = [...strip.querySelectorAll<HTMLElement>('button, summary')].filter(seen).map((node) => ({
        word: (node.innerText || '').replace(/\s+/g, ' ').trim(),
        box: boxOf(node),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }))
      return {
        name: (strip.querySelector('h3')?.textContent || '').trim(),
        box: boxOf(strip),
        col: (strip.querySelector('.strip-col') as HTMLElement).getBoundingClientRect().width,
        fader: boxOf(fader),
        thumb: boxOf(thumb),
        meter: boxOf(meter),
        nameBox: boxOf(strip.querySelector('h3') as HTMLElement),
        db: (strip.querySelector('.fader-db')?.textContent || '').trim(),
        dbBox: boxOf(strip.querySelector('.fader-db') as HTMLElement),
        marks,
        controls,
      }
    })
    return {
      short: view.dataset.short || '',
      channels,
      master: boxOf(master),
      masterCol: (master.querySelector('.strip-col') as HTMLElement).getBoundingClientRect().width,
      masterFader: boxOf(master.querySelector('.volume-row .touch-slider') as HTMLElement),
      masterThumb: boxOf(master.querySelector('.volume-row .touch-slider b') as HTMLElement),
      masterMeter: boxOf(master.querySelector('.volume-row .meter') as HTMLElement),
      masterName: boxOf(master.querySelector('h3') as HTMLElement),
      masterDb: (master.querySelector('.fader-db')?.textContent || '').trim(),
      masterDbBox: boxOf(master.querySelector('.fader-db') as HTMLElement),
      masterMarks: [...master.querySelectorAll<HTMLElement>('.fader-scale li')].filter(seen).map((mark) => ({
        text: (mark.textContent || '').trim(),
        box: boxOf(mark),
      })),
      masterControls: [...master.querySelectorAll<HTMLElement>('button, summary, .strip-note')].filter(seen).map((node) => ({
        word: (node.innerText || '').replace(/\s+/g, ' ').trim(),
        box: boxOf(node),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      })),
      port: boxOf(mixer),
      bay: boxOf(bay),
      scrollWidth: mixer.scrollWidth,
      clientWidth: mixer.clientWidth,
      widthTools: seen(document.querySelector('.width-tools') as HTMLElement),
    }
  })
}

describe('short landscape mixer', () => {
  it('gives the fader at least 160px and keeps strips from overlapping', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch({ headless: true })
    try {
      for (const viewport of landscape) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
        await page.setContent(markup(storeWith(10), viewport.width, viewport.height), { waitUntil: 'load' })
        const report = await readMixer(page)
        const where = viewport.name
        expect(report.short, where).toBe('1')
        expect(report.widthTools, where).toBe(false)
        expect(report.channels.length, where).toBe(10)
        expect(report.scrollWidth, where).toBeGreaterThan(report.clientWidth + 8)
        expect(Math.abs(report.master.width - report.channels[0].box.width), where).toBeLessThanOrEqual(1)
        expect(Math.abs(report.masterCol - report.channels[0].col), where).toBeLessThanOrEqual(1)
        expect(report.master.left, where).toBeGreaterThanOrEqual(report.port.right - 1)
        expect(report.master.right, where).toBeLessThanOrEqual(report.bay.right + 1)
        for (let i = 0; i < report.channels.length; i += 1) {
          for (let j = i + 1; j < report.channels.length; j += 1) {
            expect(overlaps(report.channels[i].box, report.channels[j].box), `${where} ${report.channels[i].name}`).toBe(false)
          }
          const visible = paint(report.channels[i].box, report.port)
          if (visible.width > 1 && visible.height > 1) {
            expect(overlaps(visible, report.master), `${where} ${report.channels[i].name} / Master`).toBe(false)
          }
        }
        const faces = [
          ...report.channels,
          {
            name: 'Master',
            box: report.master,
            fader: report.masterFader,
            thumb: report.masterThumb,
            meter: report.masterMeter,
            nameBox: report.masterName,
            db: report.masterDb,
            dbBox: report.masterDbBox,
            marks: report.masterMarks,
            controls: report.masterControls,
          },
        ]
        for (const strip of faces) {
          expect(strip.fader.height, `${where} ${strip.name} fader`).toBeGreaterThanOrEqual(160)
          expect(strip.fader.height / strip.box.height, `${where} ${strip.name} share`).toBeGreaterThan(0.5)
          expect(strip.meter.height, `${where} ${strip.name} meter`).toBeGreaterThanOrEqual(strip.fader.height - 2)
          expect(strip.thumb.height, `${where} ${strip.name} cap`).toBeGreaterThanOrEqual(40)
          expect(strip.thumb.width, `${where} ${strip.name} cap`).toBeGreaterThanOrEqual(18)
          expect(strip.thumb.top, `${where} ${strip.name} cap`).toBeGreaterThanOrEqual(strip.fader.top - 1)
          expect(strip.thumb.bottom, `${where} ${strip.name} cap`).toBeLessThanOrEqual(strip.fader.bottom + 1)
          expect(strip.thumb.left, `${where} ${strip.name} cap`).toBeGreaterThanOrEqual(strip.fader.left - 1)
          expect(strip.thumb.right, `${where} ${strip.name} cap`).toBeLessThanOrEqual(strip.fader.right + 1)
          expect(strip.db, `${where} ${strip.name} db`).toMatch(/dB|inf/)
          expect(strip.dbBox.height, `${where} ${strip.name} db`).toBeGreaterThanOrEqual(10)
          expect(strip.marks.map((mark) => mark.text), `${where} ${strip.name} scale`).toEqual(['0', '-6', '-12', '-18'])
          const inside = [strip.nameBox, strip.dbBox, strip.fader, strip.meter, strip.thumb, ...strip.marks.map((mark) => mark.box), ...strip.controls.map((control) => control.box)]
          for (const part of inside) {
            expect(part.left, `${where} ${strip.name}`).toBeGreaterThanOrEqual(strip.box.left - 1)
            expect(part.right, `${where} ${strip.name}`).toBeLessThanOrEqual(strip.box.right + 1)
            expect(part.top, `${where} ${strip.name}`).toBeGreaterThanOrEqual(strip.box.top - 1)
            expect(part.bottom, `${where} ${strip.name}`).toBeLessThanOrEqual(strip.box.bottom + 1)
          }
          const stacked = [strip.nameBox, strip.fader, ...strip.controls.map((control) => control.box)]
          for (let i = 0; i < stacked.length; i += 1) {
            for (let j = i + 1; j < stacked.length; j += 1) {
              expect(overlaps(stacked[i], stacked[j]), `${where} ${strip.name} stack`).toBe(false)
            }
          }
          expect(overlaps(strip.dbBox, strip.nameBox), `${where} ${strip.name} db`).toBe(false)
          expect(overlaps(strip.dbBox, strip.thumb), `${where} ${strip.name} db`).toBe(false)
          for (let i = 0; i < strip.marks.length; i += 1) {
            for (let j = i + 1; j < strip.marks.length; j += 1) {
              expect(overlaps(strip.marks[i].box, strip.marks[j].box), `${where} ${strip.name} scale`).toBe(false)
            }
            expect(overlaps(strip.marks[i].box, strip.fader), `${where} ${strip.name} ${strip.marks[i].text}`).toBe(false)
          }
          for (const control of strip.controls) {
            expect(control.box.height, `${where} ${strip.name} ${control.word}`).toBeGreaterThanOrEqual(40)
            expect(control.scrollWidth, `${where} ${strip.name} ${control.word}`).toBeLessThanOrEqual(control.clientWidth + 1)
            expect(control.scrollHeight, `${where} ${strip.name} ${control.word}`).toBeLessThanOrEqual(control.clientHeight + 1)
          }
          const words = strip.controls.map((control) => control.word)
          if (strip.name === 'Master') {
            expect(words, where).toEqual(expect.arrayContaining(['Arrives', 'Leaves']))
            expect(words, where).not.toContain('More')
          } else {
            expect(words, `${where} ${strip.name}`).toEqual(expect.arrayContaining(['Mute', 'Solo']))
            expect(words, `${where} ${strip.name}`).not.toContain('More')
          }
          for (const hidden of ['Arm', 'Safe', 'Inserts', 'Off', 'Read', 'Touch', 'Latch']) {
            expect(words, `${where} ${strip.name} ${hidden}`).not.toContain(hidden)
          }
        }
        const scrolled = await page.evaluate(() => {
          const mixer = document.querySelector('.mixer') as HTMLElement
          mixer.scrollLeft = mixer.scrollWidth
          const port = mixer.getBoundingClientRect()
          const master = document.querySelector('.strip.master')!.getBoundingClientRect()
          const hits = [...document.querySelectorAll('.mixer > .strip')].filter((strip) => {
            const box = strip.getBoundingClientRect()
            const left = Math.max(box.left, port.left)
            const right = Math.min(box.right, port.right)
            const top = Math.max(box.top, port.top)
            const bottom = Math.min(box.bottom, port.bottom)
            const width = right - left
            const height = bottom - top
            if (width <= 1 || height <= 1) return false
            const overlapW = Math.min(right, master.right) - Math.max(left, master.left)
            const overlapH = Math.min(bottom, master.bottom) - Math.max(top, master.top)
            return overlapW > 1 && overlapH > 1
          })
          return { hits: hits.length, masterLeft: master.left, portRight: port.right }
        })
        expect(scrolled.hits, where).toBe(0)
        expect(scrolled.masterLeft, where).toBeGreaterThanOrEqual(scrolled.portRight - 1)
        await page.evaluate(() => { (document.querySelector('.mixer') as HTMLElement).scrollLeft = 0 })
        await page.screenshot({ path: `/opt/cursor/artifacts/mix-short-${viewport.name}.png` })
        const open = await page.evaluate(() => {
          const strip = document.querySelector('.mixer > .strip') as HTMLElement
          const before = (strip.querySelector('.volume-row .touch-slider') as HTMLElement).getBoundingClientRect().height
          const details = document.querySelector('details.mix-more') as HTMLDetailsElement
          details.open = true
          const fader = (strip.querySelector('.volume-row .touch-slider') as HTMLElement).getBoundingClientRect()
          const panel = (document.querySelector('.mix-panel') as HTMLElement).getBoundingClientRect()
          const arm = [...document.querySelectorAll('.mix-panel button')].some((button) => (button.textContent || '').includes('Arm') && button.getBoundingClientRect().height >= 40)
          const phase = [...document.querySelectorAll('.mix-panel button')].find((button) => (button.textContent || '').includes('Phase'))
          return {
            before,
            after: fader.height,
            panelTop: panel.top,
            panelLeft: panel.left,
            panelRight: panel.right,
            panelBottom: panel.bottom,
            arm,
            phaseWidth: phase ? phase.getBoundingClientRect().width : 0,
            vw: window.innerWidth,
            vh: window.innerHeight,
          }
        })
        expect(open.after, where).toBeGreaterThanOrEqual(160)
        expect(Math.abs(open.after - open.before), where).toBeLessThanOrEqual(1)
        expect(open.panelRight - open.panelLeft, where).toBeLessThan(open.vw - 16)
        expect(open.panelBottom - open.panelTop, where).toBeLessThan(open.vh * 0.7)
        expect(open.arm, where).toBe(true)
        expect(open.phaseWidth, where).toBeGreaterThanOrEqual(40)
        expect(open.phaseWidth, where).toBeLessThan(open.panelRight - open.panelLeft - 24)
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)

  it('leaves portrait, cover, unfolded, and computer mixers tall', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch({ headless: true })
    try {
      for (const viewport of usual) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
        await page.setContent(markup(storeWith(4), viewport.width, viewport.height), { waitUntil: 'load' })
        const report = await readMixer(page)
        expect(report.short, viewport.name).toBe('')
        expect(report.widthTools, viewport.name).toBe(false)
        const widthCopy = await page.locator('.mix-panel').textContent()
        expect(widthCopy, viewport.name).toMatch(/Narrow|Normal/)
        expect(widthCopy, viewport.name).toContain('Reset')
        for (const strip of report.channels) {
          expect(strip.fader.height / strip.box.height, `${viewport.name} ${strip.name}`).toBeGreaterThanOrEqual(0.5)
          expect(strip.fader.height, `${viewport.name} ${strip.name}`).toBeGreaterThanOrEqual(160)
          const mute = strip.controls.find((control) => control.word === 'Mute')
          expect(mute?.box.height, `${viewport.name} Mute`).toBeGreaterThanOrEqual(40)
        }
        expect(report.masterFader.height / report.master.height, viewport.name).toBeGreaterThanOrEqual(0.5)
        await page.screenshot({ path: `/opt/cursor/artifacts/mix-layout-${viewport.name}.png` })
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})
