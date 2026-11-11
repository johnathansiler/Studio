import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { PHONE_TOOL_ROW } from '../state/tools'
import { TRANSPORT_COPY, visibleMenu } from '../ui/chrome'
import { MainMenu } from '../ui/MainMenu'
import { PhoneDock } from '../ui/phoneDock'
import { InsertList } from '../ui/PluginSheet'
import { SongPanel } from '../ui/SongPanel'
import { ToolChoices } from '../ui/UtilitySheets'
import { TransportBar } from '../ui/TransportBar'

const engine = {
  positionSamples: 0,
  status: 'stopped' as const,
  subscribe: () => () => undefined,
  currentTimelineSample: () => 0,
  unlock() {},
}

function actions(html: string) {
  return [...html.matchAll(/data-phone-action="([^"]+)"/g)].map((match) => match[1])
}

function dock(store: ProjectStore, menuOpen = false) {
  return renderToStaticMarkup(createElement(PhoneDock, {
    store,
    place: 'arrange',
    menuOpen,
    browseOpen: false,
    menuRef: { current: null },
    onMenu() {},
    onBrowse() {},
    onMenuAction() {},
    onUndo() {},
    onRedo() {},
    canUndo: true,
    canRedo: false,
    playheadSample: () => 0,
  }))
}

describe('removed duplicate controls', () => {
  it('keeps the arrange row to Setup, Snap, metronome, Undo, and Redo', () => {
    const html = dock(new ProjectStore())
    expect(actions(html)).toEqual(['setup', 'snap', 'metronome', 'undo', 'redo'])
    expect(html).not.toContain('data-phone-action="unstuck"')
    expect(html).not.toContain('>Unstuck<')
    expect(html).not.toContain('data-phone-action="plugins"')
    expect(html).toContain('data-phone-tab="menu"')
    expect(html).toContain('>Browse<')
    expect(html).toContain('>Tools<')
  })

  it('keeps New, Open, Save, and Export in the phone row and out of the menu sheet', () => {
    const store = new ProjectStore()
    const row = dock(store, true)
    expect(actions(row)).toEqual(['new', 'open', 'save', 'export'])
    const phone = visibleMenu({ phone: true, session: false, dockBottom: false, hardwareMidi: true })
    const desk = visibleMenu({ phone: false, session: false, dockBottom: false, hardwareMidi: true })
    for (const action of ['new', 'open', 'save', 'export']) {
      expect(phone.map((item) => item.action)).not.toContain(action)
      expect(desk.map((item) => item.action)).toContain(action)
    }
    const sheet = renderToStaticMarkup(createElement(MainMenu, {
      items: phone,
      pressed: () => false,
      disabled: () => false,
      onAction: () => undefined,
      signature: '4/4',
      onSignature: () => undefined,
    }))
    for (const action of ['new', 'open', 'save', 'export', 'box', 'erase', 'pan', 'signature']) {
      expect(sheet).not.toContain(`data-menu-action="${action}"`)
    }
    expect(sheet).toContain('data-menu-action="shortcuts"')
  })

  it('moves Box and Erase into the tools row and leaves Scroll only in the sheet', () => {
    const store = new ProjectStore()
    const full = renderToStaticMarkup(createElement(ToolChoices, { store, onClose() {} }))
    for (const label of ['Select', 'Draw', 'Split', 'Trim', 'Zoom', 'Box', 'Erase', 'Scroll']) {
      expect(full).toContain(`>${label}<`)
    }
    expect(full).toContain('not the mixer pan')
    const phone = renderToStaticMarkup(createElement(ToolChoices, { store, onClose() {}, omit: PHONE_TOOL_ROW }))
    const faces = [...phone.matchAll(/choice-chip-face">([^<]+)</g)].map((match) => match[1])
    expect(faces).toEqual(['Scroll'])
    expect(phone).toContain('not the mixer pan')
    const menu = visibleMenu({ phone: false, session: false, dockBottom: false, hardwareMidi: false }).map((item) => item.action)
    for (const action of ['box', 'erase', 'pan']) expect(menu).not.toContain(action)
  })

  it('keeps time signature in Setup and off the menu', () => {
    const store = new ProjectStore()
    const html = renderToStaticMarkup(createElement(SongPanel, {
      store,
      engine: engine as never,
      session: { state: { participants: [], selfId: 'me' } } as never,
      position: 0,
      compact: true,
      triggerRef: { current: null },
      onClose() {},
      onQuickPunch() {},
    }))
    expect(html).toContain('role="tab"')
    expect(html).toContain('>Time<')
    expect(html).toContain('>Automation<')
    expect(html).toContain('>Markers<')
    store.setTimeSignature(3, 4)
    expect(store.project.timeSignature).toEqual({ numerator: 3, denominator: 4 })
    const menu = visibleMenu({ phone: true, session: false, dockBottom: false, hardwareMidi: true })
    expect(menu.map((item) => item.action)).not.toContain('signature')
    expect(menu.map((item) => item.label)).not.toContain('Time')
  })

  it('hides the phone transport count and lists Click and Count once', () => {
    const store = new ProjectStore()
    const phone = renderToStaticMarkup(createElement(TransportBar, {
      store,
      engine: engine as never,
      phone: true,
      onPlay() {},
      onStop() {},
      onRecord() {},
      onSeek() {},
    }))
    const desk = renderToStaticMarkup(createElement(TransportBar, {
      store,
      engine: engine as never,
      phone: false,
      onPlay() {},
      onStop() {},
      onRecord() {},
      onSeek() {},
    }))
    expect(phone).not.toContain('id="transport-count"')
    expect(desk).toContain('id="transport-count"')
    expect(TRANSPORT_COPY.filter((item) => item.id === 'click')).toHaveLength(1)
    expect(TRANSPORT_COPY.filter((item) => item.id === 'count-in')).toHaveLength(1)
    const before = store.project.countInBars
    store.cycleCountIn()
    expect(store.project.countInBars).not.toBe(before)
  })

  it('still adds and opens a plugin from the track inserts', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    store.addPlugin(track.id, 'eq')
    const html = renderToStaticMarkup(createElement(InsertList, { store, trackId: track.id }))
    expect(html).toContain('Open this insert')
    expect(html).toContain('>EQ<')
    expect(html).toContain('Add plugin')
    expect(html).toContain('class="inserts"')
  })
})
