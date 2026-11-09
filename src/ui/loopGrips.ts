/** Slim visible cap. The hit target is separate and at least 44px. */
export const LOOP_GRIP_VISUAL = 12
export const LOOP_GRIP_HIT = 44
export const LOOP_DRAG_THRESHOLD = 4
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
  mode: 'outward' | 'side' | 'offset'
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
  const slop = 12
  const startNear = contains(grips.start, x, y, slop)
  const endNear = contains(grips.end, x, y, slop)
  if (startNear && endNear) return nearest(x, y, grips)
  if (startNear) return 'start'
  if (endNear) return 'end'
  const top = body.top ?? Number.NEGATIVE_INFINITY
  const bottom = body.bottom ?? Number.POSITIVE_INFINITY
  const inBand = y == null || (y >= top && y <= bottom)
  if (inBand && x >= body.left && x <= body.right) {
    if (body.mode === 'side' || body.mode === 'offset') {
      const mid = (body.left + body.right) / 2
      const width = body.right - body.left
      if (width >= 36 && Math.abs(x - mid) <= width * 0.18) return 'move'
      return x <= mid ? 'start' : 'end'
    }
    return 'move'
  }
  return 'seek'
}

/**
 * Each handle is at least 44px and grows away from the loop so the two pads
 * never share a pixel. A very short loop splits by which side you grab, and
 * an even shorter one lifts the handles above and below the ruler.
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
  const visR = hostW > 0 ? clamp(Math.max(viewR, visL), visL, hostW) : Math.max(viewR, visL + hit)
  const left = Math.min(input.start, input.end)
  const right = Math.max(input.start, input.end)
  const loopW = Math.max(0, right - left)
  const segL = clamp(left, visL, visR)
  const segR = clamp(right, visL, visR)

  let startFace = left
  let endFace = right - visual
  if (left < visL - 0.5) startFace = visL
  if (right > visR + 0.5) endFace = visR - visual
  if (startFace + visual > endFace) {
    const mid = (segL + segR) / 2
    startFace = mid - visual
    endFace = mid
  }
  startFace = clamp(startFace, visL, Math.max(visL, visR - visual))
  endFace = clamp(endFace, visL, Math.max(visL, visR - visual))

  const shift = (preferredLeft: number) => {
    let boxL = preferredLeft
    let boxR = boxL + hit
    if (boxL < visL) {
      boxL = visL
      boxR = boxL + hit
    }
    if (boxR > visR) {
      boxR = visR
      boxL = boxR - hit
    }
    if (boxL < visL) boxL = visL
    if (boxR > visR) boxR = visR
    return { left: boxL, right: Math.max(boxL, boxR) }
  }

  const startHit = shift(startFace + visual - hit)
  const endHit = shift(endFace)
  const overlaps = startHit.right - endHit.left > 0.5
  const inline = (box: { left: number; right: number }, face: number, offset: LoopGripBox['offset']): LoopGripBox => ({
    hitLeft: Math.round(box.left),
    hitTop: offset === 'above' ? -12 : offset === 'below' ? hostH - 12 : 0,
    hitWidth: Math.max(0, Math.round(box.right) - Math.round(box.left)),
    hitHeight: offset === 'inline' ? hostH : hit,
    faceLeft: Math.round(face),
    faceTop: offset === 'inline' ? 2 : 8,
    faceWidth: visual,
    faceHeight: offset === 'inline' ? hostH - 4 : 28,
    offset,
  })

  if (!overlaps) {
    return {
      mode: loopW < hit * 2 ? 'side' : 'outward',
      start: inline(startHit, startFace, 'inline'),
      end: inline(endHit, endFace, 'inline'),
    }
  }

  const room = visR - visL
  const mid = (Math.max(left, visL) + Math.min(right, visR)) / 2
  if (loopW >= hit && room >= hit * 2 && mid - visL >= hit - 0.5 && visR - mid >= hit - 0.5) {
    return {
      mode: 'side',
      start: inline({ left: mid - hit, right: mid }, startFace, 'inline'),
      end: inline({ left: mid, right: mid + hit }, endFace, 'inline'),
    }
  }

  let startLeft = clamp(startFace + visual - hit, visL, Math.max(visL, visR - hit))
  let endLeft = clamp(endFace, visL, Math.max(visL, visR - hit))
  if (room >= hit * 2 && Math.abs(startLeft - endLeft) < 8) {
    startLeft = clamp(segL - hit, visL, Math.max(visL, visR - hit * 2))
    endLeft = startLeft + hit
  }
  return {
    mode: 'offset',
    start: inline({ left: startLeft, right: startLeft + Math.min(hit, visR - startLeft) }, startFace, 'above'),
    end: inline({ left: endLeft, right: Math.min(visR, endLeft + hit) }, endFace, 'below'),
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
