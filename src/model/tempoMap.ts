import type { MeterChange, Project, TempoPoint } from './types'
import { countInSeconds, type TimeSignature } from './time'

const TICKS = 960

/** Sorted tempo points, always with a point at beat 0. */
export function resolveTempoPoints(tempo: number, map: TempoPoint[] | undefined): TempoPoint[] {
  const points = (map ?? []).filter((point) => point.bpm > 0 && Number.isFinite(point.beat))
  points.sort((a, b) => a.beat - b.beat || a.bpm - b.bpm)
  if (!points.length || points[0].beat > 0) points.unshift({ beat: 0, bpm: Math.max(1, tempo) })
  return points
}

/** Project tempo, including transport automation lanes. */
export function tempoMapOf(
  tempo: number,
  map: TempoPoint[] | undefined,
  lanes?: { pluginId: string; param: string; points: { beat: number; value: number }[] }[],
): TempoPoint[] {
  const automated = (lanes ?? [])
    .filter((lane) => lane.pluginId === 'transport' && lane.param === 'tempo')
    .flatMap((lane) => lane.points.map((point) => ({ beat: point.beat, bpm: point.value })))
  return resolveTempoPoints(tempo, [...(map ?? []), ...automated])
}

export function projectTempoMap(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation'>): TempoPoint[] {
  return tempoMapOf(project.tempo, project.tempoMap, project.automation)
}

function samplesOver(span: number, full: number, bpm0: number, bpm1: number, ramp: boolean, sampleRate: number): number {
  if (!(span > 0)) return 0
  const start = Math.max(1, bpm0)
  if (!ramp || !(full > 0) || Math.abs(bpm0 - bpm1) < 1e-6) return (span * sampleRate * 60) / start
  const end = Math.max(1, bpm0 + (bpm1 - bpm0) * (span / full))
  if (Math.abs(start - end) < 1e-6) return (span * sampleRate * 60) / start
  return (sampleRate * 60 * span * Math.log(end / start)) / (end - start)
}

/** Samples from the start of the project to a musical beat, following steps and ramps. */
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
    if (end > cursor) samples += samplesOver(end - cursor, point.beat - cursor, bpm, point.bpm, !!point.ramp, sampleRate)
    cursor = end
    bpm = point.bpm
    if (cursor >= target - 1e-12) return samples
  }
  if (target > cursor) samples += samplesOver(target - cursor, target - cursor, bpm, bpm, false, sampleRate)
  return samples
}

