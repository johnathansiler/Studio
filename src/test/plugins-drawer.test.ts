import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { formFactor } from '../ui/form'
import { ArrangeView } from '../ui/ArrangeView'
import { InsertList, addInsert, insertMenuChoices } from '../ui/PluginSheet'
import { PluginsDrawer, PluginsDrawerView, chainBands, groupInsertChoices, pluginNote } from '../ui/PluginsDrawer'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  levels: () => ({ master: 0, input: 0, talk: 0, tracks: {} }),
  stopPreview() {},
  previewPcm() {},
  unlock() {},
} as unknown as AudioEngine

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

function arrange(store: ProjectStore, width: number, height: number, pluginsDrawer?: boolean, pluginsMenu?: boolean) {
  return withWindow(width, height, () => renderToStaticMarkup(createElement(ArrangeView, {
    store,
    engine,
    session: { state: { participants: [], selfId: 'me' } },
    onSeek() {},
    onOpenPiano() {},
    onPerform() {},
    onQuickPunch() {},
    onAnalyze() {},
    pluginsDrawer,
    pluginsMenu,
  } as never)))
}

function propsOf(node: unknown, match: (props: Record<string, unknown>) => boolean): Record<string, unknown> {
  const found = walk(node, match)
  if (!found) throw new Error('missing control')
  return found
}

function walk(node: unknown, match: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = walk(child, match)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  const props = (node as { props?: Record<string, unknown> }).props
  if (!props) return null
  if (match(props)) return props
  const children = props.children as ReactNode
  const list = Array.isArray(children) ? children : children == null ? [] : [children]
  for (const child of list) {
    const found = walk(child, match)
    if (found) return found
  }
  return null
}

function click(props: Record<string, unknown>) {
  const onClick = props.onClick as (() => void) | undefined
  if (!onClick) throw new Error('missing click')
  onClick()
}

function drawer(store: ProjectStore, menu = false) {
  let open = menu
  const view = () => PluginsDrawerView({
    store,
    place: 'side',
    trackId: store.selectedTrackId,
    menuOpen: open,
    onMenu: (next) => { open = next },
  })
  return {
    view,
    openMenu() { open = true },
    click(pluginId: string, action: string) {
      click(propsOf(view(), (props) => props['data-for'] === pluginId && props['data-action'] === action))
    },
    choose(id: string) {
      click(propsOf(view(), (props) => props['data-plugin-choice'] === id))
    },
  }
}

