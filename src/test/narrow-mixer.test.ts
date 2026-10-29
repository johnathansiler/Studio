import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { STRIP_HALF, writeLayout } from '../model/layoutWidth'
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
  mixMeters: () => ({ cpu: 0.05, lufs: -70, truePeak: -70 }),
} as unknown as AudioEngine

function markup(store: ProjectStore) {
  const html = renderToStaticMarkup(createElement(MixerView, { store, engine }))
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: #101614; }
    ${css}
  </style></head><body>
    <div class="shell phone" style="width:412px;height:915px">
      <div class="main-pane" style="height:760px">${html}</div>
    </div>
  </body></html>`
}

describe('phone mixer at 412x915', () => {
  it('keeps narrow columns tappable, with stacked controls and no clipped text', async () => {
    const store = new ProjectStore()
    store.updateTrack(store.project.tracks[0].id, { armed: true })
    writeLayout(store.project.id, { strip: STRIP_HALF, column: 70, mixer: 'columns' })
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 412, height: 915 } })
      await page.setContent(markup(store), { waitUntil: 'load' })
      const report = await page.evaluate(() => {
        const mixer = document.querySelector('.mixer-view') as HTMLElement
        const strip = document.querySelector('.strip') as HTMLElement
        const autos = [...strip.querySelectorAll<HTMLElement>('.strip-auto button')]
        const buttons = [...document.querySelectorAll<HTMLElement>('button')].filter((button) => {
          const style = getComputedStyle(button)
          const box = button.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
        }).map((button) => ({
          label: (button.textContent || '').replace(/\s+/g, ' ').trim(),
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
          scrollWidth: button.scrollWidth,
          clientWidth: button.clientWidth,
          scrollHeight: button.scrollHeight,
          clientHeight: button.clientHeight,
        }))
        const texts = [...mixer.querySelectorAll<HTMLElement>('h3, .master-read span, .strip-name')].map((node) => ({
          label: (node.textContent || '').trim(),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        }))
        const autoBoxes = autos.map((button) => button.getBoundingClientRect())
        const arm = strip.querySelector('.arm-flag') as HTMLElement
        const armShown = [...arm.querySelectorAll<HTMLElement>('span')].filter((node) => getComputedStyle(node).display !== 'none').map((node) => (node.textContent || '').trim()).join('')
        const armStyle = getComputedStyle(arm)
        return {
          layout: mixer.dataset.layout,
          narrow: mixer.dataset.narrow,
          stripWidth: strip.getBoundingClientRect().width,
          stacked: autoBoxes.length >= 2 && autoBoxes[1].top >= autoBoxes[0].bottom - 1,
          fullWidth: autoBoxes.length > 0 && autoBoxes[0].width >= strip.getBoundingClientRect().width - 6,
          shorts: autos.map((button) => (button.querySelector('.mode-short') as HTMLElement | null)?.textContent),
          captions: autos.map((button) => (button.querySelector('.mode-caption') as HTMLElement | null)?.textContent),
          fullHidden: getComputedStyle(autos[0].querySelector('.mode-full') as HTMLElement).display,
          pressed: autos.some((button) => button.classList.contains('on') && button.getAttribute('aria-pressed') === 'true'),
          fx: !!strip.querySelector('.fx-open'),
          chevron: !!strip.querySelector('select'),
          armShown,
          armLit: arm.classList.contains('on-r') && armStyle.backgroundColor !== 'rgba(0, 0, 0, 0)',
          buttons,
          texts,
        }
      })
      expect(report.layout).toBe('columns')
      expect(report.narrow).toBe('1')
      expect(report.stripWidth).toBeLessThanOrEqual(STRIP_HALF + 1)
      expect(report.stacked).toBe(true)
      expect(report.fullWidth).toBe(true)
      expect(report.shorts).toEqual(['O', 'R', 'T', 'L'])
      expect(report.captions).toEqual(['Off', 'Read', 'Touch', 'Latch'])
      expect(report.fullHidden).toBe('none')
      expect(report.pressed).toBe(true)
      expect(report.fx).toBe(true)
      expect(report.chevron).toBe(false)
      expect(report.armShown).toBe('Arm')
      expect(report.armLit).toBe(true)
      expect(report.buttons.length).toBeGreaterThan(8)
      for (const button of report.buttons) {
        expect(button.width, button.label).toBeGreaterThanOrEqual(36)
        expect(button.height, button.label).toBeGreaterThanOrEqual(36)
        expect(button.scrollWidth, button.label).toBeLessThanOrEqual(button.clientWidth + 1)
        expect(button.scrollHeight, button.label).toBeLessThanOrEqual(button.clientHeight + 1)
      }
      for (const text of report.texts) {
        expect(text.scrollWidth, text.label).toBeLessThanOrEqual(text.clientWidth + 1)
      }
      await page.screenshot({ path: '/opt/cursor/artifacts/mixer-narrow-columns.png', fullPage: true })
      await page.close()
    } finally {
      await browser.close()
    }
  })

  it('stacks channels as horizontal rows with tappable controls', async () => {
    const store = new ProjectStore()
    writeLayout(store.project.id, { strip: STRIP_HALF, column: 70, mixer: 'rows' })
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 412, height: 915 } })
      await page.setContent(markup(store), { waitUntil: 'load' })
      const report = await page.evaluate(() => {
        const mixer = document.querySelector('.mixer-view') as HTMLElement
        const strips = [...document.querySelectorAll<HTMLElement>('.mixer > .strip')]
        const first = strips[0]
        const second = strips[1]
        const fader = first.querySelector('.fader-row .touch-slider') as HTMLElement
        const faderBox = fader.getBoundingClientRect()
        const buttons = [...document.querySelectorAll<HTMLElement>('button')].filter((button) => {
          const style = getComputedStyle(button)
          const box = button.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
        }).map((button) => ({
          label: (button.textContent || '').replace(/\s+/g, ' ').trim(),
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
          scrollWidth: button.scrollWidth,
          clientWidth: button.clientWidth,
          scrollHeight: button.scrollHeight,
          clientHeight: button.clientHeight,
        }))
        const texts = [...mixer.querySelectorAll<HTMLElement>('h3, .master-read span, .strip-name')].map((node) => ({
          label: (node.textContent || '').trim(),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        }))
        const captions = [...first.querySelectorAll<HTMLElement>('.mode-caption, .mini-caption')].map((node) => (node.textContent || '').trim())
        const arm = first.querySelector('.arm-flag') as HTMLElement
        const armShown = [...arm.querySelectorAll<HTMLElement>('span')].filter((node) => getComputedStyle(node).display !== 'none').map((node) => (node.textContent || '').trim()).join('')
        const mix = (document.querySelector('.mixer') as HTMLElement).getBoundingClientRect()
        return {
          layout: mixer.dataset.layout,
          narrow: mixer.dataset.narrow ?? '',
          below: second.getBoundingClientRect().top >= first.getBoundingClientRect().bottom - 1,
          wide: first.getBoundingClientRect().width >= mix.width - 20,
          horizontal: faderBox.width > faderBox.height,
          touch: getComputedStyle(fader).touchAction,
          armShown,
          captions,
          buttons,
          texts,
        }
      })
      expect(report.layout).toBe('rows')
      expect(report.captions).toEqual(expect.arrayContaining(['Off', 'Read', 'Touch', 'Latch', 'Mute', 'Solo']))
      expect(report.armShown).toBe('Arm')
      expect(report.narrow).toBe('')
      expect(report.below).toBe(true)
      expect(report.wide).toBe(true)
      expect(report.horizontal).toBe(true)
      expect(report.touch).toBe('none')
      for (const button of report.buttons) {
        expect(button.width, button.label).toBeGreaterThanOrEqual(36)
        expect(button.height, button.label).toBeGreaterThanOrEqual(36)
        expect(button.scrollWidth, button.label).toBeLessThanOrEqual(button.clientWidth + 1)
        expect(button.scrollHeight, button.label).toBeLessThanOrEqual(button.clientHeight + 1)
      }
      for (const text of report.texts) {
        expect(text.scrollWidth, text.label).toBeLessThanOrEqual(text.clientWidth + 1)
      }
      await page.screenshot({ path: '/opt/cursor/artifacts/mixer-rows.png', fullPage: true })
      await page.close()
    } finally {
      await browser.close()
    }
  })
})
