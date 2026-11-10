/** Slim visible cap. The hit target is separate and at least 44px. */
export const LOOP_GRIP_VISUAL = 12
export const LOOP_GRIP_HIT = 44
export const LOOP_DRAG_THRESHOLD = 4
/** A finger jitters more than a mouse. Travel under this is still a tap. */
export const LOOP_TOUCH_THRESHOLD = 10
export const LOOP_LONG_PRESS_MS = 450

export function loopGripHit(_coarse = false) {
  return LOOP_GRIP_HIT
}

export interface LoopGripBox {
  hitLeft: number
  hitTop: number
  hitWidth: number
  hitHeight: number
  faceLeft: number
  faceTop: number
  faceWidth: number
  faceHeight: number
  offset: 'inline' | 'above' | 'below'
}

export interface LoopLayout {
  start: LoopGripBox
  end: LoopGripBox
  /** `outside` parks the pads beyond the region edges. Both stay on one row. */
  mode: 'outward' | 'outside'
}

export function loopEdgeAt(
  x: number,
  grips: { start: LoopGripBox; end: LoopGripBox },
  body: { left: number; right: number; top?: number; bottom?: number; mode?: LoopLayout['mode'] },
  y?: number,
): 'start' | 'end' | 'move' | 'seek' {
  const startOn = contains(grips.start, x, y)
  const endOn = contains(grips.end, x, y)
  if (startOn && endOn) return nearest(x, y, grips)
  if (startOn) return 'start'
  if (endOn) return 'end'
  const top = body.top ?? Number.NEGATIVE_INFINITY
  const bottom = body.bottom ?? Number.POSITIVE_INFINITY
  const inBand = y == null || (y >= top && y <= bottom)
  if (inBand && x >= body.left && x <= body.right) return 'move'
  const slop = 12
  const startNear = contains(grips.start, x, y, slop)
  const endNear = contains(grips.end, x, y, slop)
  if (startNear && endNear) return nearest(x, y, grips)
  if (startNear) return 'start'
  if (endNear) return 'end'
  return 'seek'
}

/**
 * Both handles stay on one row. A wide loop grows each pad away from the
 * region. A short one, or one pinched against the screen, parks the pads
 * outside the edges so they never stack or share a pixel.
 */
export function layoutLoopGrips(input: {
  start: number
  end: number
  hostWidth: number
  hostHeight?: number
  viewLeft: number
  viewWidth: number
  labelCenter?: number
  labelWidth?: number
  hit?: number
  visual?: number
}): LoopLayout {
  const hit = Math.max(LOOP_GRIP_HIT, input.hit ?? LOOP_GRIP_HIT)
  const visual = clamp(input.visual ?? LOOP_GRIP_VISUAL, 10, 14)
  const hostW = Math.max(0, input.hostWidth)
  const hostH = Math.max(44, input.hostHeight ?? 44)
  const viewL = input.viewWidth > 0 ? input.viewLeft : 0
  const viewR = input.viewWidth > 0 ? input.viewLeft + input.viewWidth : (hostW || viewL)
  const visL = hostW > 0 ? clamp(viewL, 0, hostW) : viewL
  const visR = hostW > 0 ? clamp(Math.max(viewR, visL), visL, hostW) : Math.max(viewR, visL)
  const left = Math.min(input.start, input.end)
  const right = Math.max(input.start, input.end)
  const room = Math.max(0, visR - visL)

  let outside = right - left < hit - 0.5
  let startHit = outside && left >= visL - 0.5 ? left - hit : (left < visL ? visL : left) + visual - hit
  let endHit = outside && right <= visR + 0.5 ? right : right > visR ? visR - hit : right - visual

  if (room >= hit * 2) {
    const maxLeft = visR - hit
    startHit = clamp(startHit, visL, maxLeft)
    endHit = clamp(endHit, visL, maxLeft)
    if (startHit + hit > endHit + 0.5) {
      outside = true
      const mid = clamp((Math.max(left, visL) + Math.min(right, visR)) / 2, visL + hit, Math.max(visL + hit, visR - hit))
      startHit = clamp(mid - hit, visL, maxLeft)
      endHit = clamp(Math.max(endHit, startHit + hit), visL, maxLeft)
      if (startHit + hit > endHit) startHit = Math.max(visL, endHit - hit)
    }
    if (endHit + hit > visR) endHit = visR - hit
    if (startHit + hit > endHit) startHit = Math.max(visL, endHit - hit)
  } else {
    outside = true
    startHit = visL
    endHit = visL + Math.max(1, room / 2)
  }

  const startW = room >= hit * 2 ? hit : Math.max(1, endHit - startHit)
  const endW = room >= hit * 2 ? hit : Math.max(1, visR - endHit)
  const startFace = faceInside(startHit, startW, left < visL ? visL : left, visual)
  const endFace = faceInside(endHit, endW, right > visR ? visR - visual : right - visual, visual)
  const split = separateFaces(startFace, endFace, startHit, startW, endHit, endW, visual)

  return {
    mode: outside ? 'outside' : 'outward',
    start: box(startHit, startW, split.start, hostH, visual),
    end: box(endHit, endW, split.end, hostH, visual),
  }
}

function faceInside(hitL: number, width: number, preferred: number, visual: number) {
  const max = hitL + Math.max(visual, width) - visual
  return clamp(preferred, hitL, Math.max(hitL, max))
}

function separateFaces(startFace: number, endFace: number, startHit: number, startW: number, endHit: number, endW: number, visual: number) {
  if (startFace + visual <= endFace + 0.5) return { start: startFace, end: endFace }
  const pushed = faceInside(endHit, endW, startFace + visual, visual)
  if (startFace + visual <= pushed + 0.5) return { start: startFace, end: pushed }
  return {
    start: faceInside(startHit, startW, pushed - visual, visual),
    end: pushed,
  }
}

function box(hitLeft: number, hitWidth: number, face: number, hostH: number, visual: number): LoopGripBox {
  const left = Math.round(hitLeft)
  const width = Math.max(1, Math.round(hitWidth))
  return {
    hitLeft: left,
    hitTop: 0,
    hitWidth: width,
    hitHeight: hostH,
    faceLeft: Math.round(face),
    faceTop: 2,
    faceWidth: visual,
    faceHeight: Math.max(visual, hostH - 4),
    offset: 'inline',
  }
}

function contains(box: LoopGripBox, x: number, y: number | undefined, slop = 0) {
  const y0 = box.hitTop - slop
  const y1 = box.hitTop + box.hitHeight + slop
  const inY = y == null || (y >= y0 && y <= y1)
  return inY && x >= box.hitLeft - slop && x <= box.hitLeft + box.hitWidth + slop
}

function nearest(x: number, y: number | undefined, grips: { start: LoopGripBox; end: LoopGripBox }) {
  const dist = (box: LoopGripBox) => {
    const cx = box.hitLeft + box.hitWidth / 2
    const cy = box.hitTop + box.hitHeight / 2
    const dy = y == null ? 0 : y - cy
    return (x - cx) ** 2 + dy ** 2
  }
  return dist(grips.start) <= dist(grips.end) ? 'start' : 'end'
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
