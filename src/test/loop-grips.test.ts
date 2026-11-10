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

function sameRow(a: LoopGripBox, b: LoopGripBox) {
  expect(a.hitTop).toBe(b.hitTop)
  expect(a.faceTop).toBe(b.faceTop)
  expect(a.offset).toBe('inline')
  expect(b.offset).toBe('inline')
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
    sameRow(grips.start, grips.end)
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

  it('keeps a short loop on one row and parks the pads outside the edges', () => {
    const grips = layoutLoopGrips({
      start: 200,
      end: 210,
      hostWidth: 2000,
      viewLeft: 0,
      viewWidth: 2000,
      hit: 44,
    })
    expect(grips.mode).toBe('outside')
    sameRow(grips.start, grips.end)
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(44)
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(44)
    expect(right(grips.start)).toBeLessThanOrEqual(200.5)
    expect(grips.end.hitLeft).toBeGreaterThanOrEqual(210 - 0.5)
    expect(overlaps(grips.start, grips.end)).toBe(false)
    expect(grips.start.faceLeft + grips.start.faceWidth).toBeLessThanOrEqual(grips.end.faceLeft)
    const body = { left: 200, right: 210, top: 0, bottom: 44, mode: grips.mode }
    expect(loopEdgeAt(grips.start.faceLeft + 4, grips, body, 20)).toBe('start')
    expect(loopEdgeAt(grips.end.faceLeft + 4, grips, body, 20)).toBe('end')
    expect(loopEdgeAt(205, grips, body, 20)).toBe('move')
  })

  it('does not stack a one-beat loop that starts at the screen edge', () => {
    const grips = layoutLoopGrips({
      start: 0,
      end: 45,
      hostWidth: 1440,
      hostHeight: 44,
      viewLeft: 0,
      viewWidth: 220,
      hit: 44,
    })
    sameRow(grips.start, grips.end)
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(44)
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(44)
    expect(grips.start.hitTop).toBe(0)
    expect(grips.end.hitTop).toBe(0)
    expect(overlaps(grips.start, grips.end)).toBe(false)
    expect(grips.end.hitLeft).toBeGreaterThanOrEqual(right(grips.start) - 0.5)
    expect(grips.start.faceTop).toBe(grips.end.faceTop)
    const body = { left: 0, right: 45, top: 0, bottom: 44, mode: grips.mode }
    expect(loopEdgeAt(grips.end.faceLeft + 4, grips, body, 20)).toBe('end')
    expect(loopEdgeAt(grips.start.faceLeft + 4, grips, body, 20)).toBe('start')
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
    sameRow(grips.start, grips.end)
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(44)
    expect(right(grips.end)).toBeLessThanOrEqual(390.5)
    expect(390 - grips.end.hitLeft).toBeGreaterThanOrEqual(44)
    expect(loopEdgeAt(382, grips, { left: 0, right: 4000, mode: grips.mode }, 20)).toBe('end')
    expect(loopEdgeAt(12, grips, { left: 0, right: 4000, mode: grips.mode }, 20)).toBe('start')
    expect(overlaps(grips.start, grips.end)).toBe(false)
  })
})
