import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import {
  PHONE_LAND_SHEET,
  PHONE_LAND_VIEWPORTS,
  landscapeWorkShare,
  phoneLandscape,
} from '../ui/phoneLand'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = `${readFileSync(resolve(root, 'src/styles.css'), 'utf8')}\n${readFileSync(resolve(root, 'src/ui/remoteFixes.css'), 'utf8')}\n${readFileSync(resolve(root, 'src/ui/autoTune.css'), 'utf8')}`

function fixture() {
  const tools = Array.from({ length: 10 }, (_, index) => `<button type="button">T${index}</button>`).join('')
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head>
<body>
<div class="shell phone land studio">
  <header class="topbar">
    <div class="brand"><div class="mark"></div><h1>CueHarbor</h1></div>
    <input class="project-name" value="Night Drive" aria-label="Project name">
    <div class="views">
      <button type="button" class="active">Arrange</button>
      <button type="button">Mix</button>
      <button type="button">Beats</button>
      <button type="button">Session</button>
    </div>
    <button type="button" class="menu-btn" aria-label="Menu">Menu</button>
  </header>
  <div class="transport">
    <div class="t-buttons">
      <button type="button" class="t-btn" aria-label="Play">Play</button>
      <button type="button" class="t-btn" aria-label="Stop">Stop</button>
      <button type="button" class="t-btn rec" aria-label="Record">Rec</button>
    </div>
    <div class="lcd"><div class="bars">1.1.1</div><div class="tc">0:00 · stopped</div></div>
    <button type="button" class="bpm-readout">120</button>
  </div>
  <div class="tool-slot" id="tool-slot">
    <div class="timeline-tools">
      <span class="tool-chip">Select. Click notes and clips.</span>
      <div class="tool-strip">${tools}</div>
    </div>
  </div>
  <div class="workspace">
    <div class="main-pane" id="timeline"><div class="editor"><div class="arrange"></div></div></div>
  </div>
  <div class="plugin-sheet" id="sheet">
    <div class="faceplate" style="height:900px">Master and plugin controls</div>
  </div>
</div>
</body>
</html>`
}

describe('phone landscape compaction', () => {
  it('leaves most of 844x390 and 915x412 for the timeline', () => {
    for (const viewport of PHONE_LAND_VIEWPORTS) {
      expect(phoneLandscape(viewport.width, viewport.height)).toBe(true)
      expect(landscapeWorkShare(viewport.height)).toBeGreaterThan(0.7)
    }
    expect(PHONE_LAND_SHEET).toBeLessThanOrEqual(0.3)
  })

  it('measures the shell at 844x390 and 915x412', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const viewport of PHONE_LAND_VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.setContent(fixture(), { waitUntil: 'load' })
        const box = await page.evaluate(() => {
          const heightOf = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height
          const viewportHeight = window.innerHeight
          return {
            viewportHeight,
            top: heightOf('.topbar'),
            transport: heightOf('.transport'),
            tools: heightOf('.tool-slot'),
            work: heightOf('.workspace'),
            timeline: heightOf('#timeline'),
            sheet: heightOf('#sheet'),
            play: heightOf('.t-btn'),
          }
        })
        expect(box.viewportHeight).toBe(viewport.height)
        expect(box.top).toBeLessThanOrEqual(34)
        expect(box.transport).toBeLessThanOrEqual(34)
        expect(box.tools).toBeLessThanOrEqual(30)
        expect(box.play).toBeLessThanOrEqual(32)
        expect(box.work / box.viewportHeight).toBeGreaterThan(0.7)
        expect(box.timeline / box.viewportHeight).toBeGreaterThan(0.7)
        expect(box.sheet / box.viewportHeight).toBeLessThanOrEqual(PHONE_LAND_SHEET + 0.02)
        await page.evaluate(() => document.getElementById('tool-slot')?.remove())
        const mixer = await page.evaluate(() => ({
          work: document.querySelector('.workspace')!.getBoundingClientRect().height,
          viewportHeight: window.innerHeight,
        }))
        expect(mixer.work / mixer.viewportHeight).toBeGreaterThan(0.75)
        await page.setContent(fixture().replace('class="plugin-sheet"', 'class="plugin-sheet tune-open"'), { waitUntil: 'load' })
        const tune = await page.evaluate(() => ({
          sheet: document.querySelector('.plugin-sheet')!.getBoundingClientRect().height,
          viewportHeight: window.innerHeight,
        }))
        expect(tune.sheet / tune.viewportHeight).toBeLessThanOrEqual(PHONE_LAND_SHEET + 0.02)
      }
    } finally {
      await browser.close()
    }
  })
})
