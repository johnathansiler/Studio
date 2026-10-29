import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = [
  'src/styles.css',
  'src/ui/arrangeSpace.css',
  'src/ui/premium.css',
  'src/ui/channel-rack.css',
  'src/ui/sessionLive.css',
].map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')

const FOLD_WIDTHS = [
  { width: 600, height: 800 },
  { width: 673, height: 841 },
  { width: 768, height: 900 },
  { width: 884, height: 1104 },
]

function fixture() {
  const tools = ['Select', 'Draw', 'Slice', 'Erase', 'Duplicate'].map((label) => (
    `<button type="button" class="tool"><svg width="18" height="18"></svg><span class="tool-label">${label}</span></button>`
  )).join('')
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head>
<body>
<div class="shell fold studio">
  <header class="topbar">
    <div class="brand"><div class="mark"></div><h1>CueHarbor</h1></div>
    <input class="project-name" value="Night Drive" aria-label="Project name">
    <div class="history-btns">
      <button type="button" class="text-btn history-btn" data-history="undo" title="Undo"><span class="history-icon">↶</span><span class="history-word">Undo</span></button>
      <button type="button" class="text-btn history-btn" data-history="redo" title="Redo"><span class="history-icon">↷</span><span class="history-word">Redo</span></button>
    </div>
    <button type="button" class="menu-btn"><svg width="16" height="16"></svg><span class="fold-word">Menu</span></button>
    <div class="views">
      <button type="button" class="active">Arrange</button>
      <button type="button">Mix</button>
      <button type="button">Beats</button>
      <button type="button">Session</button>
      <button type="button">Collab</button>
    </div>
  </header>
  <div class="transport">
    <div class="t-buttons">
      <button type="button" class="t-btn"><svg width="16" height="16"></svg><span class="t-word">Start</span></button>
      <button type="button" class="t-btn play"><svg width="16" height="16"></svg><span class="t-word">Play</span></button>
      <button type="button" class="t-btn stop"><svg width="16" height="16"></svg><span class="t-word">Stop</span></button>
      <button type="button" class="t-btn rec"><svg width="16" height="16"></svg><span class="t-word">Rec</span></button>
    </div>
  </div>
  <div class="tool-slot">
    <div class="timeline-tools">
      <div class="tool-strip">${tools}</div>
    </div>
  </div>
  <div class="workspace">
    <div class="main-pane">
      <div class="arrange">
        <div class="heads">
          <div class="head">
            <div class="pl-head">
              <input class="name" value="Vocal">
              <button type="button" class="mini"><span class="mini-mark">M</span><span class="mini-word">Mute</span></button>
              <button type="button" class="mini"><span class="mini-mark">S</span><span class="mini-word">Solo</span></button>
              <button type="button" class="mini"><span class="mini-mark">R</span><span class="mini-word">Arm</span></button>
            </div>
          </div>
        </div>
      </div>
      <div class="beats channel-rack">
        <button type="button" class="rack-mute live"><span class="fold-word">Mute</span></button>
      </div>
      <div class="call-controls">
        <button type="button" class="t-btn">Mic</button>
        <button type="button" class="t-btn">Cam</button>
        <button type="button" class="t-btn">Share</button>
      </div>
    </div>
  </div>
</div>
</body>
</html>`
}

describe('fold button labels', () => {
  it('shows short words on toolbar, transport, and track buttons without clipping', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      for (const viewport of FOLD_WIDTHS) {
        await page.setViewportSize(viewport)
        await page.setContent(fixture(), { waitUntil: 'load' })
        const report = await page.evaluate(() => {
          const words = [
            ...document.querySelectorAll<HTMLElement>('.t-word, .tool-label, .mini-word, .history-word, .fold-word'),
            ...document.querySelectorAll<HTMLElement>('.views button, .call-controls button'),
          ]
          return words.map((word) => {
            const button = word.closest('button')!
            const box = button.getBoundingClientRect()
            const text = word.getBoundingClientRect()
            const style = getComputedStyle(word)
            return {
              label: word.textContent,
              display: style.display,
              textWidth: text.width,
              left: text.left,
              right: text.right,
              boxLeft: box.left,
              boxRight: box.right,
              scrollWidth: button.scrollWidth,
              clientWidth: button.clientWidth,
              scrollHeight: button.scrollHeight,
              clientHeight: button.clientHeight,
            }
          })
        })
        expect(report.length).toBeGreaterThan(12)
        for (const item of report) {
          expect(item.display, item.label ?? '').not.toBe('none')
          expect(item.textWidth, item.label ?? '').toBeGreaterThan(2)
          expect(item.left, item.label ?? '').toBeGreaterThanOrEqual(item.boxLeft - 1)
          expect(item.right, item.label ?? '').toBeLessThanOrEqual(item.boxRight + 1)
          expect(item.scrollWidth, item.label ?? '').toBeLessThanOrEqual(item.clientWidth + 1)
          expect(item.scrollHeight, item.label ?? '').toBeLessThanOrEqual(item.clientHeight + 1)
        }
        const history = await page.evaluate(() => {
          return ['[data-history="undo"]', '[data-history="redo"]'].map((selector) => {
            const node = document.querySelector(selector)!
            const box = node.getBoundingClientRect()
            return { left: box.left, right: box.right, height: box.height, text: node.textContent }
          })
        })
        for (const button of history) {
          expect(button.text).toMatch(/Undo|Redo/)
          expect(button.height).toBeGreaterThanOrEqual(44)
          expect(button.left).toBeGreaterThanOrEqual(-1)
          expect(button.right).toBeLessThanOrEqual(viewport.width + 1)
        }
      }
    } finally {
      await browser.close()
    }
  })
})
