import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { ideasPageFromSearch, ideasSheetRequested } from '../unstuck/ideasPage'
import { UnstuckSheet } from '../unstuck/UnstuckSheet'

function sheet(page?: 'write' | 'players' | 'progressions') {
  const store = new ProjectStore(createEmptyProject())
  const engine = { stopPreview() {}, positionSamples: 0, currentTimelineSample: () => 0 } as AudioEngine
  return renderToStaticMarkup(createElement(UnstuckSheet, { store, engine, onClose: () => undefined, page }))
}

describe('ideas sheet pages', () => {
  it('maps the old links onto one sheet', () => {
    expect(ideasPageFromSearch('?ideas=1')).toBe('progressions')
    expect(ideasPageFromSearch('?players=1')).toBe('players')
    expect(ideasPageFromSearch('?unstuck=1')).toBe('write')
    expect(ideasPageFromSearch('')).toBe('write')
    expect(ideasSheetRequested('?ideas=1')).toBe(true)
    expect(ideasSheetRequested('?players=1')).toBe(true)
    expect(ideasSheetRequested('?unstuck=1')).toBe(true)
    expect(ideasSheetRequested('')).toBe(false)
  })

  it('keeps Write, Progressions, and Players on one Ideas sheet', () => {
    const html = sheet()
    expect(html).toContain('aria-label="Ideas"')
    expect(html).toContain('>Write<')
    expect(html).toContain('>Progressions<')
    expect(html).toContain('>Players<')
    expect(html).toContain('data-ideas-page="write"')
    expect(html).toContain('data-unstuck="parts"')
    expect(html).toContain('>Full song<')
    expect(html).toContain('class="sheet-close overlay-close')
    expect(html).not.toMatch(/>\s*Close\s*</)
  })

  it('puts the chord catalog on the Progressions tab', () => {
    const html = sheet('progressions')
    expect(html).toContain('data-ideas-page="progressions"')
    expect(html).toContain('aria-label="Progressions"')
    expect(html).toContain('class="ideas-pop embedded"')
    expect(html).not.toMatch(/class="ideas-pop embedded"[^>]*data-screen-overlay/)
    expect(html.match(/role="dialog"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Search ideas"')
    expect(html).toContain('>Open Lift<')
    expect(html).toContain('>Hear<')
    expect(html).toContain('>Use<')
    expect(html).toContain('>Random<')
    expect(html).toContain('Hear a progression, then Use writes chords, bass, and drums.')
    expect(html).not.toContain('data-unstuck="parts"')
    expect(html).not.toMatch(/>\s*Close\s*</)
  })

  it('keeps Players inside the sheet, without a second close or overlay', () => {
    const html = sheet('players')
    expect(html).toContain('data-ideas-page="players"')
    expect(html).toContain('players-dock embedded')
    expect(html).not.toMatch(/players-dock embedded"[^>]*data-screen-overlay/)
    expect(html).toContain('aria-label="Style.')
    expect(html).toContain('>Hear<')
    expect(html).toContain('>Write<')
    expect(html).toContain('>Another<')
    expect(html).toContain('>Drums<')
    expect(html).toContain('>Bass<')
    expect(html).toContain('>Keys<')
    expect(html).toContain('A drummer, bass, and keys')
    expect(html).not.toContain('data-unstuck="parts"')
    expect(html).not.toMatch(/>\s*Close\s*</)
    expect(html).toContain('class="sheet-close overlay-close')
  })

  it('opens Progressions from the piano roll and Players only through Ideas', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain("onIdeas={() => openIdeas('progressions')}")
    expect(app).toContain("openIdeas('players')")
    expect(app).toContain("openIdeas('write')")
    expect(app).toMatch(/function toggleIdeas\(\) \{\s*setMenuOpen\(false\)\s*if \(unstuckOpen\) \{\s*engine\.stopPreview\(\)/)
    expect(app).toMatch(/if \(unstuckOpen && page !== ideasPage\) engine\.stopPreview\(\)/)
    expect(app).toContain('page={ideasPage}')
    expect(app).not.toContain('playersOpen')
    expect(app).not.toContain('ideasOpen')
    expect(app).not.toContain('<PlayersSheet')
    expect(app).not.toContain('<IdeasPop')
    const roll = readFileSync(new URL('../ui/PianoRoll.tsx', import.meta.url), 'utf8')
    expect(roll).toContain('onIdeas')
    expect(roll).toContain("sheet('ideas')")
    expect(roll).toContain('onGenerate')
    const scaler = readFileSync(new URL('../ui/ScalerPanel.tsx', import.meta.url), 'utf8')
    expect(scaler).toContain('GeneratePanel')
  })
})
