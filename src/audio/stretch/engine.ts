import { Psola } from './voice'
import type { AudioClip, ClipStretch, Project, StretchMode, TempoPoint, WarpMarker } from '../../model/types'

export type { ClipStretch, StretchMode, TempoPoint, WarpMarker }

export interface StretchOptions {
  /** Output length ÷ input length. 2 holds a clip twice as long. */
  ratio: number
  semitones?: number
  cents?: number
  mode?: StretchMode
}

const MODES: StretchMode[] = ['beats', 'tonal', 'voice', 'tape']

export function pitchFactor(semitones = 0, cents = 0) {
  return 2 ** ((semitones + cents / 100) / 12)
}

export function preferStretchCache(phone: boolean, cpu: number) {
  return phone && cpu > 0.7
}

export function detectTransients(channel: Float32Array, sampleRate: number, threshold = 0.2): number[] {
  let peak = 0
  for (let i = 0; i < channel.length; i++) {
    const mag = Math.abs(channel[i] || 0)
    if (mag > peak) peak = mag
  }
  if (peak < 1e-8) return []
  const gate = Math.max(0.02, threshold) * peak
  const minGap = Math.max(1, Math.round(sampleRate * 0.03))
  const hits: number[] = []
  let last = -minGap
  for (let index = 1; index < channel.length - 1; index++) {
    const mag = Math.abs(channel[index] || 0)
    if (mag < gate || mag < Math.abs(channel[index - 1] || 0) || mag <= Math.abs(channel[index + 1] || 0)) continue
    if (index - last < minGap) continue
    hits.push(index)
    last = index
  }
  return hits
}

/** Onset autocorrelation. Null when the signal has no pulse. */
export function detectBpm(channel: Float32Array, sampleRate: number): number | null {
  const hop = Math.max(1, Math.round(sampleRate / 200))
  const envLen = Math.floor(channel.length / hop)
  if (envLen < 16) return null
  const env = new Float32Array(envLen)
  let prev = 0
  for (let i = 0; i < envLen; i++) {
    let energy = 0
    const base = i * hop
    for (let j = 0; j < hop; j++) {
      const sample = channel[base + j] || 0
      energy += sample * sample
    }
    const mag = Math.sqrt(energy / hop)
    env[i] = Math.max(0, mag - prev)
    prev = mag
  }
  const minLag = Math.max(1, Math.round((60 / 180) * (sampleRate / hop)))
  const maxLag = Math.min(envLen - 2, Math.round((60 / 70) * (sampleRate / hop)))
  if (maxLag <= minLag) return null
  let bestLag = 0
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    for (let i = 0; i < envLen - lag; i++) corr += env[i] * env[i + lag]
    if (corr > best) {
      best = corr
      bestLag = lag
    }
  }
  if (bestLag <= 0 || best <= 0) return null
  let bpm = 60 / ((bestLag * hop) / sampleRate)
  while (bpm < 70) bpm *= 2
  while (bpm > 180) bpm /= 2
  return Math.round(bpm * 10) / 10
}

export function inspectClip(channel: Float32Array, sampleRate: number, tempo = 120): ClipStretch {
  const bpm = detectBpm(channel, sampleRate)
  const musical = bpm && bpm > 0 ? bpm : tempo
  const hits = detectTransients(channel, sampleRate, 0.35).slice(0, 64)
  const perBeat = (sampleRate * 60) / musical
  return {
    sourceSamples: channel.length,
    semitones: 0,
    cents: 0,
    mode: hits.length > (channel.length / sampleRate) * 2 ? 'beats' : 'tonal',
    followTempo: false,
    sourceBpm: bpm,
    markers: hits.map((sample) => ({
      id: `m${sample}`,
      source: sample,
      target: perBeat > 0 ? sample / perBeat : 0,
    })),
  }
}

export function quantizeMarkerTargets(markers: WarpMarker[], gridBeats: number, strength = 1): WarpMarker[] {
  if (!(gridBeats > 0)) return markers.map((marker) => ({ ...marker }))
  const amount = Math.max(0, Math.min(1, strength))
  return markers.map((marker, index) => {
    if (index === 0 && marker.target === 0) return { ...marker }
    const snapped = Math.round(marker.target / gridBeats) * gridBeats
    return { ...marker, target: Math.max(0, marker.target + (snapped - marker.target) * amount) }
  })
}

