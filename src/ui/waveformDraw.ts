import { crossingsInRange } from '../audio/zeroCross'
import { buildPeakPyramid, peaksForSpan, type PeakPyramid } from '../audio/peakPyramid'
import { showsSampleDots, usesRawSamples, type WaveSpan } from './waveZoom'

export interface WaveOutline {
  min: number
  max: number
}

/** Phone screens are often 3x. Past that, extra pixels cost more than they sharpen. */
export const WAVE_DPR_CAP = 3

/** One peak column per device pixel, so a high-DPI clip is not a stack of CSS-pixel blocks. */
export function waveColumns(cssWidth: number, dpr = 1) {
  const scale = Math.min(WAVE_DPR_CAP, Math.max(1, Number.isFinite(dpr) && dpr > 0 ? dpr : 1))
  return Math.max(1, Math.floor(Math.max(1, cssWidth) * scale))
}

export interface EnvelopePoint {
  x: number
  y: number
}

/**
 * Vertices of the filled envelope. Each column's min and max stay on that column.
 * The path only connects those measured peaks. It does not add peaks between them.
 */
export function envelopeVertices(
  bars: readonly WaveOutline[],
  width: number,
  height: number,
): { top: EnvelopePoint[]; bottom: EnvelopePoint[] } {
  const cssW = Math.max(1, width)
  const cssH = Math.max(1, height)
  const mid = cssH / 2
  const amp = Math.max(1, mid - 3)
  const count = Math.max(1, bars.length)
  const column = cssW / count
  const top: EnvelopePoint[] = []
  const bottom: EnvelopePoint[] = []
  for (let index = 0; index < count; index++) {
    const bar = bars[index] || { min: 0, max: 0 }
    const x = (index + 0.5) * column
    top.push({ x, y: mid - bar.max * amp })
    bottom.push({ x, y: mid - bar.min * amp })
  }
  return { top, bottom }
}

