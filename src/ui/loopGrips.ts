/** Visible width of a loop-edge cap. The touch target is separate and larger. */
export const LOOP_GRIP_VISUAL = 12
/** Minimum invisible hit width. Phones and foldables use the coarser size. */
export const LOOP_GRIP_HIT = 40
export const LOOP_GRIP_HIT_COARSE = 44
/** Touch room on each side of the slim cap, before the pad is clamped to the ruler. */
export const LOOP_GRIP_SIDE = 24

export function loopGripHit(coarse: boolean) {
  return coarse ? LOOP_GRIP_HIT_COARSE : LOOP_GRIP_HIT
}

/**
 * Which part of the loop a press hits. Handles win over the body, even when
 * the visible cap sits on the bar. A press on neither is a seek.
 */
export function loopEdgeAt(
  x: number,
  grips: { start: LoopGripBox; end: LoopGripBox },
  body: { left: number; right: number },
): 'start' | 'end' | 'move' | 'seek' {
  const on = (box: LoopGripBox) => x >= box.hitLeft && x <= box.hitLeft + box.hitWidth
  const start = on(grips.start)
  const end = on(grips.end)
  if (start && end) {
    const startMid = grips.start.hitLeft + grips.start.hitWidth / 2
    const endMid = grips.end.hitLeft + grips.end.hitWidth / 2
    return Math.abs(x - startMid) <= Math.abs(x - endMid) ? 'start' : 'end'
  }
  if (start) return 'start'
  if (end) return 'end'
  if (x >= body.left && x <= body.right) return 'move'
  return 'seek'
}

export interface LoopGripBox {
  hitLeft: number
  hitWidth: number
  faceLeft: number
  faceWidth: number
}

/**
 * Slim caps on the loop edges. Each touch pad is at least 40px and reaches
 * about 24px to either side of the cap. A handle on the screen edge shifts
 * inward so the whole pad stays inside the visible ruler.
 * Pads do not overlap each other or the length label.
 */
export function layoutLoopGrips(input: {
  start: number
  end: number
  hostWidth: number
  viewLeft: number
  viewWidth: number
  labelCenter: number
  labelWidth: number
  /** Requested hit width. Values under 40 are raised. */
  hit?: number
  /** Requested face width, clamped to 10–14. */
  visual?: number
}): { start: LoopGripBox; end: LoopGripBox } {
  const visual = clamp(input.visual ?? LOOP_GRIP_VISUAL, 10, 14)
  const hit = Math.max(LOOP_GRIP_HIT, input.hit ?? LOOP_GRIP_HIT)
  const leftEdge = Math.min(input.start, input.end)
  const rightEdge = Math.max(input.start, input.end)
  const hostWidth = input.hostWidth > 0 ? input.hostWidth : 0
  const viewLeft = input.viewWidth > 0 ? input.viewLeft : 0
  const viewRight = input.viewWidth > 0 ? input.viewLeft + input.viewWidth : 0
  const faces = layoutFaces(leftEdge, rightEdge, visual, hostWidth, viewLeft, viewRight)
  const label = input.labelWidth > 0
    ? { left: input.labelCenter - input.labelWidth / 2, right: input.labelCenter + input.labelWidth / 2 }
    : null
  const hits = inwardHits(faces, hit, hostWidth, viewLeft, viewRight, label)
  return {
    start: box(hits.start, faces.start, faces.faceW),
    end: box(hits.end, faces.end, faces.faceW),
  }
}

