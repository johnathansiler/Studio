import type { RackAutomation } from './rack'
import type { AutomationLane, AutomationPoint, AutomationWriteMode, Project } from './types'
import { beatsToSamples, samplesToBeats } from './time'

export type AutoTarget = 'volume' | 'pan' | 'send' | 'plugin' | 'instrument'

export interface AutoSpec {
  trackId: string
  target: AutoTarget
  param: string
  pluginId?: string
  sendId?: string
  deviceId?: string
  min: number
  max: number
}

export function specKey(spec: AutoSpec) {
  if (spec.target === 'send') return `send:${spec.trackId}:${spec.sendId}`
  if (spec.target === 'plugin') return `plugin:${spec.pluginId}:${spec.param}`
  if (spec.target === 'instrument') return `instrument:${spec.deviceId}:${spec.param}`
  return `${spec.target}:${spec.trackId}`
}

export function prepareCurve(points: AutomationPoint[]) {
  return points
    .filter((point) => Number.isFinite(point.beat) && Number.isFinite(point.value))
    .slice()
    .sort((a, b) => a.beat - b.beat)
}

/** Linear value at a musical beat. The curve holds outside the first and last points. */
export function curveAt(sorted: AutomationPoint[], beat: number, fallback: number) {
  if (!sorted.length) return fallback
  if (beat <= sorted[0].beat) return sorted[0].value
  const last = sorted[sorted.length - 1]
  if (beat >= last.beat) return last.value
  let lo = 0
  let hi = sorted.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].beat <= beat) lo = mid
    else hi = mid
  }
  const a = sorted[lo]
  const b = sorted[hi]
  const span = b.beat - a.beat || 1
  return a.value + ((beat - a.beat) / span) * (b.value - a.value)
}

export function valueAtSample(points: AutomationPoint[], sample: number, sampleRate: number, tempo: number, fallback: number) {
  return curveAt(prepareCurve(points), samplesToBeats(sample, sampleRate, tempo), fallback)
}

export function curveChanges(points: AutomationPoint[], sampleRate: number, tempo: number, length: number, fallback: number) {
  if (points.length < 2 || length < 2) return false
  const sorted = prepareCurve(points)
  const first = curveAt(sorted, 0, fallback)
  const endBeat = samplesToBeats(Math.max(0, length - 1), sampleRate, tempo)
  if (Math.abs(curveAt(sorted, endBeat, fallback) - first) > 1e-6) return true
  for (const point of sorted) {
    if (point.beat > 0 && point.beat < endBeat && Math.abs(point.value - first) > 1e-6) return true
  }
  return false
}

/** Breakpoints from the playhead forward. Times are seconds on the audio context clock. */
export function rampEvents(
  points: AutomationPoint[],
  fallback: number,
  sampleRate: number,
  tempo: number,
  originSample: number,
  originTime: number,
  endSample: number,
) {
  const sorted = prepareCurve(points)
  const events: { time: number; value: number }[] = []
  const startBeat = samplesToBeats(originSample, sampleRate, tempo)
  events.push({
    time: originTime,
    value: curveAt(sorted, startBeat, fallback),
  })
  const endBeat = samplesToBeats(endSample, sampleRate, tempo)
  for (const point of sorted) {
    if (point.beat <= startBeat + 1e-6) continue
    if (point.beat > endBeat) break
    const sample = beatsToSamples(point.beat, sampleRate, tempo)
    events.push({ time: originTime + (sample - originSample) / sampleRate, value: point.value })
  }
  return events
}

export function drawPoint(points: AutomationPoint[], beat: number, value: number, radius = 0.03) {
  const next = points.filter((point) => Math.abs(point.beat - beat) > radius)
  next.push({ beat, value })
  return prepareCurve(next)
}

export function eraseNear(points: AutomationPoint[], beat: number, radius: number) {
  return points.filter((point) => Math.abs(point.beat - beat) > radius)
}

