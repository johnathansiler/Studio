import { describe, expect, it } from 'vitest'
import { LOOP_GRIP_HIT, LOOP_GRIP_VISUAL, layoutLoopGrips, loopEdgeAt, loopGripHit, type LoopGripBox } from '../ui/loopGrips'

function right(box: LoopGripBox) {
  return box.hitLeft + box.hitWidth
}

function overlaps(a: LoopGripBox, b: LoopGripBox) {
  const x = Math.min(right(a), right(b)) - Math.max(a.hitLeft, b.hitLeft)
  const y = Math.min(a.hitTop + a.hitHeight, b.hitTop + b.hitHeight) - Math.max(a.hitTop, b.hitTop)
  return x > 0.5 && y > 0.5
}

describe('loop edge grips', () => {
  it('gives every handle a 44px target that grows away from the loop', () => {
    expect(loopGripHit(false)).toBe(44)
    expect(loopGripHit(true)).toBe(44)
    const grips = layoutLoopGrips({
      start: 400,
      end: 1200,
      hostWidth: 2000,
      viewLeft: 0,
      viewWidth: 2000,
      hit: 44,
    })
    expect(grips.mode).toBe('outward')
    expect(grips.start.faceWidth).toBe(LOOP_GRIP_VISUAL)
    expect(grips.end.faceLeft + grips.end.faceWidth).toBe(1200)
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(LOOP_GRIP_HIT)
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(LOOP_GRIP_HIT)
    expect(grips.start.hitLeft).toBeLessThanOrEqual(400)
    expect(right(grips.start)).toBeLessThanOrEqual(400 + LOOP_GRIP_VISUAL + 0.5)
    expect(grips.end.hitLeft).toBeGreaterThanOrEqual(1200 - LOOP_GRIP_VISUAL - 0.5)
    expect(right(grips.end)).toBeGreaterThanOrEqual(1200 + 18)
    expect(overlaps(grips.start, grips.end)).toBe(false)
    const body = { left: 400, right: 1200, mode: grips.mode }
    expect(loopEdgeAt(grips.start.faceLeft + 4, grips, body)).toBe('start')
    expect(loopEdgeAt(grips.end.faceLeft + 4, grips, body)).toBe('end')
    expect(loopEdgeAt(800, grips, body)).toBe('move')
    expect(loopEdgeAt(1700, grips, body)).toBe('seek')
  })

  it('picks the nearest handle when both pads are under the pointer, ignoring order', () => {
    const grips = {
      start: { hitLeft: 0, hitTop: 0, hitWidth: 44, hitHeight: 44, faceLeft: 20, faceTop: 2, faceWidth: 12, faceHeight: 40, offset: 'inline' as const },
      end: { hitLeft: 20, hitTop: 0, hitWidth: 44, hitHeight: 44, faceLeft: 40, faceTop: 2, faceWidth: 12, faceHeight: 40, offset: 'inline' as const },
    }
    const body = { left: 20, right: 40 }
    expect(loopEdgeAt(10, grips, body)).toBe('start')
    expect(loopEdgeAt(50, grips, body)).toBe('end')
    expect(loopEdgeAt(30, grips, body)).toBe('start')
    expect(loopEdgeAt(36, grips, body)).toBe('end')
  })

  it('uses the side of a short loop, and lifts tiny loops above and below the ruler', () => {
    const zoomed = layoutLoopGrips({
      start: 0,
      end: 10,
      hostWidth: 2000,
      viewLeft: 0,
      viewWidth: 2000,
      hit: 44,
    })
    expect(zoomed.mode).toBe('offset')
    expect(zoomed.start.hitWidth).toBeGreaterThanOrEqual(44)
    expect(zoomed.end.hitWidth).toBeGreaterThanOrEqual(44)
    expect(zoomed.start.offset).toBe('above')
    expect(zoomed.end.offset).toBe('below')
    expect(overlaps(zoomed.start, zoomed.end)).toBe(false)
    const body = { left: 0, right: 10, top: 0, bottom: 44, mode: zoomed.mode }
    const endY = zoomed.end.hitTop + zoomed.end.hitHeight / 2
    const startY = zoomed.start.hitTop + zoomed.start.hitHeight / 2
    expect(loopEdgeAt(zoomed.end.hitLeft + 8, zoomed, body, endY)).toBe('end')
    expect(loopEdgeAt(zoomed.start.hitLeft + 8, zoomed, body, startY)).toBe('start')
    expect(loopEdgeAt(zoomed.start.hitLeft + 4, zoomed, body, zoomed.start.hitTop + 6)).toBe('start')
    expect(loopEdgeAt(zoomed.end.hitLeft + 4, zoomed, body, zoomed.end.hitTop + zoomed.end.hitHeight - 6)).toBe('end')
  })

  it('keeps a full end target when the loop runs off a zoomed-out phone', () => {
    const grips = layoutLoopGrips({
      start: 0,
      end: 4000,
      hostWidth: 4000,
      viewLeft: 0,
      viewWidth: 390,
      hit: 44,
    })
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(44)
    expect(right(grips.end)).toBeLessThanOrEqual(390.5)
    expect(390 - grips.end.hitLeft).toBeGreaterThanOrEqual(44)
    expect(loopEdgeAt(382, grips, { left: 0, right: 4000, mode: grips.mode }, 20)).toBe('end')
    expect(loopEdgeAt(12, grips, { left: 0, right: 4000, mode: grips.mode }, 20)).toBe('start')
    expect(overlaps(grips.start, grips.end)).toBe(false)
  })
})
