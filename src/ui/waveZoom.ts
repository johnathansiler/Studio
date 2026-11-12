/** Sample window inside a waveform. `end` is exclusive. */

export interface WaveSpan {
  start: number
  end: number
}

/** Fewest samples on screen, so a pinch can reach single samples. */
export const MIN_WAVE_SPAN = 4

export function fitSpan(span: WaveSpan): WaveSpan {
  const start = Math.min(span.start, span.end)
  const end = Math.max(span.end, start + 1)
  return { start, end }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Zoom around `anchor` (a sample). Factor above 1 zooms in.
 * The result stays inside `limit` and never shrinks below a few samples.
 */
export function zoomSpan(span: WaveSpan, limit: WaveSpan, factor: number, anchor: number): WaveSpan {
  const bounds = fitSpan(limit)
  const current = fitSpan(span)
  const width = Math.max(1, current.end - current.start)
  const room = Math.max(1, bounds.end - bounds.start)
  const next = clamp(width / Math.max(0.05, factor), Math.min(MIN_WAVE_SPAN, room), room)
  const t = clamp((anchor - current.start) / width, 0, 1)
  let start = anchor - t * next
  let end = start + next
  if (start < bounds.start) {
    end += bounds.start - start
    start = bounds.start
  }
  if (end > bounds.end) {
    start -= end - bounds.end
    end = bounds.end
  }
  start = Math.max(bounds.start, start)
  end = Math.min(bounds.end, Math.max(start + Math.min(MIN_WAVE_SPAN, room), end))
  return { start, end }
}

/** Slide a window without changing its length or leaving `limit`. */
export function panSpan(span: WaveSpan, limit: WaveSpan, delta: number): WaveSpan {
  const bounds = fitSpan(limit)
  const current = fitSpan(span)
  const width = Math.min(bounds.end - bounds.start, current.end - current.start)
  let start = current.start + delta
  if (start < bounds.start) start = bounds.start
  if (start + width > bounds.end) start = Math.max(bounds.start, bounds.end - width)
  return { start, end: start + width }
}

export function sampleAtX(span: WaveSpan, x: number, width: number) {
  const view = fitSpan(span)
  const t = x / Math.max(1, width)
  return view.start + t * (view.end - view.start)
}

/**
 * Draw the samples themselves when a column is finer than one peak bin.
 * A coarser bin would hide the wave shape. The visible span stays small
 * enough to scan on the UI thread.
 */
export function usesRawSamples(span: number, width: number, leaf = 64) {
  return span <= Math.max(leaf, width * leaf)
}

/** Dots when each sample has room to sit apart from its neighbors. */
export function showsSampleDots(span: number, width: number) {
  return width / Math.max(1, span) >= 3
}
