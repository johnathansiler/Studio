import { audibleIds } from './audible'
import { DRUM_PADS } from './drums'
import { clampStepCount, emptyCell, patternPlayRange, renderPattern, STEP_BEAT, stepIndexAt, type BeatPattern, type DrumKind, type PatternClip, type RenderedHit, type StepCell, type StepChannel } from './steps'
import { beatsToSamples } from './time'
import { uid, type Project } from './types'

/** Pattern lengths the channel rack offers, in sixteenth notes. */
export const RACK_LENGTHS = [16, 32, 64] as const

export const RACK_COLORS = ['#ef6b6b', '#e0b15a', '#f09a6a', '#79b8d4', '#c58be0', '#73c48f', '#8fd0c6', '#d98baf']

export type GraphMode = 'velocity' | 'pan' | 'pitch' | 'gate'

export const GRAPH_LABELS: Record<GraphMode, string> = {
  velocity: 'Velocity',
  pan: 'Pan',
  pitch: 'Pitch',
  gate: 'Gate',
}

export interface RackChoice {
  name: string
  kind: DrumKind
  note: number
  color: string
  sampleId?: string | null
}

export function choiceColor(index: number) {
  return RACK_COLORS[index % RACK_COLORS.length]
}

/** Built-in kit. These play without downloading anything. Open hats, toms, and cymbals keep their own voice. */
export function kitChoices(): RackChoice[] {
  return DRUM_PADS.map((pad, index) => ({
    name: pad.name,
    kind: pad.kind,
    note: pad.pitch,
    color: choiceColor(index),
    sampleId: null,
  }))
}

/** A library sound becomes a note channel. Playback uses `lib_<id>` once the sample is stored. */
export function libraryChoice(entry: { id: string; name: string }, index: number): RackChoice {
  return {
    name: entry.name,
    kind: 'note',
    note: 60,
    color: choiceColor(index + 5),
    sampleId: `lib_${entry.id}`,
  }
}

export function makeRackChannel(choice: RackChoice, steps: number): StepChannel {
  const count = clampStepCount(steps)
  return {
    id: uid('row'),
    name: choice.name,
    kind: choice.kind,
    note: choice.note,
    color: choice.color,
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    output: null,
    sampleId: choice.sampleId ?? null,
    steps: count,
    swing: null,
    cells: Array.from({ length: 64 }, () => emptyCell()),
  }
}

/**
 * Set the pattern length. Channels that were the same length follow it.
 * A channel with its own shorter loop is left alone.
 */
export function applyPatternLength(pattern: BeatPattern, steps: number) {
  const next = clampStepCount(steps)
  const prev = pattern.steps
  pattern.steps = next
  for (const channel of pattern.channels) {
    if (channel.steps === prev) channel.steps = next
  }
}

/** Step indexes grouped by four, the way the rack shades beats. */
export function stepGroups(count: number) {
  const groups: number[][] = []
  for (let start = 0; start < count; start += 4) {
    const group: number[] = []
    for (let index = start; index < Math.min(count, start + 4); index++) group.push(index)
    groups.push(group)
  }
  return groups
}

/** Steps past a channel's own loop are dim. The last in-loop step wears the loop mark. */
export function stepLooks(index: number, channelSteps: number, patternSteps: number) {
  const loop = clampStepCount(channelSteps || patternSteps)
  return {
    past: index >= loop,
    loop: loop < patternSteps && index === loop - 1,
  }
}

/** Playhead inside one channel. A muted or soloed-out row stays dark. Shorter rows wrap. */
export function rackPlayIndex(beat: number, steps: number, swing: number, audible: boolean) {
  if (!audible) return -1
  return stepIndexAt(beat, steps, STEP_BEAT, swing)
}

type GraphCell = Pick<StepCell, 'velocity' | 'pan' | 'pitch' | 'gate'>

/** 0 is the bottom of a graph bar, 1 is the top. Pan and pitch sit in the middle at 0. */
export function graphRatio(mode: GraphMode, cell: GraphCell) {
  if (mode === 'velocity') return Math.max(0, Math.min(1, (cell.velocity - 0.05) / 0.95))
  if (mode === 'gate') return Math.max(0, Math.min(1, (cell.gate - 0.05) / 0.95))
  if (mode === 'pan') return Math.max(0, Math.min(1, (cell.pan + 1) / 2))
  return Math.max(0, Math.min(1, (cell.pitch + 12) / 24))
}

/** True when the timeline has no audio, MIDI, or offset pattern clips. */
export function arrangementIsEmpty(project: Project): boolean {
  for (const track of project.tracks) {
    if (track.clips.some((clip) => !clip.slotOnly)) return false
    if (track.midiClips.some((clip) => !clip.slotOnly && clip.scene == null)) return false
  }
  const placed = (project.patternClips ?? []).filter((clip) => clip.scene == null)
  if (placed.length > 1) return false
  if (placed.some((clip) => clip.startBeat > 1e-4)) return false
  return true
}