/** Inverse of samplesAtBeat. */
export function beatAtSample(sample: number, sampleRate: number, tempo: number, map: TempoPoint[]): number {
  const target = Math.max(0, sample)
  if (target <= 0) return 0
  let lo = 0
  let hi = Math.max(1, (target / Math.max(1, sampleRate)) * (Math.max(30, tempo) / 60) + 4)
  let guard = 0
  while (samplesAtBeat(hi, sampleRate, tempo, map) < target && hi < 1e7 && guard++ < 40) hi *= 2
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (samplesAtBeat(mid, sampleRate, tempo, map) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export function tempoAtBeat(beat: number, tempo: number, map: TempoPoint[]): number {
  const points = map.length ? map : [{ beat: 0, bpm: tempo }]
  let bpm = Math.max(1, tempo)
  let prevBeat = 0
  for (const point of points) {
    if (point.beat <= prevBeat) {
      bpm = point.bpm
      prevBeat = Math.max(prevBeat, point.beat)
      continue
    }
    if (beat < point.beat - 1e-9) {
      if (point.ramp) {
        const t = (beat - prevBeat) / (point.beat - prevBeat)
        return bpm + (point.bpm - bpm) * Math.max(0, Math.min(1, t))
      }
      return bpm
    }
    bpm = point.bpm
    prevBeat = point.beat
  }
  return bpm
}

export function projectBeatSample(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate'>, beat: number): number {
  const map = projectTempoMap(project)
  return samplesAtBeat(beat, project.sampleRate, project.tempo, map)
}

export function projectSampleBeat(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate'>, sample: number): number {
  const map = projectTempoMap(project)
  return beatAtSample(sample, project.sampleRate, project.tempo, map)
}

export function tempoAtSample(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate'>, sample: number): number {
  const map = projectTempoMap(project)
  return tempoAtBeat(projectSampleBeat(project, sample), project.tempo, map)
}

export function beatSpanSamples(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate'>, startBeat: number, durationBeats: number): { start: number; duration: number } {
  const map = projectTempoMap(project)
  const start = samplesAtBeat(startBeat, project.sampleRate, project.tempo, map)
  const end = samplesAtBeat(startBeat + Math.max(0, durationBeats), project.sampleRate, project.tempo, map)
  return { start, duration: Math.max(0, end - start) }
}

export function pxAtBeat(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate'>, beat: number, pxPerSecond: number): number {
  return (projectBeatSample(project, beat) / project.sampleRate) * pxPerSecond
}

export function mapIsLinear(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'meterMap'>): boolean {
  const map = projectTempoMap(project)
  if (map.some((point) => point.beat > 1e-6 || point.ramp)) return false
  return !(project.meterMap ?? []).some((change) => change.beat > 1e-6)
}

const DENOMINATORS = [1, 2, 4, 8, 16]

export function normalizeMeter(numerator: number, denominator: number): TimeSignature {
  const den = DENOMINATORS.includes(denominator) ? denominator : 4
  const num = Math.max(1, Math.min(16, Math.round(numerator) || 4))
  return { numerator: num, denominator: den }
}

export function meterChanges(project: Pick<Project, 'timeSignature' | 'meterMap'>): MeterChange[] {
  const base = normalizeMeter(project.timeSignature.numerator, project.timeSignature.denominator)
  const extra = (project.meterMap ?? [])
    .filter((change) => change.beat > 1e-6 && change.numerator > 0 && change.denominator > 0)
    .map((change) => ({ beat: change.beat, ...normalizeMeter(change.numerator, change.denominator) }))
    .sort((a, b) => a.beat - b.beat)
  return [{ beat: 0, ...base }, ...extra]
}

export function meterAtBeat(project: Pick<Project, 'timeSignature' | 'meterMap'>, beat: number): TimeSignature {
  const changes = meterChanges(project)
  let meter = changes[0]
  for (const change of changes) {
    if (change.beat <= beat + 1e-9) meter = change
    else break
  }
  return { numerator: meter.numerator, denominator: meter.denominator }
}

export function meterAtSample(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate' | 'timeSignature' | 'meterMap'>, sample: number): TimeSignature {
  return meterAtBeat(project, projectSampleBeat(project, sample))
}

export function countInAt(project: Pick<Project, 'tempo' | 'tempoMap' | 'automation' | 'sampleRate' | 'timeSignature' | 'meterMap'>, sample: number): number {
  return countInSeconds(tempoAtSample(project, sample), meterAtSample(project, sample))
}

export interface GridMark {
  beat: number
  bar: number
  beatInBar: number
  downbeat: boolean
}

function regionAt(changes: MeterChange[], beat: number): MeterChange {
  let region = changes[0]
  for (const change of changes) {
    if (change.beat <= beat + 1e-9) region = change
    else break
  }
  return region
}

/** Beat grid for the ruler, metronome, and snap. One step is the meter's beat unit. */
export function gridMarks(project: Pick<Project, 'timeSignature' | 'meterMap'>, maxBeat: number): GridMark[] {
  const changes = meterChanges(project)
  const limit = Math.max(0, maxBeat)
  const marks: GridMark[] = []
  let beat = 0
  let bar = 1
  let guard = 0
  while (beat <= limit + 1e-8 && guard++ < 200000) {
    const region = regionAt(changes, beat)
    const next = changes.find((change) => change.beat > region.beat + 1e-9)
    const unit = 4 / region.denominator
    const barLen = region.numerator * unit
    if (!(unit > 0) || !(barLen > 0)) break
    const into = Math.max(0, beat - region.beat)
    const within = into - Math.floor(into / barLen + 1e-9) * barLen
    const beatInBar = Math.floor(within / unit + 1e-8) + 1
    marks.push({ beat, bar, beatInBar, downbeat: beatInBar <= 1 })
    const step = beat + unit
    if (next && step > next.beat + 1e-8) {
      beat = next.beat
      bar += 1
      continue
    }
    if (within + unit >= barLen - 1e-6) bar += 1
    beat = step
  }
  return marks
}

export function downbeatAt(project: Pick<Project, 'timeSignature' | 'meterMap'>, beat: number): number {
  const changes = meterChanges(project)
  const region = regionAt(changes, Math.max(0, beat))
  const barLen = region.numerator * (4 / region.denominator)
  if (!(barLen > 0)) return Math.max(0, beat)
  const into = Math.max(0, beat - region.beat)
  return region.beat + Math.floor(into / barLen + 1e-9) * barLen
}

function gridBeatAtOrAfter(project: Pick<Project, 'timeSignature' | 'meterMap'>, beat: number): GridMark {
  const target = Math.max(0, beat)
  const changes = meterChanges(project)
  const region = regionAt(changes, target)
  const unit = 4 / region.denominator
  const into = Math.max(0, target - region.beat)
  const steps = Math.ceil(into / unit - 1e-8)
  let grid = region.beat + steps * unit
  const next = changes.find((change) => change.beat > region.beat + 1e-9)
  if (next && grid > next.beat + 1e-6) grid = next.beat
  const marks = gridMarks(project, grid + unit)
  return marks.find((mark) => mark.beat >= grid - 1e-6) ?? marks[marks.length - 1] ?? { beat: grid, bar: 1, beatInBar: 1, downbeat: true }
}

export function clickAtOrAfter(project: Project, sample: number): number {
  const beat = projectSampleBeat(project, Math.max(0, sample))
  const grid = gridBeatAtOrAfter(project, beat)
  return projectBeatSample(project, grid.beat)
}

export function nextClickAfter(project: Project, sample: number): number {
  const beat = projectSampleBeat(project, Math.max(0, sample))
  const grid = gridBeatAtOrAfter(project, beat + 1e-4)
  const next = projectBeatSample(project, grid.beat)
  if (next > sample + 0.5) return next
  const further = gridBeatAtOrAfter(project, grid.beat + 1e-3)
  return projectBeatSample(project, further.beat)
}

export function clickAccent(project: Project, sample: number): boolean {
  const beat = projectSampleBeat(project, Math.max(0, sample))
  const grid = gridBeatAtOrAfter(project, Math.max(0, beat - 1e-3))
  return grid.downbeat
}

export interface MusicalPlace {
  bar: number
  beat: number
  tick: number
}

export function musicalAt(project: Project, sample: number): MusicalPlace {
  const beat = Math.max(0, projectSampleBeat(project, Math.max(0, sample)))
  const changes = meterChanges(project)
  let bar = 1
  for (let i = 0; i < changes.length; i++) {
    const region = changes[i]
    const nextBeat = changes[i + 1]?.beat ?? Infinity
    const unit = 4 / region.denominator
    const barLen = region.numerator * unit
    const end = Math.min(nextBeat, beat)
    if (beat >= nextBeat - 1e-9) {
      bar += Math.floor((nextBeat - region.beat) / barLen + 1e-9)
      continue
    }
    const into = Math.max(0, end - region.beat)
    const barIndex = Math.floor(into / barLen + 1e-9)
    const within = into - barIndex * barLen
    const beatIndex = Math.floor(within / unit + 1e-9)
    let tick = Math.floor((within / unit - beatIndex) * TICKS + 1e-6)
    let beatNo = beatIndex + 1
    let barNo = bar + barIndex
    if (tick >= TICKS) {
      tick = 0
      beatNo += 1
    }
    if (beatNo > region.numerator) {
      beatNo = 1
      barNo += 1
    }
    return { bar: barNo, beat: beatNo, tick }
  }
  return { bar, beat: 1, tick: 0 }
}

export function formatMapBars(project: Project, sample: number): string {
  const place = musicalAt(project, sample)
  return `${place.bar}.${place.beat}.${place.tick.toString().padStart(3, '0')}`
}

export function snapSampleToMap(sample: number, project: Project, subdivision = 1): number {
  const rounded = Math.max(0, Math.round(sample))
  if (!project.snap) return rounded
  // 1 is a quarter note. 4 is a sixteenth. 0.25 is a bar in 4/4.
  const unit = 1 / Math.max(1e-6, subdivision)
  const beat = projectSampleBeat(project, rounded)
  const snapped = Math.max(0, Math.round(beat / unit) * unit)
  return Math.max(0, Math.round(projectBeatSample(project, snapped)))
}

export function arrangementEndSample(project: Project): number {
  let end = project.sampleRate * 8
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.slotOnly) continue
      end = Math.max(end, clip.startSample + clip.durationSamples)
    }
    for (const clip of track.midiClips) {
      if (clip.slotOnly) continue
      end = Math.max(end, Math.round(projectBeatSample(project, clip.startBeat + clip.durationBeats)))
    }
  }
  for (const clip of project.patternClips ?? []) {
    if (clip.scene != null) continue
    end = Math.max(end, Math.round(projectBeatSample(project, clip.startBeat + clip.lengthBeats)))
  }
  return end
}

/** True when the explicit map changes speed after the downbeat. */
export function hasTempoChanges(project: Pick<Project, 'tempoMap' | 'automation'>): boolean {
  const points = [...(project.tempoMap ?? [])]
  for (const lane of project.automation ?? []) {
    if (lane.pluginId === 'transport' && lane.param === 'tempo') points.push(...lane.points.map((point) => ({ beat: point.beat, bpm: point.value })))
  }
  return points.some((point) => point.beat > 1e-6 || point.ramp)
}
