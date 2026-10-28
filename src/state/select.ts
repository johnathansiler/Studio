import { descriptor } from '../audio/plugins/catalog'
import { audibleIds } from '../model/audible'
import { findLane, modeOf, specKey, valueAtSample, type AutoSpec } from '../model/automation'
import { groupForTrack } from '../model/mixGroups'
import { DEVICE_PARAMS } from '../model/rack'
import type { Project } from '../model/types'

export interface LaneChoice {
  key: string
  label: string
  min: number
  max: number
  spec: AutoSpec
}

export function automationWriteMode(project: Project) {
  return modeOf(project)
}

export function mixGroupsOf(project: Project) {
  return project.mixGroups ?? []
}

export function trackGroupId(project: Project, trackId: string) {
  return groupForTrack(project, trackId)?.id ?? null
}

export function trackAudible(project: Project, trackId: string) {
  return audibleIds(project.tracks).has(trackId)
}

export function laneChoices(project: Project, trackId: string): LaneChoice[] {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track) return []
  const choices: LaneChoice[] = [
    { key: specKey({ trackId, target: 'volume', param: 'volume', min: 0, max: 1.25 }), label: 'Volume', min: 0, max: 1.25, spec: { trackId, target: 'volume', param: 'volume', min: 0, max: 1.25 } },
    { key: specKey({ trackId, target: 'pan', param: 'pan', min: -1, max: 1 }), label: 'Pan', min: -1, max: 1, spec: { trackId, target: 'pan', param: 'pan', min: -1, max: 1 } },
  ]
  for (const send of track.sends) {
    const bus = project.tracks.find((item) => item.id === send.busId)
    const spec: AutoSpec = { trackId, target: 'send', param: 'gain', sendId: send.id, min: 0, max: 1 }
    choices.push({ key: specKey(spec), label: `${bus?.name ?? 'Send'} send`, min: 0, max: 1, spec })
  }
  for (const plugin of track.plugins) {
    const specDesc = descriptor(plugin.pluginId)
    for (const param of specDesc?.params ?? []) {
      const spec: AutoSpec = { trackId, target: 'plugin', param: param.id, pluginId: plugin.id, min: param.min, max: param.max }
      choices.push({ key: specKey(spec), label: `${specDesc?.name ?? plugin.pluginId} ${param.name}`, min: param.min, max: param.max, spec })
    }
  }
  for (const device of track.rack?.devices ?? []) {
    for (const param of DEVICE_PARAMS[device.kind] ?? []) {
      const spec: AutoSpec = { trackId, target: 'instrument', param: param.id, deviceId: device.id, min: param.min, max: param.max }
      choices.push({ key: specKey(spec), label: `${device.kind} ${param.name}`, min: param.min, max: param.max, spec })
    }
  }
  return choices
}

export function lanePoints(project: Project, spec: AutoSpec) {
  if (spec.target === 'instrument' && spec.deviceId) {
    return project.rackAutomation.find((lane) => lane.deviceId === spec.deviceId && lane.param === spec.param)?.points ?? []
  }
  return findLane(project, spec)?.points ?? []
}

export function automatedValue(project: Project, spec: AutoSpec, sample: number, fallback: number) {
  const points = lanePoints(project, spec)
  if (!points.length) return fallback
  return valueAtSample(points, sample, project.sampleRate, project.tempo, fallback)
}
