import { buildPeakPyramid, type PeakPyramid } from '../peakPyramid'
import type { AudioClip, WaveEdit, WaveRegion } from '../../model/types'

export interface WaveOutline {
  min: number
  max: number
}
import {
  bodyLength,
  clipHasWaveBody,
  dbToGain,
  fadeCurve,
  joinFadeSamples,
  regionPlaySample,
} from './edit'

export interface RenderOpts {
  /** Bake clip-edge fades into the samples. */
  fades?: boolean
  /** Bake clip gain into the samples. */
  clipGain?: boolean
}

interface Span {
  region: WaveRegion
  start: number
}

function spansOf(edit: WaveEdit): Span[] {
  const out: Span[] = []
  let cursor = 0
  for (const region of edit.regions) {
    const length = Math.max(0, Math.round(region.length))
    if (length < 1) continue
    out.push({ region, start: cursor })
    cursor += length
  }
  return out
}

function spanAt(spans: Span[], index: number): Span | null {
  for (const span of spans) {
    if (index >= span.start && index < span.start + span.region.length) return span
  }
  return spans[spans.length - 1] ?? null
}

/**
 * Render audible clip samples `[start, end)` for every channel.
 * `start` and `end` are body indexes. Edge fades and clip gain are optional
 * so the transport can apply them on the gain node instead.
 */
export function renderWaveRange(
  channels: ArrayLike<number>[],
  edit: WaveEdit,
  start: number,
  end: number,
  opts: RenderOpts = {},
): Float32Array[] {
  const spans = spansOf(edit)
  const body = spans.length ? spans[spans.length - 1].start + spans[spans.length - 1].region.length : 0
  const from = Math.max(0, Math.floor(start))
  const to = Math.max(from, Math.ceil(Math.min(body, end)))
  const count = Math.max(0, to - from)
  const gain = opts.clipGain ? dbToGain(edit.gainDb) : 1
  const out = (channels.length ? channels : [new Float32Array(0)]).map(() => new Float32Array(count))
  if (!count || !spans.length) return out

  for (let index = 0; index < count; index++) {
    const at = from + index
    const span = spanAt(spans, at)
    if (!span) continue
    const local = at - span.start
    for (let channel = 0; channel < out.length; channel++) {
      const source = channels[Math.min(channel, channels.length - 1)]
      out[channel][index] = source ? regionPlaySample(source, span.region, local) : 0
    }
  }

  for (let index = 0; index < spans.length - 1; index++) {
    const left = spans[index]
    const right = spans[index + 1]
    const fade = joinFadeSamples(edit, left.region, right.region)
    if (fade < 2) continue
    const boundary = right.start
    for (let step = 0; step < fade; step++) {
      const outGain = fadeCurve((fade - step) / fade, 'equal')
      const inGain = fadeCurve((step + 1) / fade, 'equal')
      const leftAt = boundary - fade + step
      const rightAt = boundary + step
      if (leftAt >= from && leftAt < to) {
        const slot = leftAt - from
        for (const channel of out) channel[slot] *= outGain
      }
      if (rightAt >= from && rightAt < to) {
        const slot = rightAt - from
        for (const channel of out) channel[slot] *= inGain
      }
    }
  }

  if (opts.fades && body > 1) {
    const fadeIn = Math.min(body, Math.max(0, edit.fadeIn))
    const fadeOut = Math.min(body, Math.max(0, edit.fadeOut))
    for (let index = 0; index < count; index++) {
      const at = from + index
      let edge = 1
      if (fadeIn > 0 && at < fadeIn) edge *= fadeCurve(at / fadeIn, edit.fadeInShape)
      const remain = body - 1 - at
      if (fadeOut > 0 && remain < fadeOut) edge *= fadeCurve(remain / Math.max(1, fadeOut), edit.fadeOutShape)
      if (edge === 1) continue
      for (const channel of out) channel[index] *= edge
    }
  }

  if (gain !== 1) {
    for (const channel of out) {
      for (let index = 0; index < channel.length; index++) channel[index] *= gain
    }
  }
  return out
}

const bodyCache = new Map<string, Float32Array[]>()