export function tempoMapOf(
  tempo: number,
  map: TempoPoint[] | undefined,
  lanes?: { pluginId: string; param: string; points: { beat: number; value: number }[] }[],
): TempoPoint[] {
  const automated = (lanes ?? [])
    .filter((lane) => lane.pluginId === 'transport' && lane.param === 'tempo')
    .flatMap((lane) => lane.points.map((point) => ({ beat: point.beat, bpm: point.value })))
  const points = [...(map ?? []), ...automated].filter((point) => point.bpm > 0 && Number.isFinite(point.beat))
  points.sort((a, b) => a.beat - b.beat)
  if (!points.length || points[0].beat > 0) points.unshift({ beat: 0, bpm: tempo })
  return points
}

/** Samples from the start of the project to a musical beat, following tempo changes. */
export function samplesAtBeat(beat: number, sampleRate: number, tempo: number, map: TempoPoint[]): number {
  const target = Math.max(0, beat)
  const points = map.length ? map : [{ beat: 0, bpm: tempo }]
  let bpm = tempo
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].beat <= 0) {
      bpm = points[i].bpm
      break
    }
  }
  let cursor = 0
  let samples = 0
  for (const point of points) {
    if (point.beat <= cursor) {
      if (point.beat <= 0) bpm = point.bpm
      continue
    }
    const end = Math.min(point.beat, target)
    if (end > cursor) samples += ((end - cursor) * sampleRate * 60) / bpm
    cursor = end
    bpm = point.bpm
    if (cursor >= target - 1e-12) return samples
  }
  if (target > cursor) samples += ((target - cursor) * sampleRate * 60) / bpm
  return samples
}

export function sourceSamplesOf(clip: AudioClip) {
  const stored = clip.stretch?.sourceSamples
  if (stored && stored > 0) return stored
  return Math.max(1, clip.durationSamples)
}

export function clipNeedsStretch(clip: AudioClip, project: Project) {
  const stretch = clip.stretch
  if (!stretch) return false
  if ((stretch.semitones || 0) !== 0 || (stretch.cents || 0) !== 0) return true
  if (stretch.mode === 'tape' && Math.abs(clip.durationSamples - stretch.sourceSamples) > 1) return true
  if (Math.abs(timelineSamples(clip, project) - stretch.sourceSamples) > 1) return true
  return markersDeviate(clip, project)
}

export function timelineSamples(clip: AudioClip, project: Project) {
  const stretch = clip.stretch
  const source = sourceSamplesOf(clip)
  if (stretch?.followTempo && stretch.sourceBpm && stretch.sourceBpm > 0) {
    const map = tempoMapOf(project.tempo, project.tempoMap, project.automation)
    const startBeat = samplesToBeat(clip.startSample, project.sampleRate, project.tempo, map)
    const sourceBeats = source / ((project.sampleRate * 60) / stretch.sourceBpm)
    const end = samplesAtBeat(startBeat + sourceBeats, project.sampleRate, project.tempo, map)
    const start = samplesAtBeat(startBeat, project.sampleRate, project.tempo, map)
    return Math.max(1, Math.round(end - start))
  }
  return Math.max(1, clip.durationSamples)
}

