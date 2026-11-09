import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { processChain, type ChainSlot } from '../audio/plugins/chain'
import { renderGraph } from '../audio/renderGraph'
import type { Processor } from '../audio/plugins/types'
import { writeLayout } from '../model/layoutWidth'
import { createEmptyProject, type PluginInstance } from '../model/types'
import { ProjectStore } from '../state/store'
import { MixerView } from '../ui/MixerView'
import { addStripInsert, isInstrumentSource, stripSlotChoices } from '../ui/PluginSheet'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const css = [
  'src/ui/kit/kit.css',
  'src/ui/automation.css',
  'src/ui/mixer.css',
  'src/ui/remoteFixes.css',
  'src/styles.css',
  'src/ui/premium.css',
].map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  levels: () => ({ master: 0.2, input: 0, talk: 0, tracks: { vocal: 0.2 } }),
  masterReading: () => null,
  mixMeters: () => ({ cpu: 0.05, lufs: -18, truePeak: -3 }),
} as unknown as AudioEngine

const rate = 48000

function plugin(id: string, pluginId: string): PluginInstance {
  return { id, pluginId, version: '1', enabled: true, wet: 1, params: {}, sidechain: '' }
}

function scale(factor: number): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      for (let c = 0; c < output.length; c++) {
        const src = input[c] ?? input[0]
        const dst = output[c]
        for (let i = 0; i < dst.length; i++) dst[i] = (src?.[i] || 0) * factor
      }
    },
  }
}

function bias(add: number): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      for (let c = 0; c < output.length; c++) {
        const src = input[c] ?? input[0]
        const dst = output[c]
        for (let i = 0; i < dst.length; i++) dst[i] = (src?.[i] || 0) + add
      }
    },
  }
}

function processors(map: Record<string, Processor>) {
  return (pluginId: string) => {
    const proc = map[pluginId]
    if (!proc) throw new Error(`missing ${pluginId}`)
    return proc
  }
}

function dc(length: number, value: number) {
  return new Float32Array(length).fill(value)
}

function graph(tracks: Parameters<typeof renderGraph>[0]['tracks'], masterVolume = 1, masterPlugins: PluginInstance[] = []) {
  const length = tracks[0]?.buffer[0]?.length ?? 64
  return renderGraph({
    tracks,
    masterPlugins,
    masterVolume,
    sampleRate: rate,
    tempo: 120,
    length,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    automation: [],
    offline: true,
    create: processors({ scale: scale(2), bias: bias(0.1), half: scale(0.5), gain: scale(1) }),
  })
}

function track(id: string, buffer: Float32Array, extra: Partial<Parameters<typeof renderGraph>[0]['tracks'][number]> = {}) {
  return {
    id,
    type: 'audio',
    input: 'none',
    buffer: [buffer, buffer.slice()],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    plugins: [] as PluginInstance[],
    sends: [],
    output: null,
    groupId: null,
    ...extra,
  }
}

