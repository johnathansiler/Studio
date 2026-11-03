/** Visible width of a loop-edge cap. The touch target is separate and larger. */
export const LOOP_GRIP_VISUAL = 12
/** Minimum invisible hit width. Phones and foldables use the coarser size. */
export const LOOP_GRIP_HIT = 40
export const LOOP_GRIP_HIT_COARSE = 44

export function loopGripHit(coarse: boolean) {
  return coarse ? LOOP_GRIP_HIT_COARSE : LOOP_GRIP_HIT
}

export interface LoopGripBox {
  hitLeft: number
  hitWidth: number
  faceLeft: number
  faceWidth: number
}

type Range = [number, number]

/**
 * Slim caps on the loop edges, with invisible hit pads of at least 40px.
 * Extra pad extends outward (past the loop) so the label stays easy to read.
 * A loop that starts at the ruler edge has no outward room, so that pad
 * grows inward instead. Pads never overlap the label or each other.
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
  const blocks: Range[] = []
  if (input.labelWidth > 0) {
    const half = input.labelWidth / 2
    blocks.push([input.labelCenter - half, input.labelCenter + half])
  }
  const startHit = placeHit('start', faces.start, faces.faceW, hit, blocks, hostWidth, viewLeft, viewRight, faces.startPinned)
  const endBlocks: Range[] = [...blocks, [startHit.left, startHit.right], [faces.start, faces.start + faces.faceW]]
  const endHit = placeHit('end', faces.end, faces.faceW, hit, endBlocks, hostWidth, viewLeft, viewRight, faces.endPinned)
  return {
    start: box(startHit, faces.start, faces.faceW),
    end: box(endHit, faces.end, faces.faceW),
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

function placeHit(
  side: 'start' | 'end',
  faceLeft: number,
  faceW: number,
  hit: number,
  blocks: Range[],
  hostWidth: number,
  viewLeft: number,
  viewRight: number,
  pinned: boolean,
) {
  const span = Math.max(hit, faceW)
  const faceRight = faceLeft + faceW
  const pool = [
    ...candidates(side, faceLeft, faceRight, span, blocks, hostWidth, viewLeft, viewRight, pinned, false),
    ...candidates(side, faceLeft, faceRight, span, blocks, hostWidth, viewLeft, viewRight, pinned, true),
  ]
  if (pool.length) return best(pool, side, faceLeft, faceRight, hostWidth, viewLeft, viewRight, pinned)
  return partial(side, faceLeft, faceRight, blocks, hostWidth)
}

function candidates(
  side: 'start' | 'end',
  faceLeft: number,
  faceRight: number,
  span: number,
  blocks: Range[],
  hostWidth: number,
  viewLeft: number,
  viewRight: number,
  pinned: boolean,
  allowOutside: boolean,
) {
  const raw = [side === 'start' ? faceRight - span : faceLeft, side === 'start' ? faceLeft : faceRight - span]
  for (const [a, b] of blocks) {
    raw.push(a - span)
    raw.push(b)
  }
  if (pinned && viewRight > viewLeft) {
    raw.push(viewLeft)
    raw.push(viewRight - span)
  }
  const limitL = hostWidth > 0 && !allowOutside ? 0 : Math.min(faceLeft, viewLeft, 0) - span
  const limitR = hostWidth > 0 && !allowOutside ? hostWidth : Math.max(faceRight, viewRight, hostWidth) + span
  let gaps: Range[] = [[limitL, limitR]]
  for (const block of blocks) gaps = subtract(gaps, block)
  for (const [gapL, gapR] of gaps) {
    if (gapR - gapL < span - 0.01) continue
    raw.push(gapL)
    raw.push(gapR - span)
    const anchor = side === 'start' ? faceRight - span : faceLeft
    raw.push(Math.min(gapR - span, Math.max(gapL, anchor)))
  }
  const seen = new Set<number>()
  const out: Range[] = []
  for (const value of raw) {
    if (!Number.isFinite(value)) continue
    let left = value
    if (hostWidth > 0 && !allowOutside) left = clampLeft(left, span, hostWidth)
    const right = left + span
    if (hostWidth > 0 && !allowOutside && (left < -0.01 || right > hostWidth + 0.01)) continue
    if (intersects(left, right, blocks)) continue
    const key = Math.round(left * 10)
    if (seen.has(key)) continue
    seen.add(key)
    out.push([left, right])
  }
  return out
}

function best(
  pool: Range[],
  side: 'start' | 'end',
  faceLeft: number,
  faceRight: number,
  hostWidth: number,
  viewLeft: number,
  viewRight: number,
  pinned: boolean,
) {
  let winner = pool[0]
  let score = rank(winner, side, faceLeft, faceRight, hostWidth, viewLeft, viewRight, pinned)
  for (const box of pool.slice(1)) {
    const next = rank(box, side, faceLeft, faceRight, hostWidth, viewLeft, viewRight, pinned)
    if (next > score) {
      winner = box
      score = next
    }
  }
  return { left: winner[0], right: winner[1] }
}

function rank(
  box: Range,
  side: 'start' | 'end',
  faceLeft: number,
  faceRight: number,
  hostWidth: number,
  viewLeft: number,
  viewRight: number,
  pinned: boolean,
) {
  const [left, right] = box
  const width = right - left
  const faceW = Math.max(1, faceRight - faceLeft)
  const cover = overlapLen(left, right, faceLeft, faceRight)
  const hostL = hostWidth > 0 ? 0 : left
  const hostR = hostWidth > 0 ? hostWidth : right
  const outward = side === 'start'
    ? overlapLen(left, Math.min(right, faceLeft), hostL, hostR)
    : overlapLen(Math.max(left, faceRight), right, hostL, hostR)
  const inward = side === 'start' ? Math.max(0, right - faceRight) : Math.max(0, faceLeft - left)
  let score = (width >= LOOP_GRIP_HIT - 0.01 ? 10000 : 0) + Math.min(width, LOOP_GRIP_HIT) * 10
  score += (cover / faceW) * 2000
  score += outward * 3
  score -= inward
  if (hostWidth > 0) score += overlapLen(left, right, 0, hostWidth) * 4
  if (cover <= 0) score -= Math.abs((left + right) / 2 - (faceLeft + faceRight) / 2) * 5
  if (pinned && viewRight > viewLeft) score += overlapLen(left, right, viewLeft, viewRight) * 30
  return score
}

/** Widest free gap touching the face when a full 40px pad will not fit. */
function partial(side: 'start' | 'end', faceLeft: number, faceRight: number, blocks: Range[], hostWidth: number) {
  const limitL = hostWidth > 0 ? 0 : faceLeft - LOOP_GRIP_HIT
  const limitR = hostWidth > 0 ? hostWidth : faceRight + LOOP_GRIP_HIT
  let gaps: Range[] = [[limitL, limitR]]
  for (const block of blocks) gaps = subtract(gaps, block)
  let pick: Range = [faceLeft, faceLeft]
  let bestDist = Infinity
  for (const gap of gaps) {
    const dist = gap[1] < faceLeft ? faceLeft - gap[1] : gap[0] > faceRight ? gap[0] - faceRight : 0
    const bias = side === 'start' && gap[1] <= faceRight ? -0.1 : side === 'end' && gap[0] >= faceLeft ? -0.1 : 0
    if (dist + bias < bestDist || (dist === bestDist && gap[1] - gap[0] > pick[1] - pick[0])) {
      bestDist = dist + bias
      pick = gap
    }
  }
  return { left: pick[0], right: pick[1] }
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

function clampLeft(left: number, span: number, hostWidth: number) {
  if (span >= hostWidth) return 0
  return Math.min(Math.max(0, left), hostWidth - span)
}

function intersects(left: number, right: number, blocks: Range[]) {
  return blocks.some(([a, b]) => right > a + 0.01 && left < b - 0.01)
}

function overlapLen(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function subtract(gaps: Range[], block: Range): Range[] {
  const [a, b] = block
  const out: Range[] = []
  for (const [left, right] of gaps) {
    if (right <= a || left >= b) {
      out.push([left, right])
      continue
    }
    if (left < a) out.push([left, Math.min(right, a)])
    if (right > b) out.push([Math.max(left, b), right])
  }
  return out.filter(([left, right]) => right - left > 0.01)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function round(value: number) {
  return Math.round(value)
}
