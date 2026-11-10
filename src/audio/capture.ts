export interface TimedChunk {
  frame: number
  left: Float32Array
  right: Float32Array | null
}

/**
 * Place recorder blocks on the timeline.
 * A gap stays silent instead of being glued to the next block, which used to click.
 * An overlap crossfades so a late block does not step.
 */
export function assembleTimedChunks(chunks: TimedChunk[]): { left: Float32Array; right: Float32Array | null } | null {
  if (!chunks.length) return null
  const ordered = chunks.slice().sort((a, b) => a.frame - b.frame)
  const origin = ordered[0].frame
  let end = origin
  for (const chunk of ordered) end = Math.max(end, chunk.frame + chunk.left.length)
  const length = Math.max(1, end - origin)
  const left = new Float32Array(length)
  const hasRight = ordered.some((chunk) => chunk.right)
  const right = hasRight ? new Float32Array(length) : null
  let filled = 0
  for (const chunk of ordered) {
    const at = Math.max(0, chunk.frame - origin)
    const count = Math.min(chunk.left.length, length - at)
    if (count <= 0) continue
    const overlap = Math.max(0, filled - at)
    const fade = Math.min(64, overlap, count)
    for (let i = 0; i < count; i++) {
      const dst = at + i
      const sample = chunk.left[i] || 0
      if (i < fade) {
        const gain = (i + 1) / fade
        left[dst] = left[dst] * (1 - gain) + sample * gain
        if (right && chunk.right) right[dst] = right[dst] * (1 - gain) + (chunk.right[i] || 0) * gain
      } else {
        left[dst] = sample
        if (right) right[dst] = chunk.right ? chunk.right[i] || 0 : 0
      }
    }
    filled = Math.max(filled, at + count)
  }
  return { left, right }
}
