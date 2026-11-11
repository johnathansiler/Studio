import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { FEATURES } from '../features'

declare const __CUEHARBOR_SESSION__: boolean
import { createEmptyProject, type AudioClip } from '../model/types'
import { ProjectStore } from '../state/store'
import { BeatView } from '../ui/BeatView'
import { visibleMenu } from '../ui/chrome'
import { MainMenu } from '../ui/MainMenu'
import { ViewSwitcher } from '../ui/ViewSwitcher'

function shell() {
  return renderToStaticMarkup(createElement('div', null,
    createElement(ViewSwitcher, {
      active: 'arrange',
      collabShown: false,
      phonePane: 'edit',
      collabBadge: false,
      onView: () => undefined,
      onCollab: () => undefined,
    }),
    createElement(MainMenu, {
      items: visibleMenu({ phone: false, session: true, dockBottom: false, hardwareMidi: true }),
      pressed: () => false,
      disabled: () => false,
      onAction: () => undefined,
      signature: '4/4',
      onSignature: () => undefined,
    }),
    createElement(MainMenu, {
      items: visibleMenu({ phone: true, session: true, dockBottom: false, hardwareMidi: true }),
      pressed: () => false,
      disabled: () => false,
      onAction: () => undefined,
      signature: '4/4',
      onSignature: () => undefined,
    }),
    createElement(BeatView, {
      store: new ProjectStore(),
      engine: { positionSamples: 0 } as AudioEngine,
    }),
  ))
}

describe('session launcher hidden', () => {
  it('renders no Session UI and still loads a project that has session clips', () => {
    expect(FEATURES.session).toBe(false)
    expect(__CUEHARBOR_SESSION__).toBe(false)
    const html = shell()
    expect(html).toContain('Arrange')
    expect(html).toContain('Mix')
    expect(html).toContain('Collab')
    expect(html).not.toContain('>Beats<')
    expect(html).not.toContain('>Session<')
    expect(html).not.toContain('Session. Launch clips')
    expect(html).not.toContain('data-session-view')
    expect(html).not.toContain('data-session-browser')
    expect(html).not.toContain('To arrangement')
    expect(html).not.toContain('first clip slot')
    expect(html).not.toContain('data-menu-action="session-mode"')
    expect(html).not.toContain('data-menu-action="capture"')
    expect(html).not.toContain('>Launch<')
    expect(html).not.toContain('>Timeline<')

    const project = createEmptyProject(48000)
    const vocal = project.tracks[0]
    const clip: AudioClip = {
      id: 'slot-clip',
      name: 'Hidden slot',
      bufferId: 'buf-slot',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: 480,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'local',
      slotOnly: true,
    }
    vocal.clips.push(clip)
    vocal.audioSlots = [clip.id, null]
    const store = new ProjectStore()
    store.loadProject(project, new Map())
    expect(store.project.tracks[0].clips.some((item) => item.id === 'slot-clip' && item.slotOnly)).toBe(true)
    expect(store.project.tracks[0].audioSlots?.[0]).toBe('slot-clip')
    store.setView('session')
    store.setTransportMode('session')
    store.enterSession()
    expect(store.view).toBe('arrange')
    expect(store.transportMode).toBe('arrangement')
  })
})
