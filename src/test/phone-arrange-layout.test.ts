import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MainMenu } from '../ui/MainMenu'
import { PhoneDock } from '../ui/phoneDock'
import { TrackOptions } from '../ui/TrackOptions'
import { PHONE_TOOL_ROW } from '../state/tools'
import { visibleMenu } from '../ui/chrome'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

describe('phone arrange chrome', () => {
  it('halves the phone loop strip and keeps a 44px grip hit', () => {
    const css = readFileSync(new URL('../ui/arrangeSpace.css', import.meta.url), 'utf8')
    expect(css).toContain('.shell.phone .arrange { --map-h: 0px; --ruler-h: 22px; --playhead-strip: 28px; }')
    expect(css).toContain('height: calc(var(--ruler-h) - 2px)')
    expect(css).toContain('overflow: visible')
    expect(css).toContain('--playhead-strip: 28px')
    const grips = readFileSync(new URL('../ui/loopGrips.ts', import.meta.url), 'utf8')
    expect(grips).toContain('export const LOOP_GRIP_HIT = 44')
  })

  it('keeps the short Add Track bar and parks the bulb beside a header-width button', () => {
    const css = readFileSync(new URL('../ui/dockPush.css', import.meta.url), 'utf8')
    expect(css).toContain('height: 42px')
    expect(css).toContain('.ideas-bulb')
    expect(css).toContain('ideas-shine')
    expect(css).toContain('--track-head-w')
  })

  it('puts the session name in the menu when that home is used', () => {
    const items = visibleMenu({ phone: true, session: false, dockBottom: false, hardwareMidi: false })
    let name = 'Night Drive'
    const html = renderToStaticMarkup(createElement(MainMenu, {
      items,
      pressed: () => false,
      disabled: () => false,
      onAction: () => undefined,
      signature: '4/4',
      onSignature: () => undefined,
      projectName: name,
      onProjectName: (next) => { name = next },
    }))
    expect(html).toContain('aria-label="Project name"')
    expect(html).toContain('value="Night Drive"')
    expect(html).toContain('class="menu-session"')
  })

  it('adds a plugin from the track inserts', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    const html = renderToStaticMarkup(createElement(TrackOptions, {
      store,
      track,
      level: 0,
      automationOpen: false,
      participants: [],
      onClose: () => undefined,
      onPerform: () => undefined,
      onAnalyze: () => undefined,
    }))
    expect(html).toContain('class="inserts"')
    expect(html).toContain('Add plugin')
    expect(html).not.toContain('data-arrange-plugins="toggle"')
    expect(html).not.toContain('>Plugins<')
  })

  it('keeps Ideas on the bulb and parks Box and Erase on the tools row', () => {
    const store = new ProjectStore(createEmptyProject())
    const html = renderToStaticMarkup(createElement(PhoneDock, {
      store,
      place: 'arrange',
      menuOpen: false,
      browseOpen: false,
      menuRef: { current: null },
      onMenu: () => undefined,
      onBrowse: () => undefined,
      onMenuAction: () => undefined,
      onUndo: () => undefined,
      onRedo: () => undefined,
      canUndo: false,
      canRedo: false,
      playheadSample: () => 0,
    }))
    expect(html).toContain('data-phone-tab="menu"')
    expect(html).toContain('data-phone-tab="browse"')
    expect(html).toContain('data-phone-tab="tools"')
    expect(html).toContain('data-phone-action="setup"')
    expect(html).not.toContain('data-phone-action="unstuck"')
    expect(html).not.toContain('data-phone-action="plugins"')
    expect(PHONE_TOOL_ROW).toEqual(['select', 'pencil', 'split', 'trim', 'zoom', 'box', 'erase'])
    const menu = renderToStaticMarkup(createElement(PhoneDock, {
      store,
      place: 'arrange',
      menuOpen: true,
      browseOpen: false,
      menuRef: { current: null },
      onMenu: () => undefined,
      onBrowse: () => undefined,
      onMenuAction: () => undefined,
      onUndo: () => undefined,
      onRedo: () => undefined,
      canUndo: false,
      canRedo: false,
      playheadSample: () => 0,
    }))
    for (const action of ['new', 'open', 'save', 'export']) expect(menu).toContain(`data-phone-action="${action}"`)
    expect(menu).not.toContain('data-phone-action="unstuck"')
  })
})