function samplesToBeat(samples: number, sampleRate: number, tempo: number, map: TempoPoint[]) {
  let lo = 0
  let hi = Math.max(1, (samples / sampleRate) * (tempo / 60) + 8)
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (samplesAtBeat(mid, sampleRate, tempo, map) < samples) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function markersDeviate(clip: AudioClip, project: Project) {
  const markers = clip.stretch?.markers
  if (!markers || markers.length < 2) return false
  const source = sourceSamplesOf(clip)
  const output = timelineSamples(clip, project)
  const map = tempoMapOf(project.tempo, project.tempoMap, project.automation)
  const startBeat = samplesToBeat(clip.startSample, project.sampleRate, project.tempo, map)
  for (const marker of markers) {
    const linear = startBeat + (marker.source / source) * (output / project.sampleRate) * (project.tempo / 60)
    if (Math.abs(marker.target - (linear - startBeat)) > 0.02) return true
  }
  return false
}

export function renderClipChannels(channels: Float32Array[], clip: AudioClip, project: Project): Float32Array[] {
  const stretch = clip.stretch
  const source = sourceSamplesOf(clip)
  const sliced = channels.map((channel) => Float32Array.from(channel.subarray(clip.offsetSamples, Math.min(channel.length, clip.offsetSamples + source))))
  const outLen = timelineSamples(clip, project)
  if (!stretch || !clipNeedsStretch(clip, project)) return fitChannels(sliced, outLen)
  const lead = sliced[0] ?? new Float32Array(0)
  const segments = clipSegments(lead, outLen, clip, project)
  const timed = segments
    ? fitChannels(sliced.map((channel) => stretchSegments(channel, project.sampleRate, stretch.mode, segments)), outLen)
    : null
  if (timed && !(stretch.semitones || stretch.cents)) return timed
  if (timed) {
    const formant = stretch.mode === 'voice' || stretch.mode === 'tape'
    return shiftAll(timed, project.sampleRate, stretch.semitones, stretch.cents, formant)
  }
  return renderStretch(sliced, project.sampleRate, {
    ratio: outLen / Math.max(1, lead.length),
    semitones: stretch.semitones,
    cents: stretch.cents,
    mode: stretch.mode,
  })
}

interface Segment {
  src0: number
  src1: number
  out0: number
  out1: number
}

function clipSegments(channel: Float32Array, outLen: number, clip: AudioClip, project: Project): Segment[] | null {
  const stretch = clip.stretch
  if (!stretch) return null
  const sourceLen = channel.length
  const map = tempoMapOf(project.tempo, project.tempoMap, project.automation)
  const startBeat = samplesToBeat(clip.startSample, project.sampleRate, project.tempo, map)
  if (stretch.followTempo && stretch.sourceBpm && stretch.sourceBpm > 0) {
    const beats = sourceLen / ((project.sampleRate * 60) / stretch.sourceBpm)
    const hits = stretch.mode === 'beats' ? detectTransients(channel, project.sampleRate, 0.2) : []
    return followSegments(sourceLen, beats, startBeat, project.sampleRate, project.tempo, map, hits)
  }
  if (markersDeviate(clip, project) && stretch.markers.length >= 2) {
    const points = [{ source: 0, target: 0 }, ...stretch.markers, { source: sourceLen, target: beatsOf(outLen, startBeat, project) }]
    return pointsToSegments(points, sourceLen, outLen, startBeat, project)
  }
  return null
}

function beatsOf(outLen: number, startBeat: number, project: Project) {
  const map = tempoMapOf(project.tempo, project.tempoMap, project.automation)
  const start = samplesAtBeat(startBeat, project.sampleRate, project.tempo, map)
  return samplesToBeat(start + outLen, project.sampleRate, project.tempo, map) - startBeat
}

function followSegments(
  sourceLen: number,
  sourceBeats: number,
  startBeat: number,
  sampleRate: number,
  tempo: number,
  map: TempoPoint[],
  extraSources: number[],
): Segment[] {
  const beats = new Set<number>([0, sourceBeats])
  for (const point of map) {
    const local = point.beat - startBeat
    if (local > 0 && local < sourceBeats) beats.add(local)
  }
  for (const source of extraSources) {
    const local = (source / sourceLen) * sourceBeats
    if (local > 0 && local < sourceBeats) beats.add(local)
  }
  const ordered = [...beats].sort((a, b) => a - b)
  const segments: Segment[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const b0 = ordered[i]
    const b1 = ordered[i + 1]
    segments.push({
      src0: Math.round((b0 / sourceBeats) * sourceLen),
      src1: Math.round((b1 / sourceBeats) * sourceLen),
      out0: Math.round(samplesAtBeat(startBeat + b0, sampleRate, tempo, map) - samplesAtBeat(startBeat, sampleRate, tempo, map)),
      out1: Math.round(samplesAtBeat(startBeat + b1, sampleRate, tempo, map) - samplesAtBeat(startBeat, sampleRate, tempo, map)),
    })
  }
  return segments
}

function pointsToSegments(
  points: { source: number; target: number }[],
  sourceLen: number,
  outLen: number,
  startBeat: number,
  project: Project,
): Segment[] {
  const map = tempoMapOf(project.tempo, project.tempoMap, project.automation)
  const sorted = points
    .map((point) => ({
      source: Math.max(0, Math.min(sourceLen, Math.round(point.source))),
      target: point.target,
    }))
    .sort((a, b) => a.source - b.source)
  const segments: Segment[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted[i]
    const right = sorted[i + 1]
    if (right.source <= left.source) continue
    const out0 = Math.round(samplesAtBeat(startBeat + left.target, project.sampleRate, project.tempo, map) - samplesAtBeat(startBeat, project.sampleRate, project.tempo, map))
    const out1 = Math.round(samplesAtBeat(startBeat + right.target, project.sampleRate, project.tempo, map) - samplesAtBeat(startBeat, project.sampleRate, project.tempo, map))
    segments.push({
      src0: left.source,
      src1: right.source,
      out0: Math.max(0, Math.min(outLen, out0)),
      out1: Math.max(0, Math.min(outLen, out1)),
    })
  }
  return segments
}

function stretchSegments(input: Float32Array, sampleRate: number, mode: StretchMode, segments: Segment[]): Float32Array {
  const end = segments.length ? segments[segments.length - 1].out1 : input.length
  const output = new Float32Array(Math.max(1, end))
  for (const segment of segments) {
    const src = input.subarray(Math.max(0, segment.src0), Math.min(input.length, segment.src1))
    const dstLen = segment.out1 - segment.out0
    if (src.length < 1 || dstLen < 1) continue
    const piece = mode === 'tape' ? resampleLinear(src, dstLen) : timeStretch(src, dstLen, mode, sampleRate)
    const dest = Math.max(0, segment.out0)
    output.set(piece.subarray(0, Math.min(piece.length, output.length - dest)), dest)
    if (mode === 'beats' && dest < output.length && Math.abs(src[0] || 0) >= 0.2) output[dest] = src[0] || 0
  }
  return output
}

/**
 * Time-stretch and pitch-shift. The same stream feeds a one-shot render and
 * block-sized realtime pulls, so export matches playback.
 */
export function renderStretch(channels: Float32Array[], sampleRate: number, options: StretchOptions): Float32Array[] {
  const stream = new StretchStream(Math.max(1, channels.length), sampleRate, options)
  stream.push(channels)
  return stream.flush()
}

export function renderStretchBlocks(channels: Float32Array[], sampleRate: number, options: StretchOptions, block: number): Float32Array[] {
  const stream = new StretchStream(Math.max(1, channels.length), sampleRate, options)
  const count = Math.max(1, channels[0]?.length ?? 0)
  const parts: Float32Array[][] = []
  const step = Math.max(1, block)
  for (let offset = 0; offset < count; offset += step) {
    const slice = channels.map((channel) => channel.subarray(offset, Math.min(count, offset + step)))
    const pulled = stream.push(slice)
    if (pulled[0]?.length) parts.push(pulled)
  }
  parts.push(stream.flush())
  return join(parts, Math.max(1, channels.length))
}

export class StretchStream {
  private readonly chunks: Float32Array[][] = []
  private received = 0
  private rendered: Float32Array[] | null = null
  private readAt = 0

  constructor(
    private readonly channelCount: number,
    private readonly sampleRate: number,
    private readonly options: StretchOptions,
  ) {}

  /** Append input. Samples are committed only once the same input the offline render sees is complete. */
  push(channels: Float32Array[]): Float32Array[] {
    const length = channels[0]?.length ?? 0
    if (length <= 0 || this.rendered) return this.empty()
    const copy = []
    for (let c = 0; c < this.channelCount; c++) copy.push(Float32Array.from(channels[Math.min(c, channels.length - 1)] ?? new Float32Array(length)))
    this.chunks.push(copy)
    this.received += length
    return this.empty()
  }

  flush(): Float32Array[] {
    if (!this.rendered) this.rendered = this.synthesize()
    return this.pull(this.rendered[0].length - this.readAt)
  }

  private synthesize(): Float32Array[] {
    const input = join(this.chunks, this.channelCount)
    const length = input[0]?.length ?? 0
    const ratio = clampRatio(this.options.ratio)
    const outLen = Math.max(1, Math.round(length * ratio))
    const mode = normalizeMode(this.options.mode)
    const semis = this.options.semitones || 0
    const cents = this.options.cents || 0
    if (length < 1) return [new Float32Array(outLen)]
    if (mode === 'tape') {
      const varied = input.map((channel) => resampleLinear(channel, outLen))
      return shiftAll(varied, this.sampleRate, semis, cents, true)
    }
    const factor = pitchFactor(semis, cents)
    if (mode === 'voice') {
      const stretched = input.map((channel) => timeStretch(channel, outLen, 'voice', this.sampleRate))
      return Math.abs(factor - 1) < 1e-4 ? stretched : shiftAll(stretched, this.sampleRate, semis, cents, true)
    }
    const timed = Math.abs(factor - 1) < 1e-4
      ? input
      : input.map((channel) => resampleLinear(channel, Math.max(1, Math.round(length / factor))))
    return timed.map((channel) => timeStretch(channel, outLen, mode, this.sampleRate))
  }

  private pull(count: number): Float32Array[] {
    const rendered = this.rendered ?? this.empty()
    const start = this.readAt
    const end = Math.min(rendered[0]?.length ?? 0, start + Math.max(0, count))
    this.readAt = end
    return rendered.map((channel) => channel.subarray(start, end))
  }

  private empty(): Float32Array[] {
    return Array.from({ length: this.channelCount }, () => new Float32Array(0))
  }
}

function shiftAll(channels: Float32Array[], sampleRate: number, semitones: number, cents: number, formant: boolean) {
  const factor = pitchFactor(semitones, cents)
  if (Math.abs(factor - 1) < 1e-4) return channels
  if (formant) return channels.map((channel) => formantShift(channel, sampleRate, factor))
  return channels.map((channel) => {
    const mid = resampleLinear(channel, Math.max(1, Math.round(channel.length / factor)))
    return timeStretch(mid, channel.length, 'tonal', sampleRate)
  })
}

function formantShift(input: Float32Array, sampleRate: number, factor: number) {
  if (input.length < 64 || Math.abs(factor - 1) < 1e-4) return Float32Array.from(input)
  const psola = new Psola(sampleRate, 1)
  const output = new Float32Array(input.length)
  psola.process([input], [output], (frame) => (frame.hz > 0 && frame.confidence >= 0.65 ? frame.hz * factor : 0), sampleRate, 50, 1600, 128)
  return output
}

export function timeStretch(input: Float32Array, outLen: number, mode: StretchMode, sampleRate: number) {
  const length = Math.max(1, outLen)
  if (input.length < 2) return resampleLinear(input, length)
  if (mode === 'tape') return resampleLinear(input, length)
  if (mode === 'beats') return stretchBeats(input, length, sampleRate)
  return wsola(input, length, mode)
}

function stretchBeats(input: Float32Array, outLen: number, sampleRate: number) {
  const hits = detectTransients(input, sampleRate, 0.2)
  if (!hits.length) return wsola(input, outLen, 'beats')
  const bounds = [0, ...hits, input.length]
  const output = new Float32Array(outLen)
  const attack = Math.max(1, Math.round(sampleRate * 0.004))
  for (let i = 0; i < bounds.length - 1; i++) {
    let src0 = bounds[i]
    const src1 = bounds[i + 1]
    let out0 = Math.round((src0 / input.length) * outLen)
    const out1 = i === bounds.length - 2 ? outLen : Math.round((src1 / input.length) * outLen)
    if (hits.includes(src0)) {
      const copy = Math.min(attack, src1 - src0, Math.max(0, out1 - out0))
      for (let k = 0; k < copy; k++) output[out0 + k] = input[src0 + k] || 0
      src0 += copy
      out0 += copy
    }
    const srcLen = src1 - src0
    const dstLen = out1 - out0
    if (srcLen < 1 || dstLen < 1) continue
    const piece = srcLen < 32 || dstLen < 32 ? resampleLinear(input.subarray(src0, src1), dstLen) : wsola(input.subarray(src0, src1), dstLen, 'beats')
    output.set(piece, out0)
  }
  return output
}

function wsola(input: Float32Array, outLen: number, mode: StretchMode) {
  if (input.length < 8 || outLen < 8) return resampleLinear(input, outLen)
  const output = new Float32Array(outLen)
  const weight = new Float32Array(outLen)
  let win = mode === 'beats' ? 512 : 2048
  win = Math.min(win, input.length)
  win = Math.max(32, win - (win % 2))
  const hs = Math.max(8, Math.min(outLen, Math.floor(win / 2)))
  const ratio = outLen / input.length
  const ha = hs / ratio
  const overlap = Math.max(8, win - hs)
  const radius = Math.min(mode === 'beats' ? 64 : 128, Math.max(8, overlap - 1), Math.max(0, input.length - win))
  let inPos = 0
  let outPos = 0
  const frames = Math.ceil(outLen / hs) + 4
  for (let frame = 0; frame < frames && outPos < outLen; frame++) {
    const room = Math.max(0, input.length - win)
    const natural = Math.max(0, Math.min(Math.round(inPos), room))
    const start = frame === 0 || radius < 1 ? natural : seekOutput(output, weight, outPos, input, natural, overlap, radius, win)
    const grain = Math.min(win, input.length - start)
    if (grain < 8) break
    addGrain(output, weight, input, start, outPos, grain)
    outPos += hs
    inPos += ha
  }
  for (let i = 0; i < outLen; i++) output[i] = weight[i] > 1e-5 ? output[i] / weight[i] : 0
  return output
}

/** Pick the input offset whose overlap best continues the audio already written. */
function seekOutput(
  output: Float32Array,
  weight: Float32Array,
  outAt: number,
  input: Float32Array,
  ideal: number,
  overlap: number,
  radius: number,
  win: number,
) {
  const maxStart = input.length - win
  if (maxStart <= 0) return 0
  const center = Math.max(0, Math.min(maxStart, ideal))
  const span = Math.min(overlap, output.length - outAt)
  if (span < 8) return center
  let best = center
  let bestScore = -Infinity
  const step = radius > 40 ? 4 : 1
  const scoreAt = (at: number) => {
    let corr = 0
    let left = 0
    let right = 0
    for (let i = 0; i < span; i += 4) {
      const w = weight[outAt + i]
      if (w < 1e-5) continue
      const a = output[outAt + i] / w
      const b = input[at + i] || 0
      corr += a * b
      left += a * a
      right += b * b
    }
    return corr / Math.sqrt(left * right + 1e-12)
  }
  for (let delta = -radius; delta <= radius; delta += step) {
    const at = center + delta
    if (at < 0 || at > maxStart) continue
    const score = scoreAt(at)
    if (score > bestScore) {
      bestScore = score
      best = at
    }
  }
  const from = Math.max(0, best - step)
  const to = Math.min(maxStart, best + step)
  for (let at = from; at <= to; at++) {
    const score = scoreAt(at)
    if (score > bestScore) {
      bestScore = score
      best = at
    }
  }
  return best
}

function addGrain(output: Float32Array, weight: Float32Array, input: Float32Array, inAt: number, outAt: number, grain: number) {
  const limit = Math.min(grain, output.length - outAt, input.length - inAt)
  for (let i = 0; i < limit; i++) {
    const window = grain <= 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1))
    const dest = outAt + i
    if (dest < 0 || dest >= output.length) continue
    output[dest] += (input[inAt + i] || 0) * window
    weight[dest] += window
  }
}

