import { describe, expect, it } from 'vitest'
import { loopLabelCenter } from '../model/loopEdit'
import { LOOP_GRIP_HIT, LOOP_GRIP_VISUAL, layoutLoopGrips, loopEdgeAt, loopGripHit } from '../ui/loopGrips'

function overlaps(a0: number, a1: number, b0: number, b1: number) {
  return Math.min(a1, b1) - Math.max(a0, b0) > 0.5
}

function expectClear(hit: { hitLeft: number; hitWidth: number }, label: { left: number; right: number } | null, other: { hitLeft: number; hitWidth: number }) {
  const right = hit.hitLeft + hit.hitWidth
  const otherRight = other.hitLeft + other.hitWidth
  expect(overlaps(hit.hitLeft, right, other.hitLeft, otherRight)).toBe(false)
  if (label) expect(overlaps(hit.hitLeft, right, label.left, label.right)).toBe(false)
}

describe('loop edge grips', () => {
  it('draws a slim cap and extends the touch pad around it on a wide loop', () => {
    const label = { center: 800, width: 80 }
    const grips = layoutLoopGrips({
      start: 400,
      end: 1200,
      hostWidth: 2000,
      viewLeft: 0,
      viewWidth: 2000,
      labelCenter: label.center,
      labelWidth: label.width,
      hit: loopGripHit(true),
    })
    expect(grips.start.faceWidth).toBe(LOOP_GRIP_VISUAL)
    expect(grips.end.faceWidth).toBe(LOOP_GRIP_VISUAL)
    expect(grips.start.faceWidth).toBeGreaterThanOrEqual(10)
    expect(grips.start.faceWidth).toBeLessThanOrEqual(14)
    expect(grips.start.faceLeft).toBe(400)
    expect(grips.end.faceLeft + grips.end.faceWidth).toBe(1200)
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(44)
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(44)
    expect(grips.start.hitLeft).toBeLessThanOrEqual(400 - 18)
    expect(grips.start.hitLeft + grips.start.hitWidth).toBeGreaterThanOrEqual(400 + 12 + 18)
    expect(grips.end.hitLeft).toBeLessThanOrEqual(1200 - 12 - 18)
    expect(grips.end.hitLeft + grips.end.hitWidth).toBeGreaterThanOrEqual(1200 + 18)
    const chip = { left: label.center - label.width / 2, right: label.center + label.width / 2 }
    expectClear(grips.start, chip, grips.end)
    expectClear(grips.end, chip, grips.start)
  })

  it('keeps a full pad when the loop starts at the ruler edge', () => {
    const grips = layoutLoopGrips({
      start: 0,
      end: 720,
      hostWidth: 2000,
      viewLeft: 0,
      viewWidth: 800,
      labelCenter: 360,
      labelWidth: 90,
      hit: 44,
    })
    expect(grips.start.faceLeft).toBe(0)
    expect(grips.start.faceWidth).toBe(12)
    expect(grips.start.hitLeft).toBeGreaterThanOrEqual(0)
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(LOOP_GRIP_HIT)
    expect(grips.start.hitLeft + grips.start.hitWidth).toBeGreaterThanOrEqual(44)
    expect(grips.end.hitLeft).toBeLessThanOrEqual(grips.end.faceLeft - 18)
    expect(grips.end.hitLeft + grips.end.hitWidth).toBeGreaterThanOrEqual(720 + 18)
    expect(grips.end.hitLeft + grips.end.hitWidth).toBeLessThanOrEqual(800)
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(LOOP_GRIP_HIT)
    expectClear(grips.start, { left: 315, right: 405 }, grips.end)
  })

  it('keeps short-loop pads off the label and off each other', () => {
    const label = { center: 195, width: 100 }
    const grips = layoutLoopGrips({
      start: 180,
      end: 210,
      hostWidth: 800,
      viewLeft: 0,
      viewWidth: 800,
      labelCenter: label.center,
      labelWidth: label.width,
      hit: 40,
    })
    const chip = { left: 145, right: 245 }
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(LOOP_GRIP_HIT)
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(LOOP_GRIP_HIT)
    expect(grips.start.faceLeft + grips.start.faceWidth).toBeLessThanOrEqual(grips.end.faceLeft + 0.5)
    expectClear(grips.start, chip, grips.end)
    expectClear(grips.end, chip, grips.start)
    expect(grips.start.hitLeft + grips.start.hitWidth).toBeLessThanOrEqual(chip.left + 0.5)
    expect(grips.end.hitLeft).toBeGreaterThanOrEqual(chip.right - 0.5)
  })

  it('pins an offscreen edge into the view without covering the label', () => {
    const regionLeft = -200
    const regionWidth = 4200
    const labelWidth = 100
    const viewLeft = 500
    const viewWidth = 400
    const center = loopLabelCenter(regionLeft, regionWidth, labelWidth, viewLeft, viewWidth)
    const grips = layoutLoopGrips({
      start: regionLeft,
      end: regionLeft + regionWidth,
      hostWidth: 5000,
      viewLeft,
      viewWidth,
      labelCenter: center,
      labelWidth,
      hit: loopGripHit(true),
    })
    const viewRight = viewLeft + viewWidth
    const chip = { left: center - labelWidth / 2, right: center + labelWidth / 2 }
    for (const grip of [grips.start, grips.end]) {
      expect(grip.hitWidth).toBeGreaterThanOrEqual(44)
      expect(grip.faceWidth).toBeGreaterThanOrEqual(10)
      expect(grip.faceWidth).toBeLessThanOrEqual(14)
      const visible = Math.min(grip.hitLeft + grip.hitWidth, viewRight) - Math.max(grip.hitLeft, viewLeft)
      expect(visible).toBeGreaterThanOrEqual(40)
      expectClear(grip, chip, grip === grips.start ? grips.end : grips.start)
    }
  })

  it('keeps a 44px end pad inside a narrow view when the loop runs off the right edge', () => {
    const grips = layoutLoopGrips({
      start: 0,
      end: 400,
      hostWidth: 400,
      viewLeft: 0,
      viewWidth: 120,
      labelCenter: 60,
      labelWidth: 80,
      hit: 44,
    })
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(44)
    expect(grips.start.hitLeft).toBeGreaterThanOrEqual(0)
    expect(grips.start.hitLeft + grips.start.hitWidth).toBeLessThanOrEqual(120)
    const endVisible = Math.min(grips.end.hitLeft + grips.end.hitWidth, 120) - Math.max(grips.end.hitLeft, 0)
    expect(endVisible).toBeGreaterThanOrEqual(44)
    expect(grips.end.hitLeft + grips.end.hitWidth).toBeLessThanOrEqual(120.5)
  })

  it('refuses a touch pad under 40px and a face outside 10–14px', () => {
    expect(loopGripHit(false)).toBe(40)
    expect(loopGripHit(true)).toBe(44)
    const grips = layoutLoopGrips({
      start: 100,
      end: 104,
      hostWidth: 500,
      viewLeft: 0,
      viewWidth: 500,
      labelCenter: 0,
      labelWidth: 0,
      hit: 8,
      visual: 36,
    })
    expect(grips.start.faceWidth).toBeLessThanOrEqual(14)
    expect(grips.start.faceWidth).toBeGreaterThanOrEqual(10)
    expect(grips.end.faceWidth).toBe(grips.start.faceWidth)
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(LOOP_GRIP_HIT)
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(LOOP_GRIP_HIT)
    expect(grips.start.faceLeft + grips.start.faceWidth).toBeLessThanOrEqual(grips.end.faceLeft)
    expectClear(grips.start, null, grips.end)
  })

  it('keeps the end handle inside the phone when the loop ends at the right edge', () => {
    const grips = layoutLoopGrips({
      start: 0,
      end: 1440,
      hostWidth: 2000,
      viewLeft: 0,
      viewWidth: 390,
      labelCenter: 0,
      labelWidth: 0,
      hit: 44,
    })
    const viewRight = 390
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(44)
    expect(grips.end.hitLeft).toBeGreaterThanOrEqual(0)
    expect(grips.end.hitLeft + grips.end.hitWidth).toBeLessThanOrEqual(viewRight)
    expect(viewRight - grips.end.hitLeft).toBeGreaterThanOrEqual(44)
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(44)
    expect(loopEdgeAt(viewRight - 8, grips, { left: 0, right: 390 })).toBe('end')
    expect(loopEdgeAt(20, grips, { left: 0, right: 1440 })).toBe('start')
  })

  it('lets either handle win over the loop body, including a touch on the visible cap', () => {
    const grips = layoutLoopGrips({
      start: 120,
      end: 420,
      hostWidth: 800,
      viewLeft: 0,
      viewWidth: 800,
      labelCenter: 0,
      labelWidth: 0,
      hit: 44,
    })
    const body = { left: 120, right: 420 }
    const startFace = grips.start.faceLeft + grips.start.faceWidth / 2
    const endFace = grips.end.faceLeft + grips.end.faceWidth / 2
    expect(grips.start.hitWidth).toBeGreaterThanOrEqual(40)
    expect(grips.end.hitWidth).toBeGreaterThanOrEqual(40)
    expect(loopEdgeAt(startFace, grips, body)).toBe('start')
    expect(loopEdgeAt(endFace, grips, body)).toBe('end')
    expect(loopEdgeAt((body.left + body.right) / 2, grips, body)).toBe('move')
    expect(loopEdgeAt(700, grips, body)).toBe('seek')
  })
})