export function movePoint(points: AutomationPoint[], fromBeat: number, toBeat: number, value: number, radius = 0.08) {
  let found = false
  const next = points.map((point) => {
    if (found || Math.abs(point.beat - fromBeat) > radius) return point
    found = true
    return { beat: Math.max(0, toBeat), value }
  })
  return found ? prepareCurve(next) : points
}

/**
 * Replace the curve between two beats with a straight segment.
 * Points outside the span stay, so a touch pass does not erase the later lane.
 */
export function writeSegment(points: AutomationPoint[], fromBeat: number, toBeat: number, fromValue: number, toValue: number) {
  const start = Math.min(fromBeat, toBeat)
  const end = Math.max(fromBeat, toBeat)
  const keep = points.filter((point) => point.beat < start - 1e-4 || point.beat > end + 1e-4)
  keep.push({ beat: start, value: fromBeat <= toBeat ? fromValue : toValue })
  if (end > start + 1e-4) keep.push({ beat: end, value: fromBeat <= toBeat ? toValue : fromValue })
  return prepareCurve(keep)
}

export function findLane(project: Project, spec: AutoSpec): AutomationLane | undefined {
  return project.automation.find((lane) => laneMatches(lane, spec))
}

export function ensureLane(project: Project, spec: AutoSpec, id: string): AutomationLane {
  const existing = findLane(project, spec)
  if (existing) return existing
  const lane: AutomationLane = {
    id,
    pluginId: spec.pluginId || '',
    param: spec.param,
    points: [],
    trackId: spec.trackId,
    target: spec.target === 'instrument' ? 'plugin' : spec.target,
    sendId: spec.sendId,
  }
  project.automation.push(lane)
  return lane
}

export function laneMatches(lane: AutomationLane, spec: AutoSpec) {
  if (spec.target === 'volume' || spec.target === 'pan') return lane.target === spec.target && lane.trackId === spec.trackId
  if (spec.target === 'send') return lane.target === 'send' && lane.trackId === spec.trackId && lane.sendId === spec.sendId
  if (spec.target === 'plugin') return (lane.target === 'plugin' || lane.target == null) && lane.pluginId === spec.pluginId && lane.param === spec.param
  return false
}

export function laneFor(lanes: AutomationLane[], trackId: string, target: 'volume' | 'pan') {
  return lanes.find((lane) => lane.target === target && lane.trackId === trackId && lane.points.length)
}

export function sendLane(lanes: AutomationLane[], trackId: string, sendId: string) {
  return lanes.find((lane) => lane.target === 'send' && lane.trackId === trackId && lane.sendId === sendId && lane.points.length)
}

export function rackLanesFor(project: Project, trackId: string): RackAutomation[] {
  const devices = new Set(project.tracks.find((track) => track.id === trackId)?.rack?.devices.map((device) => device.id) ?? [])
  return (project.rackAutomation ?? []).filter((lane) => devices.has(lane.deviceId))
}

export function modeOf(project: Project): AutomationWriteMode {
  return project.automationMode === 'latch' || project.automationMode === 'touch' ? project.automationMode : 'read'
}

export interface WriteCursor {
  key: string
  beat: number
  value: number
  spec: AutoSpec
}

export function pluginLanesMove(lanes: AutomationLane[], pluginIds: readonly string[], sampleRate: number, tempo: number, length: number) {
  const ids = new Set(pluginIds)
  for (const lane of lanes) {
    if (lane.target && lane.target !== 'plugin') continue
    if (!ids.has(lane.pluginId)) continue
    if (curveChanges(lane.points, sampleRate, tempo, length, 0)) return true
  }
  return false
}

export function constantOrCurve(points: AutomationPoint[] | undefined, fallback: number, sampleRate: number, tempo: number, length: number) {
  if (!points?.length) return fallback
  const sorted = prepareCurve(points)
  if (!curveChanges(sorted, sampleRate, tempo, length, fallback)) return curveAt(sorted, 0, fallback)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = curveAt(sorted, samplesToBeats(i, sampleRate, tempo), fallback)
  return out
}
