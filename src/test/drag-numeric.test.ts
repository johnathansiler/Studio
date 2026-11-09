import { describe, expect, it } from 'vitest'
import { applyIntegerDetent, DETENT_RADIUS, dragNumeric, INTEGER_PX, landedOnInteger, releaseInteger } from '../model/dragNumeric'
import { tempoFromDrag } from '../model/tempoDrag'

describe('integer drag detents', () => {
  it('sticks within ±0.45 of a whole number and still lets the finger move past', () => {
    expect(DETENT_RADIUS).toBeGreaterThanOrEqual(0.45)
    expect(INTEGER_PX).toBeGreaterThanOrEqual(8)
    expect(INTEGER_PX).toBeLessThanOrEqual(12)
    expect(applyIntegerDetent(122.4)).toBe(122)
    expect(applyIntegerDetent(120.45)).toBe(120)
    expect(applyIntegerDetent(120.46)).toBeCloseTo(120.46)
    expect(applyIntegerDetent(120.7)).toBe(121)
    expect(dragNumeric({ origin: 120, deltaPx: 3 })).toBe(120)
    expect(dragNumeric({ origin: 120, deltaPx: 8 })).toBe(121)
    expect(dragNumeric({ origin: 120, deltaPx: 10 })).toBe(121)
    expect(dragNumeric({ origin: 120, deltaPx: 14 })).toBe(121)
    expect(dragNumeric({ origin: 120, deltaPx: 24 })).toBe(122)
    expect(dragNumeric({ origin: 120, deltaPx: 15 })).toBeCloseTo(121.5)
  })

  it('rounds a normal release to an integer and keeps decimals when bypassed', () => {
    expect(releaseInteger(122.4, false)).toBe(122)
    expect(releaseInteger(122.5, false)).toBe(123)
    expect(releaseInteger(122.4, true)).toBeCloseTo(122.4)
    expect(dragNumeric({ origin: 120, deltaPx: 15, release: true })).toBe(122)
    expect(dragNumeric({ origin: 120, deltaPx: 24, release: true })).toBe(122)
    expect(Number.isInteger(dragNumeric({ origin: 120, deltaPx: 15, release: true }))).toBe(true)
    expect(Number.isInteger(tempoFromDrag(120, 24, undefined, false, true))).toBe(true)
    const bypass = dragNumeric({ origin: 120, deltaPx: 24, fine: true, release: true })
    expect(bypass).toBeCloseTo(120.6)
    expect(Number.isInteger(bypass)).toBe(false)
    expect(tempoFromDrag(120, 24, undefined, true, true)).toBeCloseTo(120.6)
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