/**
 * Pattern loops the beat open in the channel rack.
 * Song plays clips on the arrangement. An empty timeline starts in Pattern
 * so Play in the drums view is heard before anything is placed.
 */
export function rackPlayMode(project: Project): 'pattern' | 'song' {
  if (project.rackMode === 'pattern' || project.rackMode === 'song') return project.rackMode
  return arrangementIsEmpty(project) ? 'pattern' : 'song'
}

export function activeBeatPattern(project: Project): BeatPattern | null {
  const rack = project.beats
  if (!rack?.patterns?.length) return null
  return rack.patterns.find((item) => item.id === rack.activeId) ?? rack.patterns[0]
}

/**
 * Samples in one pass of Pattern mode. 0 means Song mode, so the arrangement
 * loop and the placed clips keep the shared transport.
 */
export function emptyPatternLoopSamples(project: Project): number {
  if (rackPlayMode(project) !== 'pattern') return 0
  const pattern = activeBeatPattern(project)
  if (!pattern) return 0
  const beats = Math.max(STEP_BEAT, pattern.steps * STEP_BEAT)
  return Math.max(1, Math.round(beatsToSamples(beats, project.sampleRate, project.tempo)))
}

/**
 * What the live transport schedules. Pattern mode hears the open pattern,
 * even when the song loop sits somewhere else or the timeline is empty.
 * Offline renders stay on the clips that were actually placed.
 */
export function transportPatternClips(project: Project, live: boolean): PatternClip[] {
  const clips = project.patternClips ?? []
  if (!live || rackPlayMode(project) !== 'pattern') return clips
  const pattern = activeBeatPattern(project)
  if (!pattern) return clips
  return [{
    id: 'live-pattern',
    patternId: pattern.id,
    startBeat: 0,
    lengthBeats: Math.max(STEP_BEAT, pattern.steps * STEP_BEAT),
    scene: null,
  }]
}

/** Hits Play will schedule from the drums view or the song, for one pass. */
export function scheduledPatternNotes(project: Project): RenderedHit[] {
  if (rackPlayMode(project) === 'pattern') {
    const pattern = activeBeatPattern(project)
    if (!pattern) return []
    return renderPattern(pattern, 0, Math.max(STEP_BEAT, pattern.steps * STEP_BEAT))
  }
  const hits: RenderedHit[] = []
  for (const clip of project.patternClips ?? []) {
    if (clip.scene != null) continue
    const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
    if (!pattern) continue
    const range = patternPlayRange(clip)
    hits.push(...renderPattern(pattern, range.from, range.to))
  }
  hits.sort((a, b) => a.startBeat - b.startBeat)
  return hits
}

/**
 * Mixer strip for one hit. An explicit output or a placed clip's lane wins.
 * A row with no output uses the first audible instrument track, then the master.
 */
export function patternHitTrack(
  project: Project,
  hit: Pick<RenderedHit, 'output'>,
  clip: Pick<PatternClip, 'trackId'>,
): string | null {
  const live = new Set(project.tracks.map((track) => track.id))
  if (hit.output && live.has(hit.output)) return hit.output
  if (clip.trackId && live.has(clip.trackId)) return clip.trackId
  const heard = audibleIds(project.tracks)
  const open = project.tracks.find((track) => track.type === 'midi' && heard.has(track.id) && track.volume > 0.001)
  return open?.id ?? null
}

export function shortSoundName(name: string): string {
  const cleaned = name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= 18) return cleaned
  return `${cleaned.slice(0, 17).trimEnd()}…`
}

export type RackCategory = 'Kicks' | 'Snares' | 'Hats' | 'Perc' | 'Notes'

export function kitCategory(kind: DrumKind): RackCategory {
  if (kind === 'kick') return 'Kicks'
  if (kind === 'snare' || kind === 'clap') return 'Snares'
  if (kind === 'hat' || kind === 'openhat' || kind === 'cymbal') return 'Hats'
  if (kind === 'note') return 'Notes'
  return 'Perc'
}

export function valueFromRatio(mode: GraphMode, ratio: number): Partial<GraphCell> {
  const t = Math.max(0, Math.min(1, ratio))
  if (mode === 'velocity') return { velocity: Math.round((0.05 + t * 0.95) * 100) / 100 }
  if (mode === 'gate') return { gate: Math.round((0.05 + t * 0.95) * 100) / 100 }
  if (mode === 'pan') return { pan: Math.round((-1 + t * 2) * 100) / 100 }
  return { pitch: Math.round(-12 + t * 24) }
}
