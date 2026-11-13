/** Timeline pixels for a sample. Fractional on purpose, so the line does not step by whole pixels. */
export function playheadPx(sample: number, sampleRate: number, pxPerSecond: number) {
  if (!(sampleRate > 0) || !Number.isFinite(sample) || !Number.isFinite(pxPerSecond)) return 0
  return (sample / sampleRate) * pxPerSecond
}

export function playheadTransform(px: number) {
  return `translateX(${px}px)`
}

/** Move a playhead element from the audio clock without rendering React. */
export function placePlayhead(
  node: { style: { transform: string } },
  sample: number,
  sampleRate: number,
  pxPerSecond: number,
) {
  const px = playheadPx(sample, sampleRate, pxPerSecond)
  node.style.transform = playheadTransform(px)
  return px
}
