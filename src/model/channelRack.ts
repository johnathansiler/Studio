import { DRUM_PADS, type DrumKind as PadKind } from './drums'
import { clampStepCount, emptyCell, STEP_BEAT, stepIndexAt, type BeatPattern, type DrumKind, type StepCell, type StepChannel } from './steps'
import { uid } from './types'

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

function rackKind(kind: PadKind): DrumKind {
  if (kind === 'openhat') return 'hat'
  if (kind === 'kick' || kind === 'snare' || kind === 'clap' || kind === 'hat') return kind
  return 'perc'
}

/** Built-in kit. These play without downloading anything. */
export function kitChoices(): RackChoice[] {
  return DRUM_PADS.map((pad, index) => ({
    name: pad.name,
    kind: rackKind(pad.kind),
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

export function valueFromRatio(mode: GraphMode, ratio: number): Partial<GraphCell> {
  const t = Math.max(0, Math.min(1, ratio))
  if (mode === 'velocity') return { velocity: Math.round((0.05 + t * 0.95) * 100) / 100 }
  if (mode === 'gate') return { gate: Math.round((0.05 + t * 0.95) * 100) / 100 }
  if (mode === 'pan') return { pan: Math.round((-1 + t * 2) * 100) / 100 }
  return { pitch: Math.round(-12 + t * 24) }
}
