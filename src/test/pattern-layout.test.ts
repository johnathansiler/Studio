import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { ProjectStore } from '../state/store'
import { BeatView } from '../ui/BeatView'
import { formFactor } from '../ui/form'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = [
  readFileSync(resolve(root, 'src/styles.css'), 'utf8'),
  readFileSync(resolve(root, 'src/ui/remoteFixes.css'), 'utf8'),
  readFileSync(resolve(root, 'src/ui/channel-rack.css'), 'utf8'),
].join('\n')

const PHONES = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
  { width: 915, height: 412 },
  { width: 673, height: 841 },
  { width: 884, height: 1104 },
]

function shellClass(width: number, height: number) {
  const factor = formFactor(width, height)
  return [
    'shell',
    'studio',
    factor === 'phone' ? 'phone' : '',
    factor === 'fold' ? 'fold' : '',
    width > height ? 'land' : '',
  ].filter(Boolean).join(' ')
}

function markup(width: number, height: number) {
  const previous = globalThis.window
  globalThis.window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window & typeof globalThis
  try {
    const store = new ProjectStore()
    const html = renderToStaticMarkup(createElement(BeatView, {
      store,
      engine: { positionSamples: 0 } as AudioEngine,
    }))
    return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head>
<body>
<div class="${shellClass(width, height)}">
  <div class="workspace">
    <div class="main-pane"><div class="editor">${html}</div></div>
    <div class="dock-slot"></div>
  </div>
</div>
</body>
</html>`
  } finally {
    if (previous) globalThis.window = previous
    else delete (globalThis as { window?: Window }).window
  }
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector('.rack-row[data-channel="Kick"]') as HTMLElement
    const steps = [...row.querySelectorAll('.rack-step')].map((el) => {
      const box = el.getBoundingClientRect()
      return { top: box.top, left: box.left, right: box.right, width: box.width, height: box.height }
    })
    const lead = row.querySelector('.rack-lead') as HTMLElement
    const scroller = document.querySelector('.rack-scroll') as HTMLElement
    const leadBox = lead.getBoundingClientRect()
    const scrollBox = scroller.getBoundingClientRect()
    const outside = [...document.querySelectorAll('.rack-bar button, .rack-bar select, .rack-bar input, .rack-lead button, .rack-add, .rack-extras.open button, .rack-extras.open input, .rack-extras.open select')]
      .filter((el) => {
        const box = el.getBoundingClientRect()
        if (box.width < 1 || box.height < 1) return false
        return box.left < -1 || box.right > window.innerWidth + 1
      })
      .map((el) => `${(el.getAttribute('aria-label') || el.className || el.tagName)}`.slice(0, 80))
    const tops = steps.map((step) => Math.round(step.top))
    return {
      steps,
      tops: [...new Set(tops)],
      scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      outside,
      sticky: getComputedStyle(lead).position,
      leadLeft: leadBox.left,
      leadRight: leadBox.right,
      scrollLeft: scrollBox.left,
      scrollRight: scrollBox.right,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      groups: row.querySelectorAll('.rack-group').length,
      alt: row.querySelectorAll('.rack-group.alt').length,
      bar: document.querySelector('.rack-bar')?.textContent ?? '',
      extras: document.querySelector('.rack-extras')?.textContent ?? '',
      tool: document.querySelector('.rack-tool')?.textContent ?? '',
      mute: row.querySelectorAll('.rack-mute').length,
      ticks: document.querySelectorAll('.rack-ruler .rack-tick').length,
      align: (() => {
        const tick = document.querySelector('.rack-ruler .rack-tick')
        const step = row.querySelector('.rack-step')
        if (!tick || !step) return 99
        return Math.abs(tick.getBoundingClientRect().left - step.getBoundingClientRect().left)
      })(),
    }
  })
}

describe('pattern step layout', () => {
  it('keeps the perform pad editor stacked and the pattern steps horizontal', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
        <div class="perform-pop"><div class="step-grid" id="perform-steps"></div></div>
      </body></html>`, { waitUntil: 'load' })
      const direction = await page.evaluate(() => getComputedStyle(document.getElementById('perform-steps')!).flexDirection)
      expect(direction).toBe('column')
    } finally {
      await browser.close()
    }
  })

  it('lays Kick steps out horizontally at phone, fold, and desktop widths', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const viewport of PHONES) {
        await page.setViewportSize(viewport)
        await page.setContent(markup(viewport.width, viewport.height), { waitUntil: 'load' })
        const box = await measure(page)
        const where = `${viewport.width}x${viewport.height}`
        const portrait = viewport.width <= 520 && viewport.height > viewport.width
        expect(box.steps, where).toHaveLength(16)
        expect(box.steps[1].left, JSON.stringify(box.steps.slice(0, 2))).toBeGreaterThan(box.steps[0].left + 8)
        expect(box.groups, where).toBe(4)
        expect(box.alt, where).toBe(2)
        if (portrait) {
          expect(box.tops, where).toHaveLength(2)
          expect(box.steps[8].top, where).toBeGreaterThan(box.steps[0].top + 30)
          expect(box.sticky, where).toBe('static')
          expect(box.scrollWidth, where).toBeLessThanOrEqual(box.clientWidth + 8)
        } else {
          expect(Math.abs(box.steps[0].top - box.steps[1].top), where).toBeLessThan(2)
          expect(box.tops, where).toHaveLength(1)
          expect(box.sticky, where).toBe('sticky')
        }
        expect(box.leadLeft, where).toBeGreaterThanOrEqual(-1)
        expect(box.leadRight, where).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.scrollRight, where).toBeLessThanOrEqual(viewport.width + 1)
        expect(box.scroll, where).toBeLessThanOrEqual(1)
        expect(box.outside, box.outside.join(', ')).toEqual([])
        expect(box.mute, where).toBe(1)
        expect(box.bar).toContain('Steps')
        expect(box.bar).toContain('Paint')
        expect(box.ticks, where).toBe(16)
        expect(box.align, where).toBeLessThan(2)
        const phone = viewport.width <= 520 || (viewport.width > viewport.height && viewport.height <= 520)
        if (phone) expect(box.bar, where).not.toContain('Swing')
        else expect(box.bar, where).toContain('Swing')
        for (const step of box.steps) {
          expect(step.width, where).toBeGreaterThanOrEqual(portrait ? 36 : 24)
          expect(step.height, where).toBeGreaterThanOrEqual(portrait ? 40 : 28)
        }
        if (!portrait && viewport.width <= 520) expect(box.scrollWidth, where).toBeGreaterThan(box.clientWidth + 8)
        await page.evaluate(() => document.querySelector('.rack-extras')!.classList.add('open'))
        const open = await measure(page)
        expect(open.outside, open.outside.join(', ')).toEqual([])
        expect(open.scroll, where).toBeLessThanOrEqual(1)
        expect(open.tops, where).toHaveLength(portrait ? 2 : 1)
        if (phone) expect(open.extras, where).toContain('Swing')
        const visible = await page.evaluate(() => document.querySelector('.rack-extras')!.getBoundingClientRect().height)
        expect(visible).toBeGreaterThan(32)
      }

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.setContent(markup(1440, 900), { waitUntil: 'load' })
      const desk = await measure(page)
      expect(desk.steps).toHaveLength(16)
      expect(desk.tops).toHaveLength(1)
      expect(desk.steps[1].left).toBeGreaterThan(desk.steps[0].left + 8)
      expect(desk.scroll).toBeLessThanOrEqual(1)
      expect(desk.outside, desk.outside.join(', ')).toEqual([])
      expect(desk.sticky).toBe('sticky')
      expect(desk.bar).toContain('Swing')
      expect(desk.bar).toContain('Steps')
      expect(desk.bar).toContain('Paint')
      expect(desk.ticks).toBe(16)
      expect(desk.align).toBeLessThan(2)
      expect(desk.mute).toBe(1)
      const place = await page.evaluate(() => {
        const button = [...document.querySelectorAll('.rack-bar button')].find((el) => el.textContent === 'To Arrange')
        const box = button!.getBoundingClientRect()
        return { right: box.right, width: box.width }
      })
      expect(place.width).toBeGreaterThan(20)
      expect(place.right).toBeLessThanOrEqual(1440 + 1)
    } finally {
      await browser.close()
    }
  })
})
