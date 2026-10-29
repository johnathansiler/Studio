import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { STRIP_HALF } from '../model/layoutWidth'
import { ProjectStore } from '../state/store'
import { MixerView } from '../ui/MixerView'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = [
  readFileSync(resolve(root, 'src/styles.css'), 'utf8'),
  readFileSync(resolve(root, 'src/ui/premium.css'), 'utf8'),
  readFileSync(resolve(root, 'src/ui/automation.css'), 'utf8'),
].join('\n')

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  levels: () => ({ master: 0, input: 0, talk: 0, tracks: {} }),
  masterReading: () => null,
  mixMeters: () => ({ cpu: 0, lufs: -70, truePeak: -70 }),
} as unknown as AudioEngine

describe('half-width mixer strips', () => {
  it('uses initials for Off Read Touch Latch and keeps the strip controls on screen', async () => {
    const store = new ProjectStore()
    const html = renderToStaticMarkup(createElement(MixerView, { store, engine })).replace(/--strip:\s*\d+px/g, `--strip:${STRIP_HALF}px`)
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setViewportSize({ width: 900, height: 800 })
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="shell">${html}</div></body></html>`, { waitUntil: 'load' })
      const box = await page.evaluate(() => {
        const strip = document.querySelector('.strip') as HTMLElement
        const full = strip.querySelector('.mode-full') as HTMLElement
        const short = strip.querySelector('.mode-short') as HTMLElement
        const shorts = [...strip.querySelectorAll('.mode-short')].map((node) => node.textContent)
        const name = strip.querySelector('h3') as HTMLElement
        const fader = strip.querySelector('.fader-row input') as HTMLElement
        const pan = strip.querySelector('input.pan') as HTMLElement
        const meter = strip.querySelector('.meter') as HTMLElement
        const buttons = [...strip.querySelectorAll('.mini')].map((node) => (node.textContent || '').replace(/\s+/g, ''))
        const stripBox = strip.getBoundingClientRect()
        const nameBox = name.getBoundingClientRect()
        const faderBox = fader.getBoundingClientRect()
        return {
          width: stripBox.width,
          left: stripBox.left,
          full: getComputedStyle(full).display,
          short: getComputedStyle(short).display,
          shorts,
          buttons,
          name: name.textContent,
          nameInside: nameBox.right <= stripBox.right + 1 && nameBox.left >= stripBox.left - 1,
          faderInside: faderBox.right <= stripBox.right + 1 && faderBox.width > 8,
          pan: !!pan,
          meter: !!meter,
        }
      })
      expect(box.width).toBeLessThanOrEqual(STRIP_HALF + 1)
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.full).toBe('none')
      expect(box.short).not.toBe('none')
      expect(box.shorts).toEqual(['O', 'R', 'T', 'L'])
      expect(box.buttons.some((label) => label.includes('M'))).toBe(true)
      expect(box.buttons.some((label) => label.includes('S'))).toBe(true)
      expect(box.buttons.some((label) => label.includes('R') || label.includes('Arm'))).toBe(true)
      expect(box.name).toBe('Vocal')
      expect(box.nameInside).toBe(true)
      expect(box.faderInside).toBe(true)
      expect(box.pan).toBe(true)
      expect(box.meter).toBe(true)
    } finally {
      await browser.close()
    }
  })
})