export interface WaveDrawOptions {
  /** When false, paint over whatever is already in the canvas. */
  clear?: boolean
  /** Scales the envelope. 1 is unity. */
  gain?: number
  /** Flat color behind the center line. */
  background?: string
  /** Mirror the wave left-to-right. Sample 0 of the span lands on the right. */
  flipX?: boolean
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
  options?: WaveDrawOptions,
) {
  const cssW = Math.max(1, width)
  const cssH = Math.max(1, height)
  const gain = Number.isFinite(options?.gain) ? options!.gain! : 1
  const clear = options?.clear !== false
  if (options?.flipX) {
    ctx.translate(cssW, 0)
    ctx.scale(-1, 1)
  }
  if (clear) {
    ctx.clearRect(0, 0, cssW, cssH)
    if (options?.background) {
      ctx.fillStyle = options.background
      ctx.fillRect(0, 0, cssW, cssH)
    }
    const midLine = cssH / 2
    ctx.strokeStyle = 'rgba(244, 255, 248, 0.78)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, midLine + 0.5)
    ctx.lineTo(cssW, midLine + 0.5)
    ctx.stroke()
  }

  const mid = cssH / 2
  const amp = Math.max(1, mid - 3)
  const start = span.start
  const end = Math.max(span.start + 1, span.end)
  const view = end - start

  if (channel && channel.length > 1 && usesRawSamples(view, cssW)) {
    const from = Math.max(0, Math.floor(start))
    const to = Math.min(channel.length - 1, Math.ceil(end))
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    let moved = false
    for (let i = from; i <= to; i++) {
      const x = ((i - start) / view) * cssW
      const y = mid - (channel[i] || 0) * gain * amp
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
        const y = mid - (channel[i] || 0) * gain * amp
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    paintTicks(ctx, channel, start, end, cssW, cssH)
    return
  }

  let dpr = 1
  try { dpr = ctx.getTransform().a } catch { dpr = 1 }
  const columns = waveColumns(cssW, dpr)
  const bars = channel && pyramid
    ? peaksForSpan(pyramid, start, end, columns)
    : outlineColumns(outline, start, end, channel?.length ?? outline?.length ?? 1, columns)
  paintEnvelope(ctx, gain === 1 ? bars : bars.map((bar) => ({ min: bar.min * gain, max: bar.max * gain })), cssW, cssH, color)
  if (channel && view <= 16000) paintTicks(ctx, channel, start, end, cssW, cssH)
}

function paintEnvelope(
  ctx: CanvasRenderingContext2D,
  bars: readonly WaveOutline[],
  cssW: number,
  cssH: number,
  color: string,
) {
  if (!bars.length) return
  const { top, bottom } = envelopeVertices(bars, cssW, cssH)
  ctx.beginPath()
  ctx.moveTo(top[0].x, top[0].y)
  for (let index = 1; index < top.length; index++) ctx.lineTo(top[index].x, top[index].y)
  for (let index = bottom.length - 1; index >= 0; index--) ctx.lineTo(bottom[index].x, bottom[index].y)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.stroke()
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

/** Min/max of every outline bin a column covers, so a transient is not skipped by nearest-neighbor. */
export function outlineColumns(
  outline: WaveOutline[] | null | undefined,
  start: number,
  end: number,
  length: number,
  columns: number,
) {
  if (!outline?.length) return []
  const span = Math.max(1, length)
  const from = Math.max(0, start / span)
  const to = Math.min(1, end / span)
  const bars: WaveOutline[] = []
  const count = Math.max(1, columns)
  for (let column = 0; column < count; column++) {
    const a = from + (column / count) * (to - from)
    const b = from + ((column + 1) / count) * (to - from)
    const first = Math.max(0, Math.min(outline.length - 1, Math.floor(a * outline.length)))
    const last = Math.max(first + 1, Math.min(outline.length, Math.ceil(b * outline.length)))
    let lo = 0
    let hi = 0
    for (let index = first; index < last; index++) {
      const bin = outline[index]
      if (!bin) continue
      if (bin.min < lo) lo = bin.min
      if (bin.max > hi) hi = bin.max
    }
    bars.push({ min: lo, max: hi })
  }
  return bars
}

/** Absolute peaks from older project rows become a symmetric min/max outline. */
export function peakOutline(peaks: readonly (number | WaveOutline)[] | null | undefined): WaveOutline[] {
  if (!peaks?.length) return []
  return peaks.map((peak) => {
    if (typeof peak === 'number') {
      const amp = Math.abs(peak)
      return { min: -amp, max: amp }
    }
    return { min: peak?.min || 0, max: peak?.max || 0 }
  })
}

/**
 * Size a canvas for the device pixel ratio and paint with `drawWaveform`.
 * This is the only canvas entry point for waveforms.
 */
export function paintWaveCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  channel: ArrayLike<number> | null | undefined,
  color: string,
  span: WaveSpan,
  extras?: {
    outline?: WaveOutline[] | null
    pyramid?: PeakPyramid | null
    clear?: boolean
    gain?: number
    background?: string
    flipX?: boolean
    dpr?: number
  },
) {
  const cssW = Math.max(1, cssWidth)
  const cssH = Math.max(1, cssHeight)
  const dpr = Math.min(WAVE_DPR_CAP, Math.max(1, extras?.dpr && extras.dpr > 0 ? extras.dpr : 1))
  const pxW = Math.max(1, Math.floor(cssW * dpr))
  const pxH = Math.max(1, Math.floor(cssH * dpr))
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW
    canvas.height = pxH
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  canvas.dataset.waveformDraw = 'shared'
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const length = channel?.length ?? extras?.outline?.length ?? 1
  const view = { start: span.start, end: Math.max(span.start + 1, span.end || length) }
  let pyramid = extras?.pyramid ?? null
  if (!pyramid && channel && channel.length > 1 && !usesRawSamples(view.end - view.start, cssW)) {
    pyramid = buildPeakPyramid(channel)
  }
  ctx.save()
  drawWaveform(ctx, cssW, cssH, channel, pyramid, view, color, extras?.outline, {
    clear: extras?.clear !== false,
    gain: extras?.gain,
    background: extras?.background,
    flipX: extras?.flipX,
  })
  ctx.restore()
  return pyramid
}
