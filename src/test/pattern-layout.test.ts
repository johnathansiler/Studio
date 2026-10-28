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
  readFileSync(resolve(root, 'src/ui/beats.css'), 'utf8'),
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
    const row = document.querySelector('.beat-row[data-channel="Kick"]') as HTMLElement
    const grid = row.querySelector('.step-grid') as HTMLElement
    const steps = [...row.querySelectorAll('.step')].map((el) => {
      const box = el.getBoundingClientRect()
      return { top: box.top, left: box.left, right: box.right, width: box.width, height: box.height }
    })
    const style = getComputedStyle(grid)
    const outside = [...document.querySelectorAll('.beats button, .beats input, .beats select, .beats .beat-field')]
      .filter((el) => {
        const box = el.getBoundingClientRect()
        if (box.width < 1 || box.height < 1) return false
        return box.left < -1 || box.right > window.innerWidth + 1
      })
      .map((el) => `${el.className}`.slice(0, 80))
    const tops = steps.map((step) => Math.round(step.top))
    return {
      display: style.display,
      direction: style.flexDirection,
      columns: style.gridTemplateColumns.split(' ').filter((part) => part && part !== 'none').length,
      steps,
      tops: [...new Set(tops)],
      counts: [...new Set(tops)].map((top) => tops.filter((item) => item === top).length),
      scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      outside,
      more: row.querySelectorAll('.beat-more').length,
      swing: document.querySelector('.beat-bar')?.textContent ?? '',
      rowText: row.textContent ?? '',
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
        expect(box.steps, `${viewport.width}x${viewport.height}`).toHaveLength(16)
        expect(box.direction, `${viewport.width}x${viewport.height} ${box.display}`).not.toBe('column')
        expect(box.steps[1].left, JSON.stringify(box.steps.slice(0, 2))).toBeGreaterThan(box.steps[0].left + 8)
        expect(Math.abs(box.steps[0].top - box.steps[1].top)).toBeLessThan(2)
        expect(box.tops.length).toBeLessThanOrEqual(2)
        expect(box.counts[0]).toBeGreaterThanOrEqual(8)
        if (box.tops.length === 2) expect(box.counts).toEqual([8, 8])
        for (const step of box.steps) {
          expect(step.width).toBeGreaterThanOrEqual(32)
          expect(step.height).toBeGreaterThanOrEqual(32)
          expect(step.right).toBeLessThanOrEqual(viewport.width + 1)
          expect(step.left).toBeGreaterThanOrEqual(-1)
        }
        expect(box.scroll).toBeLessThanOrEqual(1)
        expect(box.outside, box.outside.join(', ')).toEqual([])
        expect(box.more).toBe(1)
        expect(box.swing).toContain('Swing')
        expect(box.swing).toContain('Steps')
        expect(box.rowText).toContain('Vol')
        expect(box.rowText).toContain('Pan')
        await page.evaluate(() => document.querySelector('.beat-row[data-channel="Kick"]')!.classList.add('open'))
        const open = await measure(page)
        expect(open.outside, open.outside.join(', ')).toEqual([])
        expect(open.scroll).toBeLessThanOrEqual(1)
        expect(open.steps[1].left).toBeGreaterThan(open.steps[0].left + 8)
        expect(Math.abs(open.steps[0].top - open.steps[1].top)).toBeLessThan(2)
        const visible = await page.evaluate(() => document.querySelector('.beat-row[data-channel="Kick"] .beat-settings')!.getBoundingClientRect().height)
        expect(visible).toBeGreaterThan(32)
      }

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.setContent(markup(1440, 900), { waitUntil: 'load' })
      const desk = await measure(page)
      expect(desk.display).toBe('flex')
      expect(desk.direction).toBe('row')
      expect(desk.more).toBe(0)
      expect(desk.steps).toHaveLength(16)
      expect(new Set(desk.steps.map((step) => Math.round(step.top))).size).toBe(1)
      expect(desk.steps[1].left).toBeGreaterThan(desk.steps[0].left + 8)
      expect(desk.scroll).toBeLessThanOrEqual(1)
      expect(desk.outside, desk.outside.join(', ')).toEqual([])
      expect(desk.swing).toContain('Swing')
      expect(desk.rowText).toContain('Vol')
      expect(desk.rowText).toContain('Pan')
      const copy = await page.evaluate(() => {
        const button = [...document.querySelectorAll('.beat-action')].find((el) => el.textContent === 'Copy')
        const box = button!.getBoundingClientRect()
        return { right: box.right, width: box.width }
      })
      expect(copy.width).toBeGreaterThan(20)
      expect(copy.right).toBeLessThanOrEqual(1440 + 1)
    } finally {
      await browser.close()
    }
  })
})