function bodyCacheKey(clip: AudioClip, channels: ArrayLike<number>[]): string {
  const wave = clip.wave
  return `${clip.bufferId}:${channels[0]?.length ?? 0}:${wave ? JSON.stringify({ regions: wave.regions, crossfade: wave.crossfade }) : ''}`
}

/** Full audible body, without clip-edge fades or clip gain. Cached for stretch and session playback. */
export function cachedWaveBody(channels: ArrayLike<number>[], clip: AudioClip): Float32Array[] | null {
  if (!clip.wave || !clipHasWaveBody(clip)) return null
  const key = bodyCacheKey(clip, channels)
  const hit = bodyCache.get(key)
  if (hit) return hit
  const rendered = renderWaveRange(channels, clip.wave, 0, bodyLength(clip.wave))
  if (bodyCache.size > 2) {
    const oldest = bodyCache.keys().next().value
    if (oldest) bodyCache.delete(oldest)
  }
  bodyCache.set(key, rendered)
  return rendered
}

const pyramids = new WeakMap<ArrayLike<number>, PeakPyramid>()

export function pyramidFor(channel: ArrayLike<number>): PeakPyramid {
  let found = pyramids.get(channel)
  if (!found) {
    found = buildPeakPyramid(channel)
    pyramids.set(channel, found)
  }
  return found
}

function peakOfRange(pyramid: PeakPyramid, start: number, end: number): { min: number; max: number } {
  if (!pyramid.levels.length || end <= start) return { min: 0, max: 0 }
  const span = Math.max(1, end - start)
  let level = pyramid.levels[0]
  for (const candidate of pyramid.levels) {
    if (candidate.leaf <= span) level = candidate
    else break
  }
  const bin0 = Math.max(0, Math.floor(Math.max(0, start) / level.leaf))
  const bin1 = Math.min(level.min.length, Math.max(bin0 + 1, Math.ceil(end / level.leaf)))
  let min = 0
  let max = 0
  for (let bin = bin0; bin < bin1; bin++) {
    if (level.min[bin] < min) min = level.min[bin]
    if (level.max[bin] > max) max = level.max[bin]
  }
  return { min, max }
}

function regionSlicePeak(pyramid: PeakPyramid | undefined, region: WaveRegion, localStart: number, localEnd: number): { min: number; max: number } {
  if (region.silence || !pyramid || localEnd <= localStart) return { min: 0, max: 0 }
  const gain = region.gain ?? 1
  const from = region.reverse ? region.source + region.length - localEnd : region.source + localStart
  const to = region.reverse ? region.source + region.length - localStart : region.source + localEnd
  const peak = peakOfRange(pyramid, from, to)
  return { min: peak.min * gain, max: peak.max * gain }
}

const outlineCache = new Map<string, WaveOutline[]>()

/** Arrange-view peaks for a clip whose audible audio is no longer one window. */
export function arrangeOutline(channels: ArrayLike<number>[] | undefined, clip: AudioClip): WaveOutline[] | null {
  if (!channels?.length || !clip.wave || !clipHasWaveBody(clip)) return null
  const key = `${clip.bufferId}:${clip.gain}:${bodyCacheKey(clip, channels)}`
  const hit = outlineCache.get(key)
  if (hit) return hit
  const edit = clip.wave
  const body = Math.max(1, bodyLength(edit))
  const columns = 2048
  const built = channels.map((channel) => pyramidFor(channel))
  const gain = clip.gain
  const bars: WaveOutline[] = []
  const spans = spansOf(edit)
  for (let column = 0; column < columns; column++) {
    const a = (column / columns) * body
    const b = ((column + 1) / columns) * body
    let min = 0
    let max = 0
      for (const span of spans) {
        const start = span.start
        const end = start + span.region.length
        const overlap0 = Math.max(a, start)
        const overlap1 = Math.min(b, end)
        if (overlap1 <= overlap0) continue
        for (const pyramid of built) {
          const peak = regionSlicePeak(pyramid, span.region, overlap0 - start, overlap1 - start)
          if (peak.min < min) min = peak.min
          if (peak.max > max) max = peak.max
        }
      }
    bars.push({ min: min * gain, max: max * gain })
  }
  if (outlineCache.size > 8) {
    const oldest = outlineCache.keys().next().value
    if (oldest) outlineCache.delete(oldest)
  }
  outlineCache.set(key, bars)
  return bars
}