describe('mixer insert order and pan', () => {
  it('runs the top insert first, the bottom insert last, then the fader and master', () => {
    const input = dc(64, 0.2)
    const forward = [plugin('a', 'scale'), plugin('b', 'bias')]
    const reversed = [plugin('b', 'bias'), plugin('a', 'scale')]
    const serial = graph([track('vocal', input, { plugins: forward, volume: 1, pan: 0 })])
    const flipped = graph([track('vocal', input, { plugins: reversed, volume: 1, pan: 0 })])
    const quiet = graph([track('vocal', input, { plugins: forward, volume: 0.5, pan: 0 })], 1)
    const mastered = graph([track('vocal', input, { plugins: forward, volume: 1, pan: 0 })], 0.5)
    const panLaw = Math.SQRT1_2
    const afterChain = (0.2 * 2 + 0.1) * panLaw
    expect(serial.master[0][20]).toBeCloseTo(afterChain, 5)
    expect(serial.master[1][20]).toBeCloseTo(afterChain, 5)
    expect(flipped.master[0][20]).toBeCloseTo((0.2 + 0.1) * 2 * panLaw, 5)
    expect(Math.abs(serial.master[0][20] - flipped.master[0][20])).toBeGreaterThan(0.05)
    const parallel = (0.2 * 2 + (0.2 + 0.1)) * panLaw
    expect(Math.abs(serial.master[0][20] - parallel)).toBeGreaterThan(0.05)
    expect(quiet.master[0][20]).toBeCloseTo(afterChain * 0.5, 5)
    expect(mastered.master[0][20]).toBeCloseTo(afterChain * 0.5, 5)
    const faderFirst = ((0.2 * panLaw * 0.5) * 2) + 0.1
    expect(Math.abs(quiet.master[0][20] - faderFirst)).toBeGreaterThan(0.05)
  })

  it('pans the signal after the insert chain and keeps a bus in series', () => {
    const input = dc(64, 0.4)
    const chain = [plugin('a', 'bias')]
    const left = graph([track('vocal', input, { plugins: chain, pan: -1 })])
    const right = graph([track('vocal', input, { plugins: chain, pan: 1 })])
    const center = graph([track('vocal', input, { plugins: chain, pan: 0 })])
    expect(left.master[0][12]).toBeCloseTo(0.5, 5)
    expect(left.master[1][12]).toBeCloseTo(0, 5)
    expect(right.master[0][12]).toBeCloseTo(0, 5)
    expect(right.master[1][12]).toBeCloseTo(0.5, 5)
    expect(center.master[0][12]).toBeCloseTo(0.5 * Math.SQRT1_2, 5)
    expect(Math.abs(center.master[0][12] - center.master[1][12])).toBeLessThan(1e-6)
    const bus = graph([
      track('vocal', input, { plugins: chain, output: 'bus', pan: 0, volume: 1 }),
      track('bus', dc(64, 0), { type: 'bus', plugins: [plugin('h', 'half')], volume: 1, pan: 0 }),
    ])
    const throughBus = 0.5 * Math.SQRT1_2 * 0.5 * Math.SQRT1_2
    expect(bus.master[0][12]).toBeCloseTo(throughBus, 5)
    const skipped = 0.5 * Math.SQRT1_2
    expect(Math.abs(bus.master[0][12] - skipped)).toBeGreaterThan(0.05)
    const group = graph([
      track('vocal', input, { plugins: chain, output: 'other', groupId: 'grp', pan: 0 }),
      track('grp', dc(64, 0), { type: 'group', plugins: [plugin('h', 'half')], volume: 1, pan: 0 }),
      track('other', dc(64, 0), { type: 'bus', plugins: [plugin('s', 'scale')], volume: 1, pan: 0 }),
    ])
    expect(group.master[0][12]).toBeCloseTo(throughBus, 5)
  })

  it('keeps insert order and pan through the live chain primitive, save, and undo', () => {
    const block = dc(32, 0.2)
    const slots: ChainSlot[] = [
      { id: 'a', pluginId: 'scale', enabled: true, wet: 1, params: {}, failed: false, sidechain: '', processor: scale(2) },
      { id: 'b', pluginId: 'bias', enabled: true, wet: 1, params: {}, failed: false, sidechain: '', processor: bias(0.1) },
    ]
    const out = [dc(32, 0), dc(32, 0)]
    processChain(slots, [block, block.slice()], out, {
      sampleRate: rate, tempo: 120, sampleTime: 0, sidechain: null, scaleRoot: 0, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], quality: 'full',
    })
    expect(out[0][8]).toBeCloseTo(0.5, 5)
    const backward = [...slots].reverse()
    const backOut = [dc(32, 0), dc(32, 0)]
    processChain(backward, [block, block.slice()], backOut, {
      sampleRate: rate, tempo: 120, sampleTime: 0, sidechain: null, scaleRoot: 0, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], quality: 'full',
    })
    expect(backOut[0][8]).toBeCloseTo(0.6, 5)

    const store = new ProjectStore()
    const vocal = store.project.tracks[0]
    const music = store.project.tracks[1]
    store.addPlugin(vocal.id, 'eq')
    store.addPlugin(vocal.id, 'compressor')
    store.addPlugin(music.id, 'delay')
    expect(store.track(vocal.id)!.plugins.map((item) => item.pluginId)).toEqual(['eq', 'compressor'])
    expect(store.track(music.id)!.plugins.map((item) => item.pluginId)).toEqual(['delay'])
    store.beginAutomationTouch()
    store.setAutomated({ trackId: vocal.id, target: 'pan', param: 'pan', min: -1, max: 1 }, -0.4, false, 0)
    store.endAutomationTouch()
    expect(store.track(vocal.id)!.pan).toBeCloseTo(-0.4, 5)
    expect(store.track(music.id)!.pan).toBe(0)
    const saved = new ProjectStore(JSON.parse(JSON.stringify(store.project)))
    expect(saved.track(vocal.id)!.plugins.map((item) => item.pluginId)).toEqual(['eq', 'compressor'])
    expect(saved.track(vocal.id)!.pan).toBeCloseTo(-0.4, 5)
    expect(saved.track(music.id)!.plugins.map((item) => item.pluginId)).toEqual(['delay'])
    store.undo()
    expect(store.track(vocal.id)!.pan).toBe(0)
    expect(store.track(vocal.id)!.plugins.map((item) => item.pluginId)).toEqual(['eq', 'compressor'])
    store.undo()
    expect(store.track(music.id)!.plugins).toHaveLength(0)
    store.undo()
    expect(store.track(vocal.id)!.plugins.map((item) => item.pluginId)).toEqual(['eq'])
    const empty = createEmptyProject()
    expect(empty.tracks[0].pan).toBe(0)
  })

  it('does not retarget an instrument add from an audio strip', () => {
    const store = new ProjectStore()
    const vocal = store.project.tracks.find((track) => track.type === 'audio')!
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    const keysBefore = keys.plugins.map((plugin) => plugin.pluginId)
    const midiCount = store.project.tracks.filter((track) => track.type === 'midi').length
    const choices = stripSlotChoices(store, vocal.id).map((plugin) => plugin.id)
    for (const id of ['synth', 'steps', 'scaler', 'pads', 'drums']) {
      expect(choices, id).not.toContain(id)
      addStripInsert(store, vocal.id, id)
    }
    expect(store.track(vocal.id)!.plugins.map((plugin) => plugin.pluginId)).toEqual([])
    expect(store.track(keys.id)!.plugins.map((plugin) => plugin.pluginId)).toEqual(keysBefore)
    expect(store.project.tracks.filter((track) => track.type === 'midi')).toHaveLength(midiCount)
    expect(stripSlotChoices(store, keys.id).map((plugin) => plugin.id)).toEqual(expect.arrayContaining(['synth', 'steps']))
    addStripInsert(store, keys.id, 'synth')
    expect(store.track(keys.id)!.plugins.some((plugin) => plugin.pluginId === 'synth')).toBe(true)
    expect(store.track(vocal.id)!.plugins.some((plugin) => plugin.pluginId === 'synth')).toBe(false)
    expect(isInstrumentSource({ pluginId: 'steps' })).toBe(true)
    for (const id of ['synth', 'sampler', 'scaler', 'pads', 'looper', 'eq', 'compressor']) {
      expect(isInstrumentSource({ pluginId: id }), id).toBe(false)
    }
    addStripInsert(store, vocal.id, 'eq')
    expect(store.track(vocal.id)!.plugins.map((plugin) => plugin.pluginId)).toEqual(['eq'])
  })
})

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '476x752', width: 476, height: 752 },
  { name: '880x1000', width: 880, height: 1000 },
  { name: '844x390', width: 844, height: 390 },
  { name: '1440x900', width: 1440, height: 900 },
] as const

