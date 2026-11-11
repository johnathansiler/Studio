/**
 * Blend the end of a loop into its start so the wrap lands on the first sample.
 * `end` is exclusive. The buffer length does not change.
 */
export function crossfadeLoopRegion(channel: Float32Array, start: number, end: number, fade: number) {
  const out = Float32Array.from(channel)
  const from = Math.max(0, Math.min(out.length - 2, Math.floor(start)))
  const to = Math.max(from + 2, Math.min(out.length, Math.floor(end)))
  const width = to - from
  const count = Math.min(Math.max(0, fade | 0), Math.floor(width / 4))
  if (count < 4) return out
  // Arrive at the first loop sample. Mixing in start[0], start[1], … snapped the
  // last step from start[fade-1] to start[0], which is a full seam click.
  const anchor = out[from] || 0
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / count
    const w = 0.5 - 0.5 * Math.cos(Math.PI * t)
    const at = to - count + i
    out[at] = (out[at] || 0) * (1 - w) + anchor * w
  }
  return out
}
