import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { ExportSheet } from '../ui/ExportSheet'
import { PlaylistBrowser } from '../ui/PlaylistBrowser'
import { ProjectSheet } from '../ui/ProjectSheet'

const engine = {
  unlock() {},
  stopPreview() {},
  previewPcm() {},
  currentTimelineSample: () => 0,
}

function browser(phone: boolean, tab: 'library' | 'patterns' | 'clips') {
  const store = new ProjectStore(createEmptyProject(48000))
  return renderToStaticMarkup(createElement(PlaylistBrowser, {
    store,
    engine,
    phone,
    tab,
    onTab() {},
    onClose() {},
    onSeek() {},
    sheet: phone,
  }))
}

describe('phone browser sections', () => {
  it('titles each phone section with the same word as the button', () => {
    const titles = { library: 'My Library', patterns: 'Patterns', clips: 'Clips' } as const
    for (const tab of ['library', 'patterns', 'clips'] as const) {
      const html = browser(true, tab)
      expect(html).toContain(`data-browser-title="${tab}"`)
      expect(html).toContain(`>${titles[tab]}<`)
      expect(html).not.toContain('>Sounds<')
      expect(html).not.toContain('>Project<')
    }
  })

  it('uses the same three tabs on the desktop', () => {
    const html = browser(false, 'library')
    expect(html).toContain('>My Library<')
    expect(html).toContain('>Patterns<')
    expect(html).toContain('>Clips<')
    expect(html).not.toContain('>Project<')
    expect(html).not.toContain('>Sounds<')
    expect(html).not.toContain('data-browser-title')
  })
})

describe('phone project and export sheets', () => {
  const sheetProps = {
    projects: [],
    snapshots: [],
    usage: '0',
    persisted: true,
    name: 'Night',
    onName() {},
    onClose() {},
    onNew() {},
    onSave() {},
    onSaveAs() {},
    onRename() {},
    onDuplicate() {},
    onDelete() {},
    onOpen() {},
    onRevert() {},
    onAudio() {},
    onKeep() {},
  }

  it('uses an X above the dock on a phone', () => {
    const projects = renderToStaticMarkup(createElement(ProjectSheet, { ...sheetProps, dockSheet: true }))
    expect(projects).toContain('phone-sheet')
    expect(projects).toContain('sheet-close')
    expect(projects).not.toMatch(/>\s*Close\s*</)
    const store = new ProjectStore(createEmptyProject(48000))
    const exported = renderToStaticMarkup(createElement(ExportSheet, {
      store,
      phone: true,
      dockSheet: true,
      onClose() {},
      onFreeze() {},
    }))
    expect(exported).toContain('phone-sheet')
    expect(exported).toContain('sheet-close')
    expect(exported).not.toMatch(/>\s*Close\s*</)
  })

  it('keeps the Close word on the desk', () => {
    const projects = renderToStaticMarkup(createElement(ProjectSheet, sheetProps))
    expect(projects).toContain('>Close<')
    expect(projects).not.toContain('phone-sheet')
  })
})