export function resampleLinear(input: Float32Array, outLen: number) {
  const output = new Float32Array(Math.max(1, outLen))
  if (input.length < 1) return output
  if (input.length === 1 || output.length === 1) {
    output.fill(input[0] || 0)
    return output
  }
  const step = (input.length - 1) / (output.length - 1)
  for (let i = 0; i < output.length; i++) {
    const pos = i * step
    const index = Math.floor(pos)
    const frac = pos - index
    const a = input[index] || 0
    const b = input[Math.min(input.length - 1, index + 1)] || 0
    output[i] = a + (b - a) * frac
  }
  return output
}

function fitChannels(channels: Float32Array[], length: number) {
  return channels.map((channel) => {
    if (channel.length === length) return channel
    const next = new Float32Array(length)
    next.set(channel.subarray(0, Math.min(length, channel.length)))
    return next
  })
}

function join(parts: Float32Array[][], channelCount: number) {
  const length = parts.reduce((sum, part) => sum + (part[0]?.length ?? 0), 0)
  const channels = Array.from({ length: channelCount }, () => new Float32Array(length))
  let offset = 0
  for (const part of parts) {
    const n = part[0]?.length ?? 0
    for (let c = 0; c < channelCount; c++) channels[c].set(part[Math.min(c, part.length - 1)] ?? new Float32Array(n), offset)
    offset += n
  }
  return channels
}

