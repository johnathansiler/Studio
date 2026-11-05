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
        for (const details of document.querySelectorAll<HTMLDetailsElement>('details.mix-more')) details.open = true
        const mixer = document.querySelector('.mixer-view') as HTMLElement
        const strip = document.querySelector('.strip') as HTMLElement
        const autos = [...document.querySelectorAll<HTMLElement>('.mix-panel .strip-auto button')]
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
        const face = (strip.querySelector('.strip-col') as HTMLElement | null) ?? strip
        const faceBox = face.getBoundingClientRect()
        const autoBoxes = autos.map((button) => button.getBoundingClientRect())
        const panel = document.querySelector('.mix-panel') as HTMLElement
        const panelBox = panel.getBoundingClientRect()
        const arm = panel.querySelector('.arm-flag') as HTMLElement
        const armShown = [...arm.querySelectorAll<HTMLElement>('span')].filter((node) => getComputedStyle(node).display !== 'none').map((node) => (node.textContent || '').trim()).join('')
        const armStyle = getComputedStyle(arm)
        return {
          layout: mixer.dataset.layout,
          narrow: mixer.dataset.narrow,
          stripWidth: faceBox.width,
          modeCount: autos.length,
          modeInside: autoBoxes.length === 1 && autoBoxes[0].width >= 36 && autoBoxes[0].height >= 40 && autoBoxes[0].left >= panelBox.left - 1 && autoBoxes[0].right <= panelBox.right + 1 && panelBox.width < window.innerWidth - 16,
          words: autos.map((button) => (button.querySelector('.mode-full') as HTMLElement | null)?.textContent),
          letters: autos.map((button) => getComputedStyle(button.querySelector('.mode-short') as HTMLElement).display),
          pressed: autos.some((button) => button.classList.contains('on') && button.getAttribute('aria-pressed') === 'true'),
          fx: !!document.querySelector('.mix-chips [role="tab"]'),
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
      expect(report.modeCount).toBe(1)
      expect(report.modeInside).toBe(true)
      expect(report.words).toEqual(['Read'])
      expect(report.letters.every((display) => display === 'none')).toBe(true)
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

  it('keeps a saved rows choice on side-by-side columns', async () => {
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
        const details = document.querySelector('details.mix-more') as HTMLDetailsElement
        details.open = true
        const panel = document.querySelector('.mix-panel') as HTMLElement
        const captions = [...document.querySelectorAll<HTMLElement>('.mode-full, .mini-word, .arm-full')].filter((node) => getComputedStyle(node).display !== 'none').map((node) => (node.textContent || '').trim())
        const arm = panel.querySelector('.arm-flag') as HTMLElement
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
      expect(report.layout).toBe('columns')
      expect(report.captions).toEqual(expect.arrayContaining(['Read', 'Mute', 'Solo', 'Arm', 'Safe']))
      expect(report.armShown).toBe('Arm')
      expect(report.below).toBe(false)
      expect(report.horizontal).toBe(false)
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
