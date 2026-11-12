import { uid, type AudioClip, type FadeShape, type WaveEdit, type WaveRegion } from '../../model/types'

export type { FadeShape, WaveEdit, WaveRegion }

/** Always applied at a discontinuous join so a cut does not click. About 1 ms at 48 kHz. */
export const DECLICK_SAMPLES = 48

const SHAPES: readonly FadeShape[] = ['linear', 'equal', 's', 'log']

export function sourceLen(clip: { durationSamples: number; stretch?: { sourceSamples?: number } | null }): number {
  const stored = clip.stretch?.sourceSamples
  if (stored && stored > 0) return stored
  return Math.max(1, clip.durationSamples)
}

export function gainToDb(gain: number): number {
  const safe = Math.max(1e-5, Number.isFinite(gain) ? gain : 1)
  return 20 * Math.log10(safe)
}

export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1
  return 10 ** (db / 20)
}

export function fadeShape(value: unknown): FadeShape {
  return SHAPES.includes(value as FadeShape) ? (value as FadeShape) : 'linear'
}

/** 0 at the start of a fade-in, 1 at the end. Fade-out uses the same curve on the way down. */
export function fadeCurve(amount: number, shape: FadeShape = 'linear'): number {
  const t = Math.min(1, Math.max(0, amount))
  if (shape === 'equal') return Math.sin(t * Math.PI / 2)
  if (shape === 's') return 0.5 - 0.5 * Math.cos(Math.PI * t)
  if (shape === 'log') return t * t
  return t
}

/** True when playback cannot be a single forward window into the buffer. */
export function isStructural(edit: WaveEdit | null | undefined): boolean {
  if (!edit?.regions.length) return false
  if (edit.regions.length !== 1) return true
  const region = edit.regions[0]
  if (!region || region.silence || region.reverse) return true
  if (region.gain != null && Math.abs(region.gain - 1) > 1e-3) return true
  return false
}

export function clipHasWaveBody(clip: { wave?: WaveEdit | null }): boolean {
  return isStructural(clip.wave)
}

export function bodyLength(edit: WaveEdit): number {
  let total = 0
  for (const region of edit.regions) total += Math.max(0, Math.round(region.length))
  return total
}

