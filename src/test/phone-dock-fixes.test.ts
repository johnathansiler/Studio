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

function browser(phone: boolean, tab: 'sounds' | 'instruments' | 'loops' | 'patterns') {
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
    for (const tab of ['sounds', 'instruments', 'loops', 'patterns'] as const) {
      const html = browser(true, tab)
      const title = tab[0].toUpperCase() + tab.slice(1)
      expect(html).toContain(`data-browser-title="${tab}"`)
      expect(html).toContain(`>${title}<`)
      expect(html).not.toContain('>Project<')
    }
  })

  it('keeps the desktop Project menu', () => {
    const html = browser(false, 'sounds')
    expect(html).toContain('>Project<')
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
