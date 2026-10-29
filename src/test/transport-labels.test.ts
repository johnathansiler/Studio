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
const css = ['src/styles.css', 'src/ui/premium.css', 'src/ui/remoteFixes.css', 'src/ui/loopRegion.css']
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
    desk: shell === 'studio',
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
  { name: 'desktop', width: 1920, height: 1080, shell: 'studio' },
  { name: 'phone', width: 412, height: 915, shell: 'phone' },
  { name: 'fold', width: 768, height: 900, shell: 'fold' },
]

describe('transport words', () => {
  it('shows Start, Play, Stop, Rec, and Loop on desktop, phone, and fold, and lights Play only while playing', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.setContent(transportPage(viewport.shell), { waitUntil: 'load' })
        const report = await page.evaluate(() => {
          const words = ['Start', 'Play', 'Stop', 'Rec', 'Loop']
          const buttons = words.map((word) => {
            const node = [...document.querySelectorAll<HTMLElement>('.transport .t-word')].find((item) => item.textContent === word)!
            const button = node.closest('button') as HTMLElement
            const text = node.getBoundingClientRect()
            const box = button.getBoundingClientRect()
            return {
              word,
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
          const stop = document.querySelector('.t-btn.stop') as HTMLElement
          const stopped = getComputedStyle(play).backgroundColor
          const idle = getComputedStyle(stop).backgroundColor
          play.classList.add('on')
          const playing = getComputedStyle(play).backgroundColor
          play.classList.remove('on')
          return {
            buttons,
            playClass: play.className,
            stopped,
            idle,
            playing,
            svg: getComputedStyle(document.querySelector('.transport .t-btn svg') as Element | null ?? document.body).display,
          }
        })
        expect(report.playClass).not.toContain(' on')
        expect(report.stopped).toBe(report.idle)
        expect(report.playing).not.toBe(report.stopped)
        for (const button of report.buttons) {
          expect(button.display, `${viewport.name} ${button.word}`).not.toBe('none')
          expect(button.textWidth, `${viewport.name} ${button.word}`).toBeGreaterThan(2)
          expect(button.left, `${viewport.name} ${button.word}`).toBeGreaterThanOrEqual(button.boxLeft - 1)
          expect(button.right, `${viewport.name} ${button.word}`).toBeLessThanOrEqual(button.boxRight + 1)
          expect(button.scrollWidth, `${viewport.name} ${button.word}`).toBeLessThanOrEqual(button.clientWidth + 1)
          expect(button.scrollHeight, `${viewport.name} ${button.word}`).toBeLessThanOrEqual(button.clientHeight + 1)
          expect(button.width, `${viewport.name} ${button.word}`).toBeGreaterThanOrEqual(36)
          if (viewport.name !== 'phone' || viewport.height > viewport.width) {
            expect(button.height, `${viewport.name} ${button.word}`).toBeGreaterThanOrEqual(36)
          }
        }
      }
    } finally {
      await browser.close()
    }
  })
})
