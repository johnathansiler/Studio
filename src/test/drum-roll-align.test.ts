import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { ChannelRack } from '../ui/channelRack'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = [
  'src/styles.css',
  'src/ui/premium.css',
  'src/ui/channel-rack.css',
  'src/ui/drumRoll.css',
  'src/ui/loopRegion.css',
].map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')

const engine = {
  positionSamples: 0,
  status: 'stopped' as const,
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  seek() {},
  unlock() {},
}

function markup(width: number) {
  const store = new ProjectStore()
  store.toggleRackRoll()
  const html = renderToStaticMarkup(createElement(ChannelRack, { store, engine }))
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: #101614; }
    ${css}
  </style></head><body>
    <div class="shell" style="width:${width}px">${html}</div>
  </body></html>`
}

describe('drum roll alignment', () => {
  it('puts each roll note on the same column as its step', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const width of [1100, 412]) {
        await page.setViewportSize({ width, height: 800 })
        await page.setContent(markup(width), { waitUntil: 'load' })
        const report = await page.evaluate(() => {
          const row = document.querySelector('.rack-row[data-channel="Kick"]') as HTMLElement
          const lane = document.querySelector('.drum-lane') as HTMLElement
          const steps = [...row.querySelectorAll<HTMLElement>('.rack-step')]
          const slots = [...lane.querySelectorAll<HTMLElement>('.drum-slot')]
          const pairs = [0, 4, 8, 15].map((index) => {
            const step = steps[index].getBoundingClientRect()
            const slot = slots[index].getBoundingClientRect()
            const note = slots[index].querySelector('.drum-note')?.getBoundingClientRect() ?? null
            return {
              index,
              stepLeft: step.left,
              slotLeft: slot.left,
              stepRight: step.right,
              slotRight: slot.right,
              noteLeft: note?.left ?? null,
            }
          })
          const stepGrid = row.querySelector('.rack-steps')!.getBoundingClientRect()
          const rollGrid = lane.querySelector('.rack-steps')!.getBoundingClientRect()
          return {
            pairs,
            stepRight: stepGrid.right,
            rollRight: rollGrid.right,
            stepLeft: stepGrid.left,
            rollLeft: rollGrid.left,
          }
        })
        expect(Math.abs(report.stepLeft - report.rollLeft), `grid left ${width}`).toBeLessThanOrEqual(2)
        expect(Math.abs(report.stepRight - report.rollRight), `grid right ${width}`).toBeLessThanOrEqual(2)
        for (const pair of report.pairs) {
          expect(Math.abs(pair.stepLeft - pair.slotLeft), `step ${pair.index} left`).toBeLessThanOrEqual(2)
          expect(Math.abs(pair.stepRight - pair.slotRight), `step ${pair.index} right`).toBeLessThanOrEqual(2)
          if (pair.noteLeft != null) {
            expect(Math.abs(pair.noteLeft - pair.slotLeft), `note ${pair.index}`).toBeLessThanOrEqual(2)
          }
        }
        expect(report.pairs.filter((pair) => pair.noteLeft != null).length).toBeGreaterThan(0)
      }
    } finally {
      await browser.close()
    }
  })
})