function clampRatio(ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1
  return Math.min(8, Math.max(0.125, ratio))
}

function normalizeMode(mode: StretchMode | undefined): StretchMode {
  return mode && MODES.includes(mode) ? mode : 'tonal'
}

/** Peak position of a channel, for alignment tests and marker checks. */
export function peakIndex(channel: Float32Array) {
  let best = 0
  let at = 0
  for (let i = 0; i < channel.length; i++) {
    const mag = Math.abs(channel[i] || 0)
    if (mag > best) {
      best = mag
      at = i
    }
  }
  return at
}

export function defaultStretch(sourceSamples: number, mode: StretchMode = 'tonal'): ClipStretch {
  return {
    sourceSamples: Math.max(1, sourceSamples),
    semitones: 0,
    cents: 0,
    mode,
    followTempo: false,
    sourceBpm: null,
    markers: [],
  }
}

export function stretchEdge(clip: AudioClip, edge: 'start' | 'end', sample: number): AudioClip {
  const stretch = clip.stretch ?? defaultStretch(clip.durationSamples)
  const source = Math.max(1, stretch.sourceSamples || clip.durationSamples)
  const end = clip.startSample + clip.durationSamples
  let start = clip.startSample
  let duration = clip.durationSamples
  if (edge === 'end') duration = Math.max(64, Math.round(sample) - start)
  else {
    start = Math.max(0, Math.min(end - 64, Math.round(sample)))
    duration = end - start
  }
  const scale = clip.durationSamples > 0 ? duration / clip.durationSamples : 1
  return {
    ...clip,
    startSample: start,
    durationSamples: duration,
    stretch: {
      ...stretch,
      sourceSamples: source,
      followTempo: false,
      markers: stretch.markers.map((marker) => ({ ...marker, target: marker.target * scale })),
    },
  }
}