/** Pads centered on each cap, about 24px past the cap on both sides, clamped to the visible ruler. */
function inwardHits(
  faces: { start: number; end: number; faceW: number },
  hit: number,
  hostWidth: number,
  viewLeft: number,
  viewRight: number,
  label: { left: number; right: number } | null,
) {
  const span = Math.max(hit, faces.faceW + LOOP_GRIP_SIDE * 2)
  const hostL = 0
  const hostR = hostWidth > 0 ? hostWidth : Math.max(viewRight, faces.end + faces.faceW)
  const seeL = viewRight > viewLeft ? viewLeft : hostL
  const seeR = viewRight > viewLeft ? viewRight : hostR
  const rawL = hostWidth > 0 ? Math.max(hostL, Math.min(seeL, hostR)) : seeL
  const rawR = hostWidth > 0 ? Math.min(hostR, Math.max(seeR, rawL)) : Math.max(seeR, rawL + span)
  const visL = Math.ceil(rawL)
  const visR = Math.floor(rawR)
  const room = Math.max(0, visR - visL)
  const width = room >= span ? span : room

  const place = (faceLeft: number, faceRight: number) => {
    const mid = (faceLeft + faceRight) / 2
    let left = mid - width / 2
    let right = left + width
    if (right > visR) {
      right = visR
      left = right - width
    }
    if (left < visL) {
      left = visL
      right = Math.min(visR, left + width)
    }
    return { left, right }
  }

  let start = place(faces.start, faces.start + faces.faceW)
  let end = place(faces.end, faces.end + faces.faceW)
  let startLeft = start.left
  let startRight = start.right
  let endLeft = end.left
  let endRight = end.right

  if (startRight > endLeft) {
    const anchor = (faces.start + faces.end + faces.faceW) / 2
    if (room >= span * 2) {
      startLeft = Math.max(visL, Math.min(faces.start, anchor - span))
      startRight = startLeft + span
      endRight = Math.min(visR, Math.max(faces.end + faces.faceW, anchor + span))
      endLeft = endRight - span
      if (startLeft < visL) {
        startLeft = visL
        startRight = visL + span
      }
      if (endRight > visR) {
        endRight = visR
        endLeft = visR - span
      }
    }
    if (startRight > endLeft) {
      const split = (Math.max(startLeft, visL) + Math.min(endRight, visR)) / 2
      startRight = split
      endLeft = split
      if (startRight - startLeft < width && startLeft - (width - (startRight - startLeft)) >= visL) {
        startLeft = startRight - width
      }
      if (endRight - endLeft < width && endLeft + width <= visR) endRight = endLeft + width
    }
  }

  const blocksLabel = (left: number, right: number) => !!label && right > label.left + 0.5 && left < label.right - 0.5
  if (blocksLabel(startLeft, startRight) && label) {
    const parkedRight = label.left
    const parkedLeft = parkedRight - width
    if (parkedLeft >= visL - 0.5) {
      startLeft = Math.max(visL, parkedLeft)
      startRight = startLeft + width
    } else if (label.left - visL >= LOOP_GRIP_HIT) {
      startLeft = visL
      startRight = Math.min(label.left, visL + width)
    }
  }
  if (blocksLabel(endLeft, endRight) && label) {
    const parkedLeft = label.right
    const parkedRight = parkedLeft + width
    if (parkedRight <= visR + 0.5) {
      endLeft = parkedLeft
      endRight = Math.min(visR, parkedRight)
    } else if (visR - label.right >= LOOP_GRIP_HIT) {
      endRight = visR
      endLeft = Math.max(label.right, visR - width)
    }
  }

  return {
    start: { left: startLeft, right: Math.max(startLeft, startRight) },
    end: { left: endLeft, right: Math.max(endLeft, endRight) },
  }
}

function layoutFaces(leftEdge: number, rightEdge: number, visual: number, hostWidth: number, viewLeft: number, viewRight: number) {
  let faceW = visual
  let start = leftEdge
  let end = rightEdge - faceW
  if (start + faceW > end) {
    const mid = (leftEdge + rightEdge) / 2
    start = mid - faceW
    end = mid
  }
  const startPinned = viewRight > viewLeft && leftEdge < viewLeft
  const endPinned = viewRight > viewLeft && rightEdge > viewRight
  if (startPinned) start = Math.max(start, viewLeft)
  if (endPinned) end = Math.min(end, viewRight - faceW)
  if (start + faceW > end) {
    const overlap = start + faceW - end
    start -= overlap / 2
    end += overlap / 2
  }
  if (hostWidth > 0) {
    const pair = end + faceW - start
    if (pair <= hostWidth) {
      if (start < 0) {
        end -= start
        start = 0
      }
      if (end + faceW > hostWidth) {
        const shift = end + faceW - hostWidth
        start -= shift
        end -= shift
      }
      if (start < 0) start = 0
    } else {
      faceW = hostWidth / 2
      start = 0
      end = faceW
    }
  }
  return { start, end, faceW, startPinned, endPinned }
}

function box(hit: { left: number; right: number }, faceLeft: number, faceW: number): LoopGripBox {
  const hitLeft = round(hit.left)
  const hitRight = round(hit.right)
  const face = round(faceLeft)
  return {
    hitLeft,
    hitWidth: Math.max(0, hitRight - hitLeft),
    faceLeft: face,
    faceWidth: Math.max(0, round(faceLeft + faceW) - face),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function round(value: number) {
  return Math.round(value)
}