export interface DisplayColumn {
  min: number
  max: number
  dim: boolean
}

function sourceIndex(edit: WaveEdit, displayIndex: number, body: number): number | null {
  if (displayIndex < edit.head) return edit.origin + displayIndex
  if (displayIndex >= edit.head + body) return edit.tailAt + (displayIndex - edit.head - body)
  return null
}

/** Overview peaks for the editor, including the dimmed head and tail. */
export function displayColumns(
  channels: ArrayLike<number>[],
  edit: WaveEdit,
  start: number,
  end: number,
  columns: number,
): DisplayColumn[][] {
  const count = Math.max(1, columns)
  const body = bodyLength(edit)
  const built = channels.map((channel) => pyramidFor(channel))
  const spans = spansOf(edit)
  const gain = dbToGain(edit.gainDb)
  return built.map((pyramid, channelIndex) => {
    const channel = channels[channelIndex]
    const bars: DisplayColumn[] = []
    for (let column = 0; column < count; column++) {
      const a = start + (column / count) * (end - start)
      const b = start + ((column + 1) / count) * (end - start)
      const mid = (a + b) / 2
      const file = sourceIndex(edit, mid, body)
      if (file != null) {
        const peak = channel ? peakOfRange(pyramid, file, file + Math.max(1, b - a)) : { min: 0, max: 0 }
        bars.push({ min: peak.min, max: peak.max, dim: true })
        continue
      }
      let min = 0
      let max = 0
      const bodyA = a - edit.head
      const bodyB = b - edit.head
      for (const span of spans) {
        const spanEnd = span.start + span.region.length
        const overlap0 = Math.max(bodyA, span.start)
        const overlap1 = Math.min(bodyB, spanEnd)
        if (overlap1 <= overlap0) continue
        const peak = regionSlicePeak(pyramid, span.region, overlap0 - span.start, overlap1 - span.start)
        if (peak.min < min) min = peak.min
        if (peak.max > max) max = peak.max
      }
      const at = Math.max(0, Math.min(body - 1, mid - edit.head))
      let edge = gain
      if (edit.fadeIn > 0 && at < edit.fadeIn) edge *= fadeCurve(at / edit.fadeIn, edit.fadeInShape)
      const remain = body - 1 - at
      if (edit.fadeOut > 0 && remain < edit.fadeOut) edge *= fadeCurve(remain / Math.max(1, edit.fadeOut), edit.fadeOutShape)
      bars.push({ min: min * edge, max: max * edge, dim: false })
    }
    return bars
  })
}

/**
 * Exact samples for a display window. Used when the editor is zoomed in far
 * enough that a peak bin would hide the wave.
 */
export function displaySamples(
  channels: ArrayLike<number>[],
  edit: WaveEdit,
  start: number,
  end: number,
): Float32Array[] {
  const from = Math.floor(start)
  const to = Math.ceil(end)
  const count = Math.max(0, to - from)
  const body = bodyLength(edit)
  const bodyFrom = Math.max(0, from - edit.head)
  const bodyTo = Math.min(body, Math.max(0, to - edit.head))
  const rendered = bodyTo > bodyFrom
    ? renderWaveRange(channels, edit, bodyFrom, bodyTo, { fades: true, clipGain: true })
    : channels.map(() => new Float32Array(0))
  return channels.map((channel, channelIndex) => {
    const out = new Float32Array(count)
    const bodyChannel = rendered[Math.min(channelIndex, rendered.length - 1)]
    for (let index = 0; index < count; index++) {
      const display = from + index
      const file = sourceIndex(edit, display, body)
      if (file != null) {
        out[index] = file >= 0 && file < channel.length ? channel[file] || 0 : 0
        continue
      }
      const slot = display - edit.head - bodyFrom
      out[index] = bodyChannel && slot >= 0 && slot < bodyChannel.length ? bodyChannel[slot] : 0
    }
    return out
  })
}