/**
 * Tempo-follow render used by the alignment test and by clip playback.
 * An impulse at `sourceBeat` lands on that project beat.
 */
export function renderTempoFollow(
  channel: Float32Array,
  sampleRate: number,
  sourceBpm: number,
  tempo: number,
  map: TempoPoint[],
  startBeat: number,
  mode: StretchMode = 'beats',
) {
  const points = tempoMapOf(tempo, map)
  const sourceBeats = channel.length / ((sampleRate * 60) / sourceBpm)
  const extra = mode === 'beats' ? detectTransients(channel, sampleRate, 0.2) : []
  const beats = new Set<number>([0, sourceBeats])
  for (const point of points) {
    const local = point.beat - startBeat
    if (local > 0.0001 && local < sourceBeats - 0.0001) beats.add(local)
  }
  for (const hit of extra) {
    const local = hit / ((sampleRate * 60) / sourceBpm)
    if (local > 0 && local < sourceBeats) beats.add(local)
  }
  const ordered = [...beats].sort((a, b) => a - b)
  const segments: Segment[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    segments.push({
      src0: Math.round((ordered[i] / sourceBeats) * channel.length),
      src1: Math.round((ordered[i + 1] / sourceBeats) * channel.length),
      out0: Math.round(samplesAtBeat(startBeat + ordered[i], sampleRate, tempo, points) - samplesAtBeat(startBeat, sampleRate, tempo, points)),
      out1: Math.round(samplesAtBeat(startBeat + ordered[i + 1], sampleRate, tempo, points) - samplesAtBeat(startBeat, sampleRate, tempo, points)),
    })
  }
  return stretchSegments(channel, sampleRate, mode, segments)
}
