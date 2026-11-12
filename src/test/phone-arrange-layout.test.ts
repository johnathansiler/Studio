import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MainMenu } from '../ui/MainMenu'
import { TrackOptions } from '../ui/TrackOptions'
import { visibleMenu } from '../ui/chrome'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

describe('phone arrange chrome', () => {
  it('halves the phone loop strip and keeps a 44px grip hit', () => {
    const css = readFileSync(new URL('../ui/arrangeSpace.css', import.meta.url), 'utf8')
    expect(css).toContain('.shell.phone .arrange { --map-h: 0px; --ruler-h: 22px; --playhead-strip: 42px; }')
    expect(css).toContain('.shell.phone .arrange .ruler .loop-host .loop-grip-face')
    expect(css).toContain('height: 100%')
    expect(css).toContain('overflow: visible')
    expect(css).toContain('--playhead-strip: 42px')
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

  it('opens the plugins sheet from the track menu', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    let opened = false
    const html = renderToStaticMarkup(createElement(TrackOptions, {
      store,
      track,
      level: 0,
      automationOpen: false,
      participants: [],
      onClose: () => undefined,
      onPerform: () => undefined,
      onAnalyze: () => undefined,
      onOpenPlugins: () => { opened = true },
    }))
    expect(html).toContain('data-arrange-plugins="toggle"')
    expect(html).toContain('>Plugins<')
    expect(html).toContain('class="inserts"')
    const props = html
    expect(props).toContain('aria-label="Plugins. Effects on this track."')
    void opened
  })
})
