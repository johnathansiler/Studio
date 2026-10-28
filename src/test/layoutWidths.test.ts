import { describe, expect, it } from 'vitest'
import type { FormFactor } from '../ui/form'
import {
  LAYOUT_KEY,
  clearLayoutValue,
  clampWidth,
  defaultSlot,
  defaultStrip,
  displayWidth,
  nudgeWidth,
  readLayoutValue,
  resizeWidth,
  slotBounds,
  stripBounds,
  writeLayoutValue,
  type LayoutStorage,
} from '../ui/layoutWidths'

function memory(): LayoutStorage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

const FORMS: FormFactor[] = ['phone', 'fold', 'desk']

describe('mixer and session widths', () => {
  it('starts narrower than the old fixed sizes, and narrower on a phone', () => {
    expect(defaultStrip('phone')).toBeLessThan(defaultStrip('fold'))
    expect(defaultStrip('fold')).toBeLessThan(defaultStrip('desk'))
    expect(defaultStrip('desk')).toBeLessThan(168)
    expect(defaultSlot('phone')).toBeLessThan(defaultSlot('fold'))
    expect(defaultSlot('fold')).toBeLessThan(defaultSlot('desk'))
    expect(defaultSlot('phone')).toBeLessThan(88)
    for (const form of FORMS) {
      const strip = stripBounds(form, form === 'phone' ? 390 : 1280)
      const slot = slotBounds(form, form === 'phone' ? 390 : 1280)
      expect(defaultStrip(form)).toBeGreaterThanOrEqual(strip.min)
      expect(defaultStrip(form)).toBeLessThanOrEqual(strip.max)
      expect(defaultSlot(form)).toBeGreaterThanOrEqual(slot.min)
      expect(defaultSlot(form)).toBeLessThanOrEqual(slot.max)
      expect(strip.max).toBeGreaterThan(strip.min)
      expect(slot.max).toBeGreaterThan(slot.min)
    }
  })

  it('caps a phone mixer so a drag cannot swallow the screen', () => {
    const narrow = stripBounds('phone', 320)
    const wide = stripBounds('phone', 430)
    expect(narrow.max).toBeLessThanOrEqual(180)
    expect(wide.max).toBeLessThanOrEqual(180)
    expect(wide.max).toBeGreaterThanOrEqual(narrow.max)
    expect(slotBounds('phone', 280).max).toBeLessThanOrEqual(160)
    expect(stripBounds('desk').max).toBeGreaterThan(stripBounds('phone', 390).max)
  })

  it('clamps drags and key nudges to the limits', () => {
    const bounds = { min: 76, max: 180 }
    expect(clampWidth(40, bounds)).toBe(76)
    expect(clampWidth(400, bounds)).toBe(180)
    expect(clampWidth(100.4, bounds)).toBe(100)
    expect(clampWidth(Number.NaN, bounds)).toBe(76)
    expect(resizeWidth(100, 50, bounds)).toBe(150)
    expect(resizeWidth(170, 40, bounds)).toBe(180)
    expect(resizeWidth(80, -20, bounds)).toBe(76)
    expect(nudgeWidth(100, 'ArrowRight', bounds)).toBe(108)
    expect(nudgeWidth(100, 'ArrowLeft', bounds, true)).toBe(76)
    expect(nudgeWidth(100, 'Home', bounds)).toBe(76)
    expect(nudgeWidth(100, 'End', bounds)).toBe(180)
    expect(nudgeWidth(100, 'Enter', bounds)).toBeNull()
  })

  it('keeps a saved width across a refresh and drops one axis without the other', () => {
    const storage = memory()
    expect(readLayoutValue(storage, 'strip')).toBeNull()
    writeLayoutValue(storage, 'strip', 140.2)
    writeLayoutValue(storage, 'slot', 90)
    expect(JSON.parse(storage.getItem(LAYOUT_KEY) || '')).toEqual({ strip: 140, slot: 90 })
    expect(readLayoutValue(storage, 'strip')).toBe(140)
    expect(readLayoutValue(storage, 'slot')).toBe(90)
    clearLayoutValue(storage, 'strip')
    expect(readLayoutValue(storage, 'strip')).toBeNull()
    expect(readLayoutValue(storage, 'slot')).toBe(90)
    expect(displayWidth(null, defaultStrip('phone'), stripBounds('phone', 390))).toBe(defaultStrip('phone'))
    expect(displayWidth(240, defaultStrip('phone'), stripBounds('phone', 390))).toBe(stripBounds('phone', 390).max)
    expect(displayWidth(40, defaultSlot('desk'), slotBounds('desk'))).toBe(slotBounds('desk').min)
  })

  it('ignores corrupt storage and a missing store', () => {
    const storage = memory()
    storage.setItem(LAYOUT_KEY, '{')
    expect(readLayoutValue(storage, 'strip')).toBeNull()
    storage.setItem(LAYOUT_KEY, JSON.stringify({ strip: 'wide', slot: 80 }))
    expect(readLayoutValue(storage, 'strip')).toBeNull()
    expect(readLayoutValue(storage, 'slot')).toBe(80)
    storage.setItem(LAYOUT_KEY, '[]')
    expect(readLayoutValue(storage, 'slot')).toBeNull()
    expect(readLayoutValue(null, 'strip')).toBeNull()
    expect(() => writeLayoutValue(null, 'strip', 120)).not.toThrow()
    expect(() => clearLayoutValue(null, 'slot')).not.toThrow()
    const failing: LayoutStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readLayoutValue(failing, 'strip')).toBeNull()
    expect(() => writeLayoutValue(failing, 'strip', 110)).not.toThrow()
    expect(() => clearLayoutValue(failing, 'strip')).not.toThrow()
  })
})
