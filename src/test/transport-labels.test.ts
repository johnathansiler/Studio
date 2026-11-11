import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { TransportBar } from '../ui/TransportBar'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = [
  'src/styles.css',
  'src/ui/remoteFixes.css',
  'src/ui/premium.css',
  'src/ui/buttonTiers.css',
  'src/ui/anchoredMenu.css',
  'src/ui/buttonTray.css',
  'src/ui/loopRegion.css',
]
  .map((file) => readFileSync(resolve(root, file), 'utf8'))
  .join('\n')

const engine = {
  positionSamples: 0,
  status: 'stopped' as const,
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  unlock() {},
}

function transportPage(shell: string) {
  const store = new ProjectStore()
  const html = renderToStaticMarkup(createElement(TransportBar, {
    store,
    engine: engine as never,
    simple: true,
    phone: shell === 'phone',
    onPlay() {},
    onStop() {},
    onRecord() {},
    onSeek() {},
  }))
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: #101614; }
    ${css}
  </style></head><body><div class="shell ${shell}">${html}</div></body></html>`
}

const VIEWPORTS = [
  { name: 'desk', width: 1440, height: 900, shell: 'studio', words: ['Start', 'Rewind', 'Forward', 'Play', 'Record'] },
  { name: 'phone', width: 390, height: 844, shell: 'phone', words: ['Start', 'Rewind', 'Forward', 'Play', 'Record'] },
  { name: 'fold', width: 880, height: 1000, shell: 'fold', words: ['Start', 'Rewind', 'Forward', 'Play', 'Record'] },
]

describe('transport words', () => {
  it('shows the transport words without clipping, and lights Play only while playing', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.setContent(transportPage(viewport.shell), { waitUntil: 'load' })
        const report = await page.evaluate((words) => {
          const buttons = words.map((word) => {
            const node = [...document.querySelectorAll<HTMLElement>('.transport .t-word')].find((item) => item.textContent === word || item.textContent?.startsWith(`${word} `))!
            const button = node.closest('button') as HTMLElement
            const text = node.getBoundingClientRect()
            const box = button.getBoundingClientRect()
            return {
              word,
              text: node.textContent,
              display: getComputedStyle(node).display,
              textWidth: text.width,
              left: text.left,
              right: text.right,
              boxLeft: box.left,
              boxRight: box.right,
              scrollWidth: button.scrollWidth,
              clientWidth: button.clientWidth,
              scrollHeight: button.scrollHeight,
              clientHeight: button.clientHeight,
              width: box.width,
              height: box.height,
            }
          })
          const play = document.querySelector('.t-btn.play') as HTMLElement
          const idleHost = (document.querySelector('.t-btn.stop') || document.querySelector('.t-main .t-btn')) as HTMLElement
          const stopped = getComputedStyle(play).backgroundColor
          const idle = getComputedStyle(idleHost).backgroundColor
          play.classList.add('on')
          const playing = getComputedStyle(play).backgroundColor
          play.classList.remove('on')
          const bar = document.querySelector('.transport') as HTMLElement
          const barBox = bar.getBoundingClientRect()
          return {
            buttons,
            playClass: play.className,
            stopped,
            idle,
            playing,
            barRight: barBox.right,
            barScroll: bar.scrollWidth,
            barClient: bar.clientWidth,
            viewport: window.innerWidth,
          }
        }, viewport.words)
        expect(report.playClass).not.toContain(' on')
        expect(report.playing).not.toBe(report.stopped)
        expect(report.barRight).toBeLessThanOrEqual(report.viewport + 1)
        expect(report.barScroll).toBeLessThanOrEqual(report.barClient + 1)
        const order = await page.evaluate(() => {
          const words = [...document.querySelectorAll('.t-main .t-word, .t-main .tempo-kicker')].map((node) => (node.textContent || '').trim())
          const row = [...document.querySelectorAll<HTMLElement>('.t-main > .t-btn, .t-main > .tempo-cluster')]
          const boxes = row.map((node) => node.getBoundingClientRect())
          const tops = boxes.map((box) => Math.round(box.top))
          const widths = boxes.map((box) => box.width)
          const transport = document.querySelector('.transport')!.getBoundingClientRect()
          const tray = document.querySelector('.t-main')!.getBoundingClientRect()
          const click = document.querySelector('.t-btn.click') as HTMLElement | null
          const count = document.querySelector('.t-btn.count') as HTMLElement | null
          const rec = document.querySelector('.t-btn.rec') as HTMLElement
          const paint = (node: HTMLElement, on: boolean) => {
            node.classList.toggle('on', on)
            return getComputedStyle(node).backgroundColor
          }
          const clickOff = click ? paint(click, false) : ''
          const clickOn = click ? paint(click, true) : ''
          const countOff = count ? paint(count, false) : ''
          const countOn = count ? paint(count, true) : ''
          const recOff = paint(rec, false)
          const recOn = paint(rec, true)
          if (click) paint(click, false)
          if (count) paint(count, false)
          paint(rec, false)
          const buttons = row.map((node) => {
            const box = node.getBoundingClientRect()
            return { text: (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim(), top: box.top, height: box.height, width: box.width }
          })
          const tempo = document.querySelector('.tempo-tap')
          return {
            words,
            kicker: document.querySelector('.tempo-kicker')?.textContent,
            buttons,
            tapButton: buttons.some((button) => button.text === 'Tap'),
            tempoLabel: tempo?.getAttribute('aria-label') || '',
            lengthButton: buttons.some((button) => button.text === 'Length'),
            more: document.querySelectorAll('.t-btn.menu, #transport-menu, .transport-drawer').length,
            rowCount: row.length,
            oneRow: new Set(tops).size === 1,
            traySpans: tray.width >= transport.width - 16 && tray.left >= transport.left - 1 && tray.right <= transport.right + 1,
            minWidth: Math.min(...widths),
            widthSpread: Math.max(...widths) - Math.min(...widths),
            clickWord: words.includes('Click') || [...document.querySelectorAll('.t-word')].some((node) => (node.textContent || '').trim() === 'Click'),
            clickOff,
            clickOn,
            countOff,
            countOn,
            countPresent: Boolean(count),
            recOff,
            recOn,
          }
        })
        expect(order.words.filter((word) => word !== 'Tempo' && word !== 'Click' && word !== '1-2' && word !== 'Reset' && word !== 'Punch'), viewport.name).toEqual(['Start', 'Rewind', 'Forward', 'Play', 'Record'])
        expect(order.rowCount, viewport.name).toBe(6)
        if (viewport.name === 'phone') {
          expect(order.clickWord, viewport.name).toBe(false)
          expect(order.countPresent, viewport.name).toBe(false)
          expect(order.recOn, viewport.name).not.toBe(order.recOff)
        } else {
          expect(order.clickWord, viewport.name).toBe(true)
          expect(order.clickOn, viewport.name).not.toBe(order.clickOff)
          expect(order.countOn, viewport.name).toBe(order.clickOn)
          expect(order.recOn, viewport.name).not.toBe(order.clickOn)
        }
        expect(order.kicker).toBe('Tempo')
        expect(order.tapButton, viewport.name).toBe(false)
        expect(order.lengthButton, viewport.name).toBe(false)
        expect(order.tempoLabel).toContain('Tap to set tempo')
        expect(order.more, viewport.name).toBe(0)
        expect(order.oneRow, viewport.name).toBe(true)
        expect(order.traySpans, viewport.name).toBe(true)
        expect(order.minWidth, viewport.name).toBeGreaterThanOrEqual(40)
        expect(order.widthSpread, viewport.name).toBeLessThanOrEqual(4)
        for (const button of order.buttons) {
          expect(button.height, `${viewport.name} ${button.text}`).toBeGreaterThanOrEqual(40)
          expect(button.width, `${viewport.name} ${button.text}`).toBeLessThan(viewport.width - 8)
        }
        for (const button of report.buttons) {
          expect(button.display, `${viewport.name} ${button.word}`).not.toBe('none')
          expect(button.textWidth, `${viewport.name} ${button.word}`).toBeGreaterThan(2)
          expect(button.left, `${viewport.name} ${button.word}`).toBeGreaterThanOrEqual(button.boxLeft - 1)
          expect(button.right, `${viewport.name} ${button.word}`).toBeLessThanOrEqual(button.boxRight + 1)
          expect(button.scrollWidth, `${viewport.name} ${button.word}`).toBeLessThanOrEqual(button.clientWidth + 1)
          expect(button.scrollHeight, `${viewport.name} ${button.word}`).toBeLessThanOrEqual(button.clientHeight + 1)
          expect(button.width, `${viewport.name} ${button.word}`).toBeGreaterThanOrEqual(40)
          if (viewport.name !== 'phone' || viewport.height > viewport.width) {
            expect(button.height, `${viewport.name} ${button.word}`).toBeGreaterThanOrEqual(40)
          }
        }
      }
    } finally {
      await browser.close()
    }
  })
})