function shellClass(width: number, height: number) {
  const land = width > height
  const form = land && height <= 520 ? 'phone' : width <= 520 ? 'phone' : width <= 1100 ? 'fold' : 'desk'
  return `shell studio${form === 'phone' ? ' phone' : ''}${form === 'fold' ? ' fold' : ''}${land ? ' land' : ''}`
}

function withWindow<T>(width: number, height: number, draw: () => T): T {
  const previous = globalThis.window
  globalThis.window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window & typeof globalThis
  try {
    return draw()
  } finally {
    if (previous) globalThis.window = previous
    else delete (globalThis as { window?: Window }).window
  }
}

function loadedStore() {
  const store = new ProjectStore()
  writeLayout(store.project.id, { strip: 84, column: 70, mixer: 'columns' })
  const [vocal, music, keys] = store.project.tracks
  store.addPlugin(vocal.id, 'eq')
  store.addPlugin(vocal.id, 'compressor')
  store.addPlugin(vocal.id, 'reverb')
  store.addPlugin(music.id, 'delay')
  store.addPlugin(keys.id, 'eq')
  store.addPlugin(keys.id, 'steps')
  store.addPlugin(keys.id, 'compressor')
  store.updateTrack(vocal.id, { pan: -0.35 })
  for (let i = store.project.tracks.length; i < 8; i += 1) store.addTrack('audio')
  return store
}

function markup(store: ProjectStore, width: number, height: number) {
  const html = withWindow(width, height, () => renderToStaticMarkup(createElement(MixerView, { store, engine })))
  return `<!doctype html><html><head><style>
    html, body { margin: 0; height: 100%; background: #101614; }
    ${css}
  </style></head><body>
    <div class="${shellClass(width, height)}" style="width:${width}px;height:${height}px">
      <header class="topbar"><button type="button" class="menu-btn">Menu</button><div class="views"><button type="button">Arrange</button><button type="button" class="active">Mix</button></div></header>
      <div class="transport"><div class="t-buttons"><button type="button" class="t-btn rec">Record</button><button type="button" class="t-btn play">Play</button><button type="button" class="t-btn stop">Stop</button></div></div>
      <div class="workspace session-closed"><div class="main-pane"><div class="editor">${html}</div></div></div>
    </div>
  </body></html>`
}

