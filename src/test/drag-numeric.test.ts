import { describe, expect, it } from 'vitest'
import { applyIntegerDetent, dragNumeric, INTEGER_PX, landedOnInteger } from '../model/dragNumeric'

describe('integer drag detents', () => {
  it('sticks within ±0.3 of a whole number and still lets the finger move past', () => {
    expect(INTEGER_PX).toBeGreaterThanOrEqual(8)
    expect(INTEGER_PX).toBeLessThanOrEqual(12)
    expect(applyIntegerDetent(120.3)).toBe(120)
    expect(applyIntegerDetent(120.31)).toBeCloseTo(120.31)
    expect(applyIntegerDetent(120.7)).toBe(121)
    expect(dragNumeric({ origin: 120, deltaPx: 3 })).toBe(120)
    expect(dragNumeric({ origin: 120, deltaPx: 8 })).toBe(121)
    expect(dragNumeric({ origin: 120, deltaPx: 10 })).toBe(121)
    expect(dragNumeric({ origin: 120, deltaPx: 13 })).toBe(121)
    expect(dragNumeric({ origin: 120, deltaPx: 14 })).toBeCloseTo(121.4)
    expect(dragNumeric({ origin: 120, deltaPx: -14 })).toBeCloseTo(118.6)
  })

  it('skips the detent while fine, and keeps one step a short finger move', () => {
    expect(dragNumeric({ origin: 120, deltaPx: 8, fine: true })).toBeCloseTo(120.2)
    expect(dragNumeric({ origin: 0, deltaPx: 90, min: 0, max: 1, spanPx: 90 })).toBe(1)
    expect(dragNumeric({ origin: 0, deltaPx: 90, min: 0, max: 100, spanPx: 90 })).toBe(9)
    expect(landedOnInteger(120.4, 121)).toBe(true)
    expect(landedOnInteger(121, 121)).toBe(false)
    expect(landedOnInteger(120, 120.4)).toBe(false)
  })
})
