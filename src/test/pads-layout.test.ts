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
import { FACTORY_VINTAGE } from '../model/padChop'
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
        { name: 'folded', width: 673, height: 841 },
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
            screen: document.querySelector('.hw-screen')?.getBoundingClientRect().height ?? 0,
            padWidth: first ? Math.round(first.width) : 0,
            padHeight: first ? Math.round(first.height) : 0,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            scrollHeight: document.documentElement.scrollHeight,
            mpcRight: mpc ? Math.round(mpc.right) : 0,
            pastRight: boxes.filter((box) => box.right > (mpc?.right ?? 0) + 1).map((box) => `${box.name} right ${Math.round(box.right)} mpc ${Math.round(mpc?.right ?? 0)}`).slice(0, 8),
          }
        })
        const path = `/opt/cursor/artifacts/beat-${viewport.name}-${viewport.width}x${viewport.height}.png`
        await page.screenshot({ path, fullPage: true })
        expect(report.hits, `${viewport.name}\n${report.hits.join('\n')}`).toEqual([])
        expect(report.pads).toBe(8)
        expect(report.short).toBe(0)
        expect(report.screen).toBeGreaterThan(0)
        if (viewport.width < 800) expect(report.screen).toBeGreaterThanOrEqual(90)
        if (viewport.width < 800) expect(report.screen).toBeLessThanOrEqual(120)
        if (viewport.width >= 800) expect(report.screen).toBeGreaterThan(120)
        if (viewport.name === 'phone412') {
          expect(report.padWidth).toBeGreaterThanOrEqual(80)
          expect(report.padWidth).toBeLessThanOrEqual(100)
        }
        expect(report.scrollWidth).toBeLessThanOrEqual(viewport.width + 1)
        expect(report.pastRight, viewport.name).toEqual([])
        expect(report.scrollHeight).toBeLessThanOrEqual(viewport.height + 1)
        const minimum = viewport.width >= 800 ? 110 : viewport.width >= 390 ? 72 : 64
        expect(report.padWidth).toBeGreaterThanOrEqual(minimum)
        expect(report.padHeight).toBeGreaterThanOrEqual(minimum)
        expect(Math.abs(report.padWidth - report.padHeight)).toBeLessThanOrEqual(6)
        const face = await page.evaluate(() => {
          const overlaps = (pad: DOMRect, row?: DOMRect) => {
            if (!row || row.width < 1) return false
            const width = Math.min(pad.right, row.right) - Math.max(pad.left, row.left)
            const height = Math.min(pad.bottom, row.bottom) - Math.max(pad.top, row.top)
            return width > 1 && height > 1
          }
          document.querySelectorAll('.mpc-pad').forEach((node) => node.classList.add('lit'))
          const banks = document.querySelector('.mpc-banks')?.getBoundingClientRect()
          const repeat = document.querySelector('.note-repeat-row')?.getBoundingClientRect()
          const pads = [...document.querySelectorAll('.mpc-pad')].map((node) => node.getBoundingClientRect())
          const transport = document.querySelector('[data-beat-transport]') as HTMLElement | null
          const lip = document.querySelector('.hw-lip') as HTMLElement | null
          const wave = document.querySelector('.pad-screen-wave') as HTMLElement | null
          const transportBox = transport?.getBoundingClientRect()
          const lipBox = lip?.getBoundingClientRect()
          return {
            tabs: [...document.querySelectorAll('[data-plugin-tab]')].map((node) => node.textContent?.trim() || ''),
            readout: document.querySelector('.pad-screen-readout') != null,
            waveText: (wave?.innerText || '').replace(/\s+/g, ' ').trim(),
            transportHidden: transport?.closest('[hidden]') != null,
            transportText: transport?.innerText || '',
            lipHidden: lip?.closest('[hidden]') != null,
            lipText: lip?.innerText || '',
            padHits: pads.filter((pad) => overlaps(pad, banks) || overlaps(pad, repeat)).length,
            transportBottom: transportBox?.bottom ?? -1,
            lipBottom: lipBox?.bottom ?? -1,
            viewH: window.innerHeight,
          }
        })
        expect(face.tabs, viewport.name).toEqual(['Pads', 'Sound', 'Pattern'])
        expect(face.readout, viewport.name).toBe(false)
        expect(face.waveText, viewport.name).not.toMatch(/Vinyl|Swing|One shot|Vintage|Level/)
        expect(face.transportHidden, viewport.name).toBe(false)
        for (const word of ['Record', 'Overdub', 'Replace', 'Stop', 'Play', 'Erase', 'Arm', 'Count in', 'Metronome', 'Trim', 'Auto chop']) {
          expect(face.transportText, `${viewport.name} ${word}`).toContain(word)
        }
        expect(face.lipHidden, viewport.name).toBe(false)
        expect(face.lipText, viewport.name).toMatch(/sampler/i)
        expect(face.lipText, viewport.name).toContain('Presets')
        expect(face.padHits, viewport.name).toBe(0)
        expect(face.transportBottom, viewport.name).toBeGreaterThan(0)
        expect(face.transportBottom, viewport.name).toBeLessThanOrEqual(face.viewH + 1)
        expect(face.lipBottom, viewport.name).toBeLessThanOrEqual(face.viewH + 1)
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
  }, 20000)

  it('shows the chop editor and the vintage menu at phone, fold, and desktop', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const rate = 48000
    const beat = Math.round(rate * 60 / 120)
    const samples = new Float32Array(beat * 8)
    const hz = 261.625565
    for (let i = 0; i < samples.length; i++) {
      const env = (i % beat) < 3600 ? 1 : 0.12
      samples[i] = Math.sin((2 * Math.PI * hz * i) / rate) * env
    }
    store.setChopSample(id, samples, rate, 'Soul loop')
    store.patchChop(id, { sampleBpm: 120, tempoSource: 'sample', root: 0, modeName: 'minor' })
    store.patchTrackKit(id, { vintage: { macro: 0.65, table: FACTORY_VINTAGE[0].table, presetName: 'SP-1200' } })
    const open = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {}, chopStartsOpen: true }))
    const menu = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {}, chopStartsOpen: true, vintageStartsOpen: true }))
    const browser = await chromium.launch()
    try {
      const views = [
        { name: 'phone', width: 390, height: 844, html: open, vintage: false },
        { name: 'folded', width: 673, height: 841, html: open, vintage: false },
        { name: 'unfold', width: 880, height: 1000, html: open, vintage: false },
        { name: 'desktop', width: 1440, height: 900, html: open, vintage: false },
        { name: 'vintage-phone', width: 390, height: 844, html: menu, vintage: true },
        { name: 'vintage-desktop', width: 1440, height: 900, html: menu, vintage: true },
      ]
      for (const viewport of views) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
        await page.setContent(`<!doctype html><html><head><style>
          ${css}
          html, body { margin: 0; height: auto; overflow: visible; background: #1a1a1a; }
          .stage { width: ${viewport.width}px; min-height: ${viewport.height}px; height: auto; }
          .mpc, .hw-body { height: auto; overflow: visible; }
          ${viewport.vintage ? '.vintage-menu { position: relative; top: auto; bottom: auto; left: auto; max-height: none; width: min(360px, 100%); }' : ''}
        </style></head><body><div class="stage">${viewport.html}</div></body></html>`, { waitUntil: 'load' })
        await page.evaluate(() => {
          const canvas = document.querySelector('.chop-wave canvas') as HTMLCanvasElement | null
          if (!canvas) return
          const width = Math.max(280, Math.floor(canvas.clientWidth || 320))
          const height = 96
          canvas.width = width
          canvas.height = height
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.fillStyle = '#101010'
          ctx.fillRect(0, 0, width, height)
          ctx.strokeStyle = '#9ec8ff'
          ctx.beginPath()
          for (let x = 0; x < width; x++) {
            const peak = Math.abs(Math.sin(x / 7)) * (0.25 + 0.75 * ((Math.floor(x / 28) % 2)))
            ctx.moveTo(x, height / 2 - peak * height / 2)
            ctx.lineTo(x, height / 2 + peak * height / 2)
          }
          ctx.stroke()
        })
        const report = await page.evaluate(() => {
          const chop = document.querySelector('[data-chop="open"]') as HTMLElement | null
          const mpc = document.querySelector('.mpc') as HTMLElement | null
          const body = document.querySelector('.hw-body') as HTMLElement | null
          const stage = document.querySelector('.stage') as HTMLElement | null
          const bottom = chop ? Math.ceil(chop.getBoundingClientRect().bottom + 28) : 900
          for (const node of [document.documentElement, document.body, stage, mpc]) {
            if (!node) continue
            node.style.height = `${bottom}px`
            node.style.overflow = 'visible'
          }
          if (body) {
            body.style.height = 'auto'
            body.style.overflow = 'visible'
            body.style.flex = 'none'
          }
          return {
            chop: chop != null,
            vintage: document.querySelector('[aria-label="Vintage"]') != null,
            menu: document.querySelector('[aria-label="Vintage menu"]') != null,
            amounts: [...document.querySelectorAll('.vintage-menu label')].map((node) => node.textContent?.trim().slice(0, 48) || ''),
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            bottom,
          }
        })
        const path = `/opt/cursor/artifacts/beat-chop-${viewport.name}-${viewport.width}x${viewport.height}.png`
        await page.screenshot({ path, fullPage: true })
        expect(report.chop, viewport.name).toBe(true)
        expect(report.vintage, viewport.name).toBe(true)
        expect(report.scrollWidth, viewport.name).toBeLessThanOrEqual(viewport.width + 1)
        if (viewport.vintage) {
          expect(report.menu, viewport.name).toBe(true)
          expect(report.amounts.join(' ')).toContain('Tape wow and flutter')
          expect(report.amounts.join(' ')).toContain('Sample-rate reduction')
        }
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 20000)
})