describe('arrange plugins drawer', () => {
  it('adds, bypasses, reorders, and removes through the drawer, and Mix follows', () => {
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    store.selectTrack(vocal.id)
    const panel = drawer(store, true)
    panel.choose('eq')
    panel.openMenu()
    panel.choose('reverb')
    expect(store.track(vocal.id)!.plugins.map((plugin) => plugin.pluginId)).toEqual(['eq', 'reverb'])
    const eq = store.track(vocal.id)!.plugins[0]!
    const reverb = store.track(vocal.id)!.plugins[1]!

    const before = renderToStaticMarkup(createElement(InsertList, { store, trackId: vocal.id }))
    expect(before.indexOf('>EQ<')).toBeGreaterThan(-1)
    expect(before.indexOf('>EQ<')).toBeLessThan(before.indexOf('>Reverb<'))
    expect(propsOf(InsertList({ store, trackId: vocal.id }), (props) => props.children === 'EQ').className).toBe('on')

    panel.click(eq.id, 'bypass')
    expect(store.track(vocal.id)!.plugins.find((plugin) => plugin.id === eq.id)!.enabled).toBe(false)
    expect(propsOf(InsertList({ store, trackId: vocal.id }), (props) => props.children === 'EQ').className).toBe('')
    const bypassed = renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side' }))
    expect(bypassed).toContain('data-bypassed="on"')
    expect(bypassed).toContain('>Bypassed<')

    panel.click(eq.id, 'bypass')
    expect(eq.enabled).toBe(true)

    panel.click(eq.id, 'later')
    expect(store.track(vocal.id)!.plugins.map((plugin) => plugin.pluginId)).toEqual(['reverb', 'eq'])
    const moved = renderToStaticMarkup(createElement(InsertList, { store, trackId: vocal.id }))
    expect(moved.indexOf('>Reverb<')).toBeLessThan(moved.indexOf('>EQ<'))
    const chain = renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side' }))
    expect(chain.indexOf('data-chain-plugin="reverb"')).toBeLessThan(chain.indexOf('data-chain-plugin="eq"'))

    store.movePlugin(vocal.id, reverb.id, 1)
    expect(store.track(vocal.id)!.plugins.map((plugin) => plugin.pluginId)).toEqual(['eq', 'reverb'])
    const restored = renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side' }))
    expect(restored.indexOf('data-chain-plugin="eq"')).toBeLessThan(restored.indexOf('data-chain-plugin="reverb"'))

    panel.click(eq.id, 'earlier')
    expect(store.track(vocal.id)!.plugins.map((plugin) => plugin.pluginId)).toEqual(['eq', 'reverb'])

    panel.click(eq.id, 'open')
    expect(store.pluginFocus).toEqual({ trackId: vocal.id, pluginId: eq.id })
    store.focusPlugin(null)
    click(propsOf(InsertList({ store, trackId: vocal.id }), (props) => props.children === 'EQ'))
    expect(store.pluginFocus).toEqual({ trackId: vocal.id, pluginId: eq.id })

    panel.click(reverb.id, 'remove')
    expect(store.track(vocal.id)!.plugins.map((plugin) => plugin.pluginId)).toEqual(['eq'])
    const after = renderToStaticMarkup(createElement(InsertList, { store, trackId: vocal.id }))
    expect(after).not.toContain('>Reverb<')
    expect(renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side' }))).not.toContain('data-chain-plugin="reverb"')
  })

  it('keeps the selected track in sync when Mix adds a plugin', () => {
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    store.selectTrack(vocal.id)
    store.addPlugin(vocal.id, 'eq')
    const vocalHtml = renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side' }))
    expect(vocalHtml).toContain('>Vocal<')
    expect(vocalHtml).toContain('data-chain-plugin="eq"')
    expect(vocalHtml).toContain('>EQ<')

    store.selectTrack(keys.id)
    const keysHtml = renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side' }))
    expect(keysHtml).toContain('>Keys<')
    expect(keysHtml).not.toContain('data-chain-plugin="eq"')

    store.addPlugin(keys.id, 'delay')
    const delayed = renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side' }))
    expect(delayed).toContain('data-chain-plugin="delay"')
    expect(delayed).toContain('>Delay<')

    store.selectTrack(vocal.id)
    expect(renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side' }))).toContain('data-chain-plugin="eq"')
  })

  it('lists the chain as MIDI and instrument, then effects, and adds with the Mix path', () => {
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    store.selectTrack(keys.id)
    const panel = drawer(store, true)
    panel.choose('scaler')
    panel.openMenu()
    panel.choose('synth')
    panel.openMenu()
    panel.choose('tune')
    panel.openMenu()
    panel.choose('eq')
    panel.openMenu()
    panel.choose('reverb')
    const ids = store.track(keys.id)!.plugins.map((plugin) => plugin.pluginId)
    expect(ids.slice(0, 2)).toEqual(['scaler', 'synth'])
    expect(ids).toEqual(expect.arrayContaining(['tune', 'eq', 'reverb']))
    const html = renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side' }))
    const midi = html.indexOf('data-chain-band="midi"')
    const instrument = html.indexOf('data-chain-band="instrument"')
    const effects = html.indexOf('data-chain-band="effect"')
    expect(midi).toBeGreaterThan(-1)
    expect(midi).toBeLessThan(instrument)
    expect(instrument).toBeLessThan(effects)
    expect(html).toContain('>Scaler<')
    expect(html).toContain('>Synth<')
    expect(html).toContain('>Auto-Tune<')
    expect(html).toContain('>EQ<')
    expect(html).toContain('>Reverb<')
    expect(chainBands(store.track(keys.id)!.plugins).map((group) => group.band)).toEqual(['midi', 'instrument', 'effect'])

    store.selectTrack(vocal.id)
    const vocalPanel = drawer(store, true)
    vocalPanel.choose('vocal')
    expect(store.track(vocal.id)!.plugins.map((plugin) => plugin.pluginId)).toEqual(['vocal', 'eq', 'compressor', 'tune', 'saturator'])
    expect(addInsert).toBeTypeOf('function')
  })

  it('groups the add list with a one-line note and the same choices Mix uses', () => {
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    const midiChoices = insertMenuChoices(store, keys.id)
    const audioChoices = insertMenuChoices(store, vocal.id)
    const midiGroups = groupInsertChoices(midiChoices)
    const audioGroups = groupInsertChoices(audioChoices)
    const midiNames = midiGroups.flatMap((group) => group.items.map((item) => item.name))
    const audioNames = audioGroups.flatMap((group) => group.items.map((item) => item.name))
    expect(midiNames.slice(0, 2)).toEqual(['Step Sequencer', 'Beat Machine'])
    expect(audioNames).not.toContain('Beat Machine')
    expect(audioNames).not.toContain('Step Sequencer')
    expect(midiGroups.map((group) => group.title)).toEqual(['Instruments', 'Pitch', 'Tone', 'Dynamics', 'Space', 'Loudness'])
    for (const choice of [...midiChoices, ...audioChoices]) {
      const note = pluginNote(choice.id)
      expect(note.length).toBeGreaterThan(12)
      expect(note).not.toContain('\n')
    }
    store.selectTrack(keys.id)
    const html = renderToStaticMarkup(createElement(PluginsDrawer, { store, place: 'side', menuOpen: true }))
    expect(html.indexOf('>Instruments<')).toBeLessThan(html.indexOf('>Pitch<'))
    expect(html).toContain('Chords and scales in front of the sound.')
    expect(html).toContain('Pulls sung notes onto the song key.')
    expect(html).toContain('>Add Plugin<')
    expect(html).toContain('aria-expanded="true"')
    const sheet = readFileSync(new URL('../ui/PluginSheet.tsx', import.meta.url), 'utf8')
    const drawer = readFileSync(new URL('../ui/PluginsDrawer.tsx', import.meta.url), 'utf8')
    expect(sheet).toContain('addInsert(store, trackId, plugin.id)')
    expect(sheet).toContain('insertMenuChoices(store, trackId)')
    expect(drawer).toContain('addInsert(store, track.id, item.id)')
    expect(drawer).toContain('insertMenuChoices(store, track.id)')
    expect(drawer).not.toContain('store.addPlugin')
  })

  it('opens inline on a computer, stays closed on a phone and fold, and does not cover the tracks', () => {
    expect(formFactor(390, 844)).toBe('phone')
    expect(formFactor(476, 752)).toBe('phone')
    expect(formFactor(880, 1000)).toBe('fold')
    expect(formFactor(1440, 900)).toBe('desk')
    const store = new ProjectStore(createEmptyProject())

    const phone = arrange(store, 390, 844)
    expect(phone).toContain('data-arrange-plugins="toggle"')
    expect(phone).toContain('>Plugins<')
    expect(phone).toContain('data-plugins-drawer="closed"')
    expect(phone).not.toContain('id="arrange-plugins"')

    const cover = arrange(store, 476, 752)
    expect(cover).toContain('data-plugins-drawer="closed"')

    const fold = arrange(store, 880, 1000)
    expect(fold).toContain('data-plugins-drawer="closed"')

    const desk = arrange(store, 1440, 900)
    expect(desk).toContain('data-plugins-drawer="side"')
    expect(desk).toContain('plugins-side')
    expect(desk.indexOf('class="playlist-frame')).toBeLessThan(desk.indexOf('id="arrange-plugins"'))

    const phoneOpen = arrange(store, 390, 844, true)
    expect(phoneOpen).toContain('data-plugins-drawer="bottom"')
    expect(phoneOpen).toContain('data-place="bottom"')
    expect(phoneOpen).toContain('plugins-bottom')
    expect(phoneOpen.indexOf('class="playlist-frame')).toBeLessThan(phoneOpen.indexOf('id="arrange-plugins"'))

    const coverOpen = arrange(store, 476, 752, true)
    expect(coverOpen).toContain('data-place="bottom"')

    const foldOpen = arrange(store, 880, 1000, true)
    expect(foldOpen).toContain('data-place="side"')
    expect(foldOpen).toContain('plugins-side')

    const css = readFileSync(new URL('../ui/pluginsDrawer.css', import.meta.url), 'utf8')
    expect(css).toContain('min-height: 40px')
    expect(css).toContain('min-height: 44px')
    expect(css).not.toMatch(/position:\s*fixed/)
    expect(css).not.toMatch(/position:\s*absolute/)
    expect(css).toContain('flex-direction: row')
    expect(css).toContain('max-height: 46%')
    expect(css).toContain('var(--raised)')
  })
})

describe('plugins drawer screenshots', () => {
  it('captures the phone, unfolded, and computer layouts', async () => {
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    const css = [
      'src/styles.css',
      'src/ui/premium.css',
      'src/ui/guideSheet.css',
      'src/ui/arrangeSpace.css',
      'src/ui/pluginsDrawer.css',
      'src/ui/buttonTiers.css',
    ].map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    store.selectTrack(keys.id)
    store.addPlugin(keys.id, 'scaler')
    store.addPlugin(keys.id, 'synth')
    store.addPlugin(keys.id, 'tune')
    store.addPlugin(keys.id, 'eq')
    store.addPlugin(keys.id, 'reverb')
    const eq = store.track(keys.id)!.plugins.find((plugin) => plugin.pluginId === 'eq')!
    store.updatePlugin(keys.id, eq.id, { enabled: false })

    const pageHtml = (body: string, shell: string, width: number, height: number) => `<!doctype html><html><head><style>
      html, body { margin: 0; background: #101614; width: ${width}px; height: ${height}px; }
      ${css}
      .shell { width: ${width}px; height: ${height}px; display: flex; }
      .main-pane, .editor { height: 100%; min-height: 0; flex: 1; display: flex; }
    </style></head><body>
      <div class="${shell}"><div class="main-pane"><div class="editor">${body}</div></div></div>
    </body></html>`

    const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({
      headless: true,
      executablePath: '/usr/bin/google-chrome',
    }))
    try {
      const shot = async (name: string, width: number, height: number, shell: string, menu: boolean) => {
        const html = arrange(store, width, height, true, menu)
        const page = await browser.newPage({ viewport: { width, height } })
        await page.setContent(pageHtml(html, shell, width, height), { waitUntil: 'load' })
        await page.screenshot({ path: `/opt/cursor/artifacts/${name}.png` })
        await page.close()
      }
      await shot('plugins_phone_tiers', 390, 844, 'shell studio phone', false)
      await shot('plugins_fold_cover_tiers', 476, 752, 'shell studio phone', false)
      await shot('plugins_unfolded_tiers', 880, 1000, 'shell studio fold', false)
      await shot('plugins_computer_tiers', 1440, 900, 'shell studio', false)
      await shot('plugins_unfolded_menu_tiers', 880, 1000, 'shell studio fold', true)
    } finally {
      await browser.close()
    }
  })
})
