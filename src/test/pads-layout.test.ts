import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { PadsPanel } from '../ui/PadsPanel'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = ['src/styles.css', 'src/ui/premium.css', 'src/ui/pads.css']
  .map((file) => readFileSync(resolve(root, file), 'utf8'))
  .join('\n')

const engine = {
  unlock() {},
  resume: async () => {},
  status: 'stopped',
  positionSamples: 0,
  sampleRate: 48000,
  subscribe: () => () => {},
  setPadRoute() {},
  setBeatPump() {},
  setRepeatWatch() {},
} as unknown as AudioEngine

describe('beat machine layout', () => {
  it('does not overlap at phone, fold, and desktop widths', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const html = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {} }))
    const browser = await chromium.launch()
    const shots: { name: string; path: string; padWidth: number; padHeight: number }[] = []
    try {
      for (const viewport of [
        { name: 'phone360', width: 360, height: 844 },
        { name: 'phone', width: 390, height: 844 },
        { name: 'phone412', width: 412, height: 844 },
        { name: 'unfold', width: 880, height: 1000 },
        { name: 'desktop', width: 1440, height: 900 },
      ]) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
        await page.setContent(`<!doctype html><html><head><style>
          html, body { margin: 0; background: #1a1a1a; }
          ${css}
          .stage { width: ${viewport.width}px; height: ${viewport.height}px; }
        </style></head><body><div class="stage">${html}</div></body></html>`, { waitUntil: 'load' })
        const report = await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('.mpc-grid, .mpc-pad, .hw-key, .hw-wheel, .hw-knob, .mpc-brand, .hw-lip, .hw-transport, .mpc-keyboard, .mpc-close, .hw-slider input')]
          const boxes = nodes.map((node) => {
            const rect = node.getBoundingClientRect()
            return { name: node.className.toString().slice(0, 40), top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, node }
          }).filter((box) => box.width > 0 && box.height > 0)
          const hits: string[] = []
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i]
              const b = boxes[j]
              if (a.node.contains(b.node) || b.node.contains(a.node)) continue
              const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
              const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
              if (width > 4 && height > 4) hits.push(`${a.node.textContent?.trim().slice(0, 24)} @${Math.round(a.left)},${Math.round(a.top)} x ${b.node.textContent?.trim().slice(0, 24)} @${Math.round(b.left)},${Math.round(b.top)}`)
            }
          }
          const pads = [...document.querySelectorAll('.mpc-pad')].map((node) => node.getBoundingClientRect())
          const targets = [...document.querySelectorAll('.hw-key, .mpc-pad, .hw-knob, .hw-wheel, .mpc-keyboard, .mpc-close, .hw-slider input, .mpc select')]
            .map((node) => node.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0)
          const mpc = document.querySelector('.mpc')?.getBoundingClientRect()
          const first = pads[0]
          return {
            hits: hits.slice(0, 12),
            pads: pads.length,
            short: targets.filter((rect) => rect.width < 40 || rect.height < 40).length,
            screen: document.querySelector('.lcd, .hw-screen') != null,
            padWidth: first ? Math.round(first.width) : 0,
            padHeight: first ? Math.round(first.height) : 0,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            scrollHeight: document.documentElement.scrollHeight,
            mpcRight: mpc ? Math.round(mpc.right) : 0,
            pastRight: boxes.filter((box) => box.right > (mpc?.right ?? 0) + 1).length,
          }
        })
        const path = `/opt/cursor/artifacts/beat-${viewport.name}-${viewport.width}x${viewport.height}.png`
        await page.screenshot({ path, fullPage: true })
        expect(report.hits, `${viewport.name}\n${report.hits.join('\n')}`).toEqual([])
        expect(report.pads).toBe(8)
        expect(report.short).toBe(0)
        expect(report.screen).toBe(false)
        expect(report.scrollWidth).toBeLessThanOrEqual(viewport.width + 1)
        expect(report.pastRight).toBe(0)
        expect(report.scrollHeight).toBeLessThanOrEqual(viewport.height + 1)
        const minimum = viewport.width >= 800 ? 110 : viewport.width >= 390 ? 72 : 64
        expect(report.padWidth).toBeGreaterThanOrEqual(minimum)
        expect(report.padHeight).toBeGreaterThanOrEqual(minimum)
        expect(Math.abs(report.padWidth - report.padHeight)).toBeLessThanOrEqual(6)
        shots.push({ name: viewport.name, path, padWidth: report.padWidth, padHeight: report.padHeight })
        await page.close()
      }
      writeFileSync('/opt/cursor/artifacts/beat-pad-sizes.json', JSON.stringify(shots, null, 2))
      const desktop = readFileSync(shots.find((shot) => shot.name === 'desktop')!.path).toString('base64')
      const photoPath = '/home/ubuntu/.cursor/projects/agent-repos-Studio/assets/mpc2000xl.jpg'
      // Reference photo is not in the repo. Layout checks above still run; the side-by-side shot is skipped.
      if (!existsSync(photoPath)) return
      const photo = readFileSync(photoPath).toString('base64')
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#111;color:#fff;font-family:sans-serif">
        <div style="display:flex;gap:12px;align-items:flex-start;padding:12px">
          <figure style="margin:0;flex:1"><figcaption>MPC2000XL reference</figcaption><img alt="MPC2000XL" style="width:100%" src="data:image/jpeg;base64,${photo}" /></figure>
          <figure style="margin:0;flex:1"><figcaption>CueHarbor beat machine</figcaption><img alt="CueHarbor" style="width:100%" src="data:image/png;base64,${desktop}" /></figure>
        </div>
      </body></html>`, { waitUntil: 'load' })
      await page.screenshot({ path: '/opt/cursor/artifacts/beat-compare.png' })
      await page.close()
    } finally {
      await browser.close()
    }
  })
})
