import { describe, expect, it } from 'vitest'
import { PAN_APPLY, panGains } from '../audio/level'
import { smoothParam } from '../audio/paramCurve'
import {
  DB_PX,
  DB_STEP,
  PAN_CENTER_STICK,
  PAN_FINE_SCALE,
  PAN_PX,
  controlLaw,
  dbFromGain,
  dbPixels,
  dragGain,
  dragPan,
  formatPan,
  gainForDb,
  gainFromDb,
  panPixels,
  quantizeDb,
} from '../model/mixLaw'
import { gainToDb } from '../model/time'

describe('pan value mapping', () => {
  it('reaches fractions in fine mode and whole units on a normal drag', () => {
    const left = dragPan({ origin: 0, deltaPx: panPixels(-37.5, true), fine: true })
    const right = dragPan({ origin: 0, deltaPx: panPixels(12), fine: false })
    expect(left).toBeCloseTo(-0.375, 6)
    expect(formatPan(left)).toBe('Left 37.5')
    expect(right).toBeCloseTo(0.12, 6)
    expect(formatPan(right)).toBe('Right 12')
    expect(Number.isInteger(left)).toBe(false)
    expect([-1, 0, 1]).not.toContain(left)
    expect([-1, 0, 1]).not.toContain(right)
  })

  it('keeps a tiny center stick and still reaches -3 and +2', () => {
    expect(PAN_CENTER_STICK).toBeLessThan(2)
    expect(dragPan({ origin: 0, deltaPx: panPixels(2), fine: false })).toBeCloseTo(0.02, 6)
    expect(dragPan({ origin: 0, deltaPx: panPixels(-3), fine: false })).toBeCloseTo(-0.03, 6)
    expect(formatPan(0.02)).toBe('Right 2')
    expect(formatPan(-0.03)).toBe('Left 3')
    expect(dragPan({ origin: 0, deltaPx: PAN_PX * PAN_FINE_SCALE * 0.02, fine: true })).toBe(0)
    expect(formatPan(0)).toBe('Center')
    expect(dragPan({ origin: -0.37, deltaPx: 0, fine: false })).toBeCloseTo(-0.37, 6)
  })

  it('recognizes pan knobs and leaves other bipolar controls alone', () => {
    expect(controlLaw({ label: 'Vocal pan', className: 'pan-knob', min: -1, max: 1 })).toBe('pan')
    expect(controlLaw({ label: 'Pad pan', min: -1, max: 1 })).toBe('pan')
    expect(controlLaw({ label: 'Pan', min: -1, max: 1 })).toBe('pan')
    expect(controlLaw({ label: 'Depth', min: -1, max: 1 })).toBeNull()
  })
})

describe('mixer decibel mapping', () => {
  it('hits every 0.1 dB from the floor through +1.9 and round-trips the gain', () => {
    for (let step = -240; step <= 19; step += 1) {
      const db = quantizeDb(step / 10)
      const gain = gainFromDb(db)
      expect(dbFromGain(gain), String(db)).toBeCloseTo(db, 6)
      expect(gainToDb(gain)).toBe(`${db.toFixed(1)} dB`)
      const dragged = dragGain({ origin: 1, deltaPx: dbPixels(db), min: 0, max: 1.25, fine: false })
      expect(dbFromGain(dragged), String(db)).toBeCloseTo(db, 5)
      expect(gainToDb(dragged)).toBe(`${db.toFixed(1)} dB`)
      expect(Number.isInteger(dragged)).toBe(db === 0)
    }
    expect(DB_STEP).toBe(0.1)
    expect(DB_PX).toBeGreaterThan(0)
  })

  it('stores -6.3 dB and +1.7 dB as floats and keeps a saved gain until the finger moves', () => {
    const down = dragGain({ origin: 1, deltaPx: dbPixels(-6.3), min: 0, max: 1.25 })
    const up = dragGain({ origin: 1, deltaPx: dbPixels(1.7), min: 0, max: 1.25 })
    expect(gainToDb(down)).toBe('-6.3 dB')
    expect(gainToDb(up)).toBe('1.7 dB')
    expect(down).toBeCloseTo(gainFromDb(-6.3), 8)
    expect(up).toBeCloseTo(gainFromDb(1.7), 8)
    expect(down).toBeGreaterThan(0)
    expect(down).toBeLessThan(1)
    expect(up).toBeGreaterThan(1)
    expect(up).toBeLessThan(1.25)
    expect(dragGain({ origin: 0.8, deltaPx: 0, min: 0, max: 1.25 })).toBeCloseTo(0.8, 8)
    expect(gainForDb(-6.3, 0, 1.25)).toBeCloseTo(down, 8)
    expect(gainForDb(1.7, 0, 1.25)).toBeCloseTo(up, 8)
  })

  it('treats mixer faders as decibels and leaves pad level alone', () => {
    expect(controlLaw({ label: 'Master volume. How loud the whole mix is.', className: 'touch-slider vertical volume', min: 0, max: 1.25 })).toBe('db')
    expect(controlLaw({ label: 'Keys volume. How loud this track is.', className: 'volume', min: 0, max: 1.25 })).toBe('db')
    expect(controlLaw({ label: 'Kick Vol. How loud this row is.', min: 0, max: 1 })).toBe('db')
    expect(controlLaw({ label: 'Pad volume', min: 0, max: 1 })).toBeNull()
    expect(controlLaw({ label: 'Velocity sensitivity', min: 0, max: 1 })).toBeNull()
  })
})

describe('engine pan and level follow the float', () => {
  it('uses equal-power gains for in-between pan, including +2', () => {
    expect(PAN_APPLY).toBeLessThanOrEqual(0.005)
    expect(0.02).toBeGreaterThanOrEqual(PAN_APPLY)
    const mid = panGains(-0.375)
    const unit = panGains(0.12)
    const nudge = panGains(0.02)
    const center = panGains(0)
    const hard = panGains(-1)
    for (const gains of [mid, unit, nudge, center]) {
      expect(gains.left ** 2 + gains.right ** 2).toBeCloseTo(1, 5)
    }
    expect(mid.left).toBeGreaterThan(center.left)
    expect(mid.left).toBeLessThan(hard.left)
    expect(nudge.right).toBeGreaterThan(nudge.left)
    expect(unit.right).not.toBeCloseTo(panGains(1).right, 2)
  })

  it('smooths the exact gain instead of stepping to a whole number', () => {
    const gain = gainFromDb(-6.3)
    const events: { method: string; value: number }[] = []
    smoothParam({
      value: 1,
      cancelScheduledValues() {},
      setValueAtTime(value) {
        events.push({ method: 'set', value })
      },
      linearRampToValueAtTime() {},
      setTargetAtTime(value) {
        events.push({ method: 'target', value })
      },
    }, gain, 0)
    const target = events.find((event) => event.method === 'target')
    expect(target?.value).toBeCloseTo(gain, 8)
    expect(Number.isInteger(target?.value ?? 0)).toBe(false)
  })
})
