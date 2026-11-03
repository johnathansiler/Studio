import { describe, expect, it } from 'vitest'
import { controlWidth, fitSecondary, rowsFor, secondaryContentWidth } from '../model/secondaryFit'

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

describe('secondary control fit', () => {
  it('keeps every control on the strip at 200, 280, 360, and 600', () => {
    const widths = [600, 360, 280, 200].map((viewport) => secondaryContentWidth('rows', 84, viewport))
    for (const width of widths) {
      const fit = fitSecondary(width, tools)
      expect(fit.shown).toEqual(tools.map((item) => item.id))
      expect(fit.drawer).toEqual([])
      expect(fit.rows).toBe(rowsFor(width, tools.map((item) => item.width)))
      expect(fit.shown).toContain('tune')
      expect(fit.shown).toContain('automation')
    }
    expect(widths[3]).toBeLessThan(widths[0])
    expect(fitSecondary(widths[3], tools).rows).toBeGreaterThan(fitSecondary(widths[0], tools).rows)
  })

  it('stacks every column control, including the ones a narrow strip used to hide', () => {
    for (const strip of [240, 200, 84, 42]) {
      const fit = fitSecondary(secondaryContentWidth('columns', strip, 900), tools)
      expect(fit.drawer).toEqual([])
      expect(fit.shown).toEqual(tools.map((item) => item.id))
      expect(fit.shown).toContain('tune')
      expect(fit.shown).toContain('safe')
      expect(fit.shown).toContain('arm')
    }
    const flags = fitSecondary(secondaryContentWidth('columns', 42, 900), hear)
    expect(flags.shown).toEqual(['mute', 'solo'])
    expect(flags.drawer).toEqual([])
    expect(flags.rows).toBe(2)
  })
})
