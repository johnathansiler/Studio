import type { PluginInstance, Project, Track } from './types'
import { makeTrack, TRACK_COLORS, uid } from './types'
import {
  isFactoryPattern,
  normalizeBeats,
  starterPattern,
  type BeatRack,
  type PatternClip,
  type StepChannel,
} from './steps'

/** A step sequencer insert. Patterns live on the plugin so they save with the project. */
export function createStepsPlugin(rack?: BeatRack): PluginInstance {
  const steps = rack?.patterns?.length ? rack : freshRack()
  return {
    id: uid('fx'),
    pluginId: 'steps',
    version: '1',
    enabled: true,
    wet: 1,
    params: { song: 0 },
    sidechain: '',
    steps,
  }
}

export function isStepsPlugin(plugin: { pluginId?: string } | null | undefined): boolean {
  return plugin?.pluginId === 'steps'
}

export function freshRack(): BeatRack {
  const pattern = starterPattern()
  return { activeId: pattern.id, patterns: [pattern] }
}

export function stepSequencers(project: Project): { track: Track; plugin: PluginInstance }[] {
  const out: { track: Track; plugin: PluginInstance }[] = []
  for (const track of project.tracks) {
    for (const plugin of track.plugins ?? []) {
      if (plugin.pluginId === 'steps') out.push({ track, plugin })
    }
  }
  return out
}

export function stepHostForChannel(project: Project, channelId: string): string | null {
  for (const item of stepSequencers(project)) {
    if (item.plugin.steps?.patterns.some((pattern) => pattern.channels.some((channel) => channel.id === channelId))) {
      return item.track.id
    }
  }
  return null
}

export function stepPatternOwner(project: Project, patternId: string): string | null {
  for (const item of stepSequencers(project)) {
    if (item.plugin.steps?.patterns.some((pattern) => pattern.id === patternId)) return item.track.id
  }
  return null
}

export function findStepChannel(project: Project, channelId: string): StepChannel | null {
  for (const item of stepSequencers(project)) {
    for (const pattern of item.plugin.steps?.patterns ?? []) {
      const channel = pattern.channels.find((row) => row.id === channelId)
      if (channel) return channel
    }
  }
  for (const pattern of project.beats?.patterns ?? []) {
    const channel = pattern.channels.find((row) => row.id === channelId)
    if (channel) return channel
  }
  return null
}

/** True when someone edited the Beats rack or placed a pattern on the song. */
export function beatsWereUsed(beats: BeatRack | undefined, clips: PatternClip[] | undefined): boolean {
  if (!beats?.patterns?.length) return false
  if ((clips ?? []).some((clip) => (
    clip.placed
    || clip.scene != null
    || Math.abs(clip.startBeat) > 1e-4
    || Math.abs(clip.offsetBeats || 0) > 1e-6
    || clip.suppressed
  ))) return true
  if (beats.patterns.length !== 1) return true
  return !isFactoryPattern(beats.patterns[0])
}

function numbered(tracks: { name: string }[], base: string) {
  const used = tracks.filter((track) => track.name === base || track.name.startsWith(`${base} `)).length
  return `${base} ${used + 1}`
}

function ensurePluginRack(plugin: PluginInstance) {
  if (!plugin.steps?.patterns?.length) plugin.steps = freshRack()
  else plugin.steps = normalizeBeats(plugin.steps, []).beats
}

/**
 * Move a used Beats rack onto a Step Sequencer track.
 * A factory rack that nobody edited stays put and does not add a track.
 * A later load that already has the plugin keeps that plugin as the source of the steps.
 */
export function adoptStepSequencers(project: Project) {
  for (const item of stepSequencers(project)) ensurePluginRack(item.plugin)
  if (stepSequencers(project).length) project.stepsAdopted = true
  const beats = project.beats
  const owned = new Set(stepSequencers(project).flatMap((item) => item.plugin.steps?.patterns.map((pattern) => pattern.id) ?? []))
  if (beats?.patterns?.length && beats.patterns.every((pattern) => owned.has(pattern.id))) {
    const owner = stepSequencers(project).find((item) => beats.patterns.every((pattern) => item.plugin.steps?.patterns.some((row) => row.id === pattern.id)))
    if (owner?.plugin.steps) project.beats = owner.plugin.steps
    return
  }
  if (project.stepsAdopted) return
  if (!beatsWereUsed(beats, project.patternClips) || !beats) return
  const track = makeTrack({
    name: numbered(project.tracks, 'Step Sequencer'),
    type: 'midi',
    color: TRACK_COLORS[project.tracks.length % TRACK_COLORS.length],
    instrument: 'synth',
    input: 'none',
  })
  const placed = (project.patternClips ?? []).some((clip) => clip.scene == null && !clip.suppressed)
  const plugin = createStepsPlugin(beats)
  if (placed) plugin.params = { ...plugin.params, song: 1 }
  track.plugins = [plugin]
  project.tracks.push(track)
  for (const clip of project.patternClips ?? []) {
    if (clip.scene != null) continue
    clip.trackId = track.id
  }
  project.beats = plugin.steps
  project.stepsAdopted = true
}
