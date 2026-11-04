import { crossingsInRange } from '../audio/zeroCross'
import { peaksForSpan, type PeakPyramid } from '../audio/peakPyramid'
import { showsSampleDots, usesRawSamples, type WaveSpan } from './waveZoom'

export interface WaveOutline {
  min: number
  max: number
}

/**
 * Paint one frame of a waveform into a CSS-pixel context (the caller sets the
 * device-pixel transform). UI thread only.
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  channel: ArrayLike<number> | null | undefined,
  pyramid: PeakPyramid | null,
  span: WaveSpan,
  color: string,
  outline?: WaveOutline[] | null,
) {
  const cssW = Math.max(1, width)
  const cssH = Math.max(1, height)
  ctx.clearRect(0, 0, cssW, cssH)
  const mid = cssH / 2
  ctx.strokeStyle = 'rgba(244, 255, 248, 0.78)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, mid + 0.5)
  ctx.lineTo(cssW, mid + 0.5)
  ctx.stroke()

  const amp = Math.max(1, mid - 3)
  const start = span.start
  const end = Math.max(span.start + 1, span.end)
  const view = end - start

  if (channel && channel.length > 1 && usesRawSamples(view, cssW)) {
    const from = Math.max(0, Math.floor(start))
    const to = Math.min(channel.length - 1, Math.ceil(end))
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    let moved = false
    for (let i = from; i <= to; i++) {
      const x = ((i - start) / view) * cssW
      const y = mid - (channel[i] || 0) * amp
      if (!moved) {
        ctx.moveTo(x, y)
        moved = true
      } else ctx.lineTo(x, y)
    }
    ctx.stroke()
    if (showsSampleDots(view, cssW)) {
      ctx.fillStyle = color
      const radius = Math.min(4, Math.max(1.6, (cssW / view) * 0.18))
      for (let i = from; i <= to; i++) {
        const x = ((i - start) / view) * cssW
        const y = mid - (channel[i] || 0) * amp
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    paintTicks(ctx, channel, start, end, cssW, cssH)
    return
  }

  const bars = channel && pyramid
    ? peaksForSpan(pyramid, start, end, Math.max(1, Math.floor(cssW)))
    : outlineBars(outline, start, end, channel?.length ?? outline?.length ?? 1, Math.max(1, Math.floor(cssW)))
  ctx.fillStyle = color
  const column = cssW / Math.max(1, bars.length)
  bars.forEach((bar, index) => {
    const top = mid - bar.max * amp
    const bottom = mid - bar.min * amp
    ctx.fillRect(index * column, top, Math.max(1, column), Math.max(1, bottom - top))
  })
  if (channel && view <= 16000) paintTicks(ctx, channel, start, end, cssW, cssH)
}

function paintTicks(ctx: CanvasRenderingContext2D, channel: ArrayLike<number>, start: number, end: number, width: number, height: number) {
  const hits = crossingsInRange(channel, start, end)
  if (hits.length < 2 || hits.length > width) return
  const view = Math.max(1, end - start)
  ctx.strokeStyle = 'rgba(224, 177, 90, 0.95)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const hit of hits) {
    const x = ((hit.at - start) / view) * width
    ctx.moveTo(x, 0)
    ctx.lineTo(x, 7)
    ctx.moveTo(x, height)
    ctx.lineTo(x, height - 7)
  }
  ctx.stroke()
}

function outlineBars(outline: WaveOutline[] | null | undefined, start: number, end: number, length: number, columns: number) {
  if (!outline?.length) return []
  const span = Math.max(1, length)
  const from = Math.max(0, start / span)
  const to = Math.min(1, end / span)
  const bars: WaveOutline[] = []
  for (let column = 0; column < columns; column++) {
    const t = from + ((column + 0.5) / columns) * (to - from)
    const index = Math.min(outline.length - 1, Math.max(0, Math.floor(t * outline.length)))
    bars.push(outline[index] || { min: 0, max: 0 })
  }
  return bars
}
