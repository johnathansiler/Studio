import { describe, expect, it } from 'vitest'
import {
  controlWidth,
  fitSecondary,
  rowsFor,
  secondaryContentWidth,
  secondaryRowBudget,
} from '../model/secondaryFit'

const tools = [
  { id: 'automation', width: controlWidth('Touch') },
  { id: 'routing', width: controlWidth('Master') },
  { id: 'inserts', width: controlWidth('Inserts') },
  { id: 'pan', width: controlWidth('Pan') },
  { id: 'arm', width: controlWidth('Arm') },
  { id: 'safe', width: controlWidth('Safe') },
  { id: 'tune', width: controlWidth('Tune') },
]

const hear = [
  { id: 'mute', width: controlWidth('Mute') },
  { id: 'solo', width: controlWidth('Solo') },
]

function pack(width: number, flow: 'columns' | 'rows', zone: 'tools' | 'hear' | 'top' = 'tools') {
  const items = zone === 'tools' ? tools : hear
  return fitSecondary(width, items, secondaryRowBudget(flow, zone, width))
}

describe('secondary control fit', () => {
  it('keeps every word on a wide row and folds the least-used as the row gets narrower', () => {
    const widths = [600, 360, 280, 200].map((viewport) => secondaryContentWidth('rows', 84, viewport))
    let previous = new Set(tools.map((item) => item.id))
    for (const width of widths) {
      const fit = pack(width, 'rows')
      const all = new Set([...fit.shown, ...fit.drawer])
      expect(all).toEqual(new Set(tools.map((item) => item.id)))
      expect(fit.shown.length).toBeGreaterThan(0)
      expect(fit.rows).toBeLessThanOrEqual(1)
      for (const id of fit.shown) expect(previous.has(id)).toBe(true)
      if (fit.drawer.length) {
        expect(fit.drawer).toContain('tune')
        expect(fit.shown).toContain('automation')
        expect(rowsFor(width, [...fit.shown.map((id) => tools.find((item) => item.id === id)!.width), controlWidth('More')])).toBeLessThanOrEqual(1)
      }
      previous = new Set(fit.shown)
    }
    expect(pack(widths[0], 'rows').drawer).toEqual([])
    expect(pack(widths[3], 'rows').drawer.length).toBeGreaterThan(0)
    expect(pack(widths[3], 'rows').shown.length).toBeLessThan(pack(widths[0], 'rows').shown.length)
  })

  it('stacks column controls and still reserves More on a narrow strip', () => {
    const wide = pack(secondaryContentWidth('columns', 240, 900), 'columns')
    const mid = pack(secondaryContentWidth('columns', 200, 900), 'columns')
    const phone = pack(secondaryContentWidth('columns', 84, 900), 'columns')
    const narrow = pack(secondaryContentWidth('columns', 42, 900), 'columns')
    expect(wide.drawer).toEqual([])
    expect(mid.shown.length).toBeGreaterThanOrEqual(phone.shown.length)
    expect(phone.drawer).toContain('tune')
    expect(phone.drawer).toContain('safe')
    expect(phone.shown).toContain('automation')
    expect(phone.rows).toBeLessThanOrEqual(4)
    expect(narrow.drawer.length).toBeGreaterThanOrEqual(phone.drawer.length)
    expect(narrow.shown).toContain('automation')
    const flags = pack(secondaryContentWidth('columns', 42, 900), 'columns', 'hear')
    expect(flags.shown).toEqual(['mute', 'solo'])
    expect(flags.drawer).toEqual([])
    expect(flags.rows).toBe(2)
  })
})
