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
  for (let i = 0; i < count; i++) {
    const gain = (i + 1) / count
    const at = to - count + i
    const head = out[from + ((i + 1) % count)] || 0
    out[at] = (out[at] || 0) * (1 - gain) + head * gain
  }
  return out
}
