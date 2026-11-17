/** Timeline pixels for a sample. Fractional on purpose, so the line does not step by whole pixels. */
export function playheadPx(sample: number, sampleRate: number, pxPerSecond: number) {
  if (!(sampleRate > 0) || !Number.isFinite(sample) || !Number.isFinite(pxPerSecond)) return 0
  return (sample / sampleRate) * pxPerSecond
}

export function playheadTransform(px: number) {
  return `translateX(${px}px)`
}

/**
 * The seek target is the on-screen ruler strip.
 * A long arrangement can be thousands of pixels wide; the hit target is only the visible slice.
 */
export function playheadStripWidth(viewWidth: number, timelineWidth = viewWidth) {
  if (!(viewWidth > 0)) return 0
  const view = viewWidth
  if (!(timelineWidth > 0)) return view
  return Math.min(view, timelineWidth)
}

/** Content x under a finger on the visible strip. `viewLeft` is the strip's screen left. */
export function playheadContentX(clientX: number, viewLeft: number, scrollLeft: number) {
  return scrollLeft + (clientX - viewLeft)
}

/**
 * Move a playhead from the audio clock without rendering React.
 * The caller writes this from the shared animation frame. The transform is the
 * sample on that frame, so a tempo change, loop wrap, seek, pause, or a gap
 * while the tab was hidden lands on the audio clock. A linear compositor
 * animation keeps running through those discontinuities.
 */
export function placePlayhead(
  node: { style: { transform: string } },
  sample: number,
  sampleRate: number,
  pxPerSecond: number,
) {
  const px = playheadPx(sample, sampleRate, pxPerSecond)
  const transform = playheadTransform(px)
  if (node.style.transform !== transform) node.style.transform = transform
  return px
}
