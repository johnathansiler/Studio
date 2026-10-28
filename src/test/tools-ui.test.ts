import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BEAT_BAR,
  BEAT_ROW,
  BEAT_SHEET,
  CALL_COPY,
  MENU_COPY,
  PHONE_TRANSPORT_MENU,
  PIANO_BAR,
  PIANO_SHEET,
  RECORD_COPY,
  SESSION_BAR,
  SESSION_SHEET,
  TRACK_ROW,
  TRACK_SHEET,
  TRANSPORT_COPY,
  VIEW_COPY,
  sharesId,
  type Copy,
} from '../ui/chrome'
import { noteGrip, trimZone } from '../ui/touchEdit'
import { ToolBar } from '../ui/ToolBar'
import {
  ARRANGE_TOOLS,
  PRIMARY_TOOLS,
  SHEET_TOOLS,
  TOOL_ACTIONS,
  TOOL_INFO,
  compactToolOrder,
  setActiveTool,
  toolChip,
} from '../state/tools'

afterEach(() => setActiveTool('select'))

function markup(compact: boolean, context: 'arrange' | 'piano') {
  return renderToStaticMarkup(createElement(ToolBar, {
    compact,
    context,
    onChange: () => undefined,
    onDuplicate: () => undefined,
    onDelete: () => undefined,
  }))
}

describe('edit tool chrome', () => {
  it('states the draw tool in one line', () => {
    expect(TOOL_INFO.pencil.label).toBe('Draw')
    expect(toolChip('pencil', 'piano')).toBe('Draw: tap to add notes')
    expect(toolChip('pencil', 'arrange')).toBe('Draw: tap a lane to add a clip')
  })

  it('puts every tool on the phone strip, essentials first, with nothing listed twice', () => {
    const visible = PRIMARY_TOOLS.map((id) => ({ id }))
    const later = SHEET_TOOLS.map((id) => ({ id }))
    expect(sharesId(visible, later)).toEqual([])
    expect(compactToolOrder()).toEqual([...PRIMARY_TOOLS, ...SHEET_TOOLS])
    expect([...compactToolOrder()].sort()).toEqual(ARRANGE_TOOLS.map((tool) => tool.id).sort())
  })

  it('describes every tool', () => {
    for (const tool of ARRANGE_TOOLS) {
      const info = TOOL_INFO[tool.id]
      expect(info.hint.length).toBeGreaterThan(12)
      expect(info.arrange.startsWith(info.label)).toBe(true)
      expect(info.piano.startsWith(info.label)).toBe(true)
      expect(info.cursor.length).toBeGreaterThan(2)
    }
  })

  it('shows every tool inline on a phone, with the active chip and no sheet', () => {
    setActiveTool('pencil')
    const html = markup(true, 'piano')
    expect(html).toContain('Draw: tap to add notes')
    expect(html).toContain('data-active-tool="pencil"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('class="tool-strip"')
    expect(html).not.toContain('More tools')
    expect(html).not.toContain('role="dialog"')
    for (const tool of ARRANGE_TOOLS) expect(html).toContain(TOOL_INFO[tool.id].label)
    for (const action of TOOL_ACTIONS) expect(html).toContain(action.hint)
  })

  it('shows the full set and the timeline chip on a desk', () => {
    setActiveTool('trim')
    const html = markup(false, 'arrange')
    expect(html).toContain('Trim: drag an edge to resize')
    expect(html).toContain('Duplicate')
    expect(html).not.toContain('More tools')
  })

  it('trims from the nearer half under a finger', () => {
    expect(trimZone(0.1, false)).toBe('start')
    expect(trimZone(0.5, false)).toBeNull()
    expect(trimZone(0.9, false)).toBe('end')
    expect(trimZone(0.2, true)).toBe('start')
    expect(trimZone(0.8, true)).toBe('end')
    expect(trimZone(Number.NaN, true)).toBeNull()
  })

  it('gives touch a wider note edge than a mouse', () => {
    expect(noteGrip(80, true)).toBeGreaterThan(noteGrip(80, false))
    expect(noteGrip(10, false)).toBeLessThanOrEqual(8)
  })
})

describe('mobile control lists', () => {
  const groups: Copy[][] = [
    VIEW_COPY,
    TRANSPORT_COPY,
    MENU_COPY,
    PIANO_BAR,
    PIANO_SHEET,
    BEAT_BAR,
    BEAT_ROW,
    BEAT_SHEET,
    SESSION_BAR,
    SESSION_SHEET,
    TRACK_ROW,
    TRACK_SHEET,
    RECORD_COPY,
    CALL_COPY,
    [...TOOL_ACTIONS],
  ]

  it('gives every listed control a short description', () => {
    for (const list of groups) {
      expect(list.length).toBeGreaterThan(0)
      for (const item of list) {
        expect(item.label.length).toBeGreaterThan(0)
        expect(item.hint.length).toBeGreaterThan(8)
      }
    }
  })

  it('keeps bar controls out of the sheet', () => {
    expect(sharesId(PIANO_BAR, PIANO_SHEET)).toEqual([])
    expect(sharesId(BEAT_BAR, BEAT_SHEET)).toEqual([])
    expect(sharesId(SESSION_BAR, SESSION_SHEET)).toEqual([])
    expect(sharesId(TRACK_ROW, TRACK_SHEET)).toEqual([])
    expect(sharesId(PRIMARY_TOOLS.map((id) => ({ id })), [...TOOL_ACTIONS])).toEqual([])
  })

  it('moves return and loop off the phone transport and into the menu', () => {
    expect([...PHONE_TRANSPORT_MENU]).toEqual(['to-start', 'loop'])
    for (const id of PHONE_TRANSPORT_MENU) {
      expect(TRANSPORT_COPY.some((item) => item.id === id)).toBe(true)
      expect(MENU_COPY.some((item) => item.id === id)).toBe(true)
    }
  })
})