async function readStrip(page: Page) {
  return page.evaluate(() => {
    const seen = (node: HTMLElement) => {
      const style = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 1 && box.height > 1
    }
    const boxOf = (node: Element) => {
      const box = node.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }
    }
    const strips = [...document.querySelectorAll<HTMLElement>('.mixer > .strip, .strip.master')].map((strip) => {
      const fader = strip.querySelector('.volume-row .touch-slider') as HTMLElement
      const slots = [...strip.querySelectorAll<HTMLElement>('.strip-insert')].filter(seen).map((slot) => ({
        name: (slot.innerText || '').replace(/\s+/g, ' ').trim(),
        label: slot.getAttribute('aria-label') || '',
        index: slot.getAttribute('data-chain-index'),
        plugin: slot.getAttribute('data-plugin-id') || '',
        role: slot.getAttribute('data-role') || '',
        audioIndex: slot.getAttribute('data-audio-index'),
        add: slot.classList.contains('strip-insert-add'),
        box: boxOf(slot),
        scrollWidth: slot.scrollWidth,
        clientWidth: slot.clientWidth,
      }))
      const pan = strip.querySelector('.strip-pan') as HTMLElement | null
      const knob = strip.querySelector('.pan-knob') as HTMLElement | null
      return {
        name: (strip.querySelector('h3')?.textContent || '').trim(),
        master: strip.classList.contains('master'),
        order: (strip.closest('.mixer-view') as HTMLElement).dataset.insertOrder || '',
        layout: (strip.closest('.mixer-view') as HTMLElement).dataset.layout || '',
        box: boxOf(strip),
        fader: boxOf(fader),
        meter: boxOf(strip.querySelector('.volume-row .meter') as HTMLElement),
        db: (strip.querySelector('.fader-db')?.textContent || '').trim(),
        pan: pan ? { text: pan.dataset.panText || '', side: pan.dataset.pan || '', box: boxOf(knob || pan) } : null,
        slots,
        sheetPan: !!document.querySelector('.mix-panel .pan-knob'),
      }
    })
    const transport = document.querySelector('.transport') as HTMLElement
    const record = transport.querySelector('.rec') as HTMLElement
    return {
      strips,
      transport: boxOf(transport),
      record: (record.textContent || '').trim(),
      scrollWidth: (document.querySelector('.mixer') as HTMLElement).scrollWidth,
      clientWidth: (document.querySelector('.mixer') as HTMLElement).clientWidth,
    }
  })
}