export function displayLength(edit: WaveEdit): number {
  return Math.max(1, Math.round(edit.head) + bodyLength(edit) + Math.round(edit.tail))
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

function cleanRegion(region: WaveRegion): WaveRegion | null {
  const length = Math.max(0, Math.round(region.length))
  if (length < 1) return null
  return {
    id: region.id || uid('reg'),
    source: Math.max(0, Math.round(region.source || 0)),
    length,
    reverse: region.reverse === true,
    gain: Number.isFinite(region.gain) ? (region.gain as number) : 1,
    silence: region.silence === true,
  }
}

export function normalizeEdit(edit: WaveEdit, sourceLength = 0): WaveEdit {
  const limit = sourceLength > 0 ? sourceLength : 0
  let origin = Math.max(0, Math.round(edit.origin || 0))
  let head = Math.max(0, Math.round(edit.head || 0))
  let tailAt = Math.max(0, Math.round(edit.tailAt || 0))
  let tail = Math.max(0, Math.round(edit.tail || 0))
  if (limit > 0) {
    origin = Math.min(origin, limit)
    head = Math.min(head, Math.max(0, limit - origin))
    tailAt = Math.min(Math.max(0, tailAt), limit)
    tail = Math.min(tail, Math.max(0, limit - tailAt))
  }
  const regions = (edit.regions || []).map(cleanRegion).filter((region): region is WaveRegion => region != null)
  const body = regions.reduce((sum, region) => sum + region.length, 0)
  return {
    origin,
    head,
    tailAt,
    tail,
    regions,
    fadeIn: clamp(Math.round(edit.fadeIn || 0), 0, body),
    fadeOut: clamp(Math.round(edit.fadeOut || 0), 0, body),
    fadeInShape: fadeShape(edit.fadeInShape),
    fadeOutShape: fadeShape(edit.fadeOutShape),
    gainDb: clamp(Number.isFinite(edit.gainDb) ? edit.gainDb : 0, -48, 24),
    crossfade: Math.max(0, Math.round(edit.crossfade || 0)),
  }
}

/** The editor document for a clip. A plain clip is a window into the file, with the unused ends dimmed. */
export function documentFromClip(clip: AudioClip, sourceLength: number): WaveEdit {
  const audible = sourceLen(clip)
  const file = Math.max(audible, sourceLength || audible)
  const offset = clamp(Math.round(clip.offsetSamples || 0), 0, file)
  const room = Math.max(0, file - offset)
  const length = Math.max(1, Math.min(audible, room || audible))
  const ratio = clip.durationSamples / Math.max(1, audible)
  const stored = clip.wave
  const fades = {
    fadeIn: Math.round((clip.fadeInSamples || 0) / ratio),
    fadeOut: Math.round((clip.fadeOutSamples || 0) / ratio),
    fadeInShape: fadeShape(stored?.fadeInShape),
    fadeOutShape: fadeShape(stored?.fadeOutShape),
    gainDb: gainToDb(clip.gain),
    crossfade: Math.max(0, Math.round(stored?.crossfade || 0)),
  }
  if (stored && isStructural(stored)) {
    return normalizeEdit({ ...stored, ...fades }, file)
  }
  return normalizeEdit({
    origin: 0,
    head: offset,
    tailAt: Math.min(file, offset + length),
    tail: Math.max(0, file - offset - length),
    regions: [{
      id: stored?.regions?.[0]?.id || 'body',
      source: offset,
      length,
      reverse: false,
      gain: 1,
      silence: false,
    }],
    ...fades,
  }, file)
}

function keepWave(edit: WaveEdit): boolean {
  return isStructural(edit)
    || edit.fadeInShape !== 'linear'
    || edit.fadeOutShape !== 'linear'
    || edit.crossfade > 0
}

/**
 * Write an editor document back onto the clip.
 * Trim of the start keeps the audio that remains on the same timeline sample.
 */
export function applyEditToClip(clip: AudioClip, edit: WaveEdit, sourceLength = 0): AudioClip {
  const file = sourceLength > 0 ? sourceLength : Math.max(sourceLen(clip), edit.head + bodyLength(edit) + edit.tail)
  const before = documentFromClip(clip, file)
  const next = normalizeEdit(edit, file)
  const oldBody = Math.max(1, bodyLength(before))
  const newBody = bodyLength(next)
  if (newBody < 1) {
    return { ...clip, durationSamples: 0, wave: next }
  }
  const ratio = clip.durationSamples / oldBody
  const structural = isStructural(next)
  const timeline = Math.max(1, Math.round(newBody * ratio))
  const headShift = next.head - before.head
  const startSample = Math.max(0, Math.round(clip.startSample + headShift * ratio))
  const region = next.regions[0]
  const offset = structural ? clip.offsetSamples : Math.max(0, region?.source ?? clip.offsetSamples)
  const sourceShift = structural ? 0 : offset - clip.offsetSamples
  const stretch = clip.stretch
    ? {
        ...clip.stretch,
        sourceSamples: newBody,
        markers: clip.stretch.markers
          .map((marker) => ({ ...marker, source: marker.source - sourceShift }))
          .filter((marker) => marker.source > 0 && marker.source < newBody),
      }
    : undefined
  const written: AudioClip = {
    ...clip,
    startSample,
    offsetSamples: offset,
    durationSamples: timeline,
    fadeInSamples: clamp(Math.round(next.fadeIn * ratio), 0, timeline),
    fadeOutSamples: clamp(Math.round(next.fadeOut * ratio), 0, timeline),
    gain: dbToGain(next.gainDb),
    wave: keepWave(next) ? next : undefined,
    stretch,
  }
  return written
}

export function timelineOf(clip: AudioClip, edit: WaveEdit, displaySample: number): number {
  const body = Math.max(1, bodyLength(edit))
  const ratio = clip.durationSamples / body
  return clip.startSample + (displaySample - edit.head) * ratio
}

export function displayOf(clip: AudioClip, edit: WaveEdit, timeline: number): number {
  const body = Math.max(1, bodyLength(edit))
  const ratio = clip.durationSamples / body
  return edit.head + (timeline - clip.startSample) / Math.max(1e-9, ratio)
}

function sliceRegion(region: WaveRegion, skip: number, length: number): WaveRegion {
  const next: WaveRegion = { ...region, id: uid('reg'), length: Math.max(1, Math.round(length)) }
  if (region.silence) return next
  if (region.reverse) {
    const tail = Math.max(0, region.length - skip - length)
    next.source = region.source + tail
    return next
  }
  next.source = region.source + Math.max(0, skip)
  return next
}

/** Split a playlist at a body index. `at` is in audible samples, not display samples. */
export function splitRegions(regions: WaveRegion[], at: number): [WaveRegion[], WaveRegion[]] {
  const left: WaveRegion[] = []
  const right: WaveRegion[] = []
  let cursor = 0
  const cut = Math.round(at)
  for (const region of regions) {
    const length = Math.max(0, Math.round(region.length))
    if (length < 1) continue
    const start = cursor
    const end = cursor + length
    cursor = end
    if (end <= cut) {
      left.push({ ...region, length })
      continue
    }
    if (start >= cut) {
      right.push({ ...region, length })
      continue
    }
    const leftLen = cut - start
    const rightLen = length - leftLen
    if (leftLen > 0) left.push(sliceRegion(region, 0, leftLen))
    if (rightLen > 0) right.push(sliceRegion(region, leftLen, rightLen))
  }
  return [left, right]
}

function mergeRegions(regions: WaveRegion[]): WaveRegion[] {
  const out: WaveRegion[] = []
  for (const region of regions) {
    const prev = out[out.length - 1]
    const same = prev
      && !!prev.silence === !!region.silence
      && !!prev.reverse === !!region.reverse
      && Math.abs((prev.gain ?? 1) - (region.gain ?? 1)) < 1e-4
      && (prev.silence || prev.reverse || prev.source + prev.length === region.source)
    if (prev && same && !prev.reverse) {
      prev.length += region.length
      continue
    }
    out.push({ ...region })
  }
  return out
}

export function splitDocument(edit: WaveEdit, bodyAt: number): [WaveEdit, WaveEdit] | null {
  const body = bodyLength(edit)
  const at = Math.round(bodyAt)
  if (at <= 0 || at >= body) return null
  const [leftRegions, rightRegions] = splitRegions(edit.regions, at)
  const left = normalizeEdit({ ...edit, regions: leftRegions, tail: 0, fadeOut: 0 })
  const right = normalizeEdit({ ...edit, head: 0, regions: rightRegions, fadeIn: 0 })
  return [left, right]
}

function startsAtHead(edit: WaveEdit): boolean {
  const first = edit.regions[0]
  if (!first || first.silence || first.reverse) return false
  return first.source === edit.origin + edit.head
}

function endsAtTail(edit: WaveEdit): boolean {
  const last = edit.regions[edit.regions.length - 1]
  if (!last || last.silence || last.reverse) return false
  return last.source + last.length === edit.tailAt
}

/**
 * Move a trim edge. Positive `delta` removes audible samples from that edge.
 * Negative `delta` reveals dimmed audio back into the clip.
 */
export function trimDocument(edit: WaveEdit, edge: 'start' | 'end', delta: number): WaveEdit {
  const step = Math.round(delta)
  if (!step) return edit
  const body = bodyLength(edit)
  if (edge === 'start') {
    if (step > 0) {
      const cut = Math.min(body - 1, step)
      const first = edit.regions[0]
      const slide = !!first && startsAtHead(edit) && cut < first.length
      const [, regions] = splitRegions(edit.regions, cut)
      return normalizeEdit({ ...edit, head: edit.head + (slide ? cut : 0), regions })
    }
    const pull = Math.min(edit.head, -step)
    if (pull < 1) return edit
    const first = edit.regions[0]
    const contiguous = !!first && !first.silence && !first.reverse && first.source === edit.origin + edit.head
    const regions = contiguous
      ? [{ ...first, source: first.source - pull, length: first.length + pull }, ...edit.regions.slice(1)]
      : [{ id: uid('reg'), source: edit.origin + edit.head - pull, length: pull, reverse: false, gain: 1, silence: false }, ...edit.regions]
    return normalizeEdit({ ...edit, head: edit.head - pull, regions })
  }
  if (step > 0) {
    const cut = Math.min(body - 1, step)
    const last = edit.regions[edit.regions.length - 1]
    const slide = !!last && endsAtTail(edit) && cut < last.length
    const [regions] = splitRegions(edit.regions, body - cut)
    return normalizeEdit({
      ...edit,
      regions,
      tailAt: slide ? edit.tailAt - cut : edit.tailAt,
      tail: edit.tail + (slide ? cut : 0),
    })
  }
  const pull = Math.min(edit.tail, -step)
  if (pull < 1) return edit
  const last = edit.regions[edit.regions.length - 1]
  const contiguous = !!last && !last.silence && !last.reverse && last.source + last.length === edit.tailAt
  const regions = contiguous
    ? [...edit.regions.slice(0, -1), { ...last, length: last.length + pull }]
    : [...edit.regions, { id: uid('reg'), source: edit.tailAt, length: pull, reverse: false, gain: 1, silence: false }]
  return normalizeEdit({ ...edit, regions, tailAt: edit.tailAt + pull, tail: edit.tail - pull })
}

export function trimStructuralClip(clip: AudioClip, edge: 'start' | 'end', newSample: number, bufferLength: number): AudioClip {
  const wave = clip.wave
  if (!wave || !isStructural(wave)) return clip
  const body = Math.max(1, bodyLength(wave))
  const ratio = clip.durationSamples / body
  const end = clip.startSample + clip.durationSamples
  if (edge === 'start') {
    const start = clamp(Math.round(newSample), 0, end - 1)
    let delta = Math.round((start - clip.startSample) / ratio)
    if (delta < 0) delta = Math.max(delta, -Math.floor(clip.startSample / Math.max(1e-6, ratio)))
    const next = trimDocument(wave, 'start', delta)
    const applied = applyEditToClip(clip, next, bufferLength)
    return { ...applied, startSample: Math.max(0, end - applied.durationSamples) }
  }
  const maxEnd = end + Math.round(wave.tail * ratio)
  const nextEnd = clamp(Math.round(newSample), clip.startSample + 1, Math.max(clip.startSample + 1, maxEnd))
  const delta = Math.round((end - nextEnd) / ratio)
  const next = trimDocument(wave, 'end', delta)
  const applied = applyEditToClip(clip, next, bufferLength)
  return { ...applied, startSample: clip.startSample }
}

export function splitStructuralClip(clip: AudioClip, atSample: number): [AudioClip, AudioClip] | null {
  const wave = clip.wave
  if (!wave || !isStructural(wave)) return null
  const at = Math.round(atSample)
  const end = clip.startSample + clip.durationSamples
  if (at <= clip.startSample || at >= end) return null
  const body = Math.max(1, bodyLength(wave))
  const ratio = clip.durationSamples / body
  const bodyAt = clamp(Math.round((at - clip.startSample) / ratio), 1, body - 1)
  const parts = splitDocument(wave, bodyAt)
  if (!parts) return null
  const file = Math.max(1, clip.offsetSamples + sourceLen(clip) + wave.head + wave.tail)
  const left = applyEditToClip({ ...clip, id: uid('clip') }, parts[0], file)
  const rightApplied = applyEditToClip({ ...clip, id: uid('clip'), name: `${clip.name} b` }, parts[1], file)
  const right: AudioClip = { ...rightApplied, startSample: left.startSample + left.durationSamples }
  return [left, right]
}

export function deleteRange(edit: WaveEdit, start: number, end: number): WaveEdit {
  const body = bodyLength(edit)
  const from = clamp(Math.round(Math.min(start, end)), 0, body)
  const to = clamp(Math.round(Math.max(start, end)), 0, body)
  if (to - from < 1) return edit
  if (from <= 0 && to >= body) return normalizeEdit({ ...edit, regions: [] })
  const [left] = splitRegions(edit.regions, from)
  const [, right] = splitRegions(edit.regions, to)
  return normalizeEdit({ ...edit, regions: mergeRegions([...left, ...right]) })
}

export function silenceRange(edit: WaveEdit, start: number, end: number): WaveEdit {
  const body = bodyLength(edit)
  const from = clamp(Math.round(Math.min(start, end)), 0, body)
  const to = clamp(Math.round(Math.max(start, end)), 0, body)
  if (to - from < 1) return edit
  const [left] = splitRegions(edit.regions, from)
  const [, right] = splitRegions(edit.regions, to)
  const gap: WaveRegion = { id: uid('reg'), source: 0, length: to - from, silence: true, reverse: false, gain: 1 }
  return normalizeEdit({ ...edit, regions: [...left, gap, ...right] })
}

export function copyRange(edit: WaveEdit, start: number, end: number): WaveRegion[] {
  const body = bodyLength(edit)
  const from = clamp(Math.round(Math.min(start, end)), 0, body)
  const to = clamp(Math.round(Math.max(start, end)), 0, body)
  if (to - from < 1) return []
  const [, midLeft] = splitRegions(edit.regions, from)
  const [mid] = splitRegions(midLeft, to - from)
  return mid.map((region) => ({ ...region, id: uid('reg') }))
}

export function pasteRegions(edit: WaveEdit, at: number, clipboard: WaveRegion[], replaceEnd?: number): WaveEdit {
  const body = bodyLength(edit)
  const insert = clipboard.map((region) => ({ ...region, id: uid('reg'), length: Math.max(1, Math.round(region.length)) }))
  if (!insert.length) return edit
  const from = clamp(Math.round(at), 0, body)
  if (replaceEnd != null && replaceEnd > from) {
    const to = clamp(Math.round(replaceEnd), from, body)
    const [left] = splitRegions(edit.regions, from)
    const [, right] = splitRegions(edit.regions, to)
    return normalizeEdit({ ...edit, regions: [...left, ...insert, ...right] })
  }
  const [left, right] = splitRegions(edit.regions, from)
  return normalizeEdit({ ...edit, regions: [...left, ...insert, ...right] })
}

export function reverseRange(edit: WaveEdit, start: number, end: number): WaveEdit {
  const body = bodyLength(edit)
  const from = clamp(Math.round(Math.min(start, end)), 0, body)
  const to = clamp(Math.round(Math.max(start, end)), 0, body)
  if (to - from < 1) return edit
  const [left] = splitRegions(edit.regions, from)
  const [, rest] = splitRegions(edit.regions, from)
  const [mid, right] = splitRegions(rest, to - from)
  const flipped = mid.reverse().map((region) => ({ ...region, id: uid('reg'), reverse: region.silence ? false : !region.reverse }))
  return normalizeEdit({ ...edit, regions: [...left, ...flipped, ...right] })
}

export function setGainDb(edit: WaveEdit, gainDb: number): WaveEdit {
  return normalizeEdit({ ...edit, gainDb })
}

export function setFades(edit: WaveEdit, patch: Partial<Pick<WaveEdit, 'fadeIn' | 'fadeOut' | 'fadeInShape' | 'fadeOutShape'>>): WaveEdit {
  return normalizeEdit({ ...edit, ...patch })
}

export function setCrossfade(edit: WaveEdit, samples: number): WaveEdit {
  return normalizeEdit({ ...edit, crossfade: samples })
}

/** Peak of the audible clip before clip gain, so Normalize can aim at full scale. */
export function bodyPeak(channels: ArrayLike<number>[], edit: WaveEdit): number {
  let peak = 0
  for (const region of edit.regions) {
    if (region.silence) continue
    const gain = region.gain ?? 1
    const from = Math.max(0, region.source)
    const to = from + region.length
    for (const channel of channels) {
      const end = Math.min(channel.length, to)
      for (let index = from; index < end; index++) {
        const sample = Math.abs(channel[index] || 0) * Math.abs(gain)
        if (sample > peak) peak = sample
      }
    }
  }
  return peak
}

export function normalizeGain(edit: WaveEdit, channels: ArrayLike<number>[], target = 0.99): WaveEdit {
  const peak = bodyPeak(channels, edit)
  if (!(peak > 1e-8)) return edit
  return setGainDb(edit, gainToDb(target / peak))
}

export function regionPlaySample(channel: ArrayLike<number>, region: WaveRegion, indexInRegion: number): number {
  if (region.silence) return 0
  const gain = region.gain ?? 1
  const at = region.reverse ? region.source + region.length - 1 - indexInRegion : region.source + indexInRegion
  if (at < 0 || at >= channel.length) return 0
  return (channel[at] || 0) * gain
}

export function regionsJoin(left: WaveRegion, right: WaveRegion): boolean {
  if (left.silence || right.silence || left.reverse || right.reverse) return false
  if (Math.abs((left.gain ?? 1) - (right.gain ?? 1)) > 1e-3) return false
  return Math.abs(left.source + left.length - right.source) <= 1
}

export function joinFadeSamples(edit: WaveEdit, left: WaveRegion, right: WaveRegion): number {
  if (regionsJoin(left, right)) return 0
  const want = Math.max(DECLICK_SAMPLES, edit.crossfade || 0)
  return Math.max(0, Math.min(want, Math.floor(left.length / 3), Math.floor(right.length / 3)))
}
