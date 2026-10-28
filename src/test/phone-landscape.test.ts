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

function fixture(land = true) {
  const tools = Array.from({ length: 10 }, (_, index) => `<button type="button">T${index}</button>`).join('')
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head>
<body>
<div class="shell phone ${land ? 'land' : ''} studio">
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
    <div class="lcd"><div class="bars">1.1.1</div><div class="tc">00:00:00:00 · counting-in</div></div>
    <div class="tempo-cluster">
      <input class="bpm-readout" value="299.9" aria-label="Tempo">
      <button type="button" class="tap-tempo">Tap</button>
    </div>
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
          const textBox = (selector: string) => {
            const node = document.querySelector(selector)
            if (!node) return null
            const box = node.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(node)
            const text = range.getBoundingClientRect()
            return {
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              textLeft: text.left,
              textRight: text.right,
              textTop: text.top,
              textBottom: text.bottom,
              scrollWidth: node.scrollWidth,
              clientWidth: node.clientWidth,
              scrollHeight: node.scrollHeight,
              clientHeight: node.clientHeight,
            }
          }
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
            tempo: textBox('.bpm-readout'),
            tap: textBox('.tap-tempo'),
            bars: textBox('.bars'),
            tc: textBox('.tc'),
          }
        })
        const fits = (item: { left: number; right: number; top: number; bottom: number; textLeft: number; textRight: number; textTop: number; textBottom: number; scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number } | null) => {
          expect(item).not.toBeNull()
          if (!item) return
          expect(item.textLeft).toBeGreaterThanOrEqual(item.left - 1)
          expect(item.textRight).toBeLessThanOrEqual(item.right + 1)
          expect(item.textTop).toBeGreaterThanOrEqual(item.top - 1)
          expect(item.textBottom).toBeLessThanOrEqual(item.bottom + 1)
          expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1)
          expect(item.scrollHeight).toBeLessThanOrEqual(item.clientHeight + 1)
          expect(item.left).toBeGreaterThanOrEqual(-1)
          expect(item.right).toBeLessThanOrEqual(viewport.width + 1)
        }
        fits(box.tap)
        fits(box.bars)
        fits(box.tc)
        expect(box.tempo).not.toBeNull()
        if (box.tempo) {
          expect(box.tempo.scrollWidth).toBeLessThanOrEqual(box.tempo.clientWidth + 1)
          expect(box.tempo.scrollHeight).toBeLessThanOrEqual(box.tempo.clientHeight + 1)
          expect(box.tempo.left).toBeGreaterThanOrEqual(-1)
          expect(box.tempo.right).toBeLessThanOrEqual(viewport.width + 1)
        }
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

  it('keeps the tempo, Tap label, and timecode inside a portrait phone', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const viewport of [
        { width: 320, height: 568 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport)
        await page.setContent(fixture(false), { waitUntil: 'load' })
        const box = await page.evaluate(() => {
          const read = (selector: string) => {
            const node = document.querySelector(selector)
            if (!node) return null
            const rect = node.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(node)
            const text = range.getBoundingClientRect()
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              textLeft: text.left,
              textRight: text.right,
              textTop: text.top,
              textBottom: text.bottom,
              scrollWidth: node.scrollWidth,
              clientWidth: node.clientWidth,
              scrollHeight: node.scrollHeight,
              clientHeight: node.clientHeight,
              height: rect.height,
            }
          }
          return {
            tempo: read('.bpm-readout'),
            tap: read('.tap-tempo'),
            bars: read('.bars'),
            tc: read('.tc'),
            width: window.innerWidth,
          }
        })
        for (const item of [box.tap, box.bars, box.tc]) {
          expect(item).not.toBeNull()
          if (!item) continue
          expect(item.textLeft).toBeGreaterThanOrEqual(item.left - 1)
          expect(item.textRight).toBeLessThanOrEqual(item.right + 1)
          expect(item.textTop).toBeGreaterThanOrEqual(item.top - 1)
          expect(item.textBottom).toBeLessThanOrEqual(item.bottom + 1)
          expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1)
          expect(item.scrollHeight).toBeLessThanOrEqual(item.clientHeight + 1)
          expect(item.left).toBeGreaterThanOrEqual(-1)
          expect(item.right).toBeLessThanOrEqual(box.width + 1)
        }
        expect(box.tempo).not.toBeNull()
        if (box.tempo) {
          expect(box.tempo.height).toBeGreaterThanOrEqual(44)
          expect(box.tempo.scrollWidth).toBeLessThanOrEqual(box.tempo.clientWidth + 1)
          expect(box.tempo.scrollHeight).toBeLessThanOrEqual(box.tempo.clientHeight + 1)
          expect(box.tempo.left).toBeGreaterThanOrEqual(-1)
          expect(box.tempo.right).toBeLessThanOrEqual(box.width + 1)
        }
        expect(box.tap?.height).toBeGreaterThanOrEqual(44)
      }
    } finally {
      await browser.close()
    }
  })
})