describe('mixer insert slots and pan knob', () => {
  it('shows named slots and a real pan readout at every target size', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const browser = await chromium.launch({ headless: true })
    try {
      for (const viewport of viewports) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
        await page.setContent(markup(loadedStore(), viewport.width, viewport.height), { waitUntil: 'load' })
        const report = await readStrip(page)
        const where = viewport.name
        expect(report.record, where).toBe('Record')
        expect(report.transport.height, where).toBeGreaterThanOrEqual(36)
        expect(report.strips.length, where).toBeGreaterThan(2)
        const vocal = report.strips.find((strip) => strip.name === 'Vocal')!
        const music = report.strips.find((strip) => strip.name === 'Music')!
        const master = report.strips.find((strip) => strip.master)!
        expect(vocal.order, where).toBe('top-first')
        expect(vocal.layout, where).toBe('columns')
        expect(vocal.slots.map((slot) => slot.plugin), where).toEqual(['eq', 'compressor', 'reverb', ''])
        expect(vocal.slots.map((slot) => slot.index), where).toEqual(['0', '1', '2', '3'])
        expect(vocal.slots[0].label, where).toMatch(/First audio effect/)
        expect(vocal.slots[0].role, where).toBe('audio')
        expect(vocal.slots[1].label, where).toMatch(/previous audio effect/)
        expect(vocal.slots[2].label, where).toMatch(/Last audio effect/)
        expect(vocal.slots[3].add, where).toBe(true)
        expect(vocal.slots[3].label, where).toMatch(/Vocal/)
        expect(music.slots.map((slot) => slot.plugin), where).toEqual(['delay', ''])
        expect(music.slots.at(-1)?.label, where).toMatch(/Music/)
        expect(master.slots.map((slot) => slot.plugin), where).toEqual(['limiter', ''])
        expect(master.pan, where).toBeNull()
        for (let i = 1; i < vocal.slots.length; i += 1) {
          expect(vocal.slots[i].box.top, `${where} slot ${i} is below the slot above`).toBeGreaterThanOrEqual(vocal.slots[i - 1].box.bottom - 1)
        }
        const keysStrip = report.strips.find((strip) => strip.name === 'Keys')!
        const keyed = keysStrip.slots.filter((slot) => !slot.add)
        expect(keyed.map((slot) => slot.plugin), where).toEqual(['eq', 'steps', 'compressor'])
        expect(keyed.map((slot) => slot.role), where).toEqual(['audio', 'source', 'audio'])
        expect(keyed[1].label, where).toMatch(/Instrument source/)
        expect(keyed[1].label, where).toMatch(/does not process in series/)
        expect(keyed[1].label, where).not.toMatch(/audio effect/)
        expect(keyed[0].audioIndex, where).toBe('0')
        expect(keyed[2].audioIndex, where).toBe('1')
        expect(keyed[2].label, where).toMatch(/previous audio effect/)
        for (let i = 1; i < keysStrip.slots.length; i += 1) {
          expect(keysStrip.slots[i].box.top, `${where} keys ${i}`).toBeGreaterThanOrEqual(keysStrip.slots[i - 1].box.bottom - 1)
        }
        const flow = await page.locator('.mixer > .strip .strip-inserts').first().evaluate((node) => {
          const style = getComputedStyle(node)
          return { dir: style.flexDirection, overflowY: style.overflowY }
        })
        expect(flow.dir, where).toBe('column')
        expect(['auto', 'scroll'], where).toContain(flow.overflowY)
        if (viewport.height < 500 && viewport.width > viewport.height) {
          const cue = await page.locator('.strip', { has: page.locator('h3', { hasText: 'Vocal' }) }).locator('.strip-rack').evaluate((node) => getComputedStyle(node, '::before').content)
          expect(cue, where).not.toBe('none')
          const single = await page.locator('.strip', { has: page.locator('h3', { hasText: 'Audio 1' }) }).locator('.strip-rack').evaluate((node) => getComputedStyle(node, '::before').content)
          expect(single, where).toBe('none')
        }
        const rackBottom = vocal.slots[0].box.top + 40
        expect(rackBottom, where).toBeLessThanOrEqual(vocal.fader.top + 1)
        expect(vocal.pan, where).toBeTruthy()
        expect(vocal.pan!.side, where).toBe('left')
        expect(vocal.pan!.text, where).toMatch(/^Left /)
        expect(vocal.pan!.box.height, where).toBeGreaterThanOrEqual(40)
        expect(vocal.pan!.box.width, where).toBeGreaterThanOrEqual(40)
        const panOverlapsFader = vocal.pan!.box.top < vocal.fader.bottom - 1 && vocal.pan!.box.bottom > vocal.fader.top + 1
        expect(panOverlapsFader, where).toBe(false)
        expect(vocal.pan!.box.left, where).toBeGreaterThanOrEqual(vocal.box.left - 1)
        expect(vocal.pan!.box.right, where).toBeLessThanOrEqual(vocal.box.right + 1)
        expect(music.pan!.side, where).toBe('center')
        expect(music.pan!.text, where).toBe('Center')
        expect(vocal.fader.height / vocal.box.height, where).toBeGreaterThan(0.5)
        expect(vocal.fader.height, where).toBeGreaterThanOrEqual(viewport.height < 500 ? 160 : 120)
        if (viewport.height < 500 && viewport.width > viewport.height) {
          expect(vocal.meter.height, where).toBeGreaterThanOrEqual(vocal.fader.height - 2)
        } else {
          expect(vocal.meter.height, where).toBeGreaterThan(40)
        }
        expect(vocal.db, where).toMatch(/dB|inf/)
        expect(vocal.sheetPan, where).toBe(false)
        for (const slot of vocal.slots) {
          expect(slot.box.height, `${where} ${slot.name}`).toBeGreaterThanOrEqual(40)
          expect(slot.box.width, `${where} ${slot.name}`).toBeGreaterThanOrEqual(40)
          expect(slot.scrollWidth, `${where} ${slot.name}`).toBeLessThanOrEqual(slot.clientWidth + 1)
        }
        if (viewport.width > viewport.height && viewport.height < 500) {
          expect(report.scrollWidth, where).toBeGreaterThan(report.clientWidth + 8)
        }
        await page.screenshot({ path: `/opt/cursor/artifacts/mixer-inserts-${viewport.name}.png` })
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})
